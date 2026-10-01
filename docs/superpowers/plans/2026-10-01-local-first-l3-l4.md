# 本地优先 L3（同步引擎）+ L4（同步界面）实施计划

> 执行方式：session1 做 Task 1、2、3（按顺序）；session2 做 Task 4、5（Task 4 在 Task 1 的接口定下来后就能开始，Task 5 等 Task 3）。
> **每个 Task 一个提交，只提交、不推送；提交时只写自己改的路径：`git commit -- <路径>`。** 不要用 `git add .`、`git add web/src` 这种宽泛的写法。改了前端的，提交前重新 `npm run build:web`，并把 `lib/web` 一起提交。

**目标：** 方案 1。本机只有一份数据，跟着最后登录的账号走：
- 登录了就双向同步；
- 退出登录后数据都在，照常能用；
- 第一次登录时，没登录时建的项目自动上传。

**设计稿：** `docs/design/2026-10-01-local-first.md` 第 2 版（第 3、4、5.2、5.3、7 节）。**先读设计稿再动手**，本计划只写设计稿没定下来的实现细节。第 1 版的 L3a 计划（`2026-10-01-local-first-l3a.md`）作废。

## 全局约定

- **不写新测试。** 每个 Task 跑 `npm test`（71 个），必须全过。验证用一次性脚本：放在系统临时目录，用临时数据目录（`--data-dir`、`APILOOP_HOME`），**不要碰真实的 `~/.apiloop`**，跑完删掉，回报里贴结果。
- 界面行为由用户确认。用户看得到的文字一律中文。
- 云端会话（`session.json` 里的内容）不能写进日志，不能交给浏览器。

## 审阅重点

1. **应用云端的行不能用 `INSERT OR REPLACE`。** REPLACE 会先删行，外键级联会把子行一起删掉。必须「存在就 UPDATE、不存在才 INSERT」。
2. **拉下来的修改不能被当成待同步推回去。** 应用云端的行时，本机库的触发器也会写 `changes`，要在同一个事务里删掉。
3. **绑定和切换空间时，先关库再动文件**（`data.db`、`-wal`、`-shm` 一起改名或删除）。改名失败要退回原状，网关要能继续用原来的空间。
4. **退出登录、会话过期、断网时，本机的修改一条都不能丢**；下次这个账号登录后要能推上去。
5. **换账号：** A 的数据 B 看不到；换回 A，A 的数据还在，而且 A 在 B 期间没同步的修改照样能推上去。

---

## L3（session1）

### Task 1：空间管理、打开即进入、网关接管登录和退出

**文件：**
- 重写 `lib/gateway/space.js`；新建 `lib/gateway/account.js`；修改 `lib/gateway/index.js`
- **删除**第一期的转发模式：
  - `createForwarder` 对数据接口的转发；
  - `mode` 的 local/cloud 调度；
  - `POST /__apiloop/local/enter`；
  - `lib/gateway/send.js`、`lib/gateway/ws.js`（向云端 prepare / record 的那一套）。
  
  本机发送和 WebSocket 一律走当前空间的本机管理台。`lib/gateway/cloud.js` 里的 `requestJson`、`normalizeCloudUrl` 等工具函数保留。

**接口（`space.js`）：**
- `createSpaceManager({ dataDir, getCloudUrl, log }) -> manager`
- `manager.current() -> { key, dir, handle, admin, user, state }`
  - `state` 取 `'unbound'`、`'signedIn'`、`'signedOut'`；
  - `user` 是 `{ id, username, displayName, role }`。
- `manager.cloudCookie() -> string | null`：已登录时返回 `session.json` 里的云端 Cookie（形如 `apiloop_sid=…`），否则 null。
- `manager.signIn(cloudUser, cloudCookie) -> current()`：做设计稿 4.3 第 2、3 步。
- `manager.signOut()`：清掉 `session.json` 的会话，`state` 变成 `signedOut`。
- `manager.markExpired()`：同 `signOut`，但 `status` 里 `sync.expired = true`。
- `manager.deleteCurrent()`：删掉当前空间目录，换成新的空的未绑定空间。
- `manager.onChange(fn)`：空间切换、状态变化时通知（同步引擎用）。
- `spaceKey(cloudUrl, userId) -> '<主机>~<端口>~<账号ID>'`：
  - 主机小写；端口没写时，http 是 80、https 是 443；
  - 除了字母、数字、`.`、`-`、`_`、`~`，其他字符一律换成 `_`。

