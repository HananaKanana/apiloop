# 管理台 API 参考

apiloop 的管理台前端用的就是这些接口，也可以直接调。**除登录接口外都需要先登录**，
请求要带上登录返回的 cookie。路径都省略前缀 `/__admin/api`，统一返回
`{ ok: true, ... }` 或 `{ ok: false, error: "..." }`。

下面的表只列路径与一句话说明，字段细节以代码为准（`lib/api/*.js` 每个文件开头有说明）。

## 登录与用户

| 方法与路径 | 说明 |
| --- | --- |
| `POST /auth/register` | 自助注册，body `{username, password, displayName?}`。建一个**待审核**的普通成员，不登录；同一 IP 每小时最多 30 个。**公开** |
| `POST /auth/login` | 登录，body `{username, password}`，成功种 cookie。还没审核通过的账号（密码正确时）返回 403「账号还在等管理员审核」。**公开** |
| `POST /auth/logout` | 退出 |
| `GET /auth/me` | 当前登录用户 |
| `PUT /auth/password` | 改密码，body `{oldPassword, newPassword}` |
| `GET /users` | 用户列表，每个用户带 `pending`（待审核）。仅管理员 |
| `GET /users/pending-count` | 待审核的人数 `{ count }`。仅管理员 |
| `GET /users/lookup?q=` | 搜人（按用户名或显示名模糊匹配，最多 20 条，不含被禁用和待审核的）。登录即可，加项目成员时用 |
| `POST /users` | 新建用户；没传密码会随机生成并在响应里返回一次。仅管理员 |
| `PUT /users/:id` | 改显示名 / 角色 / 禁用；`{ approve: true }` 审核通过。不能对自己禁用、降级。仅管理员 |
| `POST /users/:id/reset-password` | 重置密码并返回一次。仅管理员 |
| `DELETE /users/:id` | 删除用户（拒绝注册申请也是它）。不能删自己。仅管理员 |

## 项目（契约第 2 节）

| 方法与路径 | 说明 |
| --- | --- |
| `GET /projects` | 项目列表；只返回自己参与的项目（admin 返回全部） |
| `POST /projects` | 新建项目；任何登录用户都可以，创建者自动成为 owner |
| `GET /projects/:pid` | 项目详情，`:pid` 可以是 id 或 slug |
| `PUT /projects/:pid` | 改描述 / 变量 / 鉴权 / 脚本 / `mockVariables` 要 editor；改名字 / 标识要 owner。标识被占用会报错，不自动改名 |
| `DELETE /projects/:pid` | 删除项目。owner；根项目与默认项目不能删 |
| `GET /projects/:pid/members` | 成员列表。viewer |
| `PUT /projects/:pid/members/:userId` | 加成员或改角色。owner；不是成员就加进来 |
| `DELETE /projects/:pid/members/:userId` | 移除成员。owner，或者自己退出 |

## 目录树、接口与示例（契约第 3 节）

| 方法与路径 | 说明 |
| --- | --- |
| `GET /projects/:pid/tree` | 整棵树，返回扁平的目录与接口列表，前端自己组装 |
| `POST /projects/:pid/folders` | 新建目录，同一父目录下不允许重名 |
| `PUT /folders/:id` | 改名字 / 描述 / 鉴权 / 变量 / 脚本 |
| `DELETE /folders/:id?apis=move\|delete` | 删目录。`move`（默认）把内容移到父目录，`delete` 递归删 |
| `POST /projects/:pid/move` | 移动目录或接口到指定位置，并重排 position；移进自己的子孙会被拒 |
| `GET /apis/:id` | 接口详情（含请求定义、mock 配置、全部示例） |
| `POST /projects/:pid/apis` | 新建接口。`method` 可以是 `WS`（WebSocket 接口，契约第 17 节） |
| `PUT /apis/:id` | 更新接口（含 `scripts`）；改 url 时 `mock.path` 的跟随规则、开启 mock 的前提见契约 |
| `DELETE /apis/:id` | 删除接口 |
| `POST /apis/:id/duplicate` | 复制接口（示例整份复制，名字加「 副本」） |
| `POST /apis/:id/examples` | 新增示例；这是第一个示例时会自动成为 mock 用的那条。`responseType` 为 `sse` / `ws` 时按契约第 17 节校验 `body`，不合法返回 400 |
| `PUT /examples/:id` | 更新示例。只改 `body` 时按库里那个 `responseType` 校验 |
| `DELETE /examples/:id` | 删除示例；删掉 mock 正在用的那条会自动改指或关掉 mock |
| `POST /projects/:pid/import/routes` | 把解析出来的 route 批量落进项目，可指定目录 |

## 环境（契约第 4 节）

| 方法与路径 | 说明 |
| --- | --- |
| `GET /projects/:pid/environments` | 环境列表 |
| `POST /projects/:pid/environments` | 新建环境 |
| `PUT /environments/:id` | 改名字 / 变量 |
| `DELETE /environments/:id` | 删除环境 |

> 「当前选中哪个环境」由前端存在 localStorage，服务端不存。

## 保密变量

项目、目录、环境的变量行带 `secret: true` 时，值**只属于当前用户**：保存时值存进不同步的
`secret_values` 表，共享数据（也就是同步出去、导出、别人读到的）里这一行的值是空串；读的时候
把当前用户自己的值填回去。发送时用自己的值，写历史时这次用到的保密值（≥ 4 个字符）换成 `******`。
脚本写回（`pm.environment.set`）一个保密变量时同样只写自己的值。

保密值在**同一个人的设备之间**同步（只在云端提供，客户端的同步引擎在调，页面不用）：

