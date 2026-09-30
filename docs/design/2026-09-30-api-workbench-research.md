# 调研：把 server-mock 改造成本地 Postman 类工具（产品名：apiloop）

> 状态：**决策已定（2026-09-30）**。D2–D6 按建议执行；D1 改为「始终登录 + 后台用户管理」，以第 7 节为准。
> 日期：2026-09-30
> 实施计划：P1 → [docs/superpowers/plans/2026-09-30-p1-data-foundation.md](../superpowers/plans/2026-09-30-p1-data-foundation.md)

## 0. 一句话目标

**本地的接口工作台：能调接口、能存接口，调通的响应可以一键变成 mock。**
分工对照：Postman 负责「发请求」，现有的 server-mock 负责「造假数据」。新产品要把两者接在一起：发出去的真实响应，就是 mock 的种子数据。

最接近的参照是 **Apifox**：接口定义、调试、mock 三合一。区别在于我们是本地 CLI 起的服务，数据放在本地 SQLite 里，不上云。

---

## 1. 需要你拍板的决策（按影响面排序）

| # | 问题 | 我的建议 | 为什么这件事必须先定 |
| --- | --- | --- | --- |
| D1 | 用户体系给谁用？单机个人用，还是一台机器起服务、局域网里多人共用？ | ~~默认免登录~~ → **已定：始终登录，后台加用户管理**（见第 7 节） | 决定鉴权、权限、监听地址的复杂度。不管选哪种，数据表从第一天起就带 `user_id` / `project_id`，否则以后要做数据迁移 |
| D2 | 前端要不要引入构建工具？ | **要。Vue 3 + Vite**，构建产物随 npm 包发布，使用者照样零构建，只有开发时需要 `npm run build` | 现在的前端是 2800 行原生 JS 单文件。Postman 那种界面（树形目录、多标签页、环境切换、各种键值编辑器、响应查看器）用原生 JS 写下去会失控。这是一次性的大改，越晚做越贵 |
| D3 | 数据库放在哪？ | **全局一份**，放在 `~/.server-mock/data.db`，可用 `--db` 改路径。启动时如果当前目录有 `routes.json`，提示导入成一个项目 | 有了「用户」「项目」，数据就不再属于某个目录。现在的 sqlite 改造大概率是按当前目录放库，需要对齐 |
| D4 | 「接口调试」和「mock 路由」是一个东西还是两个？ | **合成一个实体「接口」**（Apifox 模式）：一个接口 = 请求定义 + 若干示例响应 + mock 配置 | 这是整个数据模型的核心，见第 3 节 |
| D5 | 多项目时，mock 的 URL 怎么区分项目？ | 每个项目挂在 `/mock/<项目标识>/...`；另有一个「默认项目」同时挂在根路径，老用户的 `mock start` 行为不变 | 不定下来，两个项目都配了 `/api/users` 就会冲突 |
| D6 | Postman 的前置脚本和测试脚本要不要执行？ | **第一版不执行**，导入时原样保存并提示「N 个脚本未执行」。以后再考虑在沙箱里支持 `pm.*` 的一个常用子集 | Node 自带的 `vm` 模块不能当安全边界，执行别人导入的脚本有风险；做一个完整的 `pm` API 工作量很大 |

---

## 2. 竞品速览（只列对我们有借鉴意义的点）

| 产品 | 形态 | 值得借鉴的 | 不照搬的 |
| --- | --- | --- | --- |
| Postman | 云端 + 桌面客户端 | Collection v2.1 格式是事实标准；保存的示例响应（`response[]`）；环境变量体系 | 强制登录、云同步 |
| Apifox | 云端 + 桌面客户端 | 设计、调试、mock 一体；**高级 Mock「期望」**：按 query/header/body 条件返回不同响应；按字段名自动生成随机数据（智能 Mock） | 云端团队协作的整套东西 |
| Bruno | 本地文件、适合 git 管理 | 集合就是纯文本文件，没有账号；能导入 Postman / Insomnia / OpenAPI | 我们选的是 SQLite，不走「一个请求一个文件」 |
| Yaak / Hoppscotch | 本地优先 / 可自部署 | 能直接导入 Postman 的集合和环境；支持 WebSocket、SSE、GraphQL | 协议面太广，第一版不跟 |
| YApi | 自部署 Web | 用户、项目、成员权限加 mock，国内团队很熟悉 | 已经停止维护，界面老旧 |