**细节：**
- **`gateway.json`** 改成 `{ cloudUrl?, currentSpace }`，`currentSpace` 默认 `'local'`。L1 留下的 `mode` 读到了就忽略。
- **`session.json`**：`{ cookie, user: { id, username, displayName, role }, signedInAt }`，写入时 `{ mode: 0o600 }`。账号空间里没有这个文件，就是 `signedOut`。
- **绑定未绑定空间**（4.3 第 2 步的前两种情况）：
  - U 在本机没有空间：
    1. 先在本机库里插入 U 这一行用户（`password_hash: ''`）；
    2. 把 `project_members.user_id`、`projects.created_by`、`history.user_id`、`cookies.user_id` 里的 `u_local` 都换成 U.id；
    3. 删掉 `u_local` 和所有 `sessions`；
    4. 关库，把整个 `spaces/local` 目录改名成 U 的空间目录，再打开。
  - U 在本机已经有空间：
    1. 打开 U 的库，`ATTACH` 未绑定空间的库；
    2. 按 projects → project_members → environments → folders → apis → examples → mock_expectations 的顺序 `INSERT INTO main.x SELECT * FROM src.x`。成员表只插 U 一行 owner；
    3. `history`、`cookies` 不带 `id` 列插入，`user_id` 换成 U.id；
    4. `DETACH`，删掉未绑定空间目录。
    
    插入会触发本机的 `changes`，所以这些行自然就是「待同步」。
- **打开即进入：** 当前空间的本机管理台前面加一个中间件：
  - 先用 `auth.createSessionMiddleware(handle)` 认人；
  - 认不出来，就 `auth.createSession(handle, current().user.id, res)`，并把请求的 `Cookie` 头改成新发的这一个，交给管理台。
  - 页面打开就有身份，不经过登录页。
- **登录（`account.js`）：** 网关自己处理 `POST /__admin/api/auth/login`（挂 `express.json`）：
  1. 用 `cloud.requestJson` 调云端的 `/auth/login`：
     - 连不上云端，返回 502 `{ error: '连不上云端，登录需要联网。不登录也可以继续在本机使用' }`；
     - 云端返回非 2xx，状态码和内容原样返回；
     - 成功时，从云端响应的 `Set-Cookie` 里取出 `apiloop_sid=…`。
  2. `manager.signIn(user, cookie)`，并把 U 的 `must_change_password` 同步进本机库的用户表。
  3. 给浏览器发 U 身份的本机会话，返回 `{ ok: true, user }`。页面会整页刷新。
- **退出：** 网关自己处理 `POST /__admin/api/auth/logout`：
  1. 带云端 Cookie 通知云端注销（失败不管）；
  2. `manager.signOut()`；
  3. 返回 `{ ok: true }`。**浏览器的本机会话保留**：退出后页面照常可用。
- **删除本机数据：** `POST /__apiloop/space/delete` → `manager.deleteCurrent()`，返回 `{ ok: true }`。
- **只有云端有的功能**（设计稿 4.5）：
  - 已登录时转给云端，`Cookie` 换成 `manager.cloudCookie()`；
  - 云端返回 401：`manager.markExpired()`；
  - `PUT /auth/password` 成功后，云端会发新会话：把新的 `Set-Cookie` 写回 `session.json`，并清掉本机库里 U 的 `must_change_password`；
  - 未登录时返回 409 `{ ok: false, code: 'LOGIN_REQUIRED', error: '这个功能要先登录' }`；
  - 判断用的路径（相对 `/__admin/api`）：
    - `/auth/password`
    - `/users`、`/users/` 开头的
    - `/projects/<pid>/members` 开头的
    - `/projects/<pid>/mock-log` 开头的
    - `/downloads`
- **`GET /__apiloop/status`** 在原有字段上：
  - 加 `space: { state, user }`；
  - `mode` 保留一个兼容值：`state === 'unbound' ? 'local' : 'cloud'`，L4 改完前端后再删。

