# P10：mock 代理转发与录制 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **本项目约定**
> - **不写新测试**，也不装浏览器驱动做验证；既有的 `npm test` 必须全部通过。
> - 手工核对清单是交给用户的；一次性探测脚本放在 `/tmp`，跑完删掉。
> - **只提交，不推送**；只提交自己的文件，不要用 `git add -A`、`commit -a`、`git stash`。

**开工时间**：**2.0.0 发布之后**。稳定期内只修 bug，所以这份计划要等用户核对通过、打完 tag 之后才开始。

**分工**：
- **A 部分**是后端，由 session1 负责；
- **B 部分**是前端，由 session2 负责。

两部分可以并行，按契约开发。

**规则全部在契约里**：[docs/design/2026-09-30-admin-api-v2.md](../../design/2026-09-30-admin-api-v2.md) 第 18 节。

## 全局约束

- **不新增依赖**。转发走执行器，因为执行器已经处理了代理、证书、解压和背压。
- **迁移只能追加**，这次是 v6，不能修改已经发布的 v1–v5。
- **能复用的一律复用**，不能另写一份：
  - HAR 导入里的这几样：文本类型的判断、凭据清理、响应头清理、示例去重、每个接口 5 条的上限。把它们从 `lib/har.js` 抽到一个共用模块里，比如 `lib/recording.js`，HAR 导入改成调用这个模块，行为不能变；
  - 接口匹配用 mock 运行时编译路由的那一套方法。
- **文件范围**：
  - A 部分：`lib/**`（`lib/web/**` 除外）、`README.md`、`docs/api.md`；
  - B 部分：`web/**`、`lib/web/**`。

## 审阅重点

1. **转发的触发条件**：
   - 只有本地都没有接住的请求才转发；
   - 根项目要排在 `router.js` 和静态文件后面；
   - mock 关着的接口，照样转发；
   - `/__admin`、`/__apiloop` 永远不会被转发。
2. **请求体原样转发**：挂在 mock 路由前面的 `body-parser` 可能已经把请求体读走了。转发 JSON、表单、二进制这三种请求体时，上游收到的内容都要和客户端发出的一模一样。
3. **响应的背压和编码**：
   - 转发一个 300MB 的响应，客户端读得慢时，服务端内存不能涨，做法同 P7b 的 M1；
   - gzip 压缩的上游响应转发给客户端之后，不能出现「已经解压、却还带着 `content-encoding: gzip`」的情况。
4. **录制的安全和上限**：
   - 默认去掉凭据；
   - 到了 2 小时之后自动停止；
   - 新建接口最多 500 个；
   - 每个接口最多 5 条示例，并且去重；
   - 新录下来的接口，`mock.enabled` 为 false，这样后续的请求会继续转发。
5. **不能影响原来的 mock**：`forwardUrl` 为空时，行为和现在完全一样，没匹配上的请求照样返回 404，不会多出任何开销。

---

## A 部分：后端（session1）

### Task A1：转发

**Files:**
- 迁移 v6：`lib/db/migrations.js`
- `lib/db/repos/projects.js`、`lib/api/dto.js`、`lib/api/projects.js`（`mockSettings` 的读写和校验）
- 新建 `lib/mock-forward.js`：导出 `forward(req, res, { project, pathname, onLog })`
- `lib/mock-host.js` 和 `lib/command.js`：接入的位置按审阅重点第 1 条

- [ ] 迁移、DTO、`PUT /projects/:pid` 的校验，规则见契约。
- [ ] **拿到原始请求体**：在 mock 相关的 body 解析器上配置 `verify` 回调，把原始 Buffer 挂到 `req.rawBody` 上；没有被解析器处理过的请求（比如二进制请求体），就直接从流里读。具体怎么做由你决定，但要满足审阅重点第 2 条。
- [ ] 实现 `mock-forward.js`：用执行器发请求，`followRedirects: false`，`timeoutMs: 60000`，走系统代理设置；用流式钩子加背压，把响应写回给客户端；按契约处理响应头、CORS 和 502。
- [ ] **mock 调用日志**：新增 `forwarded` 和 `upstreamStatus` 两个字段，契约第 11 节的返回结构随之扩展。
- [ ] **自测**：本地起一个上游服务。
  - 分别转发 JSON、urlencoded、二进制三种请求体，上游收到的字节和原始的完全一致；
  - 上游返回 gzip 压缩的响应，客户端能正确解码；
  - 返回 302 时，原样转给客户端，不跟随跳转；
  - 上游连不上时返回 502；
  - 转发一个 300MB 的响应、客户端读得很慢时，服务端 RSS 不上涨；
  - 根项目下，`router.js` 和静态文件优先于转发；
  - `forwardUrl` 为空时，仍然返回 404。
