# 接入阶段（管理台接口 v2 后端）审阅意见 · 第 1 轮

> 审阅范围：2dc4f33、8bed096、a83598f、7732226、46d7bc3、2f4a597。
> 审阅方式：顺着调用链读代码，并用一次性脚本搭了最小环境（真实的 express、登录态、mock 运行时）实际验证。脚本已删除。`npm test` 82/82 通过。
> 契约已同步修订（见 `docs/design/2026-09-30-admin-api-v2.md` 中标注「2026-09-30 修订」的地方）。本轮修复以修订后的契约为准。

## 总体评价

整体质量很高。审阅重点 1、3、6 已实测通过，2、4、5 读代码推演也成立。

- **做得好的地方**：
  - `tree.js` 的环检测会沿祖先链一路往上查，「拖进孙子目录」这种情况也能挡住；
  - `removeFolder` 在修改 parent_id 之前就取好了两份顺序，所以原有节点在前、移上来的在后，相对顺序不变；
  - 递归删除先删接口再删目录，不会留下孤儿接口；
  - `/send` 把「写历史」和「回响应」拆开；历史截断按字节计算；
  - `PUT /apis` 只在目录真的变了、或显式传了位置时才重排。
- **契约没覆盖到、你主动发现的问题**：目录上的脚本没有地方存。你在预览和导入时都给出了警告，处理得对。这属于我的契约遗漏，本轮 S1 会补上。

---

## 必修（两条都会让**整个进程崩溃**）

### M1. 不合法的 mock 路径会让 Express 注册路由时抛错，轮询方的进程直接退出

- **位置**：`lib/mock-runtime.js` 的 `buildRouter`，`router[method](route.path, handler)`。
- **实测**：
  - `/a/(b`、`/x/:id(\d+` 这类括号不成对的路径，会被 path-to-regexp 编译出非法正则并抛错；
  - 进程 A 写进这样一条接口后，进程 B 的 `startPolling` 在 `setInterval` 回调里触发重建，**B 以 exit code 1 退出**；
  - 同一进程内，写操作提交之后会在触发事件时抛错：接口返回 500，但数据已经写入，mock 运行时则一直停留在旧的路由表上。
- **哪些入口会带进这种路径**：Postman 导入（url 是任意的，OData 风格的 url 很常见）、`PUT /apis` 的 `mock.path`、旧 UI 的 `/routes`、legacy 导入。
- **修法**，三层都要做：
  1. **运行时容错**：`buildRouter` 里逐条 try/catch，注册失败的路由跳过，并 `console.warn` 一次，内容写明是哪个接口、哪个路径。一条坏路由不能拖垮整张路由表。
  2. **写入时校验**：在 `mock-runtime.js` 里导出 `validateRoutePath(path) -> string|null`（返回 null 表示合法，否则返回原因）。实现方式是在 try/catch 里用一个临时的 `express.Router()` 注册一下这个路径。**不要直接 require path-to-regexp**，它是 express 的间接依赖，版本随时可能变。
     - `POST /projects/:pid/apis`、`PUT /apis/:id`（显式给了 `mock.path`，或者由 url 推导出了新的 path）不合法时，返回 400「mock 路径不合法：<原因>」。
     - 由 url 自动推导出的 path 不合法时，不要让整个请求失败：保存 url，mock.path 保持原值，并在响应里加一个 `warnings` 字段说明。
     - `routes-store.normalizeRoute` 也要调用这个校验并抛错，这样旧 UI 和 legacy 导入能得到 400 或者被跳过。
     - Postman 导入：路径照原样保存，但把这个接口的 `mockEnabled` 设为 false，并在 warnings 里列出这些接口的名字（按契约修订后的规则）。
  3. **轮询兜底**：`lib/db/index.js` 的 `startPolling` 里，把 `emit` 包进 try/catch，捕获到的错误 `console.error` 出来。任何监听器出错都不允许让轮询把进程带崩。

### M2. 示例状态码不做校验，加上延迟后会让进程崩溃

- **位置**：`lib/api/tree.js` 的 `exampleFields`，`Number(example.status) || 200`，接受 50、1000 之类的任意数字。
- **实测**：`PUT /examples/:id {status: 1000}` 返回 200 并写入了库；给这个接口设置 `mock.delay: 50` 后，访问 mock 地址时，`setTimeout` 回调里抛出 `ERR_HTTP_INVALID_STATUS_CODE`，**进程崩溃**。没有设置延迟时，Express 能接住这个错误，只返回 500。
- **修法**：
  1. `exampleFields`：status 必须是 100–599 的整数，否则返回 400「状态码必须是 100~599 的整数」。
  2. `tree.writeTree`：导入时遇到越界的状态码，改成 200，并加一条 warning。
  3. **运行时兜底**：`mock-runtime.js` 的 `createHandler` 里，把 `send` 的函数体包进 try/catch；出错时，如果响应头还没发出，就返回 500 文本「mock 响应生成失败：…」并 `console.error`。有延迟的分支同样适用。

---

## 建议修（这一轮一起完成）

### S1. 目录脚本要能存下来（补上契约遗漏）

- 迁移 **v3**（只追加）：`ALTER TABLE folders ADD COLUMN scripts TEXT NOT NULL DEFAULT '[]'`。
- `foldersRepo` 支持读写 `scripts`；`dto.toFolderDto` 带上 `scripts`。
- `writeTree` 和 `readTree` 读写目录脚本；`into` 模式下，集合上的脚本存到那个同名目录上。
- 删除 `countFolderScripts` 以及相关的三条「已丢弃」warning。
- **自测**：导入一个带目录级 prerequest 脚本的集合，导出后脚本还在。

### S2. 历史列表不要为了取摘要去解析整条 JSON

- **位置**：`lib/db/repos/history.js` 的 `list`。
- **问题**：一页 50 条，每条最多 256KB 的响应体都要整条 `JSON.parse`，只是为了取几个摘要字段。
- **修法**：在 SQL 里用 `json_extract` 取摘要字段，例如 `json_extract(response, '$.response.status')`、`json_extract(response, '$.error.code')`、`json_extract(response, '$.timings.total')`、`json_extract(request, '$.spec.method')`、`json_extract(request, '$.spec.url')`。`list` 不再读取 request 和 response 的整列。

### S3. 删除项目后清理它上传的文件

- `DELETE /projects/:pid` 的事务提交之后，尽力删除 `<DATA_DIR>/files/<pid>`：用 `fs.rmSync(..., { recursive: true, force: true })`，失败只打日志。

---

## 接受的偏差（不需要改）

- **`/send` 只接受 7 个标准方法**。P3/P4 计划里写的是「允许自定义方法」，但契约当时没有明确写出来。暂时接受。以后如果用户反馈导入的 PROPFIND 这类方法发不出去，再放开。
- **`tree.js` 反向依赖 `api/respond` 的 `apiError`**。从分层上说是领域层依赖了 HTTP 层，但现在只借用了「带状态码的错误」这一个概念，代价很小，暂时接受。

---

## 交付要求

- M1、M2、S1、S2、S3 放在**一个提交**里：`fix: 接入阶段审阅第 1 轮`。
- **只提交你自己的文件**，也就是 `lib/**`（`lib/web` 除外）和 `test/**`。
- 不写新测试；`npm test` 全部通过。
- 回报时附上 M1 和 M2 的自测结论：用两个进程共用一个库 + 一条坏路径验证进程不再崩溃；用 status=1000 + delay 验证不再崩溃，并且接口返回 400。
