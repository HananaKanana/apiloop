# P1 数据底座：全局库 + 项目 + 登录 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **本项目约定（覆盖上面 skill 的默认做法）**：**不写新测试**，计划里没有「先写失败的测试」这类步骤。既有测试 `npm test` 每个任务结束都要全绿；既有测试因为接口变了而失效，就改它，这属于维护，不算新写。UI 行为不用你验证，交给用户。

**Goal:** 把存储从「每个目录一个 routes.db」换成「全局一个库、库里有多个项目」；接口按「接口 + 示例」建模；管理台加上登录和用户管理接口。现有管理台和 `mock start` / `router.js` 的使用方式保持可用。

**Architecture:**
- **数据访问**：`lib/db/` 负责连库、迁移、事务和进程内变更广播，各张表的读写放在 `lib/db/repos/*`。
- **兼容层**：`lib/routes-store.js` 改成「单个项目的门面」，对外接口保持不变，所以 `admin.js` 和前端基本不用动。
- **mock 挂载**：新增 `lib/mock-host.js`，把每个项目挂在 `/mock/<slug>`，并把「根项目」挂在 `/`。
- **登录**：`lib/auth.js` 提供密码哈希、session 和两个中间件；登录和用户管理的接口挂在 `/__admin/api/auth/*`、`/__admin/api/users/*`。

**Tech Stack:** Node ≥ 22.13（`node:sqlite` 的 `DatabaseSync`）、Express 4、`crypto.scrypt`。**不加任何新依赖。**

**Spec:** [docs/design/2026-09-30-api-workbench-research.md](../../design/2026-09-30-api-workbench-research.md)。第 1 节的决策和第 3 节的数据模型是本计划的依据；D1 以第 7 节为准。

## Global Constraints

- `package.json` 里加上 `"engines": { "node": ">=22.13" }`。
- 不新增 npm 依赖。cookie 自己解析，不引入 cookie-parser。
- 产品名、数据目录、cookie 名、环境变量前缀一律从 `lib/app-info.js` 读。产品名已定为 **`apiloop`**（2026-09-30），其他地方不许硬编码。
- 默认库路径：`~/.apiloop/data.db`。优先级：`--db` 参数 > 环境变量 `APILOOP_DB` > 默认值。
- 默认监听 `127.0.0.1`，用 `--host` 改。
- mock 接口本身**不做鉴权**，只有 `/__admin/api/*` 要登录，其中 `/auth/login` 除外。
- 模板占位符语法 `{{@xxx}}` 和 `router.js` 的兼容行为都不能变。
- 数据表按 spec 第 3 节建全，但 environments / history / mock_expectations 在 P1 只建表，不写读写代码（YAGNI）。
- 所有 JSON 列在读出来的时候都要 `try/catch`，坏数据回退成默认值，不能让服务起不来。这个写法沿用现有 `lib/db.js` 里的 `parseJson`。
- **测试不能碰真实的 `~/.apiloop`**：所有启动 CLI 的测试都要传 `--db <临时目录>`。

## Review Focus

以下是审阅时我会重点推演的场景。实现时请按这里描述的预期行为来写。

1. **两个进程共用一个库**：分别在两个目录、两个端口跑 `mock web`。在 A 的管理台保存后，B 的 mock 接口要在大约 1 秒内生效（靠轮询 `PRAGMA data_version`）。两边同时写不能报 `SQLITE_BUSY` 崩掉（靠 WAL 模式加 `busy_timeout`）。
2. **老用户升级**：目录里有 P0 格式的 `routes.db` 或更老的 `routes.json`。第一次启动时导入成一个绑定到这个目录的项目，原文件不动；以后再启动不能重复导入。两个文件都在时，只导入 `routes.db`。
3. **目录名是中文或带特殊字符**：slug 回退成 `p-<短 id>`；重名时加 `-2`、`-3`；`/mock/<slug>` 能访问到。
4. **把管理员锁在门外的情况**：删除或降级最后一个 admin、删除或降级自己、禁用自己，都要拒绝并返回 400。用户被禁用后，他已经登录的 session 要立刻失效。
5. **根项目里有 `/mock/...` 开头的接口**：只有 slug 真的存在时才拦截 `/mock/<slug>`；slug 不存在时交给根项目处理。

