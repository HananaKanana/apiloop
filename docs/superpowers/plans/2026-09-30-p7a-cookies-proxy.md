# P7a：Cookie 自动管理 + 代理 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **本项目约定**
> - **不写新测试**，既有的 `npm test` 必须全部通过。
> - 自测脚本跑完就删，不提交。
> - **只提交自己的文件**：`git commit -m ... -- <文件>`。

**目标**：
1. 调试「先登录、再调业务接口」这类接口时，不用再手动复制 cookie。
2. 公司内网环境可以通过 http 代理访问外部接口。

**架构**：
- **Cookie 部分**：
  - `lib/cookies.js` 是纯函数模块，负责解析 `Set-Cookie`、判断某个 cookie 该不该发给某个 URL、生成 `Cookie` 请求头。
  - 执行器新增一个可选的 `cookieJar` 钩子，模块本身仍然是纯的，不直接访问数据库。
  - `/send` 的做法：发送前从数据库读出「当前用户 × 当前项目」的 cookie，放进一个内存 jar 交给执行器；执行结束后，在一个事务里把 jar 的变化写回数据库。
- **代理部分**：
  - 执行器新增 `proxy` 选项，支持 http 代理：目标是 http 时直接转发，目标是 https 时先用 CONNECT 建立隧道。
  - 代理设置存在 `meta` 表里，由 admin 管理。

**技术栈**：不新增依赖。只用 Node 自带的 `http`、`https`、`tls`、`net`。

**依据**：接口契约 [docs/design/2026-09-30-admin-api-v2.md](../../design/2026-09-30-admin-api-v2.md) **第 12 节**。

## 全局约束

- **文件范围**：`lib/**`（`lib/web` 除外）、`README.md`。
- **执行器必须永远 resolve**，这条约定不能破坏：
  - Cookie 钩子抛异常时，接住后跳过，本次请求照常发出；
  - 代理连不上时，返回 `error.code = 'PROXY'`。
- **数据库迁移只追加**：本次是迁移 v5。

## 审阅重点

1. **Cookie 的安全边界**（最重要）：
   - `evil.com` 的响应里带 `Set-Cookie: a=1; Domain=bank.com`，必须拒绝，不能存；
   - `Domain=com` 这种只有一段的域，必须拒绝；
   - host-only 的 cookie，也就是 `Set-Cookie` 里没有写 `Domain` 的，不能发给子域名；
   - 带 `Secure` 的 cookie，不能通过 http 发送；
   - 过期的 cookie 不能再发送，而且要从库里删掉；`Max-Age=0` 表示立即删除；
   - `Path=/api` 的 cookie 不能发给 `/apix`。
2. **登录后跳转**：登录接口返回 302 并带 `Set-Cookie`，跳转后的那一跳请求必须带上这个 cookie。也就是说，每一跳的 `Set-Cookie` 要在跟随重定向**之前**就写进 jar。
3. **用户隔离**：用户 A 的 cookie 绝不会出现在用户 B 的请求里；Cookie 接口只能看到、删除自己的 cookie。
4. **历史记录打码**：按契约第 12 节的要求处理。项目里的其他成员通过 `GET /history/:id` 查看时，看不到 cookie、`Authorization` 和 `Set-Cookie` 的值。
5. **代理**：
   - 目标是 https 时走 CONNECT 隧道，`rejectUnauthorized: false` 对目标服务器的证书仍然生效；
   - 代理地址里的用户名密码，不会出现在 `ExecResult`、历史记录和 `GET /settings/proxy` 的返回里；
   - `noProxy` 要生效；
   - 代理连不上时，返回结构化的 `PROXY` 错误，不能 reject。

---

### Task 1: `lib/cookies.js`

**接口**（纯函数，`now` 是参数，便于自测）：
- `parseSetCookie(header: string, requestUrl: string, now: number) -> Cookie | null`：不合法、或者被安全规则拒绝时返回 null。
- `matches(cookie, url: string, now: number) -> boolean`
- `cookieHeader(cookies: Cookie[], url: string, now: number) -> string`：先筛出匹配的 cookie，按 path 从长到短排序，path 长度相同的按创建时间排序，最后拼成 `a=1; b=2`。
- `isExpired(cookie, now) -> boolean`
- `createMemoryJar(initial: Cookie[], now: () => number) -> { cookieHeaderFor(url), storeFrom(url, setCookieHeaders[]), changes() -> { upserts: Cookie[], deletes: Cookie[] } }`

