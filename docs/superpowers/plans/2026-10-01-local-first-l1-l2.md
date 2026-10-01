# 本地优先 L1（本机数据库和未登录模式）+ L2（云端同步接口）实施计划

> 执行方式：session1 做 Task 1、2、3、6、7（后端，按这个顺序），session2 做 Task 4、5（前端，Task 3 的接口定下来就能开始）。
> **每个 Task 一个提交，只提交、不推送。提交时只写自己改的路径：`git commit -- <路径>`。** 共享工作区里还有别人的改动，不要 `git add .`、`git add web/src` 这种宽泛的写法。改了前端的提交，提交前重新 `npm run build:web`，并把 `lib/web` 一起提交。

**目标：**
- L1：装好本机 apiloop 后可以跳过登录，完全在本机使用，数据存在本机；mock 地址改成 `/mock-<项目ID>/`；云端地址打包时写死。
- L2：云端记录每一行数据的版本和变化，提供拉取和推送接口，给 L3 的同步引擎用。

**设计稿：** `docs/design/2026-10-01-local-first.md`。和设计稿不同的地方，以本计划为准（设计稿已同步修改）：
1. **删除不打标记，改用触发器加删除记录**（设计稿原来是 5.1 的 `deleted` 列）。行照常真删；6 张同步表上的 SQLite 触发器在每次插入、修改、删除时，自动把 `rev` 加一，并往 `changes` 表写一条记录，删除的记录 `deleted = 1`。
   - 这样现有的查询一个都不用改，没有「漏加 `deleted = 0`」的风险；
   - 也没有「某个写入路径绕过仓储层」的风险，外键级联删掉的子行同样有记录。
2. **上传的文件不按空间分目录：** 仍然放在 `<数据目录>/files/<项目ID>/`。项目 ID 全局唯一，不同空间的文件本来就不会混。
3. **L1 的模式切换：** 网关记一个「当前模式」，`local` 或 `cloud`。本机模式下页面读写本机库；登录成功后切到云端模式，和现在的转发一样。L1 **不上传**本机数据：登录后看到的是云端的项目，本机的项目留在本机库里，L3 上线后自动上传。

**技术栈：** Node 22.13+ 内置 `node:sqlite`、Express 4、Vue 3 + naive-ui。不加新依赖。

## 全局约定

- **不写新测试。** 每个 Task 跑 `npm test`（71 个），必须全过。既有测试因为接口变化失效，改测试算维护。
- 需要验证的，用一次性脚本：放在系统临时目录，跑完删掉，回报里贴结果。
- 界面行为由用户确认。回报写「代码写完、既有测试通过、审阅过，UI 行为待你确认」。
- 用户看得到的文字一律中文。
- 安装包里的 node 不能被重新签名（打包脚本自己会核对 sha256 和 TeamIdentifier）。

## 审阅重点

1. **本机模式下，任何管理台请求都不能漏到云端去，云端模式下也不能落到本机库。** 唯一的例外是本机模式下的 `POST /auth/login`。
2. **本机用户不能用密码登录**：`password_hash` 为空字符串，`/auth/login` 用 `local` 加任意密码都必须失败。本机模式下 `/auth/login` 本来就转发给云端，这一条是本机库里的兜底。
3. **触发器：**
   - 外键级联删掉的子行也要有删除记录；
   - 触发器里给 `rev` 加一的那条 UPDATE，不能再次触发自己（`recursive_triggers` 默认是关的，要实测确认）；
   - 推送时显式写入的 `rev` 不能被触发器再加一次。
4. **推送接口不能越权：**
   - viewer 推送一律 `forbidden`；
   - 往别人的项目里塞行（`project_id` 写成别的项目、`api_id` 指向别的项目的接口）一律 `forbidden`；
   - 父级不存在的一律 `invalid`。
5. **mock 地址：**
   - `/mock-<不存在的ID>/x` 交给根项目处理，和现在 slug 不存在时一样；
   - 根项目仍然挂在根路径；
   - WebSocket mock 用的解析规则和 HTTP 相同（都走 `mockHost.resolve`）。

---

## L1

### Task 1（session1）：mock 地址改成 `/mock-<项目ID>/`

**文件：**
- `lib/mock-host.js`
- `lib/admin.js`：`/meta` 的 `mockBase`
- `lib/command.js`：启动时的提示文字