---

## 文件结构

| 文件 | 动作 | 职责 |
| --- | --- | --- |
| `lib/app-info.js` | 新建 | 产品名、默认数据目录和库路径、cookie 名等常量 |
| `lib/db/index.js` | 新建 | 打开库、设置 pragma、执行迁移、事务、变更事件、外部变更轮询 |
| `lib/db/migrations.js` | 新建 | 按版本号排列的迁移数组，v1 = 全部表结构 |
| `lib/db/json.js` | 新建 | `readJson` / `writeJson` 两个小工具 |
| `lib/db/repos/users.js` `sessions.js` `projects.js` `folders.js` `apis.js` `examples.js` | 新建 | 各表的增删改查，同步 API |
| `lib/legacy/routes-db.js` | 由 `lib/db.js` 改名而来 | 只保留读取 P0 格式 `routes.db` 的功能 |
| `lib/legacy-import.js` | 新建 | 把目录里的 `routes.db` / `routes.json` 导入成项目 |
| `lib/routes-store.js` | 重写内部实现 | 单个项目的门面：对外 API 不变，内部改走 repos |
| `lib/project-stores.js` | 新建 | 每个项目只建一个 store 实例，缓存起来复用 |
| `lib/mock-host.js` | 新建 | 挂载 `/mock/:slug` 和根项目 |
| `lib/auth.js` | 新建 | 密码哈希、session、登录中间件、初始管理员、登录失败限流 |
| `lib/admin-auth.js` | 新建 | `/auth/*` 和 `/users/*` 两组接口 |
| `lib/admin.js` | 修改 | 接收 `handle`，挂登录中间件，meta 里带上当前用户和项目 |
| `lib/command.js`、`bin/server` | 修改 | 启动流程、`--db` / `--host` / `--project` 参数、`user` 子命令 |
| `lib/web/login.html`、`lib/web/app.js` | 新建 / 修改 | 登录页；遇到 401 跳登录页；顶栏显示当前用户和退出按钮 |
| `test/*.test.js` | 维护 | 适配新接口 |
| `README.md` | 修改 | 存储、登录、多项目、Node 版本要求 |

---

### Task 1: app-info 和数据库基座

**Files:**
- Create: `lib/app-info.js`, `lib/db/index.js`, `lib/db/migrations.js`, `lib/db/json.js`
- Move: `lib/db.js` → `lib/legacy/routes-db.js`（内容暂时不动，只修正 `routes-store` 的引用路径，保证这个任务结束时测试仍然全绿；`writeAll` 等到 Task 4 再删）
- Modify: `package.json`（加 engines）

**Interfaces:**
- Produces:
  - `app-info`：`{ APP_NAME: 'apiloop', DATA_DIR: string, DEFAULT_DB: string, SESSION_COOKIE: 'apiloop_sid', ENV_DB: 'APILOOP_DB', ENV_ADMIN_PASSWORD: 'APILOOP_ADMIN_PASSWORD' }`
  - `db.open(file: string) -> Handle`
  - `Handle = { db: DatabaseSync, file, events: EventEmitter, transaction(fn: () => T, change?: {projectId: string|null}) -> T, startPolling(intervalMs=1000), stopPolling(), close() }`
  - `events` 的 `'change'` 事件，参数是 `{ projectId: string|null, external: boolean }`；`projectId === null` 表示「可能影响所有项目」。
  - `json.readJson(text, fallback)`、`json.writeJson(value) -> string`

- [ ] **Step 1: `db.open` 打开库时依次执行以下动作**
  1. 目录不存在就创建。
  2. 文件已存在但不是 SQLite：沿用 `assertDatabaseFile` 的判断和报错文案。
  3. 设置 `PRAGMA journal_mode=WAL; busy_timeout=5000; foreign_keys=ON`。
  4. 读 `meta.schema_version`（不存在按 0 算），按顺序执行版本号更大的迁移。每条迁移单独一个事务，执行完写回版本号。
  5. 如果库的版本号比代码认识的最高版本还高，直接报错：「数据库由更新版本创建，请升级」。