**结论：** 我们的差异点是「调通就能 mock」，外加「本地一条命令就能启动、不用登录」。

---

## 3. 核心数据模型（建议）

```
users            id, username, password_hash, display_name, created_at
projects         id, slug(用于 mock URL), name, owner_id, created_at
project_members  project_id, user_id, role(owner|editor|viewer)
environments     id, project_id, name, variables(JSON: [{key,value,type:'default'|'secret',enabled}])
folders          id, project_id, parent_id, name, position, auth(JSON), variables(JSON)  ← 对应 Postman 的 item-group
apis             id, project_id, folder_id, name, position, description,
                 method, url(可含 {{baseUrl}})、path_params/query/headers(JSON),
                 body(JSON: {mode, raw, language, urlencoded, formdata, graphql}),
                 auth(JSON), scripts(JSON, 只存不跑),
                 mock_enabled, mock_path(由 url 推导，可手改), mock_delay, mock_cors
examples         id, api_id, name, position, status, headers(JSON), body,
                 is_template(是否含 {{@...}} 占位符), source('manual'|'recorded'|'imported')
mock_expectations id, api_id, position, name, conditions(JSON), example_id  ← 按条件选择返回哪个示例
history          id, project_id, api_id?, user_id, request(JSON), response(JSON,body 截断), timings(JSON), created_at
meta             schema_version 等
```

要点：

- **现有的一条 route，映射成 1 个 api 加 1 个 example。** 老的 `response` 模板就是这个 example 的 body，设 `is_template=1`。mock 运行时的逻辑基本不用改，只是数据来源从 route 换成「api + 当前生效的 example」。
- **示例（example）一处数据，两种用途**：
  - 调试时，它是「保存下来的响应」，也就是 Postman 的 examples；
  - mock 时，它就是返回的数据。
  - 这就是「调通即 mock」在数据模型上的落点。
- **期望（expectations）按 position 顺序匹配**，第一条命中的生效；都没命中就返回默认示例。条件的写法：`[{in:'query'|'header'|'body'|'path', key, op:'eq'|'ne'|'exists'|'contains'|'regex', value}]`。
- **变量优先级**：项目变量 < 当前环境 < 请求内临时值，比 Postman 的五层简化。
  - 变量语法沿用 Postman 的 `{{var}}`。它和 mock 占位符 `{{@xxx}}` 靠 `@` 区分，不会冲突。
- **数据库访问方式要变。** 现在 `lib/db.js` 是「全量读 + 全量写」，这对历史记录、多项目、多用户不可行，需要换成按表增删改查。
  - `meta.schema_version` 已经预留了，需要补一个按版本号顺序执行的迁移机制。

---

## 4. 发送请求：执行器设计

浏览器直接发请求会被 CORS 拦住，也拿不到完整的响应头和耗时，所以**一律由本地后端代发**：

```
前端 --POST /__admin/api/send {request, envId}--> 后端 executor --真实请求--> 目标服务
                                                   └── 写 history
```

- **实现方式**：用 Node 自带的 `http` / `https` 模块，不引入新依赖。原因：
  - 能拿到分阶段耗时（DNS、建连、TLS 握手、首字节、下载），和 Postman 的耗时面板一样；
  - 能控制「是否校验证书」（本地调自签名证书的 https 服务是刚需）；
  - 重定向自己跟随，能把完整的跳转链展示出来；
  - 自己解压 gzip / br / deflate，同时保留原始的响应头。
- **请求体支持的类型**：`none`、`raw`（JSON / 文本 / XML / HTML / JavaScript）、`x-www-form-urlencoded`、`multipart/form-data`（含文件）、`binary`（单文件）、`graphql`（本质是 POST JSON）。
- **文件上传**：因为后端就在本机，Postman 导入的 `formdata[].src` 本地路径可以直接读。浏览器里选的文件先上传到 `~/.server-mock/files/`，请求里只记路径。
- **鉴权类型**：第一版支持 `noauth`、`inherit`（沿用父级设置）、`bearer`、`basic`、`apikey`（放 header 或 query）。
  - 其他类型（oauth2、digest、awsv4 等）导入时原样保存，界面上标「暂不支持」。
- **响应展示**：状态码、耗时、大小、响应头、Cookie；body 按 Content-Type 格式化或预览；图片直接预览；二进制提供下载。
  - body 超过阈值（比如 5MB）就截断存进 history。
