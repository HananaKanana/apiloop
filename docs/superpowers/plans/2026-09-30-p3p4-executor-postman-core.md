# P3/P4 核心：请求执行器 + Postman 导入导出（纯模块）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **本项目约定（覆盖 skill 默认做法）**：**不写新测试**，计划里也没有「先写失败的测试」这类步骤。每个任务结束都要跑一遍既有的 `npm test`，必须全绿。自测可以写一次性的探测脚本，放在仓库外面或临时目录里，用完删掉，**不要提交**。

**Goal:** 提供两块和存储、HTTP 路由都无关的纯逻辑：
1. 由本地后端代发任意 HTTP 请求的执行器；
2. Postman Collection v2.0/v2.1、Environment、Globals 的解析器，以及导出 v2.1 的导出器。

P1（数据底座）完成后，这两块会接入数据库和管理台接口。

**Architecture:** 所有代码都是新文件，不修改任何现有文件。执行器用 Node 自带的 `http`、`https`、`zlib`、`dns`，不引入新依赖。解析器把 Postman JSON 转成本项目的「接口树」中间结构（字段和 P1 的 `apis`、`examples`、`folders` 表一一对应），导出器做反向转换。

**Tech Stack:** Node ≥ 22.13，CommonJS，风格与 `lib/*.js` 保持一致（`var`、`function`、中文注释）。

**Spec:** [docs/design/2026-09-30-api-workbench-research.md](../../design/2026-09-30-api-workbench-research.md)，其中第 4 节（执行器）和第 6 节（Postman 导入映射）是本计划的依据。数据形状与 [P1 计划](2026-09-30-p1-data-foundation.md) 的 Task 1、Task 2 对齐。

## Global Constraints

- **只允许新建以下文件**：`lib/variables.js`、`lib/url-utils.js`、`lib/executor.js`、`lib/postman.js`。**不改任何现有文件**，包括 `package.json`、`lib/importers.js`、`README.md`。P1 会话正在改其他文件，碰了就会冲突。
- 不新增 npm 依赖。
- 模块只导出函数，不读写数据库，不挂 express 路由，不写 console（调试输出在提交前删掉）。
- 变量语法是 `{{name}}`。`{{@...}}` 是 mock 占位符，任何情况下都**不能**当成变量处理，必须原样保留。

## 共享数据形状（所有任务都按这里来）

```js
// 键值行：query / headers / path 参数 / 表单字段通用
Row = { key, value, type: 'string', required: false, desc: '', enabled: true }
// formdata 专用：多两个字段
FormRow = Row & { kind: 'text' | 'file', src: string | null }   // src 是本地文件路径

RequestSpec = {
  method: 'GET',                       // 大写；允许自定义方法
  url: 'https://{{host}}/api/users/:id',
  params: { path: Row[], query: Row[], headers: Row[] },
  body: {
    mode: 'none' | 'raw' | 'urlencoded' | 'formdata' | 'binary' | 'graphql',
    raw: '', language: 'json' | 'text' | 'xml' | 'html' | 'javascript',
    form: Row[] | FormRow[],           // urlencoded 和 formdata 都用这个字段
    file: { src } | null,              // binary 模式用
    graphql: { query: '', variables: '' } | null
  },
  auth: null                           // null 表示不设置，等同于 inherit
      | { type: 'noauth' } | { type: 'inherit' }
      | { type: 'bearer', token }
      | { type: 'basic', username, password }
      | { type: 'apikey', key, value, in: 'header' | 'query' }
      | { type: <其他 Postman 类型>, unsupported: true, raw: <原始对象> }
}
```

P1 迁移时写入的 `body = { mode: 'urlencoded', form: rows }` 与上面的形状一致，不需要额外转换。

---

## Review Focus

以下是审阅时我会重点推演的场景：