- [ ] **Step 2: `transaction` 和变更广播**
  - `transaction(fn, change)` 用 `BEGIN IMMEDIATE` 开事务，成功就 COMMIT，失败就 ROLLBACK 并重新抛出错误。
  - COMMIT 之后，如果传了 `change`，就 emit `'change'`，参数为 `{projectId, external: false}`。
  - 不支持嵌套：在事务里再调 `transaction` 直接抛错，防止 repos 自己嵌套事务。

- [ ] **Step 3: 外部变更轮询**
  - `startPolling` 每隔 `intervalMs` 读一次 `PRAGMA data_version`，值变了就 emit `{projectId: null, external: true}`。
  - 这个值只在**别的连接**提交后才会变，所以不会被自己的写入触发。
  - 定时器要 `unref()`，不能阻止进程退出。

- [ ] **Step 4: 迁移 v1 的表结构**

  以 spec 第 3 节为准，以下是需要精确定下来的地方：

  ```sql
  users(id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL,
        display_name TEXT NOT NULL DEFAULT '', role TEXT NOT NULL CHECK(role IN ('admin','member')),
        disabled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)
  sessions(token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)
  projects(id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        source_dir TEXT UNIQUE, is_default INTEGER NOT NULL DEFAULT 0, variables TEXT NOT NULL DEFAULT '[]',
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)
  project_members(project_id TEXT REFERENCES projects(id) ON DELETE CASCADE, user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('owner','editor','viewer')), PRIMARY KEY(project_id, user_id))
  environments(id, project_id → projects CASCADE, name, variables TEXT DEFAULT '[]', position)
  folders(id, project_id → projects CASCADE, parent_id → folders CASCADE NULL, name, description, position,
        auth TEXT NULL, variables TEXT DEFAULT '[]', extra TEXT DEFAULT '{}')
  apis(id, project_id → projects CASCADE, folder_id → folders ON DELETE SET NULL, name, description, position,
        method, url, params TEXT DEFAULT '{"path":[],"query":[],"headers":[]}', body TEXT DEFAULT '{"mode":"none"}',
        auth TEXT NULL, scripts TEXT DEFAULT '[]', mock_enabled INTEGER DEFAULT 1, mock_path TEXT, mock_delay INTEGER DEFAULT 0,
        mock_cors INTEGER DEFAULT 0, mock_example_id TEXT NULL, extra TEXT DEFAULT '{}', created_at, updated_at)
  examples(id, api_id → apis CASCADE, name, position, status INTEGER DEFAULT 200, headers TEXT DEFAULT '[]', body TEXT DEFAULT '',
        response_type TEXT DEFAULT 'json', is_template INTEGER DEFAULT 1,
        source TEXT CHECK(source IN ('manual','recorded','imported')), created_at)
  mock_expectations(id, api_id → apis CASCADE, position, name, enabled, conditions TEXT DEFAULT '[]', example_id → examples CASCADE)
  history(id INTEGER PRIMARY KEY AUTOINCREMENT, project_id → projects CASCADE, api_id → apis SET NULL, user_id → users SET NULL,
        request TEXT, response TEXT, created_at)
  legacy_imports(source_path TEXT PRIMARY KEY, project_id → projects CASCADE, imported_at INTEGER)
  meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)
  ```

  补充约定：
  - 为 `apis(project_id, position)`、`folders(project_id, parent_id, position)`、`examples(api_id, position)`、`sessions(user_id)` 建索引。
  - 时间一律用毫秒时间戳（`Date.now()`）。
  - `mock_example_id` 故意不加外键（它和 examples 表互相引用）。删除示例时由 repo 负责把它置空。

- [ ] **Step 5: 验证**：`npm test` 全绿；`node -e "require('./lib/db').open('/tmp/x/data.db')"` 能建出全部表。然后提交。

---

### Task 2: repos（各表的增删改查）

**Files:** Create `lib/db/repos/{users,sessions,projects,folders,apis,examples}.js`

