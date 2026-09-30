# server-mock → apiloop —— 项目长期笔记

## 是什么
把「启动 Web 服务器 + mock 数据」的 npm 包（写法参考 Express）改造成**本地 Postman 类工具**：
能调接口、能存接口、调通的响应一键变成 mock。参照 Apifox（接口定义 / 调试 / mock 三合一），
**数据全放本地 SQLite、不上云**。

- 产品名 **apiloop**。数据目录 `~/.apiloop`、库 `~/.apiloop/data.db`、cookie `apiloop_sid`、
  环境变量 `APILOOP_DB` / `APILOOP_ADMIN_PASSWORD` —— 全部从 `lib/app-info.js` 派生，
  **其他地方不许硬编码产品名**。
- 仓库 github.com/jirengu/server-mock（上游作者 ruoyu；本地提交署名 liuxiuqi <503560552@qq.com>）。
  版本 2.0.0，License ISC。bin：`apiloop` / `mock` / `server` → `./bin/server`（yargs 17）。
- `engines: node >=22.13.0`（`node:sqlite` 和全局 `WebSocket` 都靠它）。依赖只剩
  body-parser / chalk / ejs / express / filecopy / jade / js-yaml / open / yargs。
  `bin/server` 的 `--tpl` 帮助文本只写 `ejs, jade`，**别再写 pug**。
- 前端是 **Vue 3 + Vite**（`web/` 源码 → 构建到 `lib/web/`）。旧版零构建原生 JS 管理台已废弃。

## 分期进度
P0 SQLite 替换 routes.json ✅ → P1 数据底座 ✅ → P2 前端重构 ✅ → P3 执行器 ✅ →
P4 Postman 导入导出 ✅ → P5 调通即 mock ✅ → P6 多用户 ✅ → P7 扩展：
P7a（Cookie / 代理 / Mock 调用日志）✅、**P7b（流式发送 + WebSocket 调试）进行中**。
P7b 分工：**A 部分后端由 session1 做**（`lib/**` 除 `lib/web/**`、README、docs/api.md），
**B 部分前端由 session2 做**（`web/**`、`lib/web/**`）。

## 模块结构
```
bin/server            CLI 入口
lib/command.js        start / open / web / init / user 命令
lib/app-info.js       产品名、数据目录、cookie 名等常量（改名只动这里）
lib/db.js             SQLite 持久化层（node:sqlite，零依赖）
lib/db/repos/         各表增删改查
lib/routes-store.js   单个项目的门面：读缓存 + 变更订阅 + 保留前缀常量
lib/project-stores.js handle → Map(projectId → store)；管理台与 mock-host 必须共用同一实例
lib/mock-engine.js    模板渲染与随机数据生成（{{@...}} 占位符引擎）
lib/mock-runtime.js   把配置编译成 Express 路由（热更新、期望匹配、保留前缀校验）
lib/mock-host.js      按项目挂 mock：根路径 + /mock/<slug>
lib/mock-log.js       Mock 调用日志（内存环形缓冲，每项目 200 条）
lib/executor.js       请求执行器：由服务端代发真实 HTTP 请求（含流式钩子）
lib/ws-sessions.js    WebSocket 调试会话：连接上游、事件缓冲、生命周期回收
lib/api/ndjson.js     NDJSON 流式响应（/send/stream 与 /ws/:id/events 共用）
lib/cookies.js        Cookie 解析 / 匹配 / 内存 jar（纯函数）
lib/proxy-settings.js 代理设置（存 meta.proxy，没存就现算环境变量）
lib/access.js         项目权限判定（纯计算：角色、资源归属）
lib/redact.js         历史里原始请求的打码
lib/api/*             管理台接口 v2，按资源拆，每个导出 createRouter(ctx)
lib/api/respond.js    ok / fail / wrap / apiError
lib/admin.js          组装管理台 API（挂在 /__admin/api）
lib/web/              管理台前端构建产物（由 npm run build:web 生成）
web/                  Vue 源码；sample/ test/ docs/
```

## 关键约定（都是踩过坑的）
- **管理台接口 v2 在 `lib/api/*`**，每个文件导出 `createRouter(ctx)`（`ctx = { handle, rootProjectId }`），
  挂在 `admin.js` 的 `requireLogin` **之后** —— 它们自己不做鉴权。契约是唯一来源：
  `docs/design/2026-09-30-admin-api-v2.md`（README / docs/api.md 只列路径 + 链过去）。