| 方法与路径 | 说明 |
| --- | --- |
| `GET /secrets?since=<seq>` | 当前用户 `seq > since` 的保密值（含删除记录），按 seq 升序，最多 500 行：`{ items, nextSeq, hasMore }` |
| `POST /secrets` | `{ items: [{ scope, scopeId, key, value, deleted, updatedAt }] }`，最多 500 行，按「updatedAt 大的为准」合并进当前用户的行 |

## 回收站

删除目录、接口、环境时，被删掉的数据整包存进回收站，保留 30 天。回收站会同步，团队成员都能看到和恢复。
删除项目、单独删除示例不进回收站。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /projects/:pid/trash` | 列表（viewer），按删除时间倒序：`{ items: [{ id, kind, name, location, deletedBy, deletedAt, count }] }` |
| `POST /trash/:id/restore` | 恢复（editor）。换新 id 插回原目录，原目录不在了就放根目录；返回 `{ restoredTo, folderId? / apiId? / environmentId? }` |
| `DELETE /trash/:id` | 彻底删除一条（editor） |
| `DELETE /projects/:pid/trash` | 清空（editor），返回 `{ removed }` |

## 发送、历史与文件（契约第 5 节）

| 方法与路径 | 说明 |
| --- | --- |
| `POST /projects/:pid/send` | 代发请求（网页版由云端发，客户端里由本机网关发），返回执行结果并写一条历史（`options.skipHistory: true` 时不写，批量运行默认带上）；浏览器断开时取消在途请求。会执行「请求前 / 响应后」脚本。`apiId` 指向 `WS` 接口时返回 400 |
| `POST /projects/:pid/send/stream` | 同上，但响应是 NDJSON 事件流，见「流式发送与 WebSocket」。「响应后」脚本在 `end` 之前跑完，结果在 `end.result.scripts` 里 |
| `POST /projects/:pid/send/curl` | 把请求转成 cURL 命令（变量按选中的环境解析），返回 `{ curl, missing }`；不发请求 |
| `GET /projects/:pid/history` | 历史列表，`?limit=50&before=<id>` 翻页，`limit` 最大 200 |
| `GET /history/:id` | 历史详情（原始的请求定义 + 完整执行结果）。查看者不是发起人时，`result.scripts` 的 `console` 为空、变量 `set` 的值为 `***` |
| `DELETE /projects/:pid/history` | 清空该项目的历史 |
| `POST /projects/:pid/files` | 上传文件（`application/octet-stream` + `X-Filename`），返回服务端绝对路径 |

## 接口文档分享（只在云端）

| 方法与路径 | 说明 |
| --- | --- |
| `GET /projects/:pid/shares` | 这个项目已生成的分享链接（viewer） |
| `POST /projects/:pid/shares` | 生成链接（editor）。`{ folderId?, expiresInDays? }`，`expiresInDays` 只能是 `7`、`30`（默认）或 `null`（永久） |
| `DELETE /shares/:id` | 撤销（editor） |
| `GET /shares` | 当前用户能看到的所有项目的分享链接（「我的分享」），每条多给 `projectId`、`projectName`、`canRevoke` |
| `GET /public/shares/:id` | **不用登录**。只读文档数据，服务端已脱敏：不含变量值、鉴权的值、脚本、Cookie；敏感请求头、地址里的敏感参数、请求体和示例里敏感字段的值都换成 `******`。过期、撤销、不存在一律 404 |

页面地址是 `<云端地址>/#/share/<id>`。客户端里的管理接口由网关转给云端。

## 接口状态和负责人

接口 DTO 和目录树的接口节点上多 `status`（`designing` / `developing` / `done` / `deprecated`）和 `ownerId`，
存在接口的 `extra` 里、跟着同步。`PUT /apis/:id` 传这两个字段即可修改，传空串清掉。

## OpenAPI 导出与同步更新

| 方法与路径 | 说明 |
| --- | --- |
| `GET /projects/:pid/export/openapi?folderId=&format=yaml\|json` | 导出 OpenAPI 3.0.3，返回 `{ filename, format, text }`（viewer） |
| `POST /projects/:pid/openapi/diff` | `{ url?, text?, folderId? }`，和文档比对，返回 `{ added, changed, removed, source }`，不改数据（editor） |
| `POST /projects/:pid/openapi/apply` | `{ url?, text?, folderId?, add: [key], update: [apiId], remove: [apiId] }`，服务端重新拉取、重新比对后只执行勾选的；删除的进回收站（editor） |

## 公共请求头

项目、目录的 DTO 顶层多 `headers`（行数组，和接口请求头同一个形状），存在 `extra` 里、跟着同步，保存接口传 `headers` 即可。
发送时按「项目 → 外层目录 → 内层目录 → 接口」合并，后面覆盖前面同名的（不区分大小写），停用的行不参与。

## 全局查找替换

| 方法与路径 | 说明 |
| --- | --- |
| `POST /projects/:pid/search` | `{ query, caseSensitive?, wholeWord?, regex?, fields, folderId? }` → `{ matches, total, truncated }`，最多 500 处（viewer）。正则最多跑 3 秒，超时返回 400 |
| `POST /projects/:pid/replace` | 同上的条件 + `{ replacement, targets: [{ apiId, field, location }], skipApiIds }`，服务端重新查找后只替换列出的位置（editor） |

## 接口评论和提醒（只在云端）

| 方法与路径 | 说明 |
| --- | --- |
| `GET /apis/:id/comments` | 评论列表（viewer）。接口还没同步到云端时 404 + `code: 'API_NOT_SYNCED'` |
| `POST /apis/:id/comments` | `{ body, mentions }` 发评论（viewer），只给项目成员发提醒 |
| `PUT /comments/:id` | 改自己的评论；新 @ 的人才发提醒 |
| `DELETE /comments/:id` | 删除（作者本人或管理员），楼层保留 |
| `GET /projects/:pid/comment-counts` | `{ counts: { apiId: n } }` |
| `GET /notifications?limit=` | 自己的提醒（最多 50 条），只含现在还能看到的项目 |
| `GET /notifications/unread-count` | `{ count }` |
| `POST /notifications/read` | `{ ids }` 或 `{ all: true }` |