**Interfaces:**
- Consumes: Task 1 的 `Handle`
- Produces（全部是同步函数，第一个参数都是 `handle`）：
  - **users**：`create(h, {username, password_hash, display_name?, role})`、`getById`、`getByUsername`、`list(h)`、`update(h, id, patch)`、`remove(h, id)`、`countAdmins(h, {excludeId?})`。所有返回值都**去掉 `password_hash`**，只有 `getAuthRecordByUsername(h, username)` 返回完整行（登录时用）。
  - **sessions**：`create(h, {token_hash, user_id, expires_at})`、`get(h, token_hash)`、`remove(h, token_hash)`、`removeByUser(h, user_id)`、`removeExpired(h)`
  - **projects**：`create(h, {name, slug?, source_dir?, is_default?, created_by?})`，不传 slug 就自动生成；`getById`、`getBySlug`、`getBySourceDir`、`getDefault`、`list`、`uniqueSlug(h, base) -> string`
  - **folders**：`list(h, projectId)`、`create(h, projectId, {name, parent_id?, position?})`、`rename`、`setPositions(h, projectId, orderedIds)`、`remove(h, id)`
  - **apis**：`list(h, projectId)`，按 position 排序；`get`、`insert(h, projectId, api)`、`update(h, id, patch)`、`remove`、`removeByFolder(h, folderId)`、`nextPosition(h, projectId)`
  - **examples**：`listByApi(h, apiId)`、`get`、`insert(h, apiId, ex)`、`update`、`remove`
  - 行对象用 camelCase，JSON 列已经解析好，布尔列已经还原。例如 api 的形状：`{ id, projectId, folderId, name, description, position, method, url, params, body, auth, scripts, mockEnabled, mockPath, mockDelay, mockCors, mockExampleId, extra, createdAt, updatedAt }`

- [ ] **Step 1: 写各个 repo**
  - repo 自己**不开事务**；需要原子性的地方由调用方包 `handle.transaction`。
  - 写操作不 emit 事件，事件由 `transaction` 统一发。
- [ ] **Step 2: `uniqueSlug(base)` 的规则**
  1. 转小写，把不在 `[a-z0-9-]` 里的字符替换成 `-`，合并连续的 `-`，去掉首尾的 `-`，截到最多 32 个字符。
  2. 结果为空（比如中文目录名）时用 `p-` 加 6 位随机的 `[a-z0-9]`。
  3. 结果是 `mock` 或以 `__` 开头时，前面加 `p-`。
  4. 已被占用就加 `-2`、`-3`……直到可用。
- [ ] **Step 3: 验证**：`npm test` 全绿（这个任务还没有调用方，确认没有破坏现有代码）。然后提交。

---

### Task 3: routes-store 改成「单个项目的门面」，加 project-stores 注册表

**Files:**
- Rewrite: `lib/routes-store.js`
- Create: `lib/project-stores.js`
- 维护: `test/routes-store.test.js`、`test/server.test.js` 中创建 store 的部分

**Interfaces:**
- Consumes: Task 1 / 2
- Produces:
  - `createStore({ handle, projectId }) -> Store`。Store 的方法**名字和返回形状与现在一致**：`load, getRoutes, getRoute, create, update, remove, duplicate, addMany, getGroups, addGroup, renameGroup, reorderGroups, removeGroup, replaceAll, on, off, startWatching, stopWatching, close`，另外新增 `projectId` 属性。
    - `filePath` 保留，值为 `handle.file`，因为 meta 接口在用。
    - `getMigratedFrom` / `getMigrationWarnings` **删除**，这部分职责移到 Task 4。
  - `normalizeRoute`、`createSampleRoutes`、`METHODS`、`RESPONSE_TYPES`、`FIELD_TYPES`、`RESERVED_PREFIX` 保持不变继续导出，`DEFAULT_FILE` 删除。
  - `projectStores.get(handle, projectId) -> Store`：同一个 handle 下，同一个项目只建一个实例；`projectStores.closeAll(handle)`。