- 统一返回 `{ ok: true, ... }` / `{ ok: false, error: '中文' }`。
- **管理台前缀 `/__admin`**，定义在 `lib/routes-store.js` 的 `RESERVED_PREFIX`（`admin.js` 引用它拼
  `API_PATH`）。**配 mock 路由不许占用 `/__admin`、`/__apiloop`**，由 `lib/mock-runtime.js` 的
  `RESERVED_PREFIXES` 在 `validateRoutePath` 里拦；比较前先 `toLowerCase()`（Express 路由默认大小写不敏感，
  `/__ADMIN/api/...` 一样打到管理台）。两份字面量必须一致，但**别互相 require（会成环）**。
- **mock 路径必须能被 Express 编译**（括号成对之类）；`buildRouter` 逐条 try/catch 兜底，坏路由跳过而不是
  整张表陪葬。**路径是用户数据，会流进 `setInterval`/`setTimeout` 回调 —— 那里没有 Express 兜底，
  抛出去就是进程崩溃。**
- **示例 `status` 必须是 100~599 的整数**（`Number.isInteger`；别用 `Number(x) || 200` —— 那会把
  200.5 / 'abc' 洗成合法值，校验等于没有）。
- **`enabled = mockEnabled && 有示例`** —— 没有示例的接口不算启用，不会挂出去。
- **mock 挂载**：根项目挂根路径，其他项目挂 `/mock/<slug>`；`/mock/<slug>` 只在 slug 真存在时才拦，
  否则交给根项目。改写 `req.url`/`req.baseUrl` 后必须在 runtime 的 `next` 里还原。
  **被 mock 的接口本身永远不鉴权。**
- **`folders.parent_id` 是 CASCADE、`apis.folder_id` 是 SET NULL** —— 递归删目录必须先删子孙目录里的接口，
  否则留下孤儿接口。
- **position 只在同一个父目录内部有意义**：同级用 repo 的 `listChildren` / `nextPositionIn` /
  `setPositionsIn`；`setPositions` / `nextPosition` 是**项目级**的（P1 遗留），别拿错。
- **事务与 change**：改动哪个项目就传 `{ projectId }`；影响多个项目（建/删项目、导入成新项目）传 `null`；
  不影响 mock 的（写历史、写 cookie）干脆不传。`lib/tree.js` 的函数**一律不开事务**（handle 不支持嵌套事务），
  校验失败用 `respond.apiError` 抛带状态码的错。
- **迁移**：表结构版本现在是 **v5**（v1 初始 / v2 接入补齐 / v3 folders.scripts / v4 members / v5 cookies）。
  加迁移只追加、不改历史条目。
- 内存里的 `routes` / `declaredGroups` 是读缓存，**库是唯一真相**；订阅常驻（自己的写也靠它刷新缓存），
  `startWatching`/`stopWatching` 只管库层的外部变更轮询。
- **默认界面入口**：`mock web` 后管理台在 `/index.html`，访问 `/` 由 `lib/command.js` 显式 **302** 过去，
  跳转必须注册在 routes.json / router.js **之前**；挂根路径的静态资源必须 `index: false`（否则 `express.static`
  会把 `/` 直接返回 200，跳转永远不执行）。
- **上传的文件落在 `appInfo.DATA_DIR/files/<pid>/`**（没有环境变量能改），测试会污染 `~/.apiloop/files`。
- **路由优先级**：先匹配库里的接口，未命中再交给用户目录的 `router.js`（router.js 里不要自己套 `setRouter`）。
- **配置热更新**：保存后服务端热更新路由，无需重启；外部直接用 sqlite3 改库也会生效。
- **测试**：`npm test` → `node --test --test-timeout=30000 test/*.test.js`，**基线 71 全绿**。
  测试不能碰真实的 `~/.apiloop`：启动 CLI 的用例都要传 `--db <临时目录>` + `APILOOP_ADMIN_PASSWORD`。
  **本项目约定「不写新测试」**：审阅用的一次性探测脚本放 `/tmp`，跑完删掉，不进仓库。
  **覆盖很薄**：`/send`、`/send/stream`、`/ws/*` 一条用例都没有，全靠一次性脚本。所以
  「npm test 全绿」**不能**用来证明某条接口行为没变 —— 用下面的「干净副本 + 双跑对比」。