## 可视化断言、提取变量、响应字段说明

接口 DTO 顶层多 `assertions`、`extracts`、`responseFields`，都存在接口的 `extra` 里、跟着同步，`PUT /apis/:id` 传即可保存。
发送时请求体里的 `request.assertions` / `request.extracts` 优先（没保存的修改也生效）；断言在「响应后」脚本之前执行，
结果并进 `result.scripts.tests`（`source: '断言'`），提取的值和脚本写回的变量一样落库。里面的正则最多跑 2 秒。

## 跨项目复制 / 移动

| 方法与路径 | 说明 |
| --- | --- |
| `POST /apis/:id/copy` | `{ projectId, folderId?, move? }`，复制（源项目 viewer）或移动（源项目 editor，原来的进回收站）到另一个项目，目标项目要 editor。目标不能是同一个项目 |
| `POST /folders/:id/copy` | 同上，连同整棵子树 |
| `POST /projects/:pid/duplicate` | `{ name }`，复制整个项目为新项目（成员、历史、分享、评论、保密值不复制） |

## Mock 故障模拟

项目 DTO 顶层多 `mockFaults`：`{ enabled, scope: { type: 'all' | 'folders' | 'apis', ids }, rules: [{ id, enabled, type, percent, ... }] }`，
`type` 是 `error` / `delay` / `timeout` / `disconnect` / `ratelimit`。存在项目的 `extra` 里，`PUT /projects/:pid` 保存。
只对普通 HTTP 的 Mock 生效；请求头 `X-Apiloop-Fault: off` 绕过；Mock 日志的记录里多 `fault` 字段。

## 个人偏好（分组、收藏、最近打开）

| 方法与路径 | 说明 |
| --- | --- |
| `GET /me/prefs` | `{ prefs: { projectGroups, favorites, recent } }`。客户端里读写本机库，后台同步到云端 |
| `PUT /me/prefs/:key` | `{ value }`，key 只能是 `projectGroups` / `favorites` / `recent` |
| `GET /prefs?since=` / `POST /prefs` | 只在云端，客户端同步用，形状同 `/secrets` |

## GraphQL Schema

| 方法与路径 | 说明 |
| --- | --- |
| `POST /projects/:pid/graphql/schema` | 请求体同 `/send`；服务端把 body 换成 introspection 查询发出去（不跑脚本、不写历史、不写 Cookie），返回 `{ schema }`（viewer） |

## 测试集

测试集会同步（同步实体 `suite`，排在 `api` 后面）。DTO：`{ id, projectId, name, description, position, steps, stepCount, enabledStepCount, data, settings, createdAt, updatedAt }`。

- `steps`：`[{ id, apiId, enabled, onFail: 'continue' | 'skipIteration', delayMs, assertions, extracts }]`，断言 / 提取的形状和接口上的一样，**接在接口自己的断言 / 提取后面**跑。
- `data`：`null` 或 `{ format: 'csv' | 'json', fileName, text }`，保存时先解析一次，不合法 400；上限 1000 行 / 2 MB。
- `settings`：`{ iterations (1–100), delayMs, timeoutMs? }`。有数据时轮数 = 数据行数。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /projects/:pid/suites` | 列表，`data` 不带 `text`（viewer） |
| `POST /projects/:pid/suites` | 新建，可以带 `steps`（editor） |
| `GET /suites/:id` / `PUT /suites/:id` / `DELETE /suites/:id` | 详情（viewer）/ 只改传了的字段（editor）/ 删除，不进回收站（editor） |
| `POST /suites/:id/copy` | 复制，名字加「（副本）」（editor） |
| `POST /projects/:pid/suites/reorder` | `{ ids }`（editor） |
| `POST /projects/:pid/suites/preview-data` | `{ format, text }` → `{ columns, rows（前 20 行）, total }`，不合法 400（viewer） |
| `POST /suites/:id/run` | **运行**，`{ environmentId, mockBase }`，NDJSON：`start { runId, iterations, steps }` → 每步一条 `step { iteration, index, stepId, apiId, name, method, url, status, timeMs, size, ok, skipped, error, tests }` → `done { runId, status, summary, result, saved, warning }`（viewer）。云端 `SERVER_SEND=0` 时 409 `SERVER_SEND_DISABLED`；同一个测试集已经在跑时 409 |
| `POST /suites/:id/stop` | 停止正在跑的那次；收尾、存记录、`done` 照常从运行那条流上回来（viewer） |

运行时：变量改动（脚本、提取）只在这次运行的内存里，不写库；Cookie 每次从空开始、步骤之间共用；不写历史。
变量优先级多一层：项目 → 目录 → 环境 → **数据** → 临时变量；脚本里 `pm.iterationData.get / has / toObject`（只读）。
`status`：`passed` / `failed` / `stopped` / `error`。

**运行记录（只在云端，客户端转发）**：每个测试集只留最近 100 条。客户端跑完后带当前用户的会话存到云端（没登录不存，`done.saved` 为 false）。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /suites/:id/runs` | 列表，不带 `result`（viewer） |
| `POST /suites/:id/runs` | 存一条：`{ source: 'app' \| 'cli', environmentName, status, summary, result, label, startedAt, finishedAt }`（viewer） |
| `GET /suite-runs/:id` / `DELETE /suite-runs/:id` | 一条（带 `result`，viewer）/ 删除（editor） |

