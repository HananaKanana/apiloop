# P6 项目权限实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **本项目约定（覆盖 skill 默认做法）**
> - **不写新测试**；既有测试 `npm test` 必须全部通过，既有测试因为接口变化失效的，按维护处理。
> - 自测用一次性脚本，跑完删掉。
> - **只提交自己的文件**：`git commit -m ... -- <文件>`。

**目标**：让「仅项目成员可见」这条规则真正生效：每个管理台接口都按角色拦截，并提供成员管理接口。

**架构**：
- 新增 `lib/access.js`，负责两件事：
  1. 算出「某个用户在某个项目里是什么角色」；
  2. 把各种资源（目录、接口、示例、环境、期望、历史）反查到它所属的项目。
- 新增 `lib/api/guard.js`，提供一个 express 中间件工厂 `guard(level, locate)`。**每个**跟项目有关的路由，都在它的 handler 之前挂上 guard。
- 成员管理接口放在 `lib/api/members.js`。

**技术栈**：沿用现有依赖，不新增。

**依据**：接口契约 [docs/design/2026-09-30-admin-api-v2.md](../../design/2026-09-30-admin-api-v2.md) **第 10 节**。可见性规则是用户拍板的：仅成员可见。

## 全局约束

- **文件范围**：`lib/**`（`lib/web` 除外）、`test/**`、`README.md`。
- **路由必须显式声明权限**：凡是经过 `:pid`、`:id` 定位到某个项目的路由，都**必须**挂 guard。审阅时我会把每个路由文件逐条过一遍，漏掉一条就等于一个越权漏洞。
- **不改 mock 行为**：mock 运行时和 mock 接口的行为保持不变，只在管理台接口这一侧做权限拦截。

## 审阅重点

1. **越权访问**：非成员拿一个别人项目里的 `apiId`、`exampleId`、`expectationId`、`environmentId`、`historyId`、`folderId`，去调这些资源各自的 GET、PUT、DELETE，全部应该返回 404。另外还有三个隐蔽的入口：
   - `/send` 的 `environmentId` 和 `apiId`：之前已经会校验是否属于同一项目，这次要复查；
   - `/projects/:pid/move` 的 `parentId`；
   - Postman `into` 模式的 `projectId`。
2. **角色不够时返回 403，不存在时返回 404**，两者不能混淆。viewer 能正常发请求，但不能保存。
3. **项目至少保留一个 owner**：以下几种操作都会让 owner 数量减到 0，一律返回 400：
   - 降级最后一个 owner；
   - 移除最后一个 owner；
   - 最后一个 owner 自己退出。
4. **升级后没有人被锁在门外**：从 v3 的库升级到 v4 后，老用户还能看到并编辑原来的所有项目；根项目和默认项目也都有 owner。
5. **admin 不是任何项目的成员时**，仍然能看到所有项目，并且能做 owner 能做的全部操作；`myRole` 字段返回 `'admin'`。

---

### Task 1: 迁移 v4、成员 repo、access.js，以及创建项目的各个入口

**文件**：
- 修改：`lib/db/migrations.js`、`lib/command.js`、`lib/legacy-import.js`（如需调整）、`lib/api/projects.js`、`lib/api/postman.js`
- 新建：`lib/db/repos/members.js`、`lib/access.js`

**接口**：
- **members repo**：
  - `list(h, projectId) -> [{ userId, username, displayName, role, disabled }]`：join users 表
  - `get(h, projectId, userId)`
  - `upsert(h, projectId, userId, role)`
  - `remove(h, projectId, userId)`
  - `countOwners(h, projectId, { excludeUserId? })`
  - `projectIdsOf(h, userId) -> string[]`
- **access.js**：
  - `ROLE_RANK = { viewer: 1, editor: 2, owner: 3, admin: 4 }`
  - `roleOf(h, user, projectId) -> 'admin' | 'owner' | 'editor' | 'viewer' | null`：user 是 admin 时直接返回 `'admin'`
  - `atLeast(role, level) -> boolean`
  - `projectIdOf(h, kind, id) -> string | null`，kind 取值为 `'folder' | 'api' | 'example' | 'environment' | 'expectation' | 'history'`：example 和 expectation 要先查到所属的 api，再查到项目
  - `addOwner(h, projectId, userId)`：userId 为空时什么也不做

- [ ] **Step 1: 迁移 v4**，只追加，按契约第 10 节「存量数据迁移」的三条规则写成 SQL：
  ```sql
  INSERT OR IGNORE INTO project_members (project_id, user_id, role)
    SELECT p.id, u.id, 'editor' FROM projects p CROSS JOIN users u;
  UPDATE project_members SET role = 'owner'
    WHERE EXISTS (SELECT 1 FROM projects p WHERE p.id = project_members.project_id AND p.created_by = project_members.user_id);
  UPDATE project_members SET role = 'owner'
    WHERE user_id = (SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1)
      AND project_id NOT IN (SELECT project_id FROM project_members WHERE role = 'owner');
  ```
  legacy 导入时已经写入的 owner 行，会被第一条的 `OR IGNORE` 保留下来。
