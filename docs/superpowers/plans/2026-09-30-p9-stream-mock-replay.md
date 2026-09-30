# P9：SSE 与 WebSocket 的 mock 回放 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **本项目约定**
> - **不写新测试**，也不装浏览器驱动做验证。既有的 `npm test` 必须全部通过。
> - 手工核对清单是交给用户的；一次性探测脚本放在 `/tmp`，跑完删掉。
> - **只提交自己的文件**：用 `git commit -m ... -- <文件>`。不要用 `git add -A`、`commit -a`、`git stash`。
> - **只提交，不要推送**（2026-09-30 用户规定）：`git push` 统一由审阅方在审过之后执行。

**分工与排期**：
- **A 部分**是后端，由 session1 负责，排在 P8 A 部分之后；
- **B 部分**是前端，由 session2 负责，排在 P8 B 部分之后。

两部分可以并行，按契约先写代码。

**规则全部在契约里**：[docs/design/2026-09-30-admin-api-v2.md](../../design/2026-09-30-admin-api-v2.md) 第 17 节。

## 全局约束

- **新增依赖只有 `ws`**，写进 `dependencies`，版本锁定为 `8.x` 的最新版。它只用作 **mock 服务端**；WebSocket 调试会话仍然用 Node 自带的客户端。
- **计时器与连接**：所有回放用的计时器，在客户端断开、服务关闭时都要清理干净。WebSocket mock 连接要能被 `closeAll` 全部关掉，挂在服务关闭的流程上。
- **不能影响 HTTP 的 mock**：`method` 为 `WS` 的接口不注册 HTTP 路由；非 `sse` 的示例，行为和原来完全一样。
- **文件范围**：
  - A 部分：`lib/**`（`lib/web/**` 除外）、`package.json`、`package-lock.json`、`README.md`、`docs/api.md`；
  - B 部分：`web/**`、`lib/web/**`。

## 审阅重点

1. **SSE 回放的节奏和断开**：
   - 事件按 `delay` 到达；
   - 客户端断开之后，计时器全部清理；
   - 设置了 `repeat` 的无限回放，在客户端断开之后必须停下；
   - 每条 `data` 在发送的那一刻才渲染模板，所以每次拿到的随机值都不一样。
2. **WebSocket 的升级请求只由 mock 处理**：
   - `/__admin`、`/__apiloop` 开头的升级请求直接断开；
   - 找不到对应接口时返回 404；
   - 每个项目最多同时保持 100 个连接。
3. **路由匹配**：WebSocket 的路径匹配和 HTTP 用同一套编译方式，`:id` 这类路径参数要能匹配；非根项目要带上 `/mock/<slug>` 前缀。
4. **写入时的校验**：`sse` 和 `ws` 示例的 `body` 不合法时返回 400，并且给出中文原因。已经存在库里的坏数据，运行时也不能让进程崩溃，沿用 mock 运行时逐条兜底的做法。
5. **录制时的时间换算**：第一条的 `delay` 从哪里开始算，要和契约一致。
   - SSE：从 `head` 到达开始算；
   - WebSocket 的 `onOpen`：从 `open` 事件开始算；
   - 每条 `reply`：从它前面那条发出的消息开始算。

---

## A 部分：后端（session1）

### Task A1：SSE 回放

**Files:** `lib/mock-runtime.js`（或者新建 `lib/mock-sse.js`，由 mock 运行时调用）、校验放在示例写入的地方（`lib/api/tree.js` 或 dto）、`lib/routes-store.js`（`RESPONSE_TYPES` 加上 `sse`、`ws`）

- [ ] **校验**：写入示例时校验 `sse` 和 `ws` 两种 `body`，规则见契约。导入走 `writeTree`，这条路上的坏数据降级处理并给出 warning，不能让整个导入失败。
- [ ] **回放**：mock 命中的示例是 `sse` 类型时，按契约回放。模板渲染复用普通响应体用的那个渲染函数，并且在每条事件发送时调用一次。
- [ ] **mock 调用日志**：在发出响应头时记一条，`durationMs` 取发出响应头的耗时。
- [ ] **自测**：
  - 3 条事件，`delay` 分别是 0、500、1000，确认到达时间分别约为 0、500、1500ms；
  - `data` 里写 `{{@name}}`，确认每次请求渲染出来的值不一样；
  - `repeat: true` 时，客户端断开之后服务端不再写数据。可以用 `process._getActiveHandles` 的数量，或者给计时器计数来确认；
  - 坏的 JSON 写入时返回 400。
- [ ] 提交：`feat: SSE mock 回放`。

### Task A2：WebSocket 接口与 mock

**Files:** `lib/routes-store.js`（`METHODS` 加上 `WS`）、`lib/mock-runtime.js`（跳过 WS 接口）、新建 `lib/mock-ws.js`、`lib/command.js`（挂载 upgrade）、`lib/mock-host.js`（按项目查找）、`package.json`

