# 接入阶段：管理台接口 v2 后端实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **本项目约定（覆盖上面 skill 的默认做法）**
> - **不写新测试**。每个任务结束都要跑一遍既有的 `npm test`，必须全部通过；既有测试因接口变化而失效的，修改它们属于维护。
> - 自测用一次性脚本，用完删掉，不提交。
> - **提交时只提交自己改过的文件**：`git commit -m "..." -- <文件...>`。禁止 `git add -A`、`git add .`、`git commit -a`，因为另一个会话在同一个工作区里做 P2 前端。

**目标**：按接口契约实现新版管理台后端，把 P3/P4 的执行器和 Postman 模块接到数据库和 HTTP 接口上。

**架构**：
- 新接口按资源拆到 `lib/api/*.js`，每个文件导出 `createRouter(ctx)`。`admin.js` 在 `requireLogin` 之后、旧接口之前挂载它们。
- 涉及多张表的业务逻辑（目录树移动、级联删除、树的导入导出）放在 `lib/tree.js`，路由文件保持轻薄。
- 所有写操作都包在 `handle.transaction(fn, { projectId })` 里。这样才会触发事件，mock 运行时才会刷新。

**技术栈**：沿用现有技术，不加新依赖。

**依据**：
- **接口契约**：[docs/design/2026-09-30-admin-api-v2.md](../../design/2026-09-30-admin-api-v2.md)，所有路径、字段名、状态码和规则都以它为准。
- **上游设计**：[调研文档](../../design/2026-09-30-api-workbench-research.md)。

## 全局约束

- **文件范围**：可以改 `lib/**`（`lib/web/**` 除外）、`test/**`、`README.md`。**不许动** `lib/web/**`、`web/**`、`package.json`，这些归 P2 会话。
- **写操作必须带项目 id**：每个会改动某个项目数据的写操作，都要带上正确的 `projectId`，这样 mock 运行时才会刷新；会影响多个项目的操作，比如删除项目，传 `null`。
- **发送请求必须限制文件读取范围**：`/send` 调执行器时**必须**传 `fileRoots`，不传就等于允许读取机器上的任意文件。
- **错误提示对用户友好**：接口返回的错误信息用中文、给人看得懂，不要把堆栈返回给前端。未预料的异常返回 500，信息写「服务端出错：<err.message>」。
- **数据目录统一取常量**：用 `appInfo.DATA_DIR`，不要自己拼 `~/.apiloop`。

## 审阅重点

审阅时我会逐条推演下面这些场景，你实现时要保证它们的行为如描述所示：

1. **在新接口里改了根项目的接口，mock 立刻生效**：`PUT /apis/:id` 之后，`/api/xxx` 马上返回新内容。靠的是事务上的 `projectId`，以及 project-stores 缓存的刷新。
2. **目录移动的边界情况**：把目录移进它自己或它的子孙目录，要返回 400；把 `index` 设得超过同级节点数量，要放到末尾；移动后，原父目录和新父目录下的 position 都要连续（0..n-1）。
3. **删除一个中间层目录（选「移到父目录」）**：它的子目录和接口都要挂到它的父目录下，原有的相对顺序保留，并排在父目录已有同类节点的后面。
4. **发送请求时浏览器中途断开**：执行器要被取消，同时仍然写入一条 `errorCode` 为 `ABORTED` 的历史，进程不能出现未处理的异常。
5. **导入 Postman 到一半出错**（比如第 50 个接口写库失败）：项目不能留下半截，因为整个导入包在一个事务里。
6. **旧版管理台和新接口同时在用**：旧 UI 编辑一个位于**嵌套目录**里的接口时，不能把它挪到一个新建的同名顶层目录（见 Task 3 Step 4）。

---

## 文件结构