- [ ] **Step 1: route 与 api + 默认示例之间的映射**（这是门面的核心，一次写对）

  | route 字段 | 写入到 |
  | --- | --- |
  | `id` | `apis.id`（沿用原 id） |
  | `name` / `desc` | `apis.name` / `apis.description` |
  | `group` | 按名字找**顶层** folder，没有就建一个；空串表示 `folder_id = NULL` |
  | `enabled` | `apis.mock_enabled` |
  | `method` | `apis.method` |
  | `path` | `apis.mock_path`；**同时**写 `apis.url`，但只在新建时写，或者更新时原来的 `url` 等于原来的 `mock_path`（说明两者还是同步的）时才写 |
  | `delay` / `cors` | `apis.mock_delay` / `apis.mock_cors` |
  | `query[]` | `apis.params.query`，每行 `{key, value: example, type, required, desc, enabled: true}` |
  | `body[]` | `apis.body = { mode: rows.length ? 'urlencoded' : 'none', form: rows }`，每行的形状同上 |
  | `status` / `headers` / `responseType` / `response` | 默认示例（`mock_example_id` 指向的那条）的 `status / headers / response_type / body`。新建时示例名为「默认」，`is_template=1`，`source='manual'` |

  - **反向读取（api → route）**：按上表反推。api 没有默认示例时，`status=200, headers=[], responseType='json', response=''`，并且 `enabled = mockEnabled && 有示例`。
  - **`update` 只改上表覆盖的列和默认示例**，`auth / scripts / extra / params.path / params.headers / 其他示例` 都原样保留。
  - `duplicate` 要复制该接口的全部示例，并把 `mock_example_id` 指向复制出来的那条默认示例。
  - 分组操作都作用于**顶层** folder：
    - `removeGroup` 的 `move` 模式：先把这个分组下接口的 `folder_id` 置空，再删 folder；
    - `delete` 模式：先 `apis.removeByFolder`，再删 folder。
  - route 的顺序用 `apis.position`，在项目内全局排序。
  - 每个写方法都放在 `handle.transaction(fn, {projectId})` 里执行。

- [ ] **Step 2: 缓存与刷新**
  - 内存里的 `routes` 数组只是读缓存。
  - store 订阅 `handle.events` 的 `'change'`：事件的 `projectId` 等于自己的，或者为 null 时，从库里重新读一遍，再 emit 自己的 `'change'`（参数是 routes，`mock-runtime` 依赖这个）。
  - 写方法**不要**直接 emit，统一走这条路径，避免同一次写发两次事件。
  - `startWatching()` 改为调用 `handle.startPolling()`；`stopWatching()` 只取消本 store 的订阅。`close()` 也只取消订阅，**不关 handle**，handle 归启动流程管。
- [ ] **Step 3: 维护测试**
  - `test/routes-store.test.js` 的 `setup` 改成：打开临时库 → `projects.create` → `createStore({handle, projectId})`。
  - 原来测试「旧 JSON 迁移」「--config 指向非 SQLite 文件」的用例，搬到 Task 4 之后再改，这里先 `test.skip` 并注明「Task 4 恢复」。
  - `test/server.test.js` 的 `before` 同样调整。
- [ ] **Step 4: 验证**：`node --test test/routes-store.test.js test/server.test.js test/mock-engine.test.js test/importers.test.js` 全绿（skip 的用例除外），然后提交。

> **关于 `test/cli.test.js` 的已知断档**：从这个任务起，`command.js` 还在用旧的 `createStore({file})`，要到 Task 7 才重新接线。所以 **Task 3 到 Task 6 期间 `cli.test.js` 允许失败**，Task 7 结束时必须恢复全绿。这几个任务不要为了让它通过而在 `command.js` 里写临时代码。

---

### Task 4: 导入目录里的旧配置

**Files:** Create `lib/legacy-import.js`；维护 `test/routes-store.test.js` 中 Task 3 skip 的用例

**Interfaces:**
- Produces: `importLegacyDir(handle, dir, { userId, file? }) -> { project, importedFrom: string|null, warnings: string[] }`
  - `file` 可选，对应 `--config` 显式指定的文件。不传就在 `dir` 里按 `routes.db` → `routes.json` 的顺序找。