- [ ] **Step 2: 创建项目时一律写入 owner**：
  - `POST /projects` 和 Postman `new` 模式：在同一个事务里执行 `access.addOwner(h, created.id, req.user.id)`。
  - `command.js` 启动时建默认项目、调 `importLegacyDir`、`init` 生成示例项目：owner 取「最早创建的那个 admin」。
    - `importLegacyDir` 已经支持 `userId` 参数，只是原来没有传，这次补上。
    - 在 `usersRepo` 里补一个 `firstAdmin(h)`。
- [ ] **Step 3: 自测**：用一份 v3 的库（先用上一版代码建库，写入两个用户、两个项目）升级到 v4，按审阅重点第 4 条检查成员表的内容。
- [ ] **Step 4**：`npm test` 全部通过后提交：`feat(db): 迁移 v4 项目成员与 access 判定`

---

### Task 2: 给所有路由挂上 guard

**文件**：新建 `lib/api/guard.js`；修改 `lib/api/*.js` 的全部路由文件和 `lib/admin.js`（旧接口）。

**接口**：`guard(level, locate) -> middleware`
- `locate(req) -> projectId | null`，返回 null 就是 404。
- guard 按下面的顺序判断：
  1. `locate` 返回 null，或者对应的项目不存在 → 404「<资源>不存在」；
  2. `roleOf` 返回 null → 404，信息和上一条相同；
  3. 角色不够 → 403「需要 <level> 权限」。
- 通过后，把 `req.project` 和 `req.role` 挂到请求上，后面的 handler 直接用，不必再查一次。
- guard.js 同时导出几个现成的 locate：`byPid`（取 `req.params.pid`）、`byParam(kind)`（用 `req.params.id` 调 `projectIdOf`）、`rootProject(ctx)`。

- [ ] **Step 1: 逐个路由文件挂 guard**，权限级别按契约第 10 节的表：
  - GET 类接口：viewer；
  - `/send`、`/files`：viewer；
  - 写操作：editor；
  - 成员管理、改 name / slug、删除项目：owner。
  - `PUT /projects/:pid`：guard 用 editor；如果请求里带了 `name` 或 `slug`，在 handler 里再检查一次是否 ≥ owner，不够就返回 403。
- [ ] **Step 2: 请求体里引用的其他项目资源也要校验**：
  - Postman 导入的 `into`、environment、globals 三种情况：目标项目要求调用者至少是 editor；不是成员时返回 404。
  - `/send` 的 `apiId`、`environmentId`：已经有「是否属于本项目」的校验，这次复查一遍。
- [ ] **Step 3: 列表过滤**：
  - `GET /projects`：admin 返回全部项目；其他用户只返回 `members.projectIdsOf` 里的项目。
  - `dto.toProjectDto` 带上 `myRole`，并把 ctx 和 user 一起传进去。
- [ ] **Step 4: 旧接口**：在 `admin.js` 里，旧接口统一用 `guard(level, rootProject(ctx))`，读操作要求 viewer，写操作要求 editor。
- [ ] **Step 5: 自查清单**：在提交说明里列一张表，内容是「路由 → 权限级别 → locate 方式」，**每一条路由都要列出来**。审阅时我会拿它和代码逐条对照。
- [ ] **Step 6: 维护既有测试**：`test/server.test.js` 用的是 admin 身份，按理应该全部通过；如果有失败，修测试的准备逻辑，**不要**为了让测试通过而放宽 guard。`npm test` 全部通过后提交：`feat(api): 按项目角色拦截所有管理台接口`

---

### Task 3: 成员接口与用户搜索

**文件**：新建 `lib/api/members.js`；修改 `lib/admin-auth.js`（加 `/users/lookup`，**放在 requireAdmin 之外**）。

- [ ] **Step 1**：按契约实现 4 个接口。「至少保留一个 owner」的检查放在事务里做，用 `countOwners(..., { excludeUserId })` 判断。
- [ ] **Step 2**：`PUT /projects/:pid/members/:userId` 如果 userId 对应的用户不存在，返回 400「用户不存在」。
- [ ] **Step 3**：`DELETE` 时，如果 userId 就是当前用户自己，只要求是 viewer 及以上（自己退出）；删除别人则要求 owner。
- [ ] **Step 4: 自测**：建 3 个用户，分别是 owner、editor、非成员，按审阅重点第 1、2、3 条逐条验证状态码。
- [ ] **Step 5**：`npm test` 全部通过后提交：`feat(api): 项目成员管理与用户搜索`

---

### Task 4: README

- [ ] 新增「项目与权限」一节：说明三种角色能做什么（照搬契约里的表），说明升级时老用户会自动成为已有项目的编辑者；接口表补上成员接口。
- [ ] 提交：`docs: README 补充项目权限`

## 完成后回报

- 每个 Task 的提交号；
- Task 2 的路由权限对照表；
- 审阅重点第 1 条的越权测试结果：每一类资源，非成员访问得到的状态码。