| 文件 | 动作 | 职责 |
| --- | --- | --- |
| `lib/db/migrations.js` | 修改 | 追加迁移 v2 |
| `lib/db/repos/environments.js`、`history.js` | 新建 | 两张表的增删改查 |
| `lib/db/repos/examples.js`、`projects.js` | 修改 | 支持新增的列 |
| `lib/api/respond.js` | 新建 | `ok`、`fail`、`wrap(handler)`（把同步抛出的异常统一转成 JSON 错误）、`notFound(res, what)` |
| `lib/api/dto.js` | 新建 | repo 对象转 DTO：`toProjectDto`、`toApiDto`、`toApiSummary`，以及入参清洗函数 |
| `lib/api/projects.js`、`tree.js`、`environments.js`、`send.js`、`postman.js` | 新建 | 各组接口的路由 |
| `lib/tree.js` | 新建 | 目录树业务逻辑：移动、删除目录、复制接口、树的读取与写入 |
| `lib/routes-store.js` | 修改 | 旧接口适配层对嵌套目录的修正 |
| `lib/admin.js`、`lib/command.js` | 修改 | 挂载新接口、传入 `rootProjectId`、`/meta` 新增字段 |

---

### Task 1: 迁移 v2 和两个新 repo

**文件**：修改 `lib/db/migrations.js`、`lib/db/repos/examples.js`、`lib/db/repos/projects.js`；新建 `lib/db/repos/environments.js`、`lib/db/repos/history.js`

**接口**：
- **迁移 v2**（只追加，不改 v1）：
  - `ALTER TABLE examples ADD COLUMN extra TEXT NOT NULL DEFAULT '{}'`
  - `ALTER TABLE projects ADD COLUMN auth TEXT`
  - `ALTER TABLE projects ADD COLUMN scripts TEXT NOT NULL DEFAULT '[]'`
  - `ALTER TABLE projects ADD COLUMN extra TEXT NOT NULL DEFAULT '{}'`
  - `CREATE INDEX IF NOT EXISTS idx_history_project ON history(project_id, id)`
  - `CREATE INDEX IF NOT EXISTS idx_environments_project ON environments(project_id, position)`
- **examples**：行对象加上 `extra`（读的时候兜底为 `{}`），`insert` 和 `update` 都支持写 `extra`。
- **projects**：行对象加上 `auth`（可以为 null）、`scripts`、`extra`；`create` 和 `update` 都支持写这三个字段。
- **environments**：
  - `list(h, projectId)`，按 position 排序
  - `get(h, id)`
  - `create(h, projectId, { name, variables? })`，id 前缀为 `env`，position 取当前最大值加 1
  - `update(h, id, patch)`，可改 name 和 variables
  - `remove(h, id)`
- **history**：
  - `insert(h, { projectId, apiId?, userId?, request, response }) -> id`，写完后执行 prune：只保留该项目最新的 500 条
  - `list(h, projectId, { limit, before })`，返回摘要字段（见契约第 5 节）；摘要从 `response` 的 JSON 里取：`status = result.response ? result.response.status : null`，`errorCode = result.error ? result.error.code : null`，`totalMs = result.timings.total`
  - `get(h, id)`
  - `clear(h, projectId)`
- **history 表的存储约定**：`request` 列存 `{ spec, environmentId }`，`response` 列存 ExecResult，都是 JSON。

- [ ] **Step 1**：实现以上内容。
- [ ] **Step 2**：自测一个关键场景：找一个 P1 时期（v1）的库，打开时能自动迁移到 v2，原有数据完好；再打开一次不会重复执行迁移。
- [ ] **Step 3**：`npm test` 全部通过后提交：`feat(db): 迁移 v2 与 environments / history repo`

---

### Task 2: 路由骨架、项目、环境、/meta

**文件**：新建 `lib/api/respond.js`、`lib/api/dto.js`、`lib/api/projects.js`、`lib/api/environments.js`；修改 `lib/admin.js`、`lib/command.js`、`test/server.test.js`（只在需要传 `rootProjectId` 的地方改）