**回报（一次性脚本：一个云端、一个网关，临时目录）：**
1. 新装（空的数据目录）打开：不登录就能 `GET /meta`，`user.id === 'u_local'`；建一个带接口的项目。
2. 用云端账号 A 登录：`spaces/local` 改名成了 A 的目录；本机库里 `u_local` 没了，项目的 owner 是 A；本机 `changes` 里有这些行（待同步）。
3. 退出：`state === 'signedOut'`，`/projects` 照常返回数据；只有云端有的功能返回 409。
4. 再登录 A：`state === 'signedIn'`，只有云端有的功能转给了云端（贴一次 `/users/lookup` 的结果）。
5. 登录 B：切到 B 的空的空间，A 的目录还在；再登录 A：A 的数据都在。
6. 删除本机数据：当前空间目录没了，换成了新的未绑定空间。
7. A 在本机已有空间时，从未绑定空间登录 A：项目和历史合并进了 A 的空间，未绑定空间目录被删掉。
8. 网关目录里已经没有 `send.js`、`ws.js`；本机发送一个请求，目标服务器收到。

### Task 2：同步引擎骨架和拉取

**文件：** 新建 `lib/gateway/sync/engine.js`、`lib/gateway/sync/apply.js`、`lib/gateway/sync/pull.js`；修改 `lib/gateway/index.js`、`lib/gateway/space.js`（打开空间时建同步用的表）

**接口：**
- `apply.ensureTables(handle)`：建 `sync_base(entity, entity_id, rev, row_json, PRIMARY KEY(entity, entity_id))` 和 `sync_conflicts(entity, entity_id, fields_json, remote_row_json, created_at, PRIMARY KEY(entity, entity_id))`。打开任何空间时都调用。
- `apply.applyRemote(handle, items) -> void`：
  - `items` 是 `[{ entity, id, row | null }]`，`row` 为 null 表示删除；
  - 一个事务里做完：先记下 `MAX(seq) FROM changes`；
  - 插入、更新按「父级在前」，删除按「子级在前」；
  - 行已存在就 UPDATE 所有列（包括 `rev`），不存在就 INSERT（审阅重点 1）；
  - 每行同时更新 `sync_base`（删除就删掉基线）；
  - 最后 `DELETE FROM changes WHERE seq > <记下的值>`（审阅重点 2）。
  - 列清单用 `PRAGMA table_info(<表>)` 读出来，`lib/sync/rows.js` 的实体和表的对应关系可以复用。
- `apply.pendingKeys(handle) -> Set<'entity:id'>`：本机 `changes` 里出现过的。
- `pull.runPull({ handle, cloud }) -> { applied, removedProjects, warnings }`：设计稿 5.2「一轮同步」的第 1、2 步。
  - **第 2 步里本机也改过的行，这个 Task 先跳过**，留着 Task 3 合并。只记数，放进 `warnings`；
  - `cloud` 是 `{ get(path), post(path, body) }`，由引擎用 `cloud.requestJson` 加上云端 Cookie 包好。
- **成员镜像：**
  - `users` 改成和 state 里的一致：没有的插入，`password_hash` 为空串；当前登录的那个用户不删；
  - `project_members` 按 state 整表替换。
- `engine.createSyncEngine({ manager, getCloudUrl, log }) -> { kick(reason), status() }`：
  - `status()` 返回 `{ running, online, pending, conflicts, lastSyncAt, lastError, expired }`；
  - 只在 `signedIn` 时跑；
  - 触发时机按设计稿 5.2：登录后、启动时、每 30 秒、离线时每 10 秒试一次。「本机写入后 2 秒」在 Task 3 加；
  - 同一时间只跑一轮，跑的时候又被触发，就等跑完再跑一次；
  - 云端返回 401：`manager.markExpired()`；
  - 返回 410：这个 Task 先把 `lastError` 设成「需要重新下载」，处理放在 Task 3。
- `/__apiloop/status` 加上 `sync: engine.status()`。