- [ ] **Step 1: 实现逻辑**
  1. 如果已经有 `source_dir === dir` 的项目，直接返回它，`importedFrom = null`。
  2. 找到的旧文件的绝对路径如果已经在 `legacy_imports` 表里，也直接返回对应项目，不重复导入。
  3. 否则在一个事务里依次执行：建项目（`name = basename(dir)`，slug 用 `uniqueSlug(basename)`，`source_dir = dir`）→ 用 Task 3 的映射导入分组和接口 → 写一条 `legacy_imports` 记录 → 把 `userId` 以 owner 身份加进 `project_members`。
  4. 读 `routes.db` 用 `lib/legacy/routes-db.js`；读 `routes.json` 的容错逻辑从旧 `routes-store` 的 `migrateFromJson` 搬过来，warnings 的文案也照搬。
  5. 没有找到任何旧文件时返回 `{project: null, importedFrom: null, warnings: []}`，调用方决定怎么处理。
- [ ] **Step 2: 恢复 Task 3 skip 的用例**，改成调用 `importLegacyDir` 后断言结果。
- [ ] **Step 3: 删掉 `lib/legacy/routes-db.js` 的 `writeAll`**：从这里开始它只负责读。
- [ ] **Step 4: 验证**：除 `test/cli.test.js` 以外全绿（见 Task 3 的说明），然后提交。

---

### Task 5: 按项目挂载 mock

**Files:** Create `lib/mock-host.js`；`lib/mock-runtime.js` 不改

**Interfaces:**
- Consumes: `projectStores.get`、`projects.getBySlug`、`runtime.createRuntime(store)`
- Produces: `createMockHost(handle, { rootProjectId: string|null }) -> { middleware(req,res,next), rootProject(), close() }`

- [ ] **Step 1: 请求分发**
  - 请求路径匹配 `^/mock/([^/]+)(/.*)?$`，并且 slug 对应的项目存在时：
    1. 把 `req.url` 改写成剩下的部分（没有剩余就用 `/`，查询串保留），`req.baseUrl` 追加 `/mock/<slug>`；
    2. 交给这个项目的 runtime 处理；
    3. 在 runtime 的 `next` 回调里先还原 `req.url` 和 `req.baseUrl`，再调外层的 `next`。
  - slug 不存在，或者这个项目的 runtime 没匹配上：交给根项目的 runtime；再没匹配上就 `next()`。
- [ ] **Step 2: 缓存**
  - runtime 按项目 id 懒创建并缓存。
  - slug 到项目 id 的映射缓存起来，收到 `projectId === null` 的 change 事件时清空。
- [ ] **Step 3: 验证**：除 `test/cli.test.js` 以外全绿，然后提交。

---

### Task 6: 登录与用户管理接口

**Files:** Create `lib/auth.js`、`lib/admin-auth.js`；Modify `lib/admin.js`；维护 `test/server.test.js`

**Interfaces:**
- Produces:
  - `auth.hashPassword(plain) -> string`，格式 `scrypt$16384$8$1$<salt b64>$<hash b64>`（salt 16 字节，keylen 64）
  - `auth.verifyPassword(plain, stored) -> boolean`，用 `crypto.timingSafeEqual` 比较
  - `auth.bootstrapAdmin(handle) -> { username: 'admin', password } | null`：库里 users 表为空时才创建；密码优先取 `APILOOP_ADMIN_PASSWORD`，没有就随机生成 16 位。只有新建了账号才返回凭据。
  - `auth.createSessionMiddleware(handle) -> middleware`：解析 cookie、查 session、查用户，结果挂到 `req.user`，查不到为 `null`。session 过期、用户被禁用或已删除，都视为未登录。
  - `auth.requireLogin`（未登录返回 401 `{ok:false, error:'请先登录'}`）、`auth.requireAdmin`（不是 admin 返回 403）
  - `adminAuth.createRouter(handle) -> express.Router`

