# apiloop 项目长期笔记（原 server-mock）

> 契约/设计稿在 `docs/design/`，计划与审阅在 `docs/`。**细节以契约和代码注释为准，这里只留最容易踩的。**
> **上限 16KB（超了注入时尾部会被丢）—— 新规则往上放，稳定细节留最下。**

## 基本盘

- 产品名 **apiloop**，常量全派生自 `lib/app-info.js`（`~/.apiloop`、`APILOOP_HOME`、`data.db`、
  `apiloop_sid`、`APILOOP_DB`、`APILOOP_ADMIN_PASSWORD`）；别处不许硬编码产品名。
- `bin/server`（yargs）：start/open/web/init/user/gateway；`engines: node >=22.13.0`（`node:sqlite`）。
  前端 `web/`（Vue3+Vite）→ `lib/web/`，**产物入库**。分工：session1 后端（`lib/**`、`bin/`、README、
  `docs/api.md`、打包脚本），session2 前端（`web/**`）。当前**第九轮**（YApi/Apifox 导入、导出文档、
  数据库操作、Socket.IO），迁移 **v11**。
- **Mac 壳子** = `agent-installer/mac/shell/main.swift`（AppKit + WKWebView，图标 `shell/make-icon.swift`）。
  **「编辑」菜单不能删**（⌘C/⌘V 靠它）、**不许占用 ⌘S/⌘K/⌘\/⌘Enter**；关窗口/⌘Q/⌘R 前问
  `window.apiloopShell.hasUnsavedChanges()`，问不到当「没有」。打包/x86_64 链接坑见 skill `macos-pkg-official-node`。

## 数据库操作 / Socket.IO（第九轮，session1）

- **数据库操作**：连接在 `projects.extra.databases`、操作在 `apis.extra.dbOps`（`lib/db-ops.js` 是唯一清洗）。
  顺序是**请求前库操作 → 请求前脚本 → 发请求 → 响应后库操作 → 断言/提取 → 响应后脚本**（响应后排在断言
  前，断言才能用 `{{dbCode}}`）；请求前失败就**不发请求**。`prepared.dbAllowed = ctx.localSend`，云端整节
  跳过只提示一句（**跳过也要置 `scriptsRan`**，否则提示到不了前端）。
  `POST /projects/:pid/databases/test` **只在本机网关上挂**。连接字段可写 `{{变量}}`，**端口也认** ——
  DTO 清洗（`toDatabase`）里别把带 `{{}}` 的端口转成数字，否则会被静默换成默认端口；未替换的检查要带上
  端口。导出的连接**密码一律清空**（`x-apiloop-databases`）。真实驱动都是**用到时才 require**。
- **Socket.IO**：方法 `SIO`（`METHODS` 里有），接口进目录树，打开是 Socket.IO 标签页（kind `'sio'`）。
  会话在 `lib/sio-sessions.js`（`socket.io-client`，用到时才 require；`reconnection: false`，重连是手动的），
  接口层 `lib/api/sio.js`（`/projects/:pid/sio[/prepare]`、`/sio/:id/{events,send,}`）。配置住 `apis.extra.sio`。
  **`/send`、mock、OpenAPI / 集合导出、批量运行、测试集全都不认 SIO**；前端**每一处判断 `'ws'` 的地方都
  要带上 `'sio'`**（`grep "'WS'"` 能找全；`MockPanel` 不用改 —— SIO 接口在 SioTab 里打开，它看不到）。

## 前置接口（第十轮第 3 节，住 `extra.preflight`）

- 设置：`projects.extra.preflight` / `folders.extra.preflight` = `{ apiId, whenMissing, retryOn401 }`；
  **`apiId: null` 是「这一层不用」（挡住往上找），整份 `null` 才是「没配过」** —— 两者别合并
  （清洗只有 `dto.toPreflight` 一份）。`apis.extra.noPreflight` 是接口自己的「不使用」。
- 执行在 `lib/api/send.js` 的 `prepare`：**递归准备一整份 prepared**（`prepared.preflight` +
  `prepared.preflightRule`），`lib/send-core.js` 的 `runPreflightOnce` 递归调 `run` 跑它。
  `skipPreflight` 是内部 extra 开关（不是请求体），前置接口自己不再触发前置接口。
- **变量改动要并进 `state.variables` + `scopes`**（否则 token 写不回库、测试集每步都登录）；
  **Cookie 要并进主请求那份 jar**，且只能走 `jar.storeFrom`（把 cookie 倒回 `Set-Cookie` 头）——
  直接改 jar 内部会绕过 `initialByKey`，`changes()` 里永远没有它。