**做什么：**
- `MOCK_PREFIX` 改成 `'/mock-'`。正则改成 `^/mock-([^/]+)((?:/.*)?)$`。`parseMockPath` 返回 `{ projectId, rest }`，不再是 `slug`。
- `projectIdForSlug` 换成按 ID 查（`projectsRepo.getById`）。缓存逻辑照旧：只缓存查到的，项目有变动时清空。
- 改写 `req.baseUrl` 的地方，换成 `MOCK_PREFIX + parsed.projectId`。
- `/meta` 的 `mockBase` 跟着变成 `'/mock-'`。
- `command.js` 里所有 `/mock/<slug>` 的提示，改成 `/mock-<项目ID>`。
- 旧的 `/mock/<slug>` 不再识别，交给根项目处理（根项目里可能就有 `/mock/...` 的接口）。

**回报：** 一次性脚本起一个 `apiloop web`，建两个项目，各配一条 GET `/hello`。贴出这四个请求的结果：
- `/mock-<项目A的ID>/hello`
- `/mock-<项目B的ID>/hello`
- `/mock-不存在/hello`
- 旧的 `/mock/<slug>/hello`

### Task 2（session1）：云端地址打包时写死，去掉设置页

**文件：**
- `agent-installer/mac/build.sh`、`build-all.sh`
- `lib/gateway/index.js`、`lib/gateway/cloud.js`
- `lib/command.js`

**做什么：**
- **打包：**
  - `build.sh` 读环境变量 `APILOOP_CLOUD_URL`，没给就退出并提示 `请用 APILOOP_CLOUD_URL=<云端地址> 指定云端地址`；
  - 用 `cloud.normalizeCloudUrl` 同样的规则校验；
  - 写到安装包里 `app/cloud.json`：`{ "cloudUrl": "<地址>" }`；
  - `build-all.sh` 原样传下去；
  - 打包结束时的自检，加一条核对 `app/cloud.json` 的内容。
- **网关读云端地址的优先级：**
  1. `--cloud` 启动参数；
  2. `<数据目录>/gateway.json` 的 `cloudUrl`；
  3. `<安装目录>/cloud.json`（就是 `path.join(__dirname, '..', '..', 'cloud.json')`）。
  
  前两个只给开发用。`--cloud` **不再写回** `gateway.json`。
- **去掉：**
  - 设置页（`setupPageHtml`、没配地址时接管 `/` 的那段中间件）；
  - `POST /__apiloop/setup`。
  
  三处都取不到地址时，转发返回 503 `{ error: '这个安装包没有配置云端地址' }`。
- **`gateway.json` 改成 `{ cloudUrl?, mode }`：**
  - `mode` 取 `'local'` 或 `'cloud'`，没有时当成 `'cloud'`；
  - 读写函数改成 `readConfig(dataDir) -> { cloudUrl, mode }` 和 `writeConfig(dataDir, patch)`。`writeConfig` 先读出原来的内容，合并后再写回。
- **`GET /__apiloop/status`** 返回 `{ version, cloudUrl, cloudReachable, mode }`。

**回报：**
- 不给 `APILOOP_CLOUD_URL` 时打包的报错；
- 给了以后，展开包，看到的 `cloud.json`；
- 网关三种取地址方式各自生效的一次结果。

### Task 3（session1）：未登录空间和跳过登录

**文件：** 新建 `lib/gateway/space.js`；修改 `lib/gateway/index.js`

**接口：**
- `space.openLocalSpace(dataDir) -> { handle, admin, user }`
  - 打开（必要时新建）`<dataDir>/spaces/local/data.db`，`lib/db` 的 `open` 会跑完全部迁移；
  - 确保本机用户存在：`id: 'u_local'`、`username: 'local'`、`display_name: '本机用户'`、`role: 'admin'`、`password_hash: ''`、`must_change_password: 0`；
  - 库里一个项目都没有时，以本机用户为 owner 建一个「我的项目」；
  - 用 `adminModule.createAdmin({ handle, store: { projectId: null, filePath: '' }, version: pkg.version, rootProjectId: null })` 建管理台路由。本机没有根项目，所有项目的 mock 地址都是 `/mock-<ID>/`；
  - **不要调用 `auth.bootstrapAdmin`。**
  - 同一个进程里只打开一次：第二次调用返回同一个对象。
