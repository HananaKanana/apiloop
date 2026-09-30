# P7b：流式发送（SSE）与 WebSocket 调试 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **本项目约定**
> - **不写新测试**，也不装浏览器驱动做验证。既有 `npm test` 必须全部通过。
> - 手工核对清单是交给用户的，不要自己执行。审阅用的一次性探测脚本放在 `/tmp`，跑完删掉，不进仓库。
> - **只提交自己的文件**：`git commit -m ... -- <文件>`。**不要用 `git add -A`、`commit -a`、`git stash`**，工作区是两个会话共用的。

**分工**：
- **A 部分**是后端，由 session1 负责；
- **B 部分**是前端，由 session2 负责。session2 要先交付 HAR 导入的审阅修复，然后再开工。

两边**可以并行**：接口已经写死在契约里。B 部分在 A 部分交付之前，只能先写代码，联调要等 A 部分交付之后。

**规则全部在契约里**：[docs/design/2026-09-30-admin-api-v2.md](../../design/2026-09-30-admin-api-v2.md) 第 14 节（流式发送）和第 15 节（WebSocket 会话）。本计划只补充契约里没有写的实现决定。发现契约写得不清楚，先来问我。

## 全局约束

- **不引入新依赖**。WebSocket 客户端用 Node 自带的全局 `WebSocket`：Node 22.4 之后不需要任何标志就能用，而我们要求的是 `>=22.13`。我已经实测过，它支持 `new WebSocket(url, { headers })` 这种写法，可以带自定义请求头。
- 所有长连接的计时器都要调用 `.unref()`，不能因为它们挡住进程退出。
- **文件范围**：
  - A 部分：`lib/**`（`lib/web/**` 除外）、`README.md`、`docs/api.md`；
  - B 部分：`web/**`、`lib/web/**`。

## 审阅重点

1. **`/send` 的行为不能变**：A1 会把 `/send` 的前后处理抽成公共函数，抽完之后，`/send` 的请求、响应、历史、Cookie、代理全部保持原样。`npm test` 就是证据。
2. **取消要传到上游**：浏览器取消了流式请求之后，上游的连接必须真的断掉，不能留下没关闭的 socket；历史要照样写一条 `ABORTED` 记录。WebSocket 也一样：`events` 连接全部断开满 60 秒，或者调用了 `DELETE`，上游的 WebSocket 必须真的关掉，计时器和监听器必须全部清理干净。
3. **超时的分界点**：流式请求在 `head` 到达之前，仍然受 `timeoutMs` 约束，比如连接不上的情况；`head` 到达之后，不再有总超时。
4. **不能出现乱码**：`chunk` 按 UTF-8 解码时，多字节字符可能被切在两个 chunk 之间，要用 `StringDecoder` 处理。前端解析 NDJSON 时，一行也可能被切在两次 `read()` 之间，同样要处理。
5. **WebSocket 会话只有创建者本人能访问**：其他成员和 admin 访问都返回 404；创建者被移出项目之后，也返回 404。

---

## A 部分：后端（session1）

### Task A1：执行器的流式钩子，以及 `POST /send/stream`

**Files:**
- Modify: `lib/executor.js`、`lib/api/send.js`
- Create: `lib/api/ndjson.js`

**Interfaces:**
- `executor.execute(spec, options)` 新增三个选项：
  - `onHead(head)`：最后一跳的响应头到达时调用一次，`head` 的结构是 `{ response: { status, statusText, httpVersion, headers }, redirects }`；
  - `onChunk(buffer)`：收到最后一跳的每一段**解压之后**的数据时调用；
  - `stream: true`：`head` 到达之后清除总超时的计时器。

  回调里抛出的异常要吞掉，不能影响执行器本身；执行器「永远 resolve」的约定不变。
- `executor.buildAuth(auth) → { headers: [[k, v]], query: [[k, v]] }`：把执行器里现有的 bearer、basic、apikey 处理逻辑原样抽出来，执行器自己也改成调用它。A2 会复用这个函数。
- `lib/api/ndjson.js` 导出：
  - `start(res)`：设置第 14 节规定的响应头，然后 `flushHeaders`；
  - `write(res, obj)`：写一行 JSON；连接已经断开时返回 false，不抛异常。
- `lib/api/send.js`：把 `/send` 的「校验、变量、鉴权继承、Cookie jar、代理、执行选项」和「写回 Cookie、写历史」抽成两个内部函数，`/send` 和 `/send/stream` 共用。

