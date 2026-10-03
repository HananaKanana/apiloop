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

## 内置 Mock 环境

项目 DTO 带 `mockVariables`：内置「Mock」环境改过的变量表，没改过是 `null`（默认只有 `host`）。
值里的 `$MOCK_BASE` 代表这个项目的 mock 地址，发送时换成页面给的 `mockBase`。
`PUT /projects/:pid` 传 `mockVariables: [...]` 保存，传 `null` 还原默认值。
`/send`、`/send/stream`、`POST /projects/:pid/ws` 用 `environmentId: 'mock'` 加 `mockBase` 选中它。

## 集合 / 环境 JSON 导入导出（契约第 6 节）

格式是 Collection v2.0 / v2.1、Environment、Globals 的 JSON。

| 方法与路径 | 说明 |
| --- | --- |
| `POST /import/json/preview` | 解析并统计，不写库 |
| `POST /import/json` | 导入集合 / 环境 / 全局变量；`{ text, mode?: 'new'\|'into', projectId? }`，整个导入是一个事务 |
| `GET /projects/:pid/export/json` | 导出项目（集合 JSON），返回 `{ filename, json }`。`method` 为 `WS` 的接口会被跳过，`warnings` 里说明跳过了几个 |
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