- `POST /__apiloop/local/enter`（网关路由，要过安全闸门）：
  - 打开本机空间；
  - 用 `auth.createSession(handle, 'u_local', res)` 发会话 Cookie；
  - 把 `mode` 写成 `'local'`；
  - 返回 `{ ok: true, user }`。

**路由（`createGateway` 里，紧跟在安全闸门和 `/__apiloop/*` 之后，排在本机发送、WebSocket、转发之前）：**
- `mode === 'local'` 时，`/__admin/api/*` 全部交给 `localSpace.admin.api`。只有 `POST /__admin/api/auth/login` 例外，照旧转发给云端。
- 本机发送、WebSocket 也走本机管理台里的那一套。它们本来就在这台电脑上执行，等于现在云端自己发送的流程，不用再找云端要上下文。
- 转发 `POST /auth/login` 时，云端返回 2xx 就把 `mode` 写成 `'cloud'`。给 `createForwarder` 加一个可选参数 `onResponse(req, proxyRes)` 来实现。
- `mode === 'cloud'` 时，行为和现在完全一样。
- 网关启动时 `mode` 是 `'local'` 的，在启动时就打开本机空间。

**回报（一次性脚本）：**
- 起网关，`/local/enter` 之后：
  - `/meta` 里 `user.id === 'u_local'`；
  - 建项目、建接口、本机发送一次，目标服务器能收到；
  - `~/.apiloop/spaces/local/data.db` 里有这些数据（脚本里用临时的 `--data-dir`，不要碰真实的 `~/.apiloop`）。
- 本机模式下，用 `local` 加任意密码登录，被云端拒绝，`mode` 不变。
- 用云端真实账号登录，`mode` 变成 `'cloud'`；再请求 `/projects`，返回的是云端的数据。
- 本机模式下故意停掉云端，本机照常能用。

### Task 4（session2）：登录页「跳过登录」、「仅本机」状态、本机模式下的入口

**文件：**
- `web/src/views/LoginView.vue`
- `web/src/api/gateway.js`、`web/src/stores/gateway.js`
- `web/src/components/layout/ConnectionStatus.vue`、`UserMenu.vue`、`InstallDialog.vue`
- `web/src/views/ProjectSettingsView.vue`

**接口：**
- `gatewayApi.enterLocal()`：调 `POST /__apiloop/local/enter`；
- `gateway.mode`：取 status 里的值；
- `gateway.isLocal`：等于 `isGateway && mode === 'local'`。

**做什么：**
- **登录页**（只在网关上）：表单下面加一个链接「跳过登录，先在本机用」。点了调 `enterLocal()`，然后整页刷新到 `#/workbench`。
  - 已经在本机模式、又从菜单进到登录页时，表单上方加一行灰字：「登录后看到的是云端的项目。本机的项目会留在这台电脑上，同步功能上线后会自动上传。」
  - 在网关上登录成功后，**整页刷新**到 `#/workbench`，免得 store 里还留着本机库的数据。
- **顶栏状态**，本机模式下：
  - 灰点「仅本机」；
  - 悬停提示「数据只保存在这台电脑上。登录后可以使用云端的项目」；
  - 点击进入登录页。
- **去掉** 状态菜单里的「云端地址…」和那个设置对话框，以及 `gatewayApi.setup`。
- **头像菜单**，本机模式下只保留：
  - 「登录以同步到云端」（进入登录页）；
  - 「关于」。
  
  隐藏「修改密码」「用户管理」「退出登录」。
- **项目设置**，本机模式下隐藏成员管理那一块。
- **安装对话框第 3 步**（云端打开时），改成「装完可以直接用；要使用云端的项目就登录」。去掉现在那句"第一次打开要填云端地址"。

### Task 5（session2）：mock 地址显示改成新格式

**文件：**
- `web/src/components/mock/MockPanel.vue`、`MockLogDrawer.vue`
- `web/src/components/layout/ProjectSwitcher.vue`、`AboutDialog.vue`
- `web/src/views/ProjectSettingsView.vue`