`summary`：`{ iterations, requests, passed, failed, errors, assertions: { passed, failed }, durationMs, avgMs, truncated? }`。
`result.iterations[].steps[]` 里只有失败的步骤带 `request` / `response`（响应体最多 32 KB，保密值、`Authorization`、`Cookie` 打码）；整份超过 2 MB 时都去掉并记 `truncated`。

## 压测（只在客户端）

| 方法与路径 | 说明 |
| --- | --- |
| `POST /projects/:pid/load` | 请求体同 `/send`，多 `load: { concurrency (1–200), mode: 'count' \| 'duration', count (1–100000), durationSec (5–600), rampUpSec (0–60), timeoutMs, okStatus: [] }`，越界 400；同时只能跑一个，第二个 409。NDJSON：`start { missingVariables }` → 每秒一条 `tick { t, sent, ok, failed, active, qps, secondAvgMs, failedInSecond, avgMs, p95Ms }` → `done { status: 'finished' \| 'stopped', summary }`（viewer） |
| `POST /projects/:pid/load/stop` | 停止，`done` 照常从上面那条流回来（viewer） |

只在本机网关上有这两个路由，云端不管 `SERVER_SEND` 都是 404。不跑脚本、不跑断言、不读写 Cookie、不写历史；变量开始时算一次。
`summary`：`{ sent, ok, failed, aborted, errorRate, durationMs, qps, minMs, avgMs, maxMs, p50Ms, p90Ms, p95Ms, p99Ms, statusCodes: [{ status, count }], errors: [{ group, count, sample }], 以及这次的参数 }`。

## 内置 Mock 环境

项目 DTO 带 `mockVariables`：内置「Mock」环境改过的变量表，没改过是 `null`（默认只有 `host`）。
值里的 `$MOCK_BASE` 代表这个项目的 mock 地址，发送时换成页面给的 `mockBase`。
`PUT /projects/:pid` 传 `mockVariables: [...]` 保存，传 `null` 还原默认值。
`/send`、`/send/stream`、`POST /projects/:pid/ws` 用 `environmentId: 'mock'` 加 `mockBase` 选中它。

## 导出文档

| 方法与路径 | 说明 |
| --- | --- |
| `GET /projects/:pid/export/doc` | `?format=md\|html\|docx&folderId=&examples=1&mock=0&doneOnly=0&mockBase=`，直接回文件（`Content-Disposition: attachment`，中文文件名走 `filename*`）（viewer） |

内容和打码规则与分享文档一样（同一份 `publicDoc`）。示例里的 Mock 模板先渲染成真实数据再写进文档（分享页同样）。

## 样例项目

| 方法与路径 | 说明 |
| --- | --- |
| `POST /projects/demo` | `{ origin }`（云端地址，用来拼 Mock 地址）→ `{ project, environmentId }`。建一个配齐了的样例项目，建的人是 owner；内容见 `lib/demo-project.js` |

## 前置接口（自动登录）

- 项目 / 目录 DTO 顶层 `preflight`：`{ apiId, whenMissing, retryOn401 }`；目录上 `null` = 跟着上层，`{ apiId: null }` = 这个目录下不用。`PUT /projects/:pid`、`PUT /folders/:id` 保存。
- 接口 DTO 顶层 `noPreflight: true` = 这个接口不用前置接口（`PUT /apis/:id`，发送的请求体里也认）。
- 生效规则：接口 `noPreflight` → 目录链从内到外第一个配过的 → 项目。前置接口本身不会再触发前置接口。
- 执行：`whenMissing` 的变量没值时先跑前置接口（它的脚本、断言、提取、数据库操作照常），变量改动和 Cookie 并进这次请求、照常写回。
  非流式（`/send`、测试集、批量运行）响应 401 且 `retryOn401` 时在服务端重发一次；流式（`/send/stream`）的 `end` 事件带 `preflight`（生效规则），前端带 `options.forcePreflight: true` 重发。
  前置接口失败不拦主请求，控制台里写原因。`/send/curl`、GraphQL Schema 不跑前置接口。

## 代码片段

`POST /projects/:pid/send/curl` 返回 `{ curl, code, missing }`：`code` 是 `{ curl, fetch, axios, python, java, go, php, csharp }`，变量换成实际值、带鉴权和公共请求头。

## 内置动态变量

`{{$guid}}` `{{$timestamp}}` `{{$timestampMs}}` `{{$isoTimestamp}}` `{{$randomInt}}` / `{{$randomInt(1,100)}}` / `{{$整数(1,100)}}`，
以及中英文两种写法等价的：`$randomPhone`/`$手机号`、`$randomIdCard`/`$身份证`、`$randomChineseName`/`$中文名`、`$randomEmail`/`$邮箱`、`$randomDate`/`$日期`、`$randomDateTime`/`$时间`、
`$randomAddress`/`$地址`、`$randomCompany`/`$公司`、`$randomBankCard`/`$银行卡`、`$randomCreditCode`/`$信用代码`、`$randomPlate`/`$车牌`、`$randomIp`。每出现一次生成一个新值。
变量名允许 Unicode 字母（中文）。脚本里 `pm.variables.replaceIn(text)`。

## 数据库操作（只在客户端执行）