**回报（一次性脚本）：**
1. 云端有项目 P（带目录、接口、示例、期望、环境），网关登录后：本机库里逐列一致（包括 `rev`），`sync_base` 齐全，本机 `changes` 是空的。
2. 在云端网页上改 P 的一个接口、删一个示例、加一个目录，等一轮：本机跟上了，`changes` 仍然是空的。
3. 云端删掉一个带子目录和接口的目录：本机对应的行都没了，**同级的其他行没被误删**（专门检查审阅重点 1）。
4. 把 B 从 P 的成员里移掉，B 的网关同步后：本机没有 P 了。
5. 杀掉云端：`online = false`；重启云端，10 秒内恢复同步。

### Task 3：推送、合并、冲突

**文件：** 新建 `lib/gateway/sync/push.js`、`lib/gateway/sync/merge.js`；修改 `engine.js`、`index.js`

**接口：**
- `push.runPush({ handle, cloud }) -> { pushed, conflicts, failed, warnings }`：设计稿 5.2 第 3 步。
  - 从 `pendingKeys` 取出待同步的行：本机现在有，就推现在的行；没有，就推 `deleted: true`。`baseRev` 取 `sync_base`，没有是 0；
  - 排序：项目 → 环境 → 目录（父目录在前）→ 接口 → 示例 → 期望；删除的子级在前；
  - `ok`：`sync_base` 更新成推上去的行加新的 `rev`；本机库的 `rev` 也改成新的，用 UPDATE 只改 `rev`（v7 触发器只看业务列，不会再记一条）；删掉这一行在 `changes` 里、`seq` 不大于这次读取时最大值的记录；
  - `conflict`：交给 `merge`；
  - `forbidden`：用 snapshot 取回这个项目里这一行的云端版本，`applyRemote` 覆盖本机；`warnings` 加一条「你在项目 X 里是只读成员，修改没有保存到云端」；
  - `invalid`：留着，`lastError` 写原因。
- `merge.mergeRow(entity, base, mine, theirs) -> { merged, conflictFields }`：设计稿 5.3 的按列三方合并。
  - 位置列（`folder_id`、`parent_id`、`position`）用 theirs；
  - `rev`、`created_at`、`updated_at` 不参与比较。
  - 没有冲突：本机写成 `merged`，基线换成 theirs，留在待同步里，下一轮推送；
  - 有冲突：写进 `sync_conflicts`，这一行暂停推送。
  - **拉取时遇到本机也改过的行，也走这里**（补上 Task 2 跳过的部分）。
- **一边删了、一边改了**：
  - 本机删了、云端改了：取消删除，用云端的行重新建出来，提示一下；
  - 本机改了、云端删了：推送时 `baseRev > 0`，云端会 `recreated`，提示一下。
- **410：** 按设计稿 5.3 最后一条处理。
- **引擎：** 一轮 = 拉取 → 推送。本机库每次写入之后约 2 秒触发一次：在本机管理台的 `handle.events` 上监听 `change` 事件。
- **冲突接口（给 Task 5 用）：**
  - `GET /__apiloop/sync/conflicts` → `{ items: [{ entity, id, name, fields: [{ field, base, mine, theirs }] }] }`；
  - `POST /__apiloop/sync/conflicts/resolve`，请求体 `{ entity, id, choice: 'mine'|'theirs'|'copy' }`，按设计稿 5.3 处理。`copy` 只对接口有效：新 ID 用 `newId('a')`，名字加「（我的副本）」，所在目录和位置和原来一样；
  - `GET /__apiloop/sync/pending` → `{ items: [{ entity, id }] }`，给目录树打标记用。

**回报（一次性脚本：一个云端、两个网关 X 和 Y，同一个账号）：**
1. X 新建接口：Y 下一轮出现。X 改名字、Y 改地址：两边最后都是新名字加新地址。
2. X、Y 同时改同一个接口的地址：后同步的那边出现冲突。选「用我的」后两边一致；另一次选「另存为副本」，多了「原名（我的副本）」。
3. X 断网时改了三个接口、删了一个目录：联网后自动推上去，Y 跟上。
4. 推送到一半杀掉云端：重启后继续，云端没有重复的行。
5. X 删了一个接口、Y 同时改了它：最后保留改过的那份，有提示。
6. 只读成员推送：本机被改回云端的版本，有提示。
7. 第一次登录上传到一半断网：联网后继续，本机数据一条没少。
8. 退出登录后改了两个接口，再登录同一个账号：推了上去。