**做什么：**
- 拼 mock 地址统一写成 `project.isRoot ? '' : '/mock-' + project.id`。抽成一个函数 `mockPrefix(project)` 放到 `web/src/utils/mock.js`，两个组件都用它。
- 本机模式（`gateway.isLocal`）下，mock 地址的位置显示「登录后可用」，不显示地址，也不显示复制按钮。
- 去掉新建项目、项目设置里的「标识」输入框（不再用于 mock）。
- 关于对话框里的 mock 前缀，显示成 `/mock-<项目ID>/`。

---

## L2（session1，在 Task 3 之后）

### Task 6（session1）：迁移 v7——版本号、变更记录、触发器

**文件：** `lib/db/migrations.js`；新建 `lib/sync/purge.js`；`lib/command.js`（`web` 模式启动时调用清理）

**迁移 v7：**
- `projects`、`environments`、`folders`、`apis`、`examples`、`mock_expectations` 各加一列 `rev INTEGER NOT NULL DEFAULT 1`。
- 新表：
  ```sql
  CREATE TABLE changes (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT,
      entity TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      rev INTEGER NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0,
      at INTEGER NOT NULL
  )
  ```
  - `CREATE INDEX idx_changes_project ON changes(project_id, seq)`；
  - `entity` 取值：`project`、`environment`、`folder`、`api`、`example`、`expectation`。
- **每张表三个触发器**，下面以 `<T>` 表示表名，`<E>` 表示实体名，`<P>` 表示项目 ID 的表达式：
  - `<P>`：
    - `projects` 用 `id`；
    - `environments`、`folders`、`apis` 用 `project_id`；
    - `examples`、`mock_expectations` 用 `(SELECT project_id FROM apis WHERE id = NEW.api_id)`，删除时用 `OLD.api_id`。
    - 接口被级联删除时，这里可能取到 NULL。这种可以接受：接口自己那条删除记录会让 L3 把它的子行一起删掉。
  - `AFTER INSERT`：写一条 `changes`，`rev` 取 `NEW.rev`，`deleted` 为 0。
  - `AFTER UPDATE`：
    1. 先执行 `UPDATE <T> SET rev = OLD.rev + 1 WHERE id = NEW.id AND NEW.rev = OLD.rev`。推送时显式改了 `rev` 的，就不再加；
    2. 再写一条 `changes`，`rev` 取 `(SELECT rev FROM <T> WHERE id = NEW.id)`。
  - `AFTER DELETE`：写一条 `changes`，`rev` 取 `OLD.rev`，`deleted` 为 1。
  - `at` 写 `CAST(strftime('%s','now') AS INTEGER) * 1000`。
- `meta` 里加 `sync_min_seq`，初始为 `'1'`。

**清理（`lib/sync/purge.js`）：** `purgeChanges(handle, now) -> { removed, minSeq }`
- 删掉 `at` 早于 30 天前的变更记录；
- 把 `sync_min_seq` 更新成剩下记录里最小的 `seq`。全删光了就用「当前最大 seq + 1」。
- 由 `apiloop web` 启动时调用一次，之后每 24 小时一次（定时器要 `unref`）。

**回报（一次性脚本）：**
- 通过现有接口新建项目、目录、接口、示例、期望：每一行都有一条 `deleted = 0` 的记录；
- 改一次接口：`rev` 从 1 变成 2，记录里也是 2；
- 删除一个带子目录和接口的目录：每个被删的行都有一条 `deleted = 1` 的记录；
- 删除项目：所有子行都有删除记录；
- 实测 `recursive_triggers`：改一次接口，`rev` 只加一；
- 老库升级到 v7：已有行的 `rev` 都是 1；
- 清理：手工把一部分记录的 `at` 改到 31 天前，`purgeChanges` 删掉的正是这些，`sync_min_seq` 正确。

### Task 7（session1）：同步接口

**文件：** 新建 `lib/sync/index.js`（路由）、`lib/sync/rows.js`（各实体的列清单、读写）；修改 `lib/admin.js`（`createAdmin` 新增选项 `sync: true` 时才挂载）、`lib/command.js`（`web` 模式传 `sync: true`）。网关的本机管理台**不挂**这些接口。