- 连接：项目 DTO 顶层 `databases: [{ id, name, type: 'mysql' | 'postgres' | 'redis', host, port, user, password, database }]`，每个字段都能写 `{{变量}}`；`PUT /projects/:pid` 整份替换。
- 操作：接口 DTO 顶层 `dbOps: [{ id, enabled, phase: 'pre' | 'post', connectionId, statement, extracts: [{ id, enabled, path, scope, name }] }]`；保存接口时接受，`/send` 的 `request.dbOps` 也认（没保存的修改照样生效）。
- 执行顺序：请求前的数据库操作 → 请求前脚本 → 发请求 → 响应后的数据库操作 → 可视化断言和提取 → 响应后脚本。请求前的失败了不发请求；响应后的失败记一条没通过的测试。
- 提取路径：SQL 的结果是行数组（`[0].code`）；MySQL 的 INSERT / UPDATE / DELETE 是 `[{ affectedRows, insertId }]`；Redis 是命令的返回值（路径留空取整个）。BIGINT 按字符串给。SELECT 最多 100 行，超时 10 秒。
- 云端发送时整节跳过，控制台提示一句。

| 方法与路径 | 说明 |
| --- | --- |
| `POST /projects/:pid/databases/test` | `{ connection, environmentId }`，执行 `SELECT 1` / `PING`，回 `{ ok, timeMs, error }`（editor，只在客户端上有） |

## Socket.IO 调试

接口 `method` 为 `SIO`，DTO 顶层 `sio: { path, namespace, transports: 'polling' | 'websocket', auth, listenEvents, sends: [{ id, event, args, ack }] }`。
`auth` 里的字符串、地址、请求头都按环境替换变量。客户端是 socket.io-client v4（能连 3.x / 4.x 的服务端）。

| 方法与路径 | 说明 |
| --- | --- |
| `POST /projects/:pid/sio/prepare` | 给本机网关用的准备（viewer） |
| `POST /projects/:pid/sio` | `{ spec, environmentId }` 建会话并开始连（viewer；`SERVER_SEND=0` 时 409） |
| `GET /sio/:id/events?after=` | NDJSON 事件流（`open` / `message`（`direction`: in / out / ack，`event`，`text`）/ `close` / `error`），断线后带 `after` 补发（会话创建者） |
| `POST /sio/:id/send` | `{ event, args, ack }`（会话创建者；没连上 409） |
| `DELETE /sio/:id` | 断开并销毁 |

## gRPC 调试（只在客户端）

接口 `method` 为 `GRPC`，`url` 是 `host:port`（`grpcs://` 开头等于开 TLS）。DTO 顶层 `grpc: { source: 'proto' | 'reflection', protoFiles: [{ name, content }], reflection: { descriptorSet, fetchedAt } | null, service, method, tls, metadata: [{ key, value, enabled }], message, deadlineMs, savedMessages: [{ name, message }] }`。
断言、提取变量用接口上的 `assertions` / `extracts`（和 HTTP 接口同一份）。只在本机网关上有这些路由。

| 方法与路径 | 说明 |
| --- | --- |
| `POST /projects/:pid/grpc/parse` | `{ protoFiles }` 或 `{ descriptorSet }` → `{ services: [{ name, methods: [{ name, path, requestType, responseType, clientStreaming, serverStreaming, example }] }] }`；语法错误 400，带文件名和行号（viewer） |
| `POST /projects/:pid/grpc/reflect` | `{ url, tls, metadata, environmentId, apiId }` 问服务端反射（先 v1 后 v1alpha），→ `{ services, descriptorSet, fetchedAt, tooLarge }`；服务端没开反射 400（viewer） |
| `POST /projects/:pid/grpc/call` | 一元调用 / 服务端流。`{ url, tls, protoFiles \| descriptorSet, service, method, metadata, message, deadlineMs, assertions, extracts, environmentId, apiId }`，NDJSON：`start { target, tls, missing, note }` → `metadata` → `message { data, at }`（每条一行）→ `end { status: { code, name, details }, trailers, durationMs, tests, extracted, warnings }`；准备阶段出错是一行 `error`（viewer） |
| `POST /projects/:pid/grpc/streams` | 客户端流 / 双向流建会话（请求体同 `call`，不带 `message`）→ `{ id }`；其他方法 400 |
| `GET /grpc/streams/:id/events?after=` | NDJSON：`start` / `metadata` / `sent` / `message` / `end` / `error`，断线带 `after` 补发（会话创建者） |
| `POST /grpc/streams/:id/send` | `{ message }`（可带 `{{变量}}`）；结束后 409 |
| `POST /grpc/streams/:id/end` | 结束发送（half-close），服务端还能继续回 |
| `DELETE /grpc/streams/:id` | 取消并删除会话 |

int64 按字符串收发、枚举按名字。断言里的「响应体」：一元调用和客户端流是那一条消息，服务端流和双向流是全部消息组成的数组；「状态码」是 gRPC 状态码（OK 是 0）；「响应头」是 metadata + trailers。会话空闲 60 秒回收，每人最多 10 个。

## MQTT 调试（只在客户端）

接口 `method` 为 `MQTT`，`url` 是 broker 地址（`mqtt://`、`mqtts://`、`ws://`、`wss://`）。DTO 顶层 `mqtt: { clientId, username, password, protocolVersion: 3 | 4 | 5, clean, keepalive, connectTimeoutMs, will: { topic, payload, qos, retain }, subscriptions: [{ topic, qos, enabled }], saved: [{ name, topic, payload, qos, retain }] }`。只在本机网关上有这些路由。

| 方法与路径 | 说明 |
| --- | --- |
| `POST /projects/:pid/mqtt` | 建会话并连接（请求体是上面那些字段 + `url`、`environmentId`、`apiId`，变量按环境替换）→ `{ id, missing }`（viewer） |
| `GET /mqtt/:id/events?after=` | NDJSON：`connecting` / `connected` / `subscribed { topic, qos, granted, error }` / `unsubscribed` / `message { topic, payload \| payloadBase64, qos, retain, properties, at }` / `published` / `reconnecting` / `closed { reason }` / `error`（会话创建者） |
| `POST /mqtt/:id/subscribe` | `{ topic, qos }` |
| `POST /mqtt/:id/unsubscribe` | `{ topic }` |
| `POST /mqtt/:id/publish` | `{ topic, payload, qos, retain }`；主题带 `+` / `#` 400；QoS 1 / 2 在 broker 确认后才出 `published` |
| `DELETE /mqtt/:id` | 断开并删除会话 |