- **干净副本 + 双跑对比**（改动声称「行为不变」时用它，不必 stash）：
  `git archive HEAD | tar -x -C /tmp/before`，同一份探测脚本分别指向副本和当前工作区，
  归一化后 `diff`。两处注意：副本里没有 `node_modules`，子进程要带
  `NODE_PATH=<工作区>/node_modules`；归一化要剔掉 `timings`、`Date` 响应头、以及**错误信息里的
  临时端口号**（不做替换会 diff 出一行假差异）。
- **量内存要在被测进程内部读** `process.memoryUsage().rss`：沙箱里 `/bin/ps` 是
  `operation not permitted`，`execSync` 会抛；而它抛在定时器回调里会让驱动进程直接死掉，
  **子进程变成孤儿占着 stdout 管道**，外层 `| tail` 于是永远等下去 —— 表现成「跑了很久没结果」，
  极难定位。所以：被测进程自己上报 RSS，并且子进程里加一条「`process.ppid` 变了就自己退出」。
- **登录**：`/__admin/api/*` 全部要求登录，只有 `/auth/login` 公开。密码 scrypt 加盐哈希，会话只存 token 的
  sha256，cookie `apiloop_sid` = `HttpOnly; SameSite=Lax`。连续 5 次登录失败锁该用户名 60 秒。禁用用户会
  立刻踢掉他的会话。
- **前端**：改 `web/` 之后要 `npm run build:web`，并把 `lib/web` 一起提交 —— 仓库里只有一份构建产物，
  npm 包和 Docker 镜像都直接用它。

## 权限模型（契约第 10 节）
- **可见性**：项目只有成员能看到；**不是成员 与 对象不存在 一律 404**（同一句话，不能让人试出
  「存在但你看不到」）；是成员但角色不够才 403「需要 <角色> 权限」。
- 角色 `viewer < editor < owner`；系统角色 **admin 不在成员表里**，对任何项目返回 `'admin'`
  （rank 最高，等同 owner），所以管理员没被加进任何项目也不会把自己锁在门外。
- 判定在 `lib/access.js`（`roleOf` / `atLeast` / `projectIdOf` / `visibleProjects`），拦截在
  `lib/api/guard.js` 的 `createGuard(ctx)` → `guard(level, locate)`。locate 是 `(req) => projectId|null`，
  函数上带 `label` 属性（用于「<资源>不存在」文案）；现成有 `byPid`（收 id 或 slug）和 `byParam(kind)`。
  通过后 handler 直接用 `req.project` / `req.role`。
- **凡是按 id 定位资源的路由都必须用 `byParam(kind)`**：示例和期望不存 projectId，要先经所属 api 绕一次
  （`access.projectIdOf` 干这事）。漏了它就是一个越权口子。
- **例外：目标项目从请求体里读、不走 guard 的路由用 400 不用 404**（Postman / HAR 的 `into` 模式）：
  「项目查不到」与「查到了但我不是成员」合并成同一个 400 + 同一句文案（`项目不存在：<id>`）——
  状态码或文案一旦有差别，拿 projectId 扫一遍就能试出哪个项目存在。角色不够的 403 留在这一支之后。
  **以后凡是这种路由都照这个口径写。**
- `Project` DTO 有 `myRole`；`GET /projects` 按成员关系过滤（admin 看全部）。
- 迁移 v4 把存量数据补齐（全部项目×全部用户先设 editor → 创建者升 owner → 还没 owner 的交给最早创建的
  admin）。建项目的所有入口都要 `access.addOwner`；启动时 `access.fillMissingOwners` 再兜一次
  （`init` 先于 `web` 时项目建出来还没有用户）。
- 成员表 `project_members`，repo 在 `lib/db/repos/members.js`；`countOwners(h, pid, {excludeUserId})`
  是「至少保留一个 owner」这条规则的判据，检查要放在事务里。

## Cookie 与代理（契约第 12 节）
- **Cookie 归属「用户 × 项目」**（`cookies` 表，迁移 v5），唯一键 `(project_id, user_id, domain, path, name)`；
  repo 的每个函数都要传这两个 id，没有「只按 id 查」的入口。