**行的格式：** 和数据库里的列一一对应的「原始行」，列名用下划线写法（`project_id`、`folder_id`），JSON 列保持字符串。`rows.js` 里给每个实体写死可同步的列清单：
- 全部可同步，除了下面这些由服务端决定的列：
  - 所有表的 `rev`：只读；
  - `projects` 的 `source_dir`、`is_default`、`created_by`、`slug`；
  - `apis`、`projects` 的 `updated_at`：服务端写当前时间；
  - `created_at`：新建时用推上来的值，更新时不改。

**接口**（都挂在 `requireLogin` 和 `requirePasswordChanged` 之后）：
- **`GET /__admin/api/sync/state`**：
  ```json
  { "seq": 当前最大 seq, "minSeq": sync_min_seq,
    "projects": [{ "id", "role" }],
    "members": [{ "projectId", "userId", "role" }],
    "users": [{ "id", "username", "displayName", "role", "disabled" }] }
  ```
  - `projects` 用 `access.visibleProjects`；
  - `users` 是这些项目的成员，再加上自己。
- **`GET /__admin/api/sync/projects/:pid/snapshot`**（viewer 以上）：
  ```json
  { "seq", "rows": { "project": [...], "environment": [...], "folder": [...], "api": [...], "example": [...], "expectation": [...] } }
  ```
  `seq` 和所有行要在同一个事务里读出来。
- **`GET /__admin/api/sync/changes?since=<seq>&limit=<1-1000，默认 500>`**：
  - `since < minSeq - 1` 时，返回 410 `{ ok: false, code: 'SYNC_RESET', error: '太久没有同步，需要重新下载' }`；
  - 否则返回 `{ items: [{ seq, entity, id, projectId, rev, deleted, row }], nextSeq, hasMore }`；
  - 只返回这个用户能看到的项目里的变化（`project_id` 为 NULL 的不返回）；
  - `row` 是这一行**当前**的原始行。已经不存在的，`row` 为 null。
- **`POST /__admin/api/sync/push`**，请求体 `{ items: [{ entity, id, baseRev, row, deleted }] }`，最多 200 条：
  - 按顺序处理，每条一个事务，一条失败不影响其他条；
  - 返回 `{ results: [{ entity, id, status, rev?, row?, error?, recreated? }] }`，`status` 取 `ok`、`conflict`、`forbidden`、`invalid`。
  - **项目归属：**
    - 从推上来的行里找所属项目：`project.id`、`row.project_id`，或者沿 `api_id` 找到接口所在的项目；
    - 新建时以推上来的为准，更新时以库里现有的为准。两者不一致时返回 `forbidden`。
  - **权限：**
    - 新建项目：登录就行，当前用户成为 owner（`access.addOwner`）；
    - 改项目名：owner；
    - 删除项目：owner；
    - 其他：所在项目的 editor 以上；
    - 不够的返回 `forbidden`。
  - **父级校验：**
    - `folder.parent_id`、`api.folder_id` 必须为空，或者是同一个项目里存在的目录；
    - `example.api_id`、`expectation.api_id` 必须是存在的接口；
    - `expectation.example_id` 必须为空，或者是同一个接口下的示例；
    - 不满足的返回 `invalid`，附原因。
  - **规则**（`cur` 是库里现有的行）：

    | 情况 | 处理 |
    |---|---|
    | `deleted`，`cur` 不存在 | `ok`（已经删了） |
    | `deleted`，`cur.rev !== baseRev` | `conflict`，附 `cur` |
    | `deleted`，`rev` 对得上 | 删除，`ok` |
    | `cur` 不存在，`baseRev === 0` | 新建，`ok`，附新的 `rev` |
    | `cur` 不存在，`baseRev > 0`（云端删了，本机改了） | 用推上来的行重新建出来，`ok`，附 `recreated: true` |
    | `cur` 存在，`baseRev === 0`（上传重试） | 可同步的列都和推上来的一样，就 `ok`，附 `cur.rev`；否则 `conflict` |
    | `cur.rev !== baseRev` | `conflict`，附 `cur` |
    | `rev` 对得上 | 只更新可同步的列，`ok`，附新的 `rev` |

  - 新建项目时 `slug` 用 `projectsRepo` 现有的生成唯一 slug 的逻辑。
  - 写入后照常 `handle.events.emit('change', ...)`（用 `handle.transaction(fn, { projectId })`），让 mock 运行时重新加载。