- **超时和取消**：每个请求带超时设置；前端可以取消，后端对应中止那个真实请求。
- **暂缓**：Cookie 自动管理、代理设置、客户端证书、WebSocket、SSE。这些放到 P5。

---

## 5. 响应 → mock 的链路（产品核心）

1. 调试时发请求 → 在响应面板点「**保存为示例**」→ 生成一条 `examples` 记录，`source='recorded'`。
2. 保存时可选「**智能模板化**」：把录到的 JSON 按字段名和值推断类型，替换成占位符，从「固定数据」变成「每次随机」。例如：
   - `phone` → `{{@phone}}`
   - `name` → `{{@cname}}`
   - `createdAt` → `{{@datetime}}`
   - 长度超过 1 的数组 → `{{@repeat(n)}}` 包住第一个元素
   - 推断逻辑复用并扩展 `lib/importers.js` 里已有的 `inferFieldType` / `toField`。
3. 在接口上打开「**启用 mock**」→ 选一个示例作为默认返回 → 立刻生效，访问 `/mock/<项目>/<路径>` 即可。
   - mock 路径由 url 推导：去掉 `{{baseUrl}}`、协议和主机名；Postman 的 `:id` 写法和 Express 路由一致，可以直接用。
4. 进阶：用期望（expectations）实现「同一个接口按参数返回不同示例」，比如 `id=404` 时返回「不存在」的示例。

录制代理（把真实流量转发出去，同时自动存成示例）放到后续版本，不进第一版。

---

## 6. Postman 导入：范围与映射

**支持的格式**（导入前先按特征自动识别）：

| 输入 | 识别依据 | 第一版 |
| --- | --- | --- |
| Collection v2.1 | `info.schema` 包含 `v2.1.0` | ✅ |
| Collection v2.0 | `info.schema` 包含 `v2.0.0`。和 2.1 的主要区别是 auth 的写法：2.0 是对象，2.1 是 `[{key,value,type}]` 数组 | ✅ |
| Collection v1 | 顶层有 `requests` / `order` 字段 | ❌ 提示用户先在 Postman 里重新导出成 v2.1 |
| Environment | 顶层有 `values` 数组，通常还有 `_postman_variable_scope: "environment"` | ✅ |
| Globals | `_postman_variable_scope: "globals"` | ✅ 并入项目变量 |
| 全量数据导出（Settings → Data） | 顶层有 `collections` / `environments` 数组 | P2 之后 |

**字段映射（Collection v2.x → 本模型）**：

| Postman | 本模型 |
| --- | --- |
| `info.name` / `description` | 新建项目的名称 / 说明（也可以导入到已有项目下，作为一个文件夹） |
| `variable[]` | 项目变量 |
| 顶层的 `auth` / `event` | 顶层文件夹（或项目）的鉴权 / 脚本 |
| 含 `item` 的 item | `folders`，递归处理，保留顺序 |
| 含 `request` 的 item | `apis` |
| `request.url`（字符串或对象） | 统一取 `url.raw`；如果只有对象，从 `protocol/host/path/query` 拼出来；`url.variable` → 路径参数 |
| `request.header[]` / `url.query[]` 的 `disabled` 字段 | 保留成 `enabled=false` |
| `request.body.mode` | `raw`（带 `options.raw.language`）、`urlencoded`、`formdata`（text / file + `src`）、`file`、`graphql` 分别对应 |
| `request.auth` | 转换后保存；不支持的类型原样保存 |
| `event[]`（prerequest / test） | `scripts` 字段，只保存不执行 |
| `response[]` | `examples`，其中 `code` → status，`header` → headers，`body` → body，`source='imported'` |
| `description`（字符串或 `{content,type}`） | 统一转成 markdown 字符串 |

**导出**：保留「导出成 Postman v2.1」，方便用户随时迁回去，也能增加信任。导入 → 导出应尽量无损：不认识的字段放进各实体的 `extra` JSON 列里，原样带回。

**导入时的其他细节**：

- 导入前先预览：显示文件夹数、接口数、示例数、未支持的鉴权类型和脚本数量，用户确认后才写库。
- 同名项目提供「新建 / 合并」两种选择。
- 用事务包住，中途失败整体回滚。

同一套导入框架顺带能接：cURL 和 OpenAPI（这两个已经有了）、Insomnia v4、HAR（浏览器导出的录制文件，天然适合批量生成示例）。