- [ ] **Step 1: 接口定义**（统一的 `{ok, ...}` 返回格式沿用 `admin.js`）

  | 接口 | 权限 | 行为 |
  | --- | --- | --- |
  | `POST /auth/login` `{username,password}` | 公开 | 成功后 Set-Cookie `apiloop_sid=<32 字节随机数的 base64url>; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`。库里只存 token 的 sha256。返回 `{user}`。失败统一返回「用户名或密码错误」，不区分是哪一项错 |
  | `POST /auth/logout` | 登录 | 删除 session，清掉 cookie |
  | `GET /auth/me` | 登录 | 返回 `{user}` |
  | `PUT /auth/password` `{oldPassword,newPassword}` | 登录 | 新密码至少 6 位；改完后删掉这个用户**其他**的 session |
  | `GET /users` | admin | 用户列表 |
  | `POST /users` `{username,password?,displayName?,role?}` | admin | username 必须匹配 `^[a-zA-Z0-9_.-]{2,32}$`；没传密码就随机生成，并在响应里带 `password` 返回一次 |
  | `PUT /users/:id` `{displayName?,role?,disabled?}` | admin | 禁用用户时 `sessions.removeByUser` |
  | `POST /users/:id/reset-password` | admin | 生成随机密码并返回一次；清掉该用户所有 session |
  | `DELETE /users/:id` | admin | — |

  **保护规则**（对应 Review Focus 第 4 条）：不能对自己做删除、禁用或降级；任何会让「未禁用的 admin」变成 0 个的操作都拒绝，返回 400 并给出可读的原因。

- [ ] **Step 2: 登录失败限流**
  - 在内存里用 `Map<小写用户名, {count, until}>` 计数，同一用户名连续失败 5 次后锁定 60 秒，锁定期间直接返回 429。
  - 登录成功就清零。
- [ ] **Step 3: 接到 `admin.js` 上**
  - 签名改为 `createAdmin({ handle, store, version })`。
  - 在 api 路由上依次挂：`express.json` → session 中间件 → `adminAuth` 路由（其中 `/auth/login` 放在 requireLogin 之前）→ `requireLogin` → 现有的各个接口。
  - `/meta` 多返回 `user` 和 `project: {id, slug, name}`。
- [ ] **Step 4: 维护 `test/server.test.js`**：在 `before` 里建一个用户、调登录接口拿到 cookie，`ctx.api` 请求时带上 cookie。
- [ ] **Step 5: 验证**：除 `test/cli.test.js` 以外全绿，然后提交。

---

### Task 7: CLI 启动流程和 `user` 子命令

**Files:** Modify `lib/command.js`、`bin/server`；维护 `test/cli.test.js`；Modify `README.md`

**Interfaces:**
- Consumes: 前面所有任务
- 新参数：`--db <path>`、`--host <addr>`（默认 `127.0.0.1`）、`--project <slug>`；`--config` 保留，含义改为「要导入的旧配置文件」
- 新命令：`mock user add <username> [--admin] [--password xx]`、`mock user list`、`mock user reset-password <username>`

- [ ] **Step 1: `start` / `web` / `open` 的启动顺序**
  1. 按 Global Constraints 的优先级确定库路径，调 `db.open`。
  2. 调 `auth.bootstrapAdmin`。只有返回了凭据才打印，醒目地打一次：
     ```
     已创建管理员 admin，初始密码：xxxx（只显示这一次，登录后请修改）
     ```
  3. 确定根项目：
     1. 传了 `--project`：按 slug 找，找不到就报错退出，并列出现有的 slug。
     2. 否则调 `importLegacyDir(cwd, {file: --config})`，有项目就用它；导入成功时打印「已把 <文件> 导入为项目 <name>（/mock/<slug>）」和 warnings。
     3. 否则用 `projects.getDefault`；还没有默认项目就新建一个：名称「默认项目」，slug `default`，`is_default=1`。
  4. 管理台用的 store 取 `projectStores.get(handle, rootProjectId)`，和 mock-host 共用同一个实例。挂载顺序：`bodyParser` → admin（仅 web 模式；rootStatic 和 `/` 跳转的逻辑保持现状）→ `createMockHost(handle, {rootProjectId}).middleware` → `router.js` → 静态目录。
  5. `handle.startPolling()`，然后 `app.listen(port, host)`。
  6. 启动输出里列出：管理台地址、根项目名、`/mock/<slug>` 前缀、库路径。
  7. `host` 不是本机回环地址时，额外提示「局域网可访问，请确认账号密码强度」。
- [ ] **Step 2: `init`**
  - 示例的 `router.js` / `index.html` 照旧复制到当前目录。
  - 如果当前目录还没有绑定项目，就建一个绑定到 cwd 的项目，并用 `createSampleRoutes()` 灌入示例接口；**不再**在 cwd 生成 `routes.db`。