1. **url 里的 query 和 `params.query` 同时存在**：两边的参数都要发出去，url 自带的在前。`enabled: false` 的行不发。key 和 value 都要按 URL 规则编码，不能二次编码已经编码过的 `%xx`。
2. **响应体很大，或者是二进制**：超过 `maxBodyBytes`（默认 5MB）的部分停止保存并标记 `truncated`，但下载仍然读完，`size` 记的是真实大小。图片、zip 这类二进制不能按 utf-8 转字符串以后再存，否则数据会损坏。
3. **目标地址连不上、超时或被取消**：Promise 正常 resolve 出一个 `error` 结构，不能 reject，也不能导致进程崩溃。超时或取消以后，socket 必须被销毁。
4. **Postman 的「脏数据」**：`url` 可能是字符串，也可能是缺少 `raw` 的对象；`header` 可能是字符串；`description` 可能是 `{content}` 对象；`disabled` 可能缺失；v2.0 的 auth 是以类型名为 key 的对象。以上都要能正确解析，不能抛错。
5. **导入后再导出是否无损**：同一个 Postman 集合导入、再导出，前置/测试脚本、不支持的鉴权类型、未识别的字段都要保留下来，靠 `extra` 字段和 `unsupported.raw` 原样带回。

---

### Task 1: 变量替换与 URL 工具

**Files:** Create `lib/variables.js`、`lib/url-utils.js`

**Interfaces:**
- `variables.resolve(text: string, vars: Object<string,string>) -> { text, missing: string[] }`
  - 替换 `{{name}}`：去掉首尾空白后，名字不以 `@` 开头才算变量，名字允许 `[\w.\-$]+`。找不到值的变量原样保留，并把名字记进 `missing`（去重）。
  - 支持以下内置动态变量，每遇到一次就重新生成一次：`{{$guid}}`（uuid v4）、`{{$timestamp}}`（秒）、`{{$isoTimestamp}}`、`{{$randomInt}}`（0–1000）。
  - 不递归展开：值里面如果又含 `{{x}}`，保持原样。
- `variables.resolveSpec(spec: RequestSpec, vars) -> { spec, missing }`：对 url、所有行的 key/value、`body.raw`、`body.graphql`、auth 的各个字段都做替换，返回一份新对象，不修改入参。
- `variables.fromRows(rows: {key,value,enabled}[]) -> Object`：`enabled === false` 的行忽略，后出现的覆盖先出现的。调用方把「项目变量行 → 环境变量行」按顺序拼起来传入，就实现了 spec 第 3 节规定的优先级。
- `urlUtils.buildUrl(spec) -> string`，执行器用：
  1. 以 `spec.url` 为基础，补全协议，缺省用 `http://`；
  2. 用 `params.path` 替换路径里的 `:name` 段；
  3. 把 `params.query` 中启用的行追加到已有查询串之后。
- `urlUtils.deriveMockPath(url: string) -> string`，P1 和 P5 用：
  1. 去掉开头的 `{{任意变量}}`；
  2. 去掉协议和主机名；
  3. 去掉查询串和 `#` 之后的部分；
  4. 路径里的 `{{name}}` 段转成 `:name`；
  5. 保证以 `/` 开头，空串返回 `/`。
  - 示例：`{{baseUrl}}/api/users/{{id}}?x=1` → `/api/users/:id`；`https://a.com:8080/v1/x` → `/v1/x`。

- [ ] **Step 1**：实现上面列出的所有函数。
- [ ] **Step 2**：用一次性脚本把上面的示例都跑一遍，确认输出正确，然后删掉脚本。
- [ ] **Step 3**：`npm test` 全绿，然后提交：`feat: 变量替换与 URL 工具`。

---

### Task 2: 请求执行器

**Files:** Create `lib/executor.js`