- **401 两条路**：非流式在 `send-core` 里重发；流式由前端带 `options.forcePreflight` 再发一次
  （`/send/stream` 的 `end` 事件带 `preflight` 规则）。判断在 `web/src/utils/preflight.js`
  的 `shouldRetry401`。跑前置接口前把 `scopes.data`/`transient` 复制给 `preflight.scopes`（测试集数据行）。
- 复制项目 / 跨项目复制：`apiId` 换成新项目里的，**没复制过去的整块去掉**（`lib/api/copy.js`）。
  `/send/curl` 与 GraphQL 内省显式 `skipPreflight`（它们不发请求）。

## gRPC 调试（第十一轮第 1 节，住 `extra.grpc`）

- 方法 `GRPC`（在 METHODS 里）；`api.url` = `host:port`，`grpcs://` 开 TLS、`grpc://` 不开
  （地址写了协议头就以它为准，覆盖请求体 `tls`）。清洗只有一份：`dto.toApiGrpc`。
- **解析走 protobufjs、调用走 proto-loader**（`lib/grpc.js` 里**函数内** require）。proto 内容写进
  `mkdtemp` 临时目录读完删。protobufjs 报错带 `(路径, line N)` → 翻成「user.proto 第 5 行：…」；
  `google/protobuf/*` 由 protobufjs **内置 common 定义**兜住（node_modules 里没有 timestamp.proto）。
- 两条路由只在本机网关（`localSend` 假 → 空 router → 云端 404）：`/projects/:pid/grpc/parse`、
  `/projects/:pid/grpc/call`（NDJSON：start/metadata/message/end/error）。
- **一元调用的回调一定早于 `status` 事件**（callback 就在 emit('status') 上一行）→ message 必在 end 前。
  取消靠 `res.on('close')` → `call.cancel()`。
- 示例取值：字符串/bytes `""`、bool `false`、32 位整数 `0`、**64 位整数 `"0"`**（longs: String）、
  枚举第一个值、repeated 一项、map 一个键、循环引用按**当前路径**判（A→B→A 停，两个 B 各展开一次）。
- **`/send` 判定顺序**：`request.method` 白名单原本在「按接口自己的方法拦」之前，而界面打开非 HTTP
  接口时 `request.method` 就是 `GRPC`/`SIO`/`WS` → 只看到「不支持的请求方法：X」。已把接口方法那段
  挪到白名单前面。`SEND_METHODS` 在 `lib/send-core.js`，没动。
- 各处：`mock-runtime` 不注册 HTTP 路由；OpenAPI / 集合导出跳过并说明；**测试集两处显式拒绝**
  （建/改 400 + 运行报告里写清），比 SIO 现状更严；导出文档写地址/服务/方法/请求消息示例；
  复制/回收站带整份 `extra`，不用改。压测（`load-runner` 直接调 executor）**不认** GRPC，也没认 SIO。

## 提交纪律

- **只用带路径的提交**：`git commit -m … -- <文件>`，长信息写 `/tmp/msg.txt` 再 `-F`（双引号里的反引号
  会被 zsh 吃掉）。**禁止 `add -A`/`add .`/`commit -a`/`git stash`** —— 多会话共用工作区。**路径限定只
  保证「文件对」**：共享文件（`lib/command.js`、`lib/admin.js`、`README.md`）提交前 `git diff -- <路径>`
  核对，提交后 `git show --name-only HEAD`。
- **只 commit 不 push**；每做完一个可独立成立的小改动就提交一次，信息写「为什么改」。界面验证交给用户。
- **不写新测试**：一次性脚本放 `/tmp` 跑完删；`npm test` 基线 **71**（开工前先跑）。测试不能碰真实
  `~/.apiloop`（`--db` + `APILOOP_ADMIN_PASSWORD`；网关用 `APILOOP_HOME`）。覆盖很薄（`/send`、
  `/send/stream`、`/ws/*` 零用例），「全绿」证明不了接口行为没变 —— 用 skill `verify-behavior-unchanged`。
- **`git commit -- <路径>` 提交不了没 `git add` 过的新文件**（先 `git add`，再照样 `-F msg -- <路径>`）。
  共用文件里**混着另一个会话的改动时别提交**（对方新文件可能没进 git，那一版会 import 不存在的文件）。
- **`node:sqlite` 的 StatementSync 方法要绑在语句对象上**：`stmt.run.apply(stmt, values)`
  （`apply(null, …)` 报 `Illegal invocation`）。

## 接口层/数据层/权限（契约 3/4/10）