**接口**：
- `createAdmin({ handle, store, version, rootProjectId })`：`rootProjectId` 缺省时取 `store.projectId`。
- 新接口路由统一接收 `ctx = { handle, rootProjectId }`。
- `dto.toProjectDto(project, ctx)`：补上 `isRoot` 字段，去掉 `scripts` 和 `extra`，前端不需要这两个。

- [ ] **Step 1: 按契约第 2、4、7 节实现接口**
  - 删除项目时，先检查是不是 admin（403），再检查是不是根项目或默认项目（400）。
  - 删除项目的事务 `projectId` 传 `null`。
  - 删除项目后，从 project-stores 的缓存里移除这个项目的 store。在 `project-stores.js` 里新增 `forget(handle, projectId)`：先调用 store 的 `close()`，再从 Map 里删掉。
- [ ] **Step 2: 挂载**
  - 在 `admin.js` 的 `api.use(auth.requireLogin)` 之后、`/meta` 之前，依次 `api.use(projects.createRouter(ctx))` 和 `api.use(environments.createRouter(ctx))`。
  - `command.js` 在调用 `createAdmin` 时传入 `rootProjectId`。
- [ ] **Step 3**：`npm test` 全部通过后提交：`feat(api): 项目与环境接口`

---

### Task 3: 目录树、接口、示例

**文件**：新建 `lib/tree.js`、`lib/api/tree.js`；修改 `lib/routes-store.js`

**接口**：`lib/tree.js` 里的函数都**不开事务**，由调用方负责包事务。
- `listTree(h, projectId) -> { folders, apis }`，按契约的排序规则排好
- `move(h, projectId, { kind, id, parentId, index })`
- `removeFolder(h, folderId, mode: 'move' | 'delete')`
- `duplicateApi(h, apiId) -> newApiId`
- `ancestors(h, folderId) -> Folder[]`：从近到远排列，供 Task 4 的鉴权继承使用

- [ ] **Step 1: `move` 的算法**
  1. 校验目标父目录属于同一个项目。
  2. 如果是目录，校验目标父目录不是它自己，也不在它的子孙里：从目标父目录沿着 `ancestors` 向上找，碰到它自己就返回 400。
  3. 取出目标父目录下的同类节点，先把被移动的节点拿掉，再按 `index` 插进去（超出范围就放到末尾），然后把 position 重写为 0..n-1。
  4. 如果是跨父目录移动，原父目录下的同类节点也要重写 position。
- [ ] **Step 2: `removeFolder` 的规则**
  - `move` 模式：把直接子目录和直接子接口挂到被删目录的父目录下，放在父目录现有同类节点之后，保留它们原有的相对顺序，然后删除这个目录。
  - `delete` 模式：先删掉所有子孙目录下的接口，再删目录本身。子目录靠外键 `ON DELETE CASCADE` 一起删掉，但 apis 表的 `folder_id` 是 `SET NULL`，所以接口**必须先删**，否则会变成游离在根目录的接口。
- [ ] **Step 3: 按契约第 3 节实现接口路由**
  - `PUT /apis/:id` 的「mock.path 跟随规则」和「启用 mock 的前提」按契约原文实现。
  - `DELETE /examples/:id` 时 mock 设置怎么处理，也按契约原文实现。
  - `POST /projects/:pid/import/routes` 复用 `routesStore.insertRoutes`；传了 `folderId` 时，把每条 route 的 group 置空，写入后再把新建的这些接口的 `folderId` 改成传入的值，这两步在同一个事务里完成。
- [ ] **Step 4: 修正旧接口适配层对嵌套目录的处理**
  - **问题**：`routes-store.js` 的 `update` 里，`folderIdForGroup(route.group, true)` 只在顶层目录里按名字查找。一个位于嵌套目录下的接口，它的 group 显示的是嵌套目录的名字；旧版 UI 一保存，就会新建一个同名的顶层目录，并把接口移过去。
  - **修法**：如果 `route.group` 等于该接口当前所在目录的名字，就保留当前的 `folderId`，否则才按原逻辑查找或新建。