**Interfaces:**
- Consumes: Task 1
- Produces: `execute(spec: RequestSpec, options?) -> Promise<ExecResult>`，**永远 resolve，不会 reject**。
  - `options = { variables?: Object, timeoutMs = 30000, followRedirects = true, maxRedirects = 10, rejectUnauthorized = false, maxBodyBytes = 5 * 1024 * 1024, signal?: AbortSignal }`
  - 返回结构：

  ```js
  ExecResult = {
    ok: boolean,                        // 拿到了 HTTP 响应就是 true，不管状态码是多少
    request: { method, url, headers: [[k, v]], bodyPreview: string, bodySize },   // 实际发出去的内容
    response: null | {
      status, statusText, httpVersion,
      headers: [[k, v]],                // 保留原始顺序和重复项，Set-Cookie 可能出现多条
      body: string, bodyEncoding: 'utf8' | 'base64',   // 按内容类型判断是文本还是二进制
      size,                             // 解压后的真实字节数
      truncated: boolean
    },
    redirects: [{ status, url }],
    timings: { dns, connect, tls, ttfb, download, total },   // 单位毫秒；某个阶段没发生就是 null
    missingVariables: string[],
    error: null | { code: 'TIMEOUT' | 'ABORTED' | 'DNS' | 'CONNECT' | 'TLS' | 'INVALID_URL' | 'FILE' | 'OTHER', message }
  }
  ```

- [ ] **Step 1: 构造请求**
  1. 先用 `resolveSpec` 替换变量，再用 `buildUrl` 得到最终 URL；URL 非法时返回 `INVALID_URL`。
  2. 只取启用的 headers。
  3. 应用 auth：bearer 加 `Authorization: Bearer <token>`；basic 用 base64 编码；apikey 按 `in` 放进 header 或 query；`unsupported`、`noauth`、`inherit` 和 `null` 什么都不做。
  4. 用户自己设置的同名 header 优先，auth 不覆盖它。
- [ ] **Step 2: 按 body.mode 生成请求体**

  | mode | 请求体 | Content-Type（用户已经设置的不覆盖） |
  | --- | --- | --- |
  | `raw` | 字符串 | 按 language：json → `application/json`，xml → `application/xml`，html → `text/html`，javascript → `application/javascript`，text → `text/plain` |
  | `urlencoded` | 启用的行，用 `URLSearchParams` 编码 | `application/x-www-form-urlencoded` |
  | `formdata` | 手工拼 multipart，boundary 随机生成；`kind: 'file'` 的行读取 `src` 指向的文件，文件名取 basename，读不到就返回 `FILE` 错误 | multipart，带 boundary |
  | `binary` | 读取 `file.src` 的内容 | `application/octet-stream` |
  | `graphql` | `JSON.stringify({query, variables: JSON.parse(variables) 失败时用 {}})` | `application/json` |

  - 所有请求都补上 `Content-Length`（GET 请求且没有请求体时除外）、`User-Agent: apiloop`、`Accept: */*`。用户已经设置的一律不覆盖。
- [ ] **Step 3: 发送、计时与重定向**
  1. 用 `http.request` 或 `https.request` 发送，`agent: false`，保证每次都是新连接，计时准确。
  2. 在 socket 的 `lookup`、`connect`、`secureConnect` 事件和响应的首字节、`end` 事件上打时间点，用 `process.hrtime.bigint()`。
  3. 遇到 301、302、303、307、308 并且 `followRedirects` 为 true 时跟随：303 以及 POST 请求遇到 301/302 时改成 GET 并丢弃请求体，其他情况保持原方法和请求体。每一跳都记进 `redirects`，超过 `maxRedirects` 时返回 `OTHER` 错误。
  4. `timings` 只统计最后一跳，`total` 统计从开始到结束的全部时间。
- [ ] **Step 4: 读取响应**
  1. 按 `content-encoding` 解压 gzip、deflate、br，响应头原样保留。
  2. 累计超过 `maxBodyBytes` 以后丢弃多出来的数据，但继续读完，这样 `size` 是真实大小。
  3. 判断文本还是二进制：`content-type` 匹配 `text/*`、`json`、`xml`、`javascript`、`x-www-form-urlencoded`、`html` 的按 utf-8 处理，其余用 base64。