- 管理台 v2 = `lib/api/*`，导出 `createRouter(ctx)`（`ctx = { handle, rootProjectId }`），挂在 `admin.js`
  的 `requireLogin` **之后**（自己不做鉴权）；返回 `{ ok: true, … }` / `{ ok: false, error: '中文' }`。
- 保留前缀 `/__admin` 有两份字面量（`routes-store`、`mock-runtime` 各一份），**必须一致、别互相 require
  成环**；网关前缀 `/__apiloop`。**比较前一律 `toLowerCase()`**；判定 =「整段相等」或「前缀 + `/`」，
  `/__administrator` 不误伤。
- **mock 路径会流进 `setTimeout` 回调 —— 没有 Express 兜底，抛出去就是进程崩溃**：`buildRouter` 逐条
  try/catch，写入先经 `validateRoutePath`。示例 `status` 必须 100~599 整数；**`enabled = mockEnabled &&
  有示例`**。`/` 必须由 `command.js` 显式 302 到 `/index.html` 且注册在 mock 路由**之前**；挂根路径的
  静态资源必须 `index: false`。**被 mock 的接口永不鉴权。**
- **change 口径**：改动哪个项目传 `{ projectId }`；影响多项目传 `null`；不影响 mock 的（写历史、cookie）不
  传。**不支持嵌套事务**；`lib/tree.js` 不开事务，校验失败用 `respond.apiError`。内存 `routes` 只是读缓存，
  **库是唯一真相**；**中途补数据必须包 `handle.transaction(fn, { projectId })`**，否则静默失效（新接口一律
  404）。**迁移只追加**，列清单在 `migrations.js` 里写死（v7 同步列清单也硬编码在那儿）。
- `folders.parent_id` CASCADE、`apis.folder_id` SET NULL —— **递归删目录必须先删子孙目录里的接口**。
  **position 只在同一父目录内有意义**；`setPositions`/`nextPosition` 是**项目级**的。上传文件在
  `DATA_DIR/files/<pid>/`。**发送时变量优先级**：**项目 < 外层目录 < 内层目录 < 环境**
  （顺序由 `send.js` 的 `shared.folderChain` 给）。
- **登录**：只有 `/auth/login` 公开；scrypt 加盐、会话只存 token 的 sha256、cookie `HttpOnly; SameSite=Lax`；
  连续 5 次失败锁用户名 60 秒。自助注册默认 `pending = 1`（v8），密码对了也 403；自助注册的人**不能**禁用/
  删除/降级/重置自己。
- **不是成员 与 对象不存在 一律 404**（同一句话）；是成员但角色不够才 403。`viewer < editor < owner`；
  **admin 不在成员表里**，对任何项目返回 `'admin'`。判定 `lib/access.js`，拦截 `guard.js` 的
  `guard(level, locate)`（`byPid` 收 id/slug，`byParam(kind)` 收 `:id`）；通过后 handler 用 `req.project`。
  **按 id 定位资源的路由必须用 `byParam(kind)`**（示例、期望先经所属 api 绕一次），漏了就是越权口子。
  **例外**：目标项目从请求体里读、不走 guard 的路由用 400 —— 「项目查不到」与「不是成员」合并成同一句
  `项目不存在：<id>`（JSON/HAR 的 `into`、同步 push），否则扫 projectId 能试出哪个项目存在。建项目入口都要
  `addOwner`；`countOwners(h, pid, {excludeUserId})` 是「至少留一个 owner」的判据。
- **`session.json`**（`{ cookie, user, signedInAt }`，0600）是云端会话的唯一落点，**永不交给浏览器**；退出
  登录=删它；改密码成功后把云端发的新会话写回去（`manager.updateCloudCookie`）。

## 本地网关（G0 起）

- `gateway.json` = **`{ cloudUrl?, currentSpace }`**。云端地址三级：`--cloud` > `gateway.json` > 安装包内
  `<安装目录>/app/cloud.json`（`build.sh` 没有 `APILOOP_CLOUD_URL` 就拒绝打包）。**`--cloud` 不写回**。
- **空间**：`<数据目录>/spaces/<主机>~<端口>~<账号ID>/`，未绑定的是 `spaces/local`；键由
  `spaceKey(cloudUrl, userId)` 拼；**账号 ID 就是目录名最后一段**（`userIdFromKey`）。
- **三种状态由「`session.json` 在不在」决定**：`unbound`／`signedIn`／`signedOut`。未绑定是固定用户
  `u_local`（`password_hash` 空串、admin、所有本机项目 owner、空库自动建「我的项目」）；账号空间是镜像来的
  云端账号（`ensureUser`，没有密码）。**别调 `auth.bootstrapAdmin`。**