- `lib/cookies.js` 是**纯函数**模块（`now` 由调用方传）：`parseSetCookie` 同时是安全边界 —— Domain 必须与
  请求主机 domain-match 且**至少含一个点**（不内置公共后缀列表，已知限制）；请求主机是 IP 时要求 Domain
  完全相同（IPv6 也走这一支）。`createMemoryJar(initial, now)` 是每一跳共用的 jar，`changes()` 按值指纹求差集。
- `/send`：发送前 purgeExpired + listFor 装 jar，执行完回写差量；读写都在**不带 change 参数**的事务里。
  `options.cookies === false` 时两头都不做。用户在请求头手写了 `Cookie` 就以他为准（整个请求所有跳都不再
  从 jar 补），但 Set-Cookie 照样写回。
- **历史打码**只改历史那份副本：请求头 Cookie / Authorization / Proxy-Authorization → `***`；apikey 的头名
  由 `auth.key` 动态加进名单；响应头 Set-Cookie 用 `cookies.maskSetCookie` 保留名字与属性；apikey 在 query 时
  用 `urlUtils.encodeQueryPart` 拼出与执行器完全相同的那一段来定位，**不整体重拼 URL**。第二参必须是
  **继承解析 + 变量替换之后**的 auth，否则 `{{apiKey}}` 认不出来。
- **历史里的原始请求 `request.spec` 按查看者打码**（库里存原文，发起人重放要用）：`entry.userId !==
  req.user.id` 时才对副本打（**admin 也打**，`userId` 为 null 也打），函数在 `lib/redact.js` 的
  `redactRequestSpec`。响应体不做处理。
- **代理**：设置存 `meta.proxy`，库里没有时从 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` 现算但**不写库**；
  只接受 `http://` 形式；密码出接口一律 `***`，提交 `***` 表示不变 —— 但**只有协议、主机、端口、用户名
  都没变时才允许沿用**（否则就是把旧密码发给新代理）。执行器里 http 目标直转、https 目标走 CONNECT 隧道，
  代理相关错误一律 `PROXY`；`ExecResult.proxy` 记第一跳用的代理（已打码）。
  **隧道请求不能传 `agent: false`** —— 那样 Node 会另造一次性 Agent，`createConnection` 不生效。
- `DELETE /cookies/:id` 走 `byParam('cookie')`；「不是我的」与「不存在」必须是同一个 404「Cookie不存在」。

## Mock 调用日志（契约第 11 节）
- **只存内存**（`lib/mock-log.js`，`Map<projectId, item[]>`），每项目 200 条，重启清空；`seq` 是**进程内
  全局**计数器，前端用 `after=lastSeq` 增量拉。删项目时 `mockLog.forget(pid)`。
- 记录点只有两处：`mock-runtime` 的 `createHandler`、`mock-host` 的 `dispatch`（`/mock/<slug>` 下 runtime
  调 `next` 的未命中请求）。**根路径下没命中的不记**，**自动生成的 CORS 预检 204 也不记**。
- 计时与状态码都在 `res.on('finish')` 里取（`durationMs` 要包含 delay）。`url` 取 `originalUrl`，
  快照必须在 mock-host 改写 `req.url` 之前拍。凭据头打码，请求体与响应体各只留 4096 个字符。
- **`preview()` 截完必须过一遍 `Buffer.from(cut,'utf8').toString('utf8')`**：`slice` 出来的是 V8
  SlicedString，仍引用原串，4KB 预览会把整段 5MB 响应钉在内存里（实测 40 条涨 200MB → 修后净增 0.2MB）。
  **别用 `Buffer.toString()` 造的字符串验证这个问题** —— 那是外部字符串，slice 时本来就复制。
  量法见 skill `v8-slice-memory-check`。
- `list` 的 `lastSeq` 必须是**本次真的返回出去的最后一条**，不是缓冲末尾 —— 否则 limit 截断时中间那批
  会被前端永久跳过。

## HAR 导入（契约第 13 节）
- **模块分工**：`lib/har.js` 只做「HAR → collection」（产出结构与 `postman.parse` 一模一样）；
  `lib/api/import-collection.js` 是 Postman 与 HAR **共用**的写库入口；`lib/api/har.js` 只是两个路由。
  写库、事务、mock 设置、权限全部复用 `tree.writeTree`。