- [ ] 执行器加上这三个钩子。**只在最后一跳**调用 `onHead` / `onChunk`：重定向的中间几跳不要调用。实现时先确认 `readResponse` 在什么情况下会被重定向的中间跳调用到。
- [ ] 抽出 `buildAuth`，执行器改成调用它。改完跑一次 `npm test`。
- [ ] 抽取 `/send` 的公共部分，再跑一次 `npm test`（审阅重点第 1 条）。
- [ ] 实现 `POST /send/stream`：
  - 校验失败时，按普通 JSON 返回错误；
  - 校验通过后调用 `ndjson.start`，`onHead` 时写 `head` 事件，`onChunk` 时写 `chunk` 事件；
  - 文本类型的响应，用一个 `StringDecoder('utf8')` 转成 `text`，其他类型转成 `base64`；
  - 执行器 resolve 之后，先写回 Cookie、写历史，再写 `end` 事件，然后 `res.end()`。
- [ ] **自测**，脚本放在 `/tmp`，跑完删掉：
  - 本地起一个 SSE 服务，每 200ms 推送一条事件，推送 10 秒。确认事件是陆续到达的，而不是最后一次性到达；并且 `timeoutMs = 1000` 也不会把请求截断。
  - 推送到一半时断开客户端。确认上游服务端看到连接关闭，历史里有一条 `ABORTED` 记录。
  - 用一个 gzip 压缩的响应，再故意在多字节字符中间切开发送，确认解码结果正确。
  - 连接一个不存在的端口，确认收到 `end` 事件，里面是 `CONNECT` 错误。
- [ ] 提交：`feat: 流式发送 /send/stream（SSE 与大响应）`。

### Task A2：WebSocket 调试会话

**Files:**
- Create: `lib/ws-sessions.js`、`lib/api/ws.js`
- Modify: `lib/admin.js`（挂载路由）、`README.md`、`docs/api.md`

**Interfaces:**
- `lib/ws-sessions.js` 导出 `createRegistry({ now? }) → registry`，`registry` 提供这些方法：
  - `create({ userId, projectId, url, headers, protocols }) → session`；超过每个用户 10 个会话的上限时抛出错误；
  - `get(id, userId) → session | null`：不是本人的会话一律返回 null；
  - `send(id, { text | base64 })`：连接还没有打开，或者已经关闭时，抛出一个 `status = 409` 的错误；
  - `subscribe(id, after, listener) → unsubscribe`：先同步补发 `seq > after` 的缓冲事件，再推送新事件；
  - `destroy(id)`；
  - `closeAll()`：服务关闭时调用。
- 这个模块不碰 HTTP，也不碰数据库；鉴权和解析请求内容，都在 `lib/api/ws.js` 里做。

- [ ] 实现 `ws-sessions.js`，规则见契约第 15 节，包括缓冲 500 个事件、64KB 截断、两个 60 秒的销毁条件、每个用户 10 个会话。计时器都要 `.unref()`。
  - `binaryType` 设为 `'arraybuffer'`。
  - 握手失败时，Node 的 `WebSocket` 会先触发 `error`，再触发 `close`，关闭码是 1006。两个事件都要写进缓冲，这样用户能看到。
- [ ] 实现 `lib/api/ws.js`：
  - `POST /projects/:pid/ws` 用 `guard('viewer', byPid)` 做权限校验；
  - 变量、鉴权继承都复用 A1 抽出来的公共函数，鉴权用 `executor.buildAuth`；
  - 按契约处理 `Sec-WebSocket-Protocol`，以及 Cookie 库；
  - 按系统代理设置判断：如果这个目标本来应该走代理，就在 `open` 事件里加上 `note`。
- [ ] `/ws/:id/*` 三个路由不走 `guard`：
  - 先用 `registry.get(id, req.user.id)` 查找会话；
  - 再用 `access.roleOf` 确认用户仍然是这个项目的成员；
  - 任何一步不满足都返回 404。
- [ ] `/events` 路由：
  - 调用 `ndjson.start` 之后开始订阅；
  - `res` 触发 `close` 时取消订阅。
- [ ] **README 和 `docs/api.md`**：
  - 补上流式发送和 WebSocket 的用法；
  - 补上已知限制：握手时的 `Set-Cookie` 不会写回、WebSocket 不走代理、不能关闭证书校验、WebSocket 不记录历史；
  - 补上 **HAR 导入**那一节：内容以 session2 交来的说明段落为准，我会转给你。如果做到这里还没有收到，先跳过，单独提交。
- [ ] **自测**：
  - 本地起一个 echo 服务，注意不能引入依赖。可以用 `http` 的 `upgrade` 事件自己完成握手，或者只测连接失败和关闭这几条路径。echo 服务要确认：自定义请求头和 Cookie 送达了上游；子协议协商成功；发送和接收都会进入缓冲；
  - bob 访问 alice 的会话返回 404，admin 访问也返回 404；
  - 断开 `events` 连接 60 秒后，上游收到了关闭。测试时可以把等待时间做成可注入的参数，缩短成 1 秒；
  - 第 11 个会话返回 400。
- [ ] 提交：`feat: WebSocket 调试会话`。文档可以放在同一个提交里，也可以单独提交。

---

## B 部分：前端（session2）

### Task B1：发送改走流式接口、可以取消、SSE 实时查看