- **一个空间只打开一次**（`space.js` 的 cache）。切换空间**先关库再动文件**（`data.db`+`-wal`+`-shm`
  跟着走）；改名/并库失败一定退回未绑定空间，否则 `current` 变 null、之后每个请求都拿不到库。
- **`signIn` 三条分支**：已是对的空间→只写会话；未绑定→**改名**（本机没空间）或**并库**（已有空间，
  `ATTACH`+一个事务，成员表只留 U 一行 owner）；别的账号→切过去并**删掉上一个账号目录的 `session.json`**。
  **并库必须逐行 `uniqueSlug`**（两个空间各自会建「我的项目」，撞 UNIQUE → 登录 502）。
- **mock 地址是 `/mock-<项目ID>/`**（不再用 slug；**Mock 只在云端**）。只监听 127.0.0.1，端口 47321 起试到
  47329，实际端口写 `<dataDir>/gateway.port`。
- **路由顺序本身就是设计（L3 重排）**：安全闸门 → `/__apiloop/status` → `/__apiloop/space/delete` →
  `/auth/login`、`/auth/logout`、4.5「只有云端有的功能」 → **打开即进入 + 当前空间的本机管理台
  （`current.admin.api`）** → 静态页 + `/` 302。**L3 起没有「转发数据接口」**，连云端的只剩登录、4.5、同步。
  **打开即进入** = 管理台前的中间件先 `createSessionMiddleware`，认不出来就用当前空间的用户发一个会话。
- 4.5 清单写在 `account.cloudOnlyPath`（别凭印象放宽）；已登录就转发（401 → `markExpired()`），未登录 409
  `{ code: 'LOGIN_REQUIRED' }`。**转给云端的请求头只有一处**：`lib/gateway/cloud.js` 的 `headersForCloud`。
- **安全闸门（设计稿 3.1）**：Host 必须是 `127.0.0.1:<端口>`/`localhost:<端口>`；`Sec-Fetch-Site: cross-site`
  403；`Origin` 必须是网关自己的地址；**`/__admin/api/*` 与 `/__apiloop/*` 的非 GET 都要 `X-Apiloop: 1`（GET
  也要）**；**OPTIONS 一律 403，不设任何 `Access-Control-Allow-*`**；403 体是 `{ error }`。
- **本机发送/WebSocket 调试走当前空间的本机管理台**。`admin.js` 传 `localSend: true` 表示「在用户自己那台
  机器上」，**`send-core.applyLocalNetworkHint` 只在它为真时套用**（依据是**错误里实际连出去的地址**，不是 URL
  里写的）。**`APILOOP_SERVER_SEND=0`** 关掉 `/send`、`/send/stream`、建 WS 会话（409 +
  `SERVER_SEND_DISABLED`）。

## 同步（云端 `lib/sync/` + 网关 `lib/gateway/sync/`）

- **细节在 `.workbuddy/memory/notes-sync.md`**（rev/changes 触发器、快照与游标对齐、SAVEPOINT、
  三方合并、410 全量重下、冲突接口），改同步之前读一遍。三条最容易踩的：
  **`rev` 必须单独写一条 `SET rev = ?`**（混进同一条 UPDATE 会让本机永远比云端多 1）；
  **首次同步的游标要写云端给的 `state.seq`、不能写 0**（否则每轮 410 → 整库重下，停不下来）；
  **推送的基线用「这一批推上去的那一行」、不能重新读本机**（否则同事改同一列会被直接覆盖）。
## 断言与提取变量 / 响应字段说明（第六轮，住 `apis.extra`）

- 可视化断言 `extra.assertions`、提取变量 `extra.extracts`、响应字段说明 `extra.responseFields`：
  **清洗规则只有一份**（`lib/assertions.js` / `dto.js`），DTO 读、保存写、执行时三处都调它。
  发送时**请求体带了就用请求体的**。
- **执行位置**：`send-core.js` 里「拿到响应之后、跑『响应后』脚本之前」（反了脚本读不到刚提取的变量）。
  **这一节跑了就必须置 `scriptsRan = true`**，否则 `changes.scriptState` 是 null，提取的变量写不进库、前端也
  看不到结果（静默失效，最容易漏）。断言进 `state.tests`（`source: '断言'`），提取的变量进
  `state.variables.*.set`（保密变量照旧走 `secrets.applyChange`）**并同步进 `scopes` 和 `vars`**。
- **「取不到值」≠「值为空」**：取不到算「不存在」（只有 `不存在` 通过）；`为空` 是「存在但为空」。
  `eq/ne` **只在实际值是数字时**按数字比。响应体 > 5MB 不解析 JSON，二进制响应说「不是文本」。