- **请求体上限分层**：全局 4MB 解析器**对 `/import/har` 前缀直接跳过**，50MB 的解析器挂在
  `auth.requireLogin` **之后**。顺序不能反 —— 之前把 50MB 挂在全局 4MB 之前，而那个位置在 requireLogin
  之前，于是没登录的人也能让服务端缓冲并解析 38MB（实测 RSS +69~86MB；修完 +4~5MB）。
  常量是 `HAR_PATH_PREFIX`，两处引用同一个。
- **凭据默认不保留**：`options.keepCredentials !== true` 时去掉请求头的 Cookie / Authorization /
  Proxy-Authorization 和示例响应头的 Set-Cookie，每处计一次数。**头名一律小写比**（HTTP/2 的 HAR 里就是
  `cookie`）。
- **`lib/postman.js` 只补了两个导出**（`guessResponseType`、`toRow`），实现没动。
- **合并键是「方法 + origin + pathname」**（origin 含协议），所以同主机的 http / https 会分成两个接口，
  却落在同一个主机目录、推同一个 mockPath —— 谁生效看 position。
- **`postData.params` 里可能有 null / 字符串**，`toBody` 必须先过滤掉非对象的项：一个 null 就能让
  `toFormRow` 抛异常、整次导入失败。
- **前端不要把文件内容绑到 ref 上**：ImportDialog 的 Postman / HAR 两个页签都把文件文本放在普通变量里，
  选中文件后整个隐藏 textarea。几十 MB 文本进 DOM + naive-ui 的 autosize 复制一份量高度，界面会卡死。
- `stats.hosts` 是**保留下来的**主机数（= 实际建出来的主机目录数），不是 HAR 里出现过的。
- **50MB 是请求体上限，不是文件上限。** HAR 里的引号在 JSON 里都要转义（实测 ×1.24），所以文件到 40MB
  左右就会被「request entity too large」挡下，而前端的上限校验用的是文件字节数。

## 流式发送与 WebSocket（契约第 14、15 节，P7b / `e3a864a` + `03540e8`）

- **`/send` 与 `/send/stream` 共用 `prepareSend` / `finishSend`**（`lib/api/send.js`），
  差别只有响应形状。`createShared(ctx)` 导出 `inheritAuth` / `readCookies` / `createCookieJar` /
  `writeCookies`，**WebSocket 就是复用这一份** —— 鉴权继承与 Cookie 的作用范围不能各写一份。
- **执行器的流式钩子**：`onHead(head)` / `onChunk(buffer)` / `stream: true`（head 到达即清掉总超时）。
  **只在最后一跳触发** —— `readResponse` 只被最后一跳调到（要跟随的重定向在 `onResponse` 里就
  `res.resume()` 走掉了）。回调抛错一律吞掉，「永远 resolve」对钩子也成立。
  `buildAuth` / `isTextContentType` 已导出：前者给 WebSocket 用，后者保证 `chunk` 按文本还是
  base64 发与 `result.response.bodyEncoding` 是同一个判断。
- **NDJSON**（`lib/api/ndjson.js`）：三个响应头里 `X-Accel-Buffering: no` 不能少（否则 Nginx 会把
  整段响应缓冲住），`start` 之后必须 `flushHeaders()`；`write` 在连接断开时返回 false、不抛异常。
  **校验必须在 `start` 之前做完** —— 一旦写出字节，错误就只能用事件表达。
- **Node 自带的 WebSocket 第二个参数给 `{ headers, protocols }`** 才带得动自定义请求头
  （`new WebSocket(url, { headers })` 实测有效，`(url, [], {headers})` 三参写法无效）。
- **握手失败时 Node 的 WebSocket 只触发 `error`，不再触发 `close`**，`readyState` 一直停在
  CONNECTING（实测等 8 秒也没有）。只依赖 close 的话前端收不到「结束了」的信号、会话永远不回收。
  所以 `lib/ws-sessions.js` 在 `error` 且仍 `connecting` 时自己补一条 1006 的 close，
  并用 `status === 'closed'` 做幂等标记。**已建立的连接不受影响**（服务端拔线 → 正常来 1006）。
- `registry.create` 的 `headers` 形状是 **`[[k, v]]`**（和执行器一致），不是 `{key, value}` 行对象。
- **`createAdmin` 是自己拼 `ctx` 的**：往 ctx 里加字段（如测试用的 `wsSessionOptions`）必须同时改
  `lib/admin.js`，只在 `lib/api/ws.js` 里读 ctx 是拿不到的。