- [ ] 提交：`feat: mock 未命中时转发到真实后端`。

### Task A2：录制

**Files:** 新建 `lib/recording.js`（从 `lib/har.js` 抽出公共部分，HAR 导入改成调用它）、`lib/mock-forward.js`、`lib/api/projects.js`、`lib/api/tree.js`（新接口 `enable-mock`）、`README.md`、`docs/api.md`

- [ ] **先抽公共模块**，HAR 导入改成调用它。改完跑一次 `npm test`，再重跑一遍 HAR 导入的自测（和之前的结果一致），证明行为没有变。
- [ ] **开启录制**：`PUT /projects/:pid` 把 `record.enabled` 从 false 改成 true 时，自动新建目录「录制 YYYY-MM-DD HH:mm」，设置 `folderId`，`until` 设为「现在 + 2 小时」；如果前端传的 `until` 更早，就用前端的。
- [ ] **转发之后录制**：
  - 响应要**一边转发给客户端、一边在内存里保留一份**，最多 1MB，超过就放弃录制，但转发照常进行；
  - 按契约查找或新建接口、写示例，每个响应一个独立事务，带 `{ projectId }`；
  - 到了 `until` 就自动关闭录制；
  - 新建接口达到 500 个时，停止录制，并在 mock 调用日志里记一条说明。
- [ ] **`POST /projects/:pid/recorded/enable-mock`**：把目录（包括子目录）下符合条件的接口一次性全部启用 mock。
- [ ] **README**：新增一节「转发与录制」，把用法、安全提示（开启录制时，谁都能往项目里写数据）、各项上限都写清楚。
- [ ] **自测**：
  - 同一个路径返回 3 种不同的响应，录下 3 条示例；重复的响应不会重复记录；
  - 带 `:id` 的已有接口，`/users/1` 和 `/users/2` 都录到这个接口下面；
  - 凭据默认被去掉；
  - 把 `until` 手动设成已经过期的时间，下一次转发时就不再录制，`enabled` 变回 false；
  - 调用 `enable-mock` 之后，同样的请求改由 mock 返回，不再转发。
- [ ] 提交：`feat: mock 录制模式`。

---

## B 部分：前端（session2）

### Task B1：转发与录制的设置和状态

- [ ] **项目设置新增「转发与录制」页签**，editor 及以上可以编辑，viewer 只能看：
  - 转发目标地址，保存时由服务端校验，400 的原因原样显示；
  - 录制开关，旁边有时长选择：30 分钟、1 小时、2 小时，默认 1 小时；
  - 「保留凭据」复选框，默认不勾选，勾选时用警告色说明后果；
  - **开启录制之前先弹一个确认框**，写明「录制期间，任何能访问 mock 地址的人都能往这个项目里写入接口和示例」。
- [ ] **录制中的状态提示**：工作台顶栏显示一个红色的「● 录制中 剩余 xx 分钟」标签，点击可以停止录制，也就是 `PUT` 把 `record.enabled` 设为 false。倒计时由前端根据 `until` 计算，时间到了之后重新拉取一次项目。
- [ ] **录制目录**：录制目录的右键菜单里，加一项「启用这里所有接口的 mock」，调用 `enable-mock`，完成后提示「已启用 N 个」，并刷新目录树。
- [ ] **mock 调用日志**：转发的记录，命中情况一栏显示灰色的「转发 → 200」；502 显示成红色。
- [ ] **Mock 页签**：在项目的 mock 地址旁边加一句说明：配置了转发目标时写「未命中的请求会转发到 xxx」，没有配置时写「未命中返回 404」。
- [ ] 执行 `npm run build:web`，然后提交：`feat(web): 转发与录制设置、录制状态与日志`。

## 手工核对清单（交给用户）

- [ ] 在项目设置里填上真实后端的地址，把前端项目的接口地址改成 `http://localhost:8080/mock/<项目>`。前端页面能正常使用，mock 日志里全是「转发」。
- [ ] 开启录制，把前端页面正常点一遍，然后停止录制。「录制 xx」目录下出现了接口和示例，请求头里没有 Cookie 和 Authorization。
- [ ] 右键录制目录，选「启用这里所有接口的 mock」，然后关掉后端服务，前端页面照样能用，数据都来自 mock。

## 完成后回报

- 每个 Task 的提交号；
- A1 自测里，请求体逐字节比对的结果、背压时的 RSS 数字；
- 契约第 18 节里写得不清楚的地方。
