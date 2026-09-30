# 更新日志

## 2.0.0（未发布）

从「配 mock 数据的小服务」变成「本地接口调试工具」：能调接口、能存接口，
调通的响应一键变成 mock。数据和账号都在本地。

### 不兼容变更

- **改名**：项目名从 server-mock 改为 **apiloop**。旧命令 `mock` 仍然可用，
  数据目录从当前目录搬到 `~/.apiloop`（可用 `APILOOP_HOME` 换）。
- **必须登录**：管理台接口 `/__admin/api/*` 全部要求登录，第一次启动会创建管理员
  `admin` 并把随机密码打印一次。**被 mock 的接口本身仍然不鉴权。**
- **数据位置**：全局一份 SQLite 库（默认 `~/.apiloop/data.db`），不再是当前目录的
  `routes.json` / `routes.db`。旧文件第一次启动时自动导入，原文件保留。
- **删除旧版管理台接口**：`/__admin/api/routes`、`/groups`、`/export`、
  根级的 `/import/routes` 已删除，改用[管理台 API 参考](docs/api.md)里的新接口。
- **mock 路径不能占用管理台的前缀**：以 `/__admin` 或 `/__apiloop` 开头的路径一律
  拒绝（新建接口时返回 400，导入时降级并给出 warning）。这类请求在走到 mock 之前
  就被管理台接走了，配了也不会生效。
- **Node 版本要求**：`>=22.13.0`（用内置的 `node:sqlite`）。
- `--tpl handlebars` 从来没有生效过，现在明确不支持（可用 `ejs` / `jade`）。

### 新功能

- SQLite 替换 `routes.json`：全局一份库，多项目、多用户，外部改库自动热更新。
- 用户与登录：账号、会话、管理员后台，密码 scrypt 加盐哈希。
- 项目与角色：viewer / editor / owner 三档，一个项目只有成员可见。
- 请求执行器：服务端代发请求，分阶段耗时、重定向链、gzip/br 解压、文件上传；
  历史里 `Authorization`、`Cookie`、`Proxy-Authorization`、apikey 的值以及
  `request.spec` 里的凭据，对非发起人一律打码。
- 接口与示例：接口定义 + 多份示例响应，示例一处数据两用（调试时是保存的响应，
  mock 时是返回的数据）；状态码越界、mock 路径不合法的数据在写入时就挡掉，
  导入时降级并给出 warnings。
- 目录树：嵌套目录、拖动排序、复制接口。
- 目录设置：目录可以配置鉴权和变量，接口的鉴权按「最近的目录 → 上级目录 → 项目」继承，
  变量优先级是「项目 < 目录（从外到内）< 环境」。
- 环境变量与项目变量：`{{var}}` 与 mock 占位符 `{{@xxx}}` 各管各的。
- Postman 导入导出：Collection v2.0 / v2.1、Environment、Globals；
  带上前置 / 测试脚本，导入后照常执行。
- cURL 与 OpenAPI / Swagger 导入。
- HAR 导入：把浏览器录到的一串请求批量变成接口和示例，默认去掉登录凭据。
- 智能模板化：把真实响应一键换成「结构不变、值随机」的模板。
- Mock 期望：按 query / header / body / path 条件返回不同的示例；跨域时补上
  `Access-Control-Expose-Headers`，浏览器里也能看到命中了哪条。
- Cookie 自动管理：按「用户 × 项目」存，每一跳自动带上并写回；http 响应不能
  设置 `Secure` cookie；请求主机是 IP 地址（含 IPv6）时 `Domain` 必须完全相同。
- 代理：支持 http 代理，https 目标走 `CONNECT` 隧道，`noProxy` 可配。
- Mock 调用日志：看到最近哪些请求打到了 mock、命中了哪个接口哪条期望、或者根本没命中。
  预览只留 4KB，而且是独立的一份拷贝，大响应不会被一直拽在内存里。
- 流式发送：响应头一到就显示，响应体一段段往回推；SSE 直接按事件列表实时显示，
  大响应不会把页面卡死；进行中的请求随时能取消，取消会真的断掉上游连接。
- WebSocket 调试：由服务端代连（浏览器不能设自定义请求头、也绕不开跨域），
  消息日志看方向 / 时间 / 大小，支持子协议、Cookie、鉴权和变量。
- 执行 Postman 脚本：前置脚本和测试脚本跑在 QuickJS 的 wasm 沙箱里，支持 `pm.*` 的常用子集、
  `pm.sendRequest` 和一个 chai 断言子集；变量写回按角色与事务处理，历史里的控制台输出对
  非发起人打码。
- SSE 与 WebSocket 的 mock 回放：示例存的是「怎么推」而不是「推什么」，按录下来的节奏回放，
  `{{@xxx}}` 在每条发送的那一刻才渲染；`method` 为 `WS` 的接口可以存进目录树、配 mock 路径。
- Docker 部署：`Dockerfile` + `docker-compose.yml` + `deploy.sh`，数据挂到宿主机的 `./data`。
- 可视化界面：Vue 3 + Vite 重写，多标签页、环境切换、响应查看器、调用日志面板。

### 修复

- mock 路径在写入时就校验能不能被 Express 编译，运行时再逐条兜底 ——
  一条坏路径不会再让整个进程退出。

## 1.x

1.x 的变更见 git 历史。