- [ ] **Step 5: 超时和取消**
  - 超时用一个总计时器，覆盖包括重定向在内的全过程，到时间就 `req.destroy()`，返回 `TIMEOUT`。
  - `signal` 触发取消时同样销毁请求，返回 `ABORTED`。
  - 按 `err.code` 分类：`ENOTFOUND` / `EAI_AGAIN` → `DNS`；`ECONNREFUSED` / `ECONNRESET` / `EHOSTUNREACH` → `CONNECT`；`CERT_*` / `ERR_TLS_*` / `DEPTH_ZERO_SELF_SIGNED_CERT` → `TLS`。
- [ ] **Step 6: 自测**：写一次性脚本，在本机起一个 `http.createServer`，逐项确认：
  - 回显 method、headers、body；
  - 302 跳转；
  - gzip 响应；
  - 1×1 PNG 按 base64 返回，且解码后和原字节完全一致；
  - 服务端延时 2 秒、`timeoutMs: 500` 时返回 `TIMEOUT`；
  - 请求本机没有监听的端口时返回 `CONNECT`；
  - 请求 `https://self-signed.badssl.com/` 时：`rejectUnauthorized` 为 true 返回 `TLS`，为 false 正常拿到响应（没有网络就跳过这一项，并在提交说明里写明）。

  脚本用完删掉。
- [ ] **Step 7**：`npm test` 全绿，然后提交：`feat: 请求执行器（本地代发，含耗时/重定向/解压/超时）`。

---

### Task 3: Postman 解析器

**Files:** Create `lib/postman.js`（这个任务写解析部分）

**Interfaces:**
- Consumes: Task 1 的 `deriveMockPath`
- Produces: `parse(input: string | object) -> ParseResult`，输入格式无法识别时抛出 `Error`，错误信息要给出可读的中文原因。

  ```js
  ParseResult = {
    kind: 'collection' | 'environment' | 'globals',
    collection?: { name, description, variables: Row[], auth, scripts, extra, children: Node[] },
    environment?: { name, variables: Row[] },          // globals 也放在这里，name 固定为 'Globals'
    stats: { folders, apis, examples, scripts, unsupportedAuth: string[] },
    warnings: string[]
  }
  Node = FolderNode | ApiNode
  FolderNode = { type: 'folder', name, description, auth, variables: Row[], scripts, extra, children: Node[] }
  ApiNode = { type: 'api', name, description, method, url, params, body, auth, scripts,
              mockPath,                                 // 用 deriveMockPath(url) 算出来
              examples: [{ name, status, headers: Row[], body, responseType: 'json' | 'text' | 'html', source: 'imported' }],
              extra }
  scripts = [{ listen: 'prerequest' | 'test', exec: string }]   // exec 是数组时用 '\n' 拼成字符串
  ```

- [ ] **Step 1: 识别输入类型**。JSON 解析失败时抛出「不是合法的 JSON」。然后按以下规则判断：
  - `info.schema` 包含 `v2.1.0` → collection，版本 2.1；
  - 包含 `v2.0.0` → collection，版本 2.0；
  - 有 `requests` 和 `order` 字段 → 抛出「这是 Postman v1 格式，请在 Postman 里重新导出为 Collection v2.1」；
  - `_postman_variable_scope === 'globals'` → globals；
  - 有 `values` 数组 → environment；
  - 以上都不符合 → 抛出「无法识别的 Postman 文件」。