- [ ] **Step 1：按 RFC 6265 第 5.2–5.4 节实现以下子集**
  1. **Domain 属性**：
     - 去掉开头的 `.`，转成小写；
     - 请求的主机名必须等于它，或者以 `.` + 它结尾，否则拒绝；
     - 它本身必须含有 `.`，这样才能挡住 `com`、`localhost` 这类只有一段的域；
     - 请求的主机是 IP 地址时，Domain 必须和这个 IP 完全相同；
     - **不内置公共后缀列表**，这是已知限制，要在 README 里写明。
  2. **没写 Domain** 的 cookie 是 host-only：只匹配完全相同的主机名。
  3. **Path 属性**：没写，或者不以 `/` 开头时，按 RFC 的 default-path 规则推导。路径匹配规则是：完全相等；或者请求路径以 cookie 的 path 为前缀，并且前缀以 `/` 结尾，或者前缀后面紧跟的字符是 `/`。
  4. **过期时间**：`Max-Age` 优先于 `Expires`。`Max-Age` 小于等于 0 时，这个 cookie 立即过期，在 jar 里的效果就是删除同名 cookie。
  5. **Secure**：带了这个属性的 cookie，只在 https 请求里发送。
  6. **同一个 cookie 的判断**：`domain + path + name` 相同就视为同一个，新值覆盖旧值，并保留原来的 `createdAt`。
- [ ] **Step 2：用一次性脚本自测**，把审阅重点第 1 条逐项跑一遍。
- [ ] **Step 3**：提交：`feat: cookie 解析与匹配`

---

### Task 2: 执行器支持 Cookie 钩子和代理

**文件**：修改 `lib/executor.js`

**新增选项**：
- `cookieJar?: { cookieHeaderFor(url) -> string, storeFrom(url, setCookies[]) }`
- `proxy?: { url: string, noProxy: string } | null`

**`ExecResult` 新增**：`proxy: null | { url }`，其中的密码打码；错误码新增 `'PROXY'`。

- [ ] **Step 1：Cookie**
  - 如果用户手写的请求头里已经有 `Cookie`（不区分大小写），就记一个标记 `userCookie`，表示整个请求都不从 jar 补充 cookie。
  - 每一跳的 `send()` 在计算 `hopHeaders` 时：
    - 如果没有 `userCookie` 并且传了 jar，就用 `jar.cookieHeaderFor(urlText)` 生成这一跳的 `Cookie` 头；
    - **这一步要放在跨域去掉凭据头之后**，这样跳到新域名时，带的是新域名自己的 cookie。
  - 每一跳收到响应后，**在判断是否跟随重定向之前**，先调用 `jar.storeFrom(urlText, res.headers['set-cookie'] || [])`。
  - jar 的每次调用都用 try/catch 包住，出错就跳过。
  - `requestInfo.headers` 记录的是**第一跳**实际发出的请求头，所以里面也要包含 jar 补上的 `Cookie`。
- [ ] **Step 2：代理**
  - **选择代理**：目标是 http 就用 `proxy.url`；`noProxy` 命中时直连。`noProxy` 的判断逻辑写成导出函数 `shouldBypassProxy(host, port, noProxy)`。
  - **http 目标**：请求直接发给代理主机。`path` 用完整的绝对地址（`http://host:port/path?query`）；`Host` 头仍然是目标主机。代理地址里带了用户名密码时，加 `Proxy-Authorization: Basic ...`。
  - **https 目标**：
    1. 先用 `http.request({ host: 代理主机, port: 代理端口, method: 'CONNECT', path: 'host:port', headers: { Host: 'host:port', 'Proxy-Authorization'?: ... } })` 建立隧道；
    2. 在 `connect` 事件里拿到 socket，检查 `res.statusCode` 是否是 2xx，不是就返回 `PROXY` 错误；
    3. 然后调用 `https.request`，参数 `{ ...原来的参数, createConnection: () => tls.connect({ socket, servername: host, rejectUnauthorized }) }`；
    4. 计时方面，隧道建立的时间计入 `connect` 阶段，TLS 握手计入 `tls` 阶段。
  - **异常处理**：连接代理本身出错，或者 CONNECT 返回的不是 2xx，都返回 `PROXY`，错误信息里的代理地址要打码。
  - **超时和取消**：同样要能中止 CONNECT 阶段，而且要把隧道的 socket 一起销毁。