- [ ] **Step 3: `user` 子命令**
  - 直接打开库执行，不启动服务。
  - 生成的密码打印到终端。
  - 找不到用户时以退出码 1 结束。
- [ ] **Step 4: 维护 `test/cli.test.js`**
  - 所有启动 CLI 的地方都加 `--db <临时目录>/data.db`，环境变量加 `APILOOP_ADMIN_PASSWORD=test-pass`，先登录再访问管理台接口。
  - init 用例改为断言：cwd 里**没有** `routes.db`；启动后根项目里有 3 条示例接口。
- [ ] **Step 5: README**
  - 改写「存储」章节：全局库、多项目、`/mock/<slug>`、从旧 routes.db / routes.json 自动导入。
  - 新增「登录与用户」章节：初始管理员、`mock user` 命令、`--host`。
  - 写明 Node ≥ 22.13。
  - 管理台 API 表加上 auth 和 users 两组接口。
- [ ] **Step 6: 验证**：`npm test` **完整**全绿，包括 `cli.test.js`，然后提交。
- [ ] **Step 7: 改名收尾（单独一个提交）**
  - `package.json`：`name` 改为 `apiloop`，`bin` 改为 `{ "apiloop": "./bin/server", "mock": "./bin/server" }`（`mock` 是给老用户留的别名，`server` / `server-mock` 两个去掉），`description` 改为「本地接口调试 + mock 工具」。`repository` / `bugs` / `homepage` 先不动，等用户定下新仓库地址。
  - README 标题和安装命令改用 `apiloop`，另加一段「从 server-mock 迁移」：老命令 `mock` 还能用；旧的 `routes.db` / `routes.json` 首次启动时自动导入。
  - 启动输出和管理台 `<title>` / 顶栏品牌名改为 apiloop，文字从 `app-info` 取（前端的从 `/meta` 取）。
  - 验证：`npm test` 完整全绿，`node bin/server --help` 能看到 apiloop，然后提交：`chore: 项目更名为 apiloop`。

---

### Task 8: 管理台前端接入登录

**Files:** Create `lib/web/login.html`；Modify `lib/web/app.js`（只改 API 封装层和顶栏，**不做其他改动**，P2 会整体重写）、`lib/web/index.html`（顶栏）

- [ ] **Step 1: `login.html`**
  - 纯 HTML 加内联脚本，复用 `style.css`。
  - 表单只有用户名和密码。提交后调 `/__admin/api/auth/login`，成功就跳到 `?next=` 指定的地址；next 必须以 `/` 开头且不以 `//` 开头，否则跳 `/index.html`。
  - 失败时在页面上显示服务端返回的错误信息。
- [ ] **Step 2: `app.js` 的 `api.request`**
  - 响应状态是 401 时，执行 `location.href = '/login.html?next=' + encodeURIComponent(location.pathname + location.search)`，并返回一个永远不 resolve 的 Promise，避免后面的错误提示闪一下。
- [ ] **Step 3: 顶栏**
  - 显示 `meta.user.displayName || username` 和当前项目名，加一个「退出」按钮：调 logout 接口后跳登录页。
  - 用户管理的界面**不在 P1 做**，放到 P2 的 Vue 管理台里。P1 期间通过接口或 `mock user` 命令管理用户。
- [ ] **Step 4: 验证**：`npm test` 全绿，然后提交。UI 行为交给用户人工确认，核对清单见下方。

---

## 交给用户的手工核对清单（P1 完成后）

1. 在一个空目录跑 `mock web`：终端打印出 admin 的初始密码；打开页面会跳到登录页；登录后能看到「默认项目」。
2. 在一个有旧 `routes.db` 的目录跑 `mock web`：提示已导入，接口在 `/` 和 `/mock/<slug>/...` 下都能访问；重启后不会重复导入。
3. 开两个终端，分别在两个目录用不同端口启动；在 A 里改接口，B 的 `/mock/<A 的 slug>/...` 大约 1 秒内就生效。
4. 用 `mock user add alice` 建账号，用 alice 登录；再用 admin 通过接口禁用 alice，alice 刷新页面后被踢回登录页。
5. 用 `mock user reset-password admin` 重置密码后能用新密码登录。