- `/ws/:id/*` 三个路由**不挂 guard**：先 `registry.get(id, req.user.id)`（不是本人的、admin 的
  都返回 null），再 `access.roleOf` 确认创建者仍是项目成员，任何一步不满足都是同一个 404。
- **已知缺口**：契约第 14 节说「取消时历史里带着已经收到的响应体」，但执行器只在响应**收完**时
  才组装 `response`，abort 时 `response` 是 null。按审阅重点第 1 条（`/send` 的历史保持原样）
  没有改；README 的已知限制里写明了。要改得在 `readResponse` 里维护已收到的 chunks，并在
  `abortWith` 里组装部分 response。
- **流式转发必须有背压**（M1，`9d0c11a`）：`onHead(head, controls)` 的第二个参数是
  `{ pause(), resume() }`，作用在 `readResponse` 里**解压之后**的 `source` 上（所以建 source
  的代码在调 onHead 之前）。`/send/stream` 在 `res.write` 返回 false 时 pause、
  `res.once('drain')` 再 resume。**只 pause 一次**（`waitingForDrain` 标记）—— 暂停期间还有
  在途 chunk，重复 pause/resume 会让 drain 的配对错位。没有背压时实测 300MB 场景 RSS
  涨 328.5MB，有了之后只涨 2.6MB。**只要往流式接口里加「全部转发」的东西，就要同时想背压。**

## 变量与鉴权继承（契约第 5 节第 1、2 步）

- **变量优先级：项目 < 外层目录 < 内层目录 < 环境**（2026-09-30 修订，原来漏掉了目录）。
  拼接顺序是「项目 → 目录链（从外到内）→ 环境」，**后面的覆盖前面同名的**。
  目录变量曾经完全不参与替换，导致「导入到当前项目」时集合变量（存在顶层目录上）全部丢失。
- **目录链统一由 `lib/api/send.js` 的 `shared.folderChain(project, apiId)` 提供，
  它只维护一种顺序：「从最外层到最内层」**。两处用法方向相反 ——
  鉴权是「最近的一级优先」（倒着遍历），变量是「后者覆盖前者」（正着拼）。
  **不要在调用处各记一套顺序**，写反了在界面上根本看不出来。
- 三处共用 `shared.resolveVariables(project, apiId, environment)`：
  `/send`、`/send/stream`（同一个 `prepareSend`）、以及 `lib/api/ws.js`（传 `apiId = null`，
  目录链天然为空）。
- 接口不属于本项目时目录链直接为空（`folderChain` 里判 `api.projectId !== project.id`）——
  少了这一句就会顺着别人的目录树往上找。

## 发布与工程约定
- `files` 是 `["bin","lib","sample","README.md","docs/api.md"]` —— **`docs/api.md` 是唯一的单文件条目**
  （README 的链接因此不是死链），其余设计文档 / 计划 / 测试不进包。
- **量包内文件数要在干净副本里**：`git archive <commit> | tar -x -C <tmp>`，再 `npm pack --dry-run`。
  工作区里并行会话的未提交文件会被 `files` 一起打进去；**绝对不要用 `git stash`**（会把别人的改动收走）。
  参考基线：`470b84a`（C 阶段收尾）= 64 个文件 / 665.7 kB。
- **提交只用带路径的方式**：`git commit -m "…" -- <具体文件>`。**禁止 `git add -A` / `git add .` /
  `commit -a` / `git stash`** —— 这个工作区同时有另一个会话在改文件（P7b 期间：A 部分改 `lib/**`，
  B 部分改 `web/**` + `lib/web/**`），全量暂存会把别人没提交的改动裹进自己的提交（`33f9223` 这么干过一次）。
  提交后养成核对 `git show --name-only HEAD` 的习惯。
- `.workbuddy/`（记忆文件）**留在版本控制里**，用户已确认可以提交。
- **用户自己改前端源码时可能只提交 `web/`，把产物留给前端会话的下一次构建**（`9208daf`
  的提交信息里就写明了）。所以看到某个提交里源码和 `lib/web` 不同步，先看后面有没有
  紧跟着的构建提交，别急着补一个 —— 补出来的产物会和别人正在构建的互相覆盖。
- `lib/mock-runtime.js` 的 `applyCors` 会带 `Access-Control-Expose-Headers: X-Apiloop-Mock`。