- [ ] **Step 3：自测**
  - 用一次性脚本，基于 `http.createServer` 写一个最小的代理：普通请求用 `request` 转发，`connect` 事件用 `net.connect` 转发。
  - 分别验证：http 目标、https 目标（本地自签证书，`rejectUnauthorized: false`）、代理需要认证、`noProxy` 命中、代理端口没有监听。
  - Cookie 部分：本地服务 A 的 `/login` 返回 302 跳到 `/me`，并带 `Set-Cookie`；验证 `/me` 收到了这个 cookie。
- [ ] **Step 4**：`npm test` 全部通过后提交：`feat(executor): cookie 钩子与 http/CONNECT 代理`

---

### Task 3: Cookie 存储、`/send` 接入、历史打码、Cookie 接口

**文件**：修改 `lib/db/migrations.js`（迁移 v5）、`lib/api/send.js`、`lib/admin.js`；新建 `lib/db/repos/cookies.js`、`lib/api/cookies.js`

- [ ] **Step 1：迁移 v5**
  - 新建表：`cookies(id TEXT PK, project_id → projects CASCADE, user_id → users CASCADE, domain, path, name, value, expires INTEGER NULL, host_only, secure, http_only, same_site, created_at, updated_at)`
  - 建唯一索引：`(project_id, user_id, domain, path, name)`
- [ ] **Step 2：cookies repo**
  - `listFor(h, projectId, userId)`
  - `upsert(h, projectId, userId, cookie)`
  - `remove(h, id)`
  - `removeWhere(h, projectId, userId, { domain?, keys? })`
  - `purgeExpired(h, projectId, userId, now)`
- [ ] **Step 3：接入 `/send`**
  - 发送前：`purgeExpired`，然后 `listFor` 读出 cookie，用 `createMemoryJar` 建一个内存 jar 传给执行器。`options.cookies === false` 时不传 jar。
  - 执行结束后：在一个事务里，把 `jar.changes()` 的结果写回数据库（upsert 和 delete）。这个事务**不带** change 事件，因为 cookie 不影响 mock。
  - 写入失败只打日志，不影响返回给前端的结果。
- [ ] **Step 4：历史打码**
  - 在 `forHistory` 里，对 `result.request.headers` 和 `result.response.headers` 做契约要求的打码。打码函数 `maskSetCookie(value)` 写在 `lib/cookies.js` 里：只把第一个 `=` 到第一个 `;` 之间的内容替换成 `***`。
  - **只处理写进历史的那份副本**，返回给发送者本人的结果保持原样。
- [ ] **Step 5：Cookie 接口**
  - 按契约实现，全部挂 guard（viewer）。
  - 在处理函数里，把查询范围限定为 `user_id = req.user.id`。
  - `DELETE /cookies/:id`：cookie 不属于当前用户，或者当前用户已经不是这个项目的成员时，一律返回 404。
- [ ] **Step 6**：`npm test` 全部通过后提交：`feat: cookie 自动管理与历史打码`

---

### Task 4: 代理设置

**文件**：新建 `lib/proxy-settings.js`、`lib/api/settings.js`；修改 `lib/api/send.js`、`lib/admin.js`、`README.md`

- [ ] **Step 1：`proxy-settings.js`**
  - `get(h) -> ProxySetting`：从 `meta` 表的 `proxy` 键读取；没有这个键时，按环境变量生成默认值，但**不写库**。
  - `set(h, patch)`：代理地址必须以 `http://` 开头，否则抛出 400。如果提交的地址里密码是 `***`，就沿用库里原来的密码。
  - `mask(setting)`：把代理地址里的密码替换成 `***`。
  - `forTarget(setting, url) -> { url, noProxy } | null`：设置未启用时返回 null。
- [ ] **Step 2：接口**：`GET /settings/proxy` 只要登录就能访问；`PUT /settings/proxy` 挂 `auth.requireAdmin`。
- [ ] **Step 3：`/send` 接入**：`options.proxy !== false` 时，把 `forTarget(...)` 的结果传给执行器。
- [ ] **Step 4：README**
  - 新增「Cookie 与代理」一节，写清楚：Cookie 的作用范围（每个用户在每个项目里各一份）、历史记录里的打码规则、代理只支持 http 代理（https 目标走 CONNECT）、默认读取的环境变量。
  - 另外单独写一条已知限制：不内置公共后缀列表。
- [ ] **Step 5**：`npm test` 全部通过后提交：`feat: 代理设置`

## 完成后回报

- 每个 Task 的提交号；
- 审阅重点第 1 条逐项的自测结果；
- 代理的 5 种场景（http 目标、https 目标、需要认证、`noProxy` 命中、代理端口没有监听）各自的 `ExecResult.error` 和 `proxy` 字段。