---

## L4（session2）

### Task 4：打开即进入、登录页、账号菜单、顶栏状态

**文件：**
- `web/src/router.js`、`web/src/views/LoginView.vue`
- `web/src/components/layout/UserMenu.vue`、`ConnectionStatus.vue`、`TopBar.vue`
- `web/src/stores/gateway.js`、`web/src/api/gateway.js`
- 用到 `gateway.isLocal` 的地方：`MockPanel.vue`、`EnvSwitcher.vue`、`env.js`、`tabs.js`、`ProjectSettingsView.vue`、`TopBar.vue`、`LoginView.vue`

**接口（`stores/gateway.js`）：**
- `spaceState`：`status.space.state`，不是网关时为空串；
- `signedIn`：`spaceState === 'signedIn'`；
- `cloudFeaturesAvailable`：不是网关，或者 `signedIn`。修改密码、用户管理、成员管理、mock 日志、安装包列表都看它；
- `mockAvailable`：不是网关，或者 `spaceState !== 'unbound'`。Mock 面板、Mock 环境看它；
- `sync`：`status.sync`；
- `gatewayApi.deleteSpace()`：调 `POST /__apiloop/space/delete`。

把现在所有的 `gateway.isLocal` 换成上面这几个里语义对应的那个，然后删掉 `isLocal` 和 `mode`。

**做什么：**
- **打开即进入：** 网关上 `/meta` 不会再返回 401（网关自动发会话），不用改路由守卫。登录页：
  - 删掉「跳过登录，先在本机用」，换成链接「不登录，继续在本机使用」（`router.replace('/workbench')`）；
  - 连不上云端的提示改成设计稿 4.2 的文案；
  - 本机模式下那行灰字改成：「登录后，本机的项目会自动同步到这个账号。」
- **账号菜单：** 按设计稿 7 节「账号菜单」的三种情况。
  - 「退出登录」在网关上：调 `/auth/logout` 后不跳登录页，`gateway.refresh()` 就行；
  - 「退出并删除本机数据」「删除本机数据」：先确认，`sync.pending > 0` 时写明「还有 N 项没同步，删除后会丢失」；确认后 `deleteSpace()` 并整页刷新。
- **顶栏状态：** 按设计稿 7 节的表，`status.space` 加 `status.sync`。网关上每 3 秒刷新一次。
- **「登录后可用」：** `cloudFeaturesAvailable` 为 false 时：
  - 修改密码、用户管理、成员页签、mock 日志按钮：不显示；
  - 安装包对话框：显示「登录后可用」。
- 接口返回 409 `LOGIN_REQUIRED` 时，`message.warning(error)`，不要跳登录页。

### Task 5：冲突处理界面和待同步标记

**文件：** 新建 `web/src/components/sync/ConflictDialog.vue`；修改目录树（`ApiTree.vue`）、请求标签页顶部（`RequestTab.vue`）、`ConnectionStatus.vue`、`stores/gateway.js`

**做什么：**
- `sync.pending > 0` 时，每次刷新 status 后顺带调 `GET /__apiloop/sync/pending`。目录树里在列表中的目录、接口，名字后面加一个小圆点（灰色，悬停提示「还没同步到云端」）。
- `sync.conflicts > 0` 时，调 `GET /__apiloop/sync/conflicts`：
  - 目录树里有冲突的显示红色感叹号；
  - 打开有冲突的接口，标签页顶部一条红色提示「这个接口和云端有冲突」，带「处理」按钮。
- **冲突对话框：**
  - 左「我的」，右「云端的」，只列冲突的字段；JSON 列按 `JSON.stringify(x, null, 2)` 显示；
  - 三个按钮「用我的」「用云端的」「另存为副本」，「另存为副本」只对接口显示；
  - 调 `POST /__apiloop/sync/conflicts/resolve` 后刷新目录树和这个标签页。
- 顶栏「N 个冲突」点开是冲突列表，点一项打开对话框。