- [ ] **Step 5**：`npm test` 全部通过后提交：`feat(api): 目录树、接口与示例接口`

---

### Task 4: 发送、历史、文件上传

**文件**：新建 `lib/api/send.js`

- [ ] **Step 1: `/send` 按契约第 5 节的 5 个步骤实现**
  - 从 `/send` 进来时，`request` 要先经过 `dto` 的清洗函数，把 `params`、`body` 补齐成完整形状。
  - 鉴权继承用 `tree.ancestors`，需要读取目录和项目的 `auth`。
  - `fileRoots` 里的 `<DATA_DIR>/files/<pid>`，这个目录不存在就先创建。
  - 用 `new AbortController()`，在 `res.on('close')` 里判断 `!res.writableEnded` 后调用 `abort()`。
  - 写历史的事务**不传** change（不会影响 mock 路由），写成 `handle.transaction(fn)`。
- [ ] **Step 2: 历史接口**：按契约实现，`limit` 默认 50、最大 200。
- [ ] **Step 3: 文件上传**
  - 只在这一条路由上用 `express.raw({ type: 'application/octet-stream', limit: '50mb' })`。
  - 注意外层 api 已经挂了 `express.json`，它只处理 JSON 类型，不会干扰这里。
  - `X-Filename` 解码失败时返回 400。
- [ ] **Step 4: 自测**
  - 在本机起一个 http 服务作为目标，走完「登录 → 建项目 → 建环境 `{{host}}` → send」整个流程。
  - 验证鉴权继承：给目录设置 bearer，接口的 auth 为 null，目标服务应该收到 token。
  - 浏览器中途断开：用 `AbortController` 让 fetch 在 100ms 后取消，对应一个延迟 2 秒才响应的目标，确认历史里记下的是 `ABORTED`。
  - 越界文件：给 `src` 传 `/etc/hosts`，应该返回 `FILE` 错误。
- [ ] **Step 5**：`npm test` 全部通过后提交：`feat(api): 发送请求、历史与文件上传`

---

### Task 5: Postman 导入导出

**文件**：修改 `lib/tree.js`（新增两个函数）；新建 `lib/api/postman.js`

**接口**：
- `tree.writeTree(h, projectId, parentFolderId, children: Node[]) -> { folders, apis, examples }`（返回数量统计），不开事务
  - 递归写入目录、接口和示例；`Node` 的形状见 `lib/postman.js` 的 parse 结果。
  - 接口的 mock 设置按契约第 6 节的规则处理。
- `tree.readTree(h, projectId) -> { children: Node[] }`：按契约的排序规则组装，输出的形状可以直接交给 `postman.toCollection`。

- [ ] **Step 1**：实现这两个函数。示例的 `extra` 读写对应迁移 v2 新增的列。
- [ ] **Step 2**：按契约第 6 节实现 4 个接口。整个导入放在一个事务里；`mode: 'new'` 时事务的 `projectId` 传 null，`into` 模式传目标项目的 id。
- [ ] **Step 3: 自测**
  - 手写一个集合：两层目录、带示例、带 bearer 鉴权、带脚本、`info` 里带 `_exporter_id`。
  - 走「导入 → 导出 → `postman.parse` → 和第一次 parse 的结果比较」，要求深度相等，`warnings` 允许不同。
  - 导入后访问 `/mock/<slug>/<某个接口的路径>`，应该返回示例的 body。
- [ ] **Step 4**：`npm test` 全部通过后提交：`feat(api): Postman 导入导出`

---

### Task 6: README

- [ ] 在 README 的管理台接口表里补上 v2 接口：按契约的章节分组列出，每组只列路径和一句话说明，详细内容链接到契约文档。旧接口标注「旧版管理台使用，P2 之后移除」。
- [ ] `npm test` 全部通过后提交：`docs: README 补充管理台接口 v2`

---

## 完成后回报

- 每个 Task 的提交号；
- 自测中发现的、契约没有覆盖到的情况（列出来，由我决定是否修订契约）。
