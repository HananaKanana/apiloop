# 管理台 API 参考

apiloop 的管理台前端用的就是这些接口，也可以直接调。**除登录接口外都需要先登录**，
请求要带上登录返回的 cookie。路径都省略前缀 `/__admin/api`，统一返回
`{ ok: true, ... }` 或 `{ ok: false, error: "..." }`。

字段名、状态码与各种规则的完整定义见 [管理台接口 v2 契约](design/2026-09-30-admin-api-v2.md)（内部设计文档）。
下面的表只列路径与一句话说明。

## 登录与用户

| 方法与路径 | 说明 |
| --- | --- |
| `POST /auth/login` | 登录，body `{username, password}`，成功种 cookie。**公开** |
| `POST /auth/logout` | 退出 |
| `GET /auth/me` | 当前登录用户 |
| `PUT /auth/password` | 改密码，body `{oldPassword, newPassword}` |
| `GET /users` | 用户列表。仅管理员 |
| `GET /users/lookup?q=` | 搜人（按用户名或显示名模糊匹配，最多 20 条，不含被禁用的）。登录即可，加项目成员时用 |
| `POST /users` | 新建用户；没传密码会随机生成并在响应里返回一次。仅管理员 |
| `PUT /users/:id` | 改显示名 / 角色 / 禁用。仅管理员 |
| `POST /users/:id/reset-password` | 重置密码并返回一次。仅管理员 |
| `DELETE /users/:id` | 删除用户。仅管理员 |

## 项目（契约第 2 节）

| 方法与路径 | 说明 |
| --- | --- |
| `GET /projects` | 项目列表；只返回自己参与的项目（admin 返回全部） |
| `POST /projects` | 新建项目；任何登录用户都可以，创建者自动成为 owner |
| `GET /projects/:pid` | 项目详情，`:pid` 可以是 id 或 slug |
| `PUT /projects/:pid` | 改描述 / 变量 / 鉴权要 editor；改名字 / 标识要 owner。标识被占用会报错，不自动改名 |
| `DELETE /projects/:pid` | 删除项目。owner；根项目与默认项目不能删 |
| `GET /projects/:pid/members` | 成员列表。viewer |
| `PUT /projects/:pid/members/:userId` | 加成员或改角色。owner；不是成员就加进来 |
| `DELETE /projects/:pid/members/:userId` | 移除成员。owner，或者自己退出 |

## 目录树、接口与示例（契约第 3 节）

| 方法与路径 | 说明 |
| --- | --- |
| `GET /projects/:pid/tree` | 整棵树，返回扁平的目录与接口列表，前端自己组装 |
| `POST /projects/:pid/folders` | 新建目录，同一父目录下不允许重名 |
| `PUT /folders/:id` | 改名字 / 描述 / 鉴权 / 变量 |
| `DELETE /folders/:id?apis=move\|delete` | 删目录。`move`（默认）把内容移到父目录，`delete` 递归删 |
| `POST /projects/:pid/move` | 移动目录或接口到指定位置，并重排 position；移进自己的子孙会被拒 |
| `GET /apis/:id` | 接口详情（含请求定义、mock 配置、全部示例） |
| `POST /projects/:pid/apis` | 新建接口 |
| `PUT /apis/:id` | 更新接口；改 url 时 `mock.path` 的跟随规则、开启 mock 的前提见契约 |
| `DELETE /apis/:id` | 删除接口 |
| `POST /apis/:id/duplicate` | 复制接口（示例整份复制，名字加「 副本」） |
| `POST /apis/:id/examples` | 新增示例；这是第一个示例时会自动成为 mock 用的那条 |
| `PUT /examples/:id` | 更新示例 |
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

## 发送、历史与文件（契约第 5 节）

| 方法与路径 | 说明 |
| --- | --- |
| `POST /projects/:pid/send` | 由服务端代发请求，返回执行结果并写一条历史；浏览器断开时取消在途请求 |
| `GET /projects/:pid/history` | 历史列表，`?limit=50&before=<id>` 翻页，`limit` 最大 200 |
| `GET /history/:id` | 历史详情（原始的请求定义 + 完整执行结果） |
| `DELETE /projects/:pid/history` | 清空该项目的历史 |
| `POST /projects/:pid/files` | 上传文件（`application/octet-stream` + `X-Filename`），返回服务端绝对路径 |

## Postman 导入导出（契约第 6 节）

| 方法与路径 | 说明 |
| --- | --- |
| `POST /import/postman/preview` | 解析并统计，不写库 |
| `POST /import/postman` | 导入 collection / environment / globals；整个导入是一个事务 |
| `GET /projects/:pid/export/postman` | 导出成 Postman Collection |
| `GET /environments/:id/export/postman` | 导出成 Postman Environment |

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

> 每个用户在每个项目里各有一份，接口里没有任何一处能看到别人的。规则见
> [Cookie 与代理](#cookie-与代理)。

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
原始地址（含 `/mock/<slug>` 前缀与查询串）、查询参数、请求头、请求体预览、命中了哪个
接口的哪条期望（`matched: null` 表示在 `/mock/<slug>` 下根本没有命中，这正是地址写错、
slug 拼错时最需要看到的）、状态码与耗时。请求头里的 `Authorization`、`Cookie`、
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
| `POST /import/openapi` | 解析 OpenAPI / Swagger |