**Files:**
- Create: `web/src/api/stream.js`
- Modify: 发送请求的地方（`web/src/stores/tabs.js` 以及相关组件），`web/src/components/response/*`

- [ ] `stream.js` 导出两个函数：
  - `postNdjson(path, body, { signal, onEvent })`；
  - `getNdjson(path, { signal, onEvent })`。

  要求：
  - 用 `fetch` 加 `ReadableStream`，配合 `TextDecoder('utf-8', { stream: true })`，并按行缓冲（审阅重点第 4 条）；
  - 响应不是 200 时，按 `client.js` 的格式抛出同样的错误，这样上层处理 403、404 的代码不用改。
- [ ] 发送一律改走 `POST /send/stream`：
  - 收到 `head` 事件，立即显示状态码和响应头；
  - 收到 `end` 事件，按原来的方式渲染 `result`，历史也照旧记录。
- [ ] **请求进行中，「发送」按钮变成「取消」**：取消时 abort 掉 fetch。关闭标签页、组件卸载时，也要 abort。同一个标签页不允许同时有两个请求在进行。
- [ ] **非 SSE 的响应**：进行中显示「接收中… N KB」，不要把 `chunk` 的内容一段段拼进 DOM。
- [ ] **响应头的 content-type 是 `text/event-stream` 时，切换到「事件」视图**：
  - 在前端把 `chunk` 按 SSE 格式解析：处理 `event`、`data`（多行拼接）、`id` 这几个字段，以及空行分隔、`\r\n`、以 `:` 开头的注释行；
  - 表格有四列：时间、event、data 摘要、长度。点击一行展开，data 如果是 JSON 就格式化显示；
  - 列表最多保留 2000 条，超出后丢掉最旧的，并提示「只显示最近 2000 条」；
  - 连接结束后，还要能切换回原始文本视图。
- [ ] 执行 `npm run build:web`，然后提交：`feat(web): 流式发送、取消与 SSE 事件视图`。

### Task B2：WebSocket 标签页

**Files:**
- Create: `web/src/api/ws.js`、`web/src/components/ws/WsTab.vue`（组件可以按需要拆分）
- Modify: 新建标签页的入口（在「新建接口」旁边加「新建 WebSocket」）、`web/src/stores/tabs.js`

- [ ] 新增一种标签页类型 `ws`：
  - **不存进目录树**；
  - 最近用过的地址，按「项目」为单位存在 `localStorage` 里。读写都要包在 `try/catch` 里，读不到时也要能正常工作。
- [ ] 界面：
  - 地址输入框，只接受 `ws://` 和 `wss://`；
  - 请求头表格、query 表格、鉴权编辑器，都复用现有组件；
  - 「连接 / 断开」按钮；
  - 消息日志：显示方向（↑发出 / ↓收到）、时间、大小、内容摘要。点击展开，JSON 格式化显示；截断的消息要标注出来；
  - 输入区域：文本框加「发送」按钮，支持 `Ctrl+Enter` 发送；
  - 「清空日志」只清空界面上的显示；
  - 最多保留 2000 条。
- [ ] **连接流程**：
  1. `POST /projects/:pid/ws` 创建会话，`environmentId` 取当前选中的环境；
  2. 调用 `getNdjson('/ws/:id/events?after=' + lastSeq)`；
  3. 如果 events 连接意外断开，按 1 秒、2 秒、5 秒的间隔重连，每次都带上 `after=lastSeq`；
  4. 收到 404，说明会话已经不存在了，显示「会话已结束」，停止重连。
- [ ] 关闭标签页、断开连接、切换项目时，调用 `DELETE /ws/:id`，并 abort 掉 events 连接。
- [ ] `open` 事件里带有 `note` 时，在日志顶部显示出来，比如「系统代理不作用于 WebSocket」。
- [ ] viewer 也可以使用。发送请求本来就是 viewer 能做的事。
- [ ] 执行 `npm run build:web`，然后提交：`feat(web): WebSocket 调试标签页`。

## 手工核对清单（交给用户）

- [ ] 找一个 SSE 接口，比如自己写一个每秒推送一条消息的服务。发送之后，事件一条一条出现；点「取消」之后，服务端看到连接断开。
- [ ] 下载一个 50MB 的文件：进行中显示接收进度，页面不卡；完成后提示响应体被截断。
- [ ] 连接一个公开的 echo WebSocket 服务，发送一条 JSON，能收到回显；断开之后，日志里有 close 事件和关闭码。
- [ ] WebSocket 连接中刷新页面，重新打开同一个标签页：旧会话会在 60 秒内被服务端回收。这一条只需要确认服务端日志没有报错，并且不会一直累积会话。

## 完成后回报

- 每个 Task 的提交号；
- A1 自测里 SSE 实时到达的证据，比如每个事件的到达时间；
- B 部分：打包后 `lib/web/__apiloop` 的 gzip 体积变化；
- 契约第 14、15 节里写得不清楚，或者和实际行为对不上的地方。