## Mock 录制（只在客户端）

客户端开一个本机代理，把请求原样转发到 `target` 并记下请求和响应，可以挑着存成接口示例。整个网关同时只录一个项目，记录只在内存里（每个项目最近 500 条，body 各最多 1 MB）。

| 方法与路径 | 说明 |
| --- | --- |
| `POST /projects/:pid/record/start` | `{ target, environmentId, port (0 = 从 47400 起找空闲), lan, pathPrefix, skipStatic }` → `{ recording: { localUrl, lanUrls, port, … } }`；已经在录 409（editor） |
| `POST /projects/:pid/record/stop` | 停止，记录保留；不是这个项目在录 409（editor） |
| `GET /projects/:pid/record?after=` | `{ recording, busy, lastSeq, entries: [{ seq, id, at, method, path, query, status, durationMs, error, request, response, match }] }`；`match` 是返回时重新匹配的对应接口；别的项目在录时 `recording` 为 null、`busy` 给出那个项目（viewer） |
| `DELETE /projects/:pid/record/entries` | 清空这个项目的记录（editor） |
| `POST /projects/:pid/record/save` | `{ items: [{ entryId, apiId?, folderId?, name? }], paramize, setMock, environmentId }`：对上接口的加示例，没对上的按「方法 + 路径 + 目录」分组、每组建一个接口 → `{ created: { apis, examples }, results }`（editor） |

代理带 `Origin` 时回 CORS 头、预检直接回 204；`Set-Cookie` 去掉 `Domain`；gzip / br / deflate 记录时解压；SSE 和 WebSocket 原样转发、不记内容。

## 项目备份与恢复

备份是一个 JSON 文件：`{ format: 'apiloop-backup', version: 1, exportedAt, appVersion, project, folders, apis, examples, expectations, environments, suites }`。保密变量的值不进备份；不含成员、分享、评论、历史、回收站、运行记录。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /projects/:pid/backup` | 下载备份文件（editor） |
| `POST /backup/restore` | 请求体最大 50 MB。`{ backup, mode: 'new', name? }` 恢复成新项目（任何登录用户，自己是 owner）→ `{ project, warnings }`；`{ backup, mode: 'overwrite', projectId }` 覆盖（owner / 管理员）：原目录、接口、环境进回收站，测试集删除 → `{ project, trashed, deletedSuites, warnings }`。不是备份文件 / 版本更新 400 |
| `GET` / `PUT /settings/backup` | 云端自动备份设置 `{ backup: { enabled, hour (0–23), keepDays (1–90) } }`（PUT 仅管理员） |
| `GET /projects/:pid/backups` | 云端自动备份列表 `{ items: [{ id, at, size }] }`（owner / 管理员） |
| `GET /projects/:pid/backups/:id` | 下载那一份（`id` 形如 `20261005-030000`） |
| `POST /projects/:pid/backups/:id/restore` | `{ mode: 'new' \| 'overwrite' }`，同 `/backup/restore` |

自动备份只在云端跑：每天到点给每个项目写一份到数据目录的 `backups/<projectId>/`，内容没变不写，超过保留天数删掉。网关上 `/settings/backup` 和 `/projects/:pid/backups*` 转发给云端（没登录 409）。

## 界面语言

前端每个请求都带 `Accept-Language`（`zh-CN` / `en`）。后端返回的提示目前仍是中文。

## 集合 / 环境 JSON 导入导出（契约第 6 节）

格式是 Collection v2.0 / v2.1、Environment、Globals 的 JSON，以及 **YApi**（「数据导出 → json」）和 **Apifox**（`.apifox.json`）的导出文件 ——
自动识别，预览的响应里 `format` 是 `postman` / `yapi` / `apifox`。Apifox 文件里的环境会一并建出来。导入的请求体上限 50MB。

| 方法与路径 | 说明 |
| --- | --- |
| `POST /import/json/preview` | 解析并统计，不写库 |
| `POST /import/json` | 导入集合 / 环境 / 全局变量；`{ text, mode?: 'new'\|'into', projectId? }`，整个导入是一个事务 |
| `GET /projects/:pid/export/json` | 导出项目（集合 JSON），返回 `{ filename, json }`。`method` 为 `WS` / `SIO` 的接口会被跳过，`warnings` 里说明跳过了几个；数据库连接的密码清空 |
| `GET /environments/:id/export/json` | 导出环境 JSON |

## HAR 导入（契约第 13 节）

| 方法与路径 | 说明 |
| --- | --- |
| `POST /import/har/preview` | 解析并统计，不写库；`{ text, options?: { keepCredentials } }` |
| `POST /import/har` | 导入；`{ text, projectId?, mode?: 'new'\|'into', options? }` |

> 这两条路径的**请求体上限是 50MB**（HAR 经常几十 MB），管理台其他接口仍是 4MB。
> 权限与集合 JSON 导入一致：`new` 谁都能用（导完是 owner），`into` 要 editor，
> 且「项目不存在」与「不是成员」返回**同一个 400**。**凭据默认不保留**（请求头 `Cookie`、`Authorization`、
> `Proxy-Authorization` 和响应头 `Set-Cookie` 会去掉），`options.keepCredentials: true` 才保留。

## 脚本（契约第 16 节）

接口、目录、项目三层各可以挂「请求前」脚本（`prerequest`）与「响应后」脚本（`test`）：

```js
scripts = [{ listen: 'prerequest' | 'test', exec: '脚本源码' }]
```

- `Project`、`Folder`、`Api` 的 DTO 都带 `scripts`；`PUT /projects/:pid`、`PUT /folders/:id`、
  `PUT /apis/:id` 都接受它。
- 写入时校验：`listen` 只能是 `prerequest` 或 `test`，每段 `exec` 最长 **64KB**，不合法返回 400。
- `/send` 与 `/send/stream` 的 `options.scripts` 默认为 `true`，传 `false` 时这次发送
  **一段脚本都不执行**。执行顺序是「项目 → 目录（从外到内）→ 接口」，
  接口那一层取自请求体里的 `request.scripts`（没保存的修改也生效）。

执行结果挂在 `ExecResult` 上，**没有任何脚本时是 `null`**：

```js
scripts = {
  tests: [{ name, passed, error? }],
  console: [{ level, text, source }],            // source 形如 '项目' / '目录「人员信息」' / '接口'
  errors: [{ phase: 'prerequest'|'test', source, message }],
  warnings: [string],
  variables: {
    environment: { set: {}, unset: [] },
    project: { set: {}, unset: [] },
    persisted: boolean                           // 是否真的写进了库（viewer 不写）
  }
}
```

> 支持的 `pm.*` API 和用例见应用里的「帮助 → 脚本」；沙箱限制、变量写回规则见契约第 16 节。
> 「请求前」脚本出错时请求不发送，`result.error.code` 是 `SCRIPT`。

## SSE 与 WebSocket 的 mock 回放（契约第 17 节）

示例的 `responseType` 多了两种，它们的 `body` 是一段描述**怎么回放**的 JSON：

```js
// responseType: 'sse'
{ events: [{ delay, event?, data, id? }], repeat: false }