- [ ] **Step 2: 按 spec 第 6 节的映射表转换**，以下是需要统一的细节：
  - **`url`**：字符串就直接用。是对象时优先取 `raw`；没有 `raw` 就用 `protocol://host.join('.')` + `:port` + `/path.join('/')` 拼出来。`url.query` 转成 `params.query`，其中 `disabled: true` 转成 `enabled: false`；**同时把查询串从 url 里去掉**，避免重复发送。`url.variable` 转成 `params.path`。
  - **`header`**：字符串形式按行拆分，每行按第一个 `:` 分成 key 和 value。
  - **body**：
    - `raw` 取 `options.raw.language`，缺省为 `text`；
    - `formdata` 中 `type: 'file'` 的行转成 `kind: 'file'`，`src` 取字符串或数组的第一个元素；
    - `file` 模式转成 `binary`；
    - `graphql` 模式下 `variables` 是字符串就保留，是对象就 `JSON.stringify`。
  - **auth**：
    - v2.1 的格式是 `{type, [type]: [{key, value}]}`，v2.0 的格式是 `{type, [type]: {k: v}}`，两种都先转成普通对象再映射；
    - bearer / basic / apikey 映射到 `RequestSpec.auth`，apikey 的 `in` 取原数据里的 `in` 字段，缺省为 header；
    - `noauth` 转成 `{type: 'noauth'}`；
    - 其他类型转成 `{type, unsupported: true, raw: 原始 auth 对象}`，并把类型名记进 `stats.unsupportedAuth`（去重）；
    - 没有 auth 字段就是 `null`，即沿用父级设置。
  - **response[]**：转成 examples。`code` 缺失时按 200 处理。`responseType` 按响应头里的 content-type 判断，没有这个头就用 `_postman_previewlanguage`，判断不出来时用 `text`。
  - **description**：对象形式取 `content`，`null` 转成空串。
  - **extra**：每一层都把没有映射到的字段原样放进 `extra`，例如 `protocolProfileBehavior`、`_postman_id`、`id`、`request.proxy`、`request.certificate`。
  - **warnings**：`stats.scripts > 0` 时加一条「N 个脚本已保存但不会执行」；`unsupportedAuth` 非空时加一条「以下鉴权类型暂不支持：…」。
- [ ] **Step 3: Environment 和 Globals**：`values[]` 转成 Row，其中 `enabled` 缺失时视为 true。`type === 'secret'` 时在 Row 上保留 `secret: true`，这是一个额外字段，供 UI 打码显示。
- [ ] **Step 4: 自测**：自己手写一个覆盖 Review Focus 第 4 条所有情况的小 collection；另外如果能从网上下载公开的 Postman 集合样例，也拿来解析一遍。都用一次性脚本跑，确认不抛错、统计数字正确。脚本和样例都不提交。
- [ ] **Step 5**：`npm test` 全绿，然后提交：`feat: Postman Collection v2.0/v2.1 与 Environment 解析`。

---

### Task 4: 导出为 Postman v2.1

**Files:** Modify `lib/postman.js`（只在本计划新建的这个文件里追加）

**Interfaces:**
- Produces:
  - `toCollection({ name, description, variables, auth, scripts, extra, children }) -> object`：生成 Postman v2.1 集合，`info.schema = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'`；
  - `toEnvironment({ name, variables }) -> object`：带 `_postman_variable_scope: 'environment'`。
  - 输入就是 Task 3 的 `collection` 结构，也就是说 `toCollection(parse(x).collection)` 可以直接调用。

- [ ] **Step 1: 反向映射规则**
  1. 先把 `extra` 展开到对应层，再用已映射的字段覆盖。
  2. url 输出为对象形式：`raw` 是完整 URL，要把 `params.query` 重新拼回去；`query` 数组和 `variable` 数组也都要输出。
  3. auth 转回 v2.1 的数组格式；`unsupported` 的 auth 直接输出 `raw`。
  4. `scripts` 转回 `event[]`，`exec` 按 `\n` 拆成数组。
  5. examples 转回 `response[]`，其中 `status` 文本用 `http.STATUS_CODES` 生成。
  6. 本项目新建、没有 `extra` 的接口，也要能导出成合法的集合。
- [ ] **Step 2: 自测往返**：对 Task 3 的自测样例执行 `parse`，再 `toCollection`，再 `parse`，比较两次 `parse` 的结果是否深度相等（只允许 `warnings` 不同）。脚本用完删掉。
- [ ] **Step 3**：`npm test` 全绿，然后提交：`feat: 导出 Postman Collection v2.1 / Environment`。

---

## 完成后交回

完成后回报三件事：
1. 各 Task 的提交号；
2. 自测跳过了哪些项、为什么跳过；
3. 遇到的、本计划没有覆盖的 Postman 字段或 HTTP 行为，写成列表。

接入数据库、接入管理台接口（`POST /send`、导入导出接口）、做界面，这些都**不在本计划范围内**，等 P1 合入之后再单独排。