**回报（一次性脚本，起一个 `apiloop web`，用两个账号）：** 贴出下面每一项的结果：
1. state、snapshot、changes 的返回；`since` 太旧时返回 410；
2. 推送新建项目、目录、接口、示例：都是 `ok`，云端网页上能看到；
3. 用旧的 `baseRev` 推送：`conflict`，并附云端当前那一行；
4. viewer 推送：`forbidden`；把 `project_id` 写成别人的项目：`forbidden`；
5. 父目录不存在：`invalid`；
6. 云端已经删掉的接口，用 `baseRev > 0` 推上去：`recreated: true`；
7. 同一批新建推两次：第二次全部 `ok`，而且没有重复的行；
8. 推送之后，`changes` 里有对应的记录。

---

## 不在这次范围

- L3（同步引擎、账号空间、登录时上传、离线登录）、L4（同步界面）。
- Windows 安装包。

---

## 追加：内置 Mock 环境（2026-10-01 用户提议）

用户：「每个项目默认环境里加一个 mock 环境，host 地址直接放进去」。做法参考 Apifox 自动生成的「云端 Mock」环境：**不存库、只读、地址自动算**。如果存成普通环境，以后云端上外网，地址就过期了；而且会被误改、误删，还要参与同步。变量名固定为 `host`（用户：「基本是叫 host」）。

**后端已完成（d815c68，审阅方写的）：**
- 发送（`/send`、`/send/stream`、`/send/prepare`）和 WebSocket（`POST /projects/:pid/ws`）的请求体里，`environmentId: 'mock'` 再加上 `mockBase: '<mock 地址>'`，服务端就临时拼出环境 `{ host: mockBase }`；
- 缺少 `mockBase` 或格式不对，返回 400「Mock 环境缺少有效的 mock 地址（mockBase）」；
- WebSocket 会自动把协议换成 `ws` / `wss`；
- 脚本对这个环境的修改不落库，历史里记的 `environmentId` 仍是 `'mock'`。

### Task 8（session2）：环境下拉里的「Mock」

**文件：**
- `web/src/utils/mock.js`
- `web/src/stores/env.js`、`web/src/components/layout/EnvSwitcher.vue`
- `web/src/stores/tabs.js`（发送）、`web/src/stores/ws.js` 或 `web/src/components/ws/WsTab.vue`（WebSocket 建会话）

**接口：**
- `mockBaseUrl(project) -> string`，放在 `utils/mock.js`：
  - 网关上用 `gateway.cloudUrl`，直接打开云端时用 `window.location.origin`；
  - 去掉末尾的 `/`，再接上 `mockPrefix(project)`；
  - 根项目就是云端地址本身。
- `env.js` 导出 `MOCK_ENV_ID = 'mock'`。`selectedId === 'mock'` 时，`selected` 返回一个虚拟环境：
  ```js
  { id: 'mock', name: 'Mock', builtin: true, variables: [{ key: 'host', value: mockBaseUrl(当前项目), enabled: true }] }
  ```
  - 变量高亮、悬停看值、缺失变量提示都走 `selected`，不用另外改；
  - `load()` 恢复上次选中的环境时，要认得 `'mock'`；本机模式下恢复成「无环境」。

**界面（EnvSwitcher）：**
- 「无环境」下面固定一项「Mock」，后面一个小标签「内置」；
- 选中后，下面的变量区显示 `host` 和它的值，**没有「编辑」**；
- 本机模式（`gateway.isLocal`）下，这一项是灰的，显示「Mock（登录后可用）」，不能选；
- 双击选中的行为和其他环境一样；
- 「管理环境」页面里不列它。

**发送：**
- `tabs.js` 的 `sendRequest`，以及 WebSocket 建会话时：`environmentId === 'mock'` 就在请求体里加上 `mockBase: mockBaseUrl(当前项目)`；
- 从历史里重放 `environmentId` 是 `'mock'` 的请求时，选中 Mock（本机模式下选「无环境」）。

**回报：**
- 一个地址写成 `{{host}}/xxx`、开了 mock 的接口，切到 Mock 环境发送，响应是 mock 数据，「请求」页里实际的地址是 `<云端>/mock-<项目ID>/xxx`；
- 切回普通环境，发往真实地址。