// responseType: 'ws'     接口的 method 为 'WS'
{ onOpen: [{ delay, send }],
  rules: [{ match: { type: 'equals'|'contains'|'regex'|'any', value }, reply: [{ delay, send }] }],
  fallback: 'none'|'echo' }
```

写入时校验，不合法返回 400 + 中文原因：

- SSE：`body` 必须是合法 JSON；`events` 非空、最多 5000 条；`delay` 在 0~60000；`data` 必须是字符串；
- WebSocket：`regex` 必须能编译；`delay` 在 0~60000；**步骤总数**（`onOpen` 条数 +
  各条规则 `reply` 的条数，规则本身不计）不超过 1000。

`method` 为 `WS` 的接口：存进目录树、可以配 mock，但**不注册 HTTP 路由**，由 mock 服务端在
`upgrade` 事件上按 mockPath 匹配（规则和 HTTP 路由相同，`:param` 也支持；
非根项目要带 `/mock-<项目ID>` 前缀）。每个项目最多同时保持 100 条 mock 连接，超了拒绝。

## 流式发送与 WebSocket（契约第 14、15 节）

| 方法与路径 | 权限 | 说明 |
| --- | --- | --- |
| `POST /projects/:pid/send/stream` | viewer | 请求体与 `/send` **完全相同**，响应是 NDJSON 事件流 |
| `POST /projects/:pid/ws` | viewer | 建 WebSocket 会话，`{ spec: { url, params, auth }, environmentId?, options? }`，返回 `{ session: { id, url } }` |
| `GET /ws/:id/events?after=<seq>` | 只有创建者 | NDJSON 长连接：先补发 `seq > after` 的缓冲事件，再持续推新事件 |
| `POST /ws/:id/send` | 只有创建者 | `{ text }` 或 `{ base64 }`；连接没打开或已关闭时返回 **409** |
| `DELETE /ws/:id` | 只有创建者 | 用 1000 关闭上游并立即销毁会话 |

**`/send/stream` 的响应头**：`Content-Type: application/x-ndjson; charset=utf-8`、
`Cache-Control: no-cache`、`X-Accel-Buffering: no`。开始流式输出**之前**出的错按普通 JSON 返回，
状态码和文案与 `/send` 一致。

```js
{ type: 'head', response: { status, statusText, httpVersion, headers }, redirects }  // 最多一次
{ type: 'chunk', text }            // 文本响应：是一段按 UTF-8 解码后的文本
{ type: 'chunk', base64 }          // 二进制响应
{ type: 'end', result, historyId } // 恰好一次，而且是最后一条
```

> `timeoutMs` 只到 `head` 为止，之后由客户端取消（断开连接即中止上游，历史照样记录）。
> 重定向的中间几跳不发 `chunk`。

**WebSocket 的事件**（同一个 `events` 连接上的 NDJSON，`seq` 在会话内从 1 递增）：

```js
{ seq, time, type: 'open', protocol, note? }                        // note 例如「系统代理不作用于 WebSocket，本次为直连」
{ seq, time, type: 'message', direction: 'in'|'out', text?, base64?, size, truncated }
{ seq, time, type: 'close', code, reason }
{ seq, time, type: 'error', message }
```

> 每个会话最多缓冲最近 500 个事件，单条消息超过 64KB 的部分截断（`size` 仍是原始大小）。
> 上游断开满 60 秒、或者没有任何 `events` 连接满 60 秒，会话就被回收。
> **`/ws/:id/*` 三个路由不走项目权限 guard**：先按「会话 + 创建者」定位，再确认创建者仍是项目成员，
> 任何一步不满足都返回同一个 404。

## Mock 期望与智能模板化（契约第 8、9 节）

| 方法与路径 | 说明 |
| --- | --- |
| `POST /templatize` | 把 JSON 文本模板化（纯计算，不写库），返回 `{ body, replacements, skipped }` |
| `POST /apis/:id/expectations` | 新增期望；`exampleId` 必须是这个接口自己的示例 |
| `PUT /expectations/:id` | 改名字 / 启用状态 / 条件 / 所指示例 |
| `DELETE /expectations/:id` | 删除期望，返回更新后的接口 |
| `POST /apis/:id/expectations/reorder` | 按 `{ ids: [...] }` 重排期望顺序 |
| `GET /apis/:id` | 响应里带 `expectations`，按 `position` 排序 |

## Cookie（契约第 12 节）

| 方法与路径 | 说明 |
| --- | --- |
| `GET /projects/:pid/cookies` | 列出**自己**在这个项目里的 cookie；已过期的不返回（并顺手从库里删掉） |
| `POST /projects/:pid/cookies` | 手动新增或更新一条；按 `domain + path + name` 定位。`domain` 以 `.` 开头是域 cookie，否则 host-only |
| `DELETE /cookies/:id` | 删一条自己的。不是自己的、与不存在，都是同一个 404「Cookie不存在」 |
| `DELETE /projects/:pid/cookies?domain=` | 清空自己在这个项目下的 cookie；带 `domain` 时只清这个域名的 |

> 每个用户在每个项目里各有一份，接口里没有任何一处能看到别人的。匹配规则见契约第 12 节。

## 系统设置（契约第 12 节）

| 方法与路径 | 说明 |
| --- | --- |
| `GET /settings/proxy` | 读取代理设置。登录即可，地址里的密码显示为 `***` |
| `PUT /settings/proxy` | 修改代理设置。**仅管理员**；密码提交 `***` 表示不变 |

## Mock 调用日志（契约第 11 节）

| 方法与路径 | 说明 |
| --- | --- |
| `GET /projects/:pid/mock-log?after=<seq>&limit=100` | 最近打到这个项目 mock 上的请求，按 `seq` 升序；`limit` 默认 100、最大 200。viewer |
| `DELETE /projects/:pid/mock-log` | 清空该项目的日志（只清内存）。editor |

联调时最常问的一句话是「我明明发了请求，怎么没反应」。日志回答的就是它：每条记下完整
原始地址（含 `/mock-<项目ID>` 前缀与查询串）、查询参数、请求头、请求体预览、命中了哪个
接口的哪条期望（`matched: null` 表示在 `/mock-<项目ID>` 下根本没有命中，这正是地址写错时
最需要看到的）、状态码与耗时。请求头里的 `Authorization`、`Cookie`、
`Proxy-Authorization` 一律打码成 `***`，请求体与响应体各只留前 4KB。

**日志只存在内存里**：每个项目保留最近 200 条，服务重启后清空；多个进程共用同一个库时，
各自只记录打到自己端口上的请求。前端每 2 秒带 `after=上次返回的 lastSeq` 轮询一次，
只拿新增的记录。

## 元信息与纯解析

| 方法与路径 | 说明 |
| --- | --- |
| `GET /meta` | 占位符、字段类型、响应模板、方法列表、当前用户与根项目、mock 前缀 |
| `POST /preview` | 渲染一次响应体，返回 warnings 和 JSON 校验结果 |
| `POST /import/curl` | 解析 cURL |
| `POST /import/openapi` | 解析 OpenAPI / Swagger（JSON 或 YAML）：`{ text }`，或 `{ url }` 由服务端去拉（本机网关上就是本机拉，内网地址也行；15 秒超时、最大 20MB） |

## 安装包下载（G3）

安装包放在 **`<数据目录>/downloads/`**（Docker 下就是宿主机的 `./data/downloads/`，
不进镜像）。文件名必须是 `apiloop-gateway-<三段版本号>-<arm64|x64>.pkg`（Mac）或
`apiloop-gateway-<三段版本号>-win-x64.exe`（Windows），别的文件一律不列、也不能下；
同一平台有多个版本时只列最新的。云端每个管理台响应都带 `X-Apiloop-Version` 头，
客户端拿它判断有没有新版本。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /__admin/api/downloads` | 列出可下载的安装包（**要登录**）。`{ ok, version, files: [{ name, platform, arch, version, size }] }`，`version` 是服务端自己的版本；目录不存在时 `files` 是空数组 |
| `GET /__admin/downloads/:name` | 下载（**不需要登录**，链接可以直接发给同事）。`Content-Disposition: attachment`；文件名不在列表里就 404，文案统一，不区分「不存在」与「不允许」 |

> 下载挂在 `/__admin/downloads`（不是 `/__admin/api`）下面，因为 `/__admin/api/*`
> 整体在 `requireLogin` 之后。网关**不转发**这条路径，在网关页面上打开时用的是云端的
> 绝对地址。

## 本机网关自己的接口

只在客户端里的本机网关（`127.0.0.1:47321`）上有，前缀是 `/__apiloop`；非 GET 请求要带 `X-Apiloop: 1`。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /__apiloop/status` | 空间状态（未绑定 / 已登录 / 已退出）、同步状态（待同步数、冲突数、上次同步）、云端是否可达、云端版本 `cloudVersion`、一键更新进度 `update` |
| `POST /__apiloop/update/start` | 下载云端当前版本的安装包并打开安装程序（只在云端版本比本机新时可用） |
| `POST /__apiloop/space/delete` | 删除这台电脑上的数据（可同时退出登录） |
| `GET /__apiloop/sync/pending` | 还没同步上去的改动 |
| `GET /__apiloop/sync/conflicts` | 冲突列表 |
| `POST /__apiloop/sync/conflicts/resolve` | 处理一条冲突：`{ entity, id, choice: 'mine'\|'theirs'\|'copy' }`（`copy` 只对接口） |