- [ ] **允许 `method` 为 `WS`**。检查所有按 method 判断的地方：
  - mock 运行时注册 HTTP 路由时跳过它；
  - `/send` 遇到 WS 接口返回 400：「WebSocket 接口请用 WebSocket 标签页连接」；
  - Postman 导出时跳过它，并在 warnings 里说明；
  - HAR、cURL、OpenAPI 导入不会产生 WS 接口。
- [ ] **`lib/mock-ws.js`**：
  - 导出 `createMockWs({ handle, mockHost }) → { handleUpgrade(req, socket, head), closeAll() }`，内部用 `new WebSocketServer({ noServer: true })`；
  - 匹配规则见契约，路径匹配复用 mock 运行时编译路由的方式；
  - 回放 `onOpen` 和 `rules` 时，模板在发送时渲染；
  - 连接关闭时清理计时器；
  - 维护每个项目的连接计数，超过 100 个时以 1013 关闭；
  - mock 调用日志在握手成功时记录一条。
- [ ] 在 `lib/command.js` 创建 HTTP 服务器的地方挂上 `server.on('upgrade', ...)`，服务关闭时调用 `closeAll()`。
- [ ] **README 和 `docs/api.md`**：写清楚 SSE 和 WebSocket mock 的用法、示例格式和限制。
- [ ] **自测**：用 Node 自带的 `WebSocket` 当客户端：
  - `onOpen` 的两条消息按间隔到达；
  - 发送能匹配上规则的消息，按间隔收到回复；
  - 发送匹配不上的消息，按 `fallback` 处理（`echo` 或 `none`）；
  - 路径 `/ws/:room` 能匹配；非根项目要带 `/mock/<slug>` 前缀；
  - 请求 `/__admin/x` 时直接断开；
  - 连接第 101 个时被拒；
  - 客户端断开后，没有残留的计时器。
- [ ] 提交：`feat: WebSocket 接口入树与 mock 回放`。

---

## B 部分：前端（session2）

### Task B1：保存为 SSE 示例 + 示例编辑器支持 sse / ws

- [ ] **保存为 SSE 示例**：在 SSE 事件视图里加一个「保存为 SSE 示例」按钮。只在「editor 及以上、这个标签页绑定了接口、响应已经结束」时显示。
  - `delay` 按每个事件的到达时间计算，第一条从 `head` 到达开始算；
  - 事件列表超过上限、丢过旧事件的，提示「只保存了最近 2000 条」；
  - 调用 `POST /apis/:id/examples`，`responseType` 设为 `sse`，然后切换到 Mock 页签并选中这个新示例。
- [ ] **示例编辑器**：`responseType` 的下拉框加上 `SSE` 和 `WebSocket` 两个选项。选中这两种时，编辑器是 JSON 模式，上方放一行格式说明，以及「插入示例结构」按钮，插入的就是契约里那段示例 JSON。服务端返回的 400 原因显示在编辑器上方。
- [ ] 执行 `npm run build:web`，然后提交：`feat(web): 保存为 SSE 示例；示例编辑器支持 sse / ws`。

### Task B2：WebSocket 接口入树 + 保存为 mock

- [ ] **新建**：「新建接口」的方法下拉里加上 `WS`。目录树里 `WS` 接口用独立的颜色和标签显示。
- [ ] **打开**：打开一个 `WS` 接口时，走 WebSocket 标签页：
  - 地址、请求头、query、鉴权从接口里读取；
  - 可以保存，保存时 `PUT /apis/:id`，和接口标签页一样有「未保存」标记，也支持 `Ctrl+S`；
  - 原来那种临时的 WebSocket 标签页保留，并加一个「保存到目录」按钮，保存后转成绑定接口的标签页。
- [ ] **WS 接口的 Mock 页签**：可以启用 mock、设置路径和默认示例、编辑示例（用 B1 的 ws 编辑器）。**不显示期望。** 显示 mock 地址，协议换成 `ws://`（页面是 https 时换成 `wss://`），并提供复制按钮。
- [ ] **保存为 mock**：在已经绑定接口的 WebSocket 标签页上，加一个「保存为 mock」按钮。
  - 按契约第 17 节的规则，从当前的消息日志生成场景；
  - 生成之后先显示一个预览，列出「连接后会推送 N 条、生成 M 条规则、跳过 K 条二进制消息」，用户确认之后才保存；
  - 保存后切换到 Mock 页签。
- [ ] 执行 `npm run build:web`，然后提交：`feat(web): WebSocket 接口入树与保存为 mock`。

## 手工核对清单（交给用户）

- [ ] 用一个真实的 SSE 接口发送一次，点「保存为 SSE 示例」，然后启用 mock。用浏览器的 `EventSource` 或者 curl 访问 mock 地址，事件按原来的节奏出现。
- [ ] 连一个 WebSocket 服务，发几条消息，保存到目录，再点「保存为 mock」。用任意 WebSocket 客户端连 mock 地址：连上之后先收到录下来的推送；发送同样的消息，按原来的节奏收到回复。

## 完成后回报

- 每个 Task 的提交号；
- A1 和 A2 自测里的到达时间；
- B 部分：`lib/web/__apiloop` 经 gzip 压缩后的体积变化；
- 契约第 17 节里写得不清楚的地方。