---

## 7. 用户 / 项目 / 权限

**已定（D1）：管理台始终要求登录，没有免登录模式；后台提供用户管理。**

- **第一个管理员**：库里还没有任何用户时，启动过程自动创建 `admin` 账号，随机密码只在终端打印这一次。忘记密码时用命令行 `mock user reset-password <用户名>` 重置：能在本机敲命令，就说明有权限。
- **登录方式**：session cookie（`HttpOnly`、`SameSite=Lax`），session 存 sqlite。密码用 Node 自带的 `crypto.scrypt` 加盐哈希，不加新依赖。同一用户名连续失败 5 次，锁定 1 分钟。
- **系统角色**：`admin` / `member`。只有 admin 能管理用户：新建、禁用、重置密码、改角色、删除。不能删除或降级自己，也不能删除最后一个 admin。
- **监听地址**：默认只监听 `127.0.0.1`，要给局域网用就加 `--host 0.0.0.0`。反正都要登录，开放局域网不再需要额外开关。
- **项目权限**：按项目分三档角色，owner / editor / viewer。viewer 可以查看和发请求，不能修改。P1 只建表、默认项目自动把所有用户按 editor 对待；真正按角色拦截放到 P6。
- **mock 接口本身不鉴权**（被测试的前端要能直接访问），只有管理台接口 `/__admin/api/*` 需要鉴权。
- **环境变量里的敏感值**（Postman 的 `type: "secret"`）：界面上打码显示，但第一版仍明文存库。这一点要在文档里写清楚。

---

## 8. 分期建议

| 阶段 | 内容 | 依赖 |
| --- | --- | --- |
| **P0**（进行中） | SQLite 替换 `routes.json`（另一个会话在做） | — |
| **P1 数据底座** | 新数据模型加迁移机制；DAO 改为按表增删改查；登录与用户管理接口；老的 routes 迁成 apis + examples；mock 运行时改读新模型 | P0，D3 / D4 / D5 |
| **P2 前端重构** | Vue 3 + Vite 工程骨架；左侧目录树、多标签页、环境切换；把现有的接口编辑、mock 配置功能搬过去 | D2 |
| **P3 请求执行器** | `/send` 接口、执行器、历史记录、环境变量替换、鉴权 | P1 |
| **P4 Postman 导入导出** | Collection v2.0 / v2.1 加 Environment / Globals 的导入；导出 v2.1 | P1 |
| **P5 调通即 mock** | 保存为示例、智能模板化、期望匹配、项目级 mock 前缀 | P1, P3 |
| **P6 项目权限** | 项目成员与 owner/editor/viewer 按角色拦截（登录与用户管理已提前到 P1/P2） | P1, D1 |
| **P7 扩展** | Cookie 自动管理、代理、GraphQL 辅助、SSE / WebSocket、HAR 导入、脚本子集 | — |

P2 和 P3 / P4 可以并行：后端的执行器和导入器先按接口约定开发，前端随后接上。

---

## 9. 风险与注意

- **Node 版本要求提高。** `node:sqlite` 在 22.13 之后才能不加标志使用，从 Node 24 起转为稳定。需要在 `package.json` 里加上 `engines` 字段，并在 README 里写明。
- **和现有使用方式的兼容。** `mock start` 加 `router.js`、`routes.json`、`{{@...}}` 模板语法，都必须继续可用。老用户是学前端的新手，不能让他们一升级就用不了。
- **大改的冲突风险。** 前端重构（P2）期间不要再往 `lib/web/app.js` 里加功能，否则两边都要改。
- **当前 sqlite 改造的定位。** 它是「全量读写」的过渡方案，P1 会把它换掉。建议那个会话按现在的范围收尾，不要继续往那套方案里加功能。

## 参考

- [Postman Collection v2.1 JSON Schema](https://schema.postman.com/json/collection/v2.1.0/collection.json)
- [Postman schema v2.0 vs v2.1 差异](https://www.diffchecker.com/M2q0WZPd)
- [Node.js sqlite 文档](https://nodejs.org/api/sqlite.html)
- [Bruno vs Hoppscotch](https://www.usebruno.com/compare/bruno-vs-hoppscotch)
- [Yaak：Postman alternatives](https://yaak.app/postman-alternatives)
- [Apifox 高级 Mock 用例文档](https://2jetwix0tz.apifox.cn/1)