## 前端：流式发送与 WebSocket（P7b 的 B 部分，契约第 14、15 节）

- **发送一律走 `POST /send/stream`**（`web/src/api/stream.js` 读 NDJSON）。
  `POST /send` 服务端保留，但管理台不再用 —— 只有流式那条路能一边下一边显示、
  并且随时可以取消。`api/send.js` 里原来的 `send()` 因此删掉了。
- 两个必须自己处理的切分：NDJSON 的一行可能被切在两次 `read()` 之间（自己按行缓冲）、
  多字节字符也可能被切在两次 `read()` 之间（`TextDecoder` 的 `{ stream: true }`）。
  失败时抛出的错误必须和 `api/client.js` 一致（`toError` 是 export 的），
  否则上层处理 403 / 404 的代码要改两遍。
- **`/send/stream` 这条流自己的 content-type 是 `application/x-ndjson`，不是 SSE。**
  判断「上游返回的是不是 SSE」要看 `head` 事件里**上游**的 content-type。
- **标签页里的组件是按 `activeKey` 加 key 的，切一次标签页就卸载重建**
  （`WorkbenchView.vue`）。所以每个标签页的运行时状态（在飞的请求、长连接、日志、
  定时器）**必须放 Pinia store**（`stores/ws.js` 就是为此存在的），
  而且「组件卸载就 abort」会把切标签页当成关标签页 —— abort 要写在
  `tabs.close()` / `tabs.closeAll()` 里（切项目走 `closeAll`）。
- WebSocket 会话的 `status`（上游 socket）和 `channel`（events 长连接）**分开**：
  上游关了 socket 是 closed 但事件流还活着（还能收 close 事件）；事件流断了要重连，
  也不代表 socket 断了。重连后服务端只补发 `seq > after` 的事件，**不会再发一次
  `open` 事件**，所以 `getNdjson` 有 `onOpen` 回调用来收回「重连中」。
- WebSocket 标签页 `kind: 'ws'` **不进目录树**、不记历史、不做 mock；最近地址按项目
  存 `localStorage.apiloop.ws.<pid>`。
- **`lib/web/__apiloop` 的体积基线**（`gzip -c` 口径，1 KB = 1000 B，2026-09-30 P7b 之后）：
  JS **489.6 KB** / CSS **5.23 KB**，P7b 两个 Task（含两个小修）+5.9 KB、F2 +1.6 KB。
  列表一律手写，不用 `n-data-table`（和 `n-date-picker` 一个道理）。

## 前端：目录设置与鉴权继承（F2，契约第 3、5 节）

- 标签页有四种 `kind`：`api` / `draft` / `history` / `ws` / `folder`。
  **`ws` 和 `folder` 不进目录树**，但 `folder` 有 `folderId`，`openFolder` 的 key 带目录 id
  → 同一目录只开一个。新增一种 kind 的清单见 skill `apiloop-web-console` 第 7 条。
- **可编辑的内容放 `tab.spec`**，dirty 标记 / 关闭标签页的二次确认 / 切换项目时的提醒
  都是拿 `spec` 和 `savedSnapshot` 比出来的，不用另写。
- **`utils/auth.js` 是鉴权继承的唯一实现**（`inheritHint()`）：按契约第 5 节第 2 步沿
  「目录链由内向外 → 项目」找第一个真正配置过的 auth（`noauth` 也算配过）。
  `AuthEditor` 的 `inheritHint` 属性负责显示。**接口标签页和目录设置都要传**，
  别让某一处退回「沿用上一级的鉴权设置」那句没信息量的话。
- **`utils/tree.js` 的 `folderChain(folders, id)` 返回从内到外的目录链**，鉴权继承按这个
  顺序找，目录变量要反过来拼（项目 < 外层目录 < 内层目录 < 环境）。两处共用，别各写一遍。
- 目录右键菜单：写角色看到全部项，**viewer 只看到「目录设置」**（打开后只读）；
  接口节点对 viewer 仍然不弹菜单。
- 目录树开了 `expand-on-click`（点整行展开）。naive-ui 的 `_handleClick` 里
  **选中和展开是同一处一起做的**，所以「点目录顺手把导入落点记下来」不受影响；
  它只绑 `onClick`，**右键不会连带折叠**；空目录 `isLeaf` 为真，点了不切换也不报错。
