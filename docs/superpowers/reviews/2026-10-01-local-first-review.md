# 本地优先 L1、L2 审阅

计划：`docs/superpowers/plans/2026-10-01-local-first-l1-l2.md`。

## 第 1 轮：2d2bcd0（Task 1）、f06eeba（Task 4）、eab1458（Task 5）——通过

### Task 1：mock 地址改成 `/mock-<项目ID>/`

- 只是把按短名查项目换成按 ID 查，缓存和「查不到就交给根项目」的逻辑没变；WebSocket mock 走的是同一个 `resolve` ✓。

### Task 4：跳过登录、「仅本机」状态

- 网关接口前缀从 `/__gateway` 改成 `/__apiloop`，前后端是约好一起改的（后端在 session1 还没提交的 Task 2 里）。**所以在 Task 2、3 合进来之前，不能用这个前端打安装包。** 云端不受影响：云端上 `/__apiloop/status` 返回 404，页面照旧判断为「不是网关」（部署后实测）。
- 在网关上登录、跳过登录之后都整页刷新，免得 store 里留着上一个库的数据 ✓。
- 登录出错时在 `catch` 里复位按钮状态；成功后页面整个刷新，不需要复位 ✓。
- 「云端地址…」菜单、设置对话框、`gatewayApi.setup` 都删干净了 ✓。

### Task 5：mock 地址显示

- 拼 mock 地址统一走 `utils/mock.js` 的 `mockPrefix()` ✓。
- 新建项目、项目设置里的「标识」输入框都去掉了 ✓。
- **小问题（不改，记着）：** 本机模式下，顶栏的「Mock 日志」按钮还在。点开是空的，提示里还会给出一个本机上用不了的 mock 地址。可以在 L4 一起处理。

### 其他

- 提交的 `lib/web` 和 HEAD 源码一致：在干净副本里重新构建，得到的文件名哈希相同。
- 仓库根目录多了一个未跟踪的文件 `true`：是 session1 的探测脚本启动网关时，`--log-file` 没给值，yargs 把它解析成布尔值 `true`，日志就写进了 `./true`。`installGatewayLog` 应该只接受字符串（不是字符串就按默认处理）。已交给 session1 修，并删掉这个文件。
- `npm test` 71/71。云端已部署（index-CjSviri0.js）。

## 第 2 轮：b46fda8（Task 2 云端地址写死、去掉设置页）——通过；审阅方加了内置 Mock 环境的后端（d815c68）

### Task 2

- 云端地址的来源：`--cloud` → `gateway.json` → 安装包里的 `cloud.json`。`--cloud` 不再写回配置 ✓。
- `gateway.json` 改成 `{ cloudUrl, mode }`，写的时候先读出原来的内容再合并，不认识的 `mode` 当成 `cloud` ✓。
- 设置页和 `/setup` 删干净了；三处都取不到地址时返回 503「这个安装包没有配置云端地址」✓。
- 打包没给 `APILOOP_CLOUD_URL` 时直接退出；打完会把安装包展开，核对 `app/cloud.json` ✓。
- 第 1 轮提到的 `--log-file` 布尔值问题已经修了，仓库根目录的 `true` 文件也删了 ✓。

### 内置 Mock 环境（用户提议，审阅方写后端）

- 用户提议「每个项目默认加一个 mock 环境，把 host 地址放进去」。做法参考 Apifox：不存库、只读、地址自动算（理由见计划的追加部分）。
- 后端：`environmentId: 'mock'` 加上 `mockBase`，临时拼出 `{ host }`。一次性脚本实测：
  - 发 `{{host}}/hello`，实际请求打到 `<云端>/mock-<项目ID>/hello`，拿到 mock 数据；
  - 缺少 `mockBase` 返回 400；
  - `prepare` 里 `environmentId` 为 null，脚本对环境的修改不落库；历史里记的是 `mock`；
  - WebSocket 自动换成 `ws://`。
- 前端交给 session2（计划 Task 8）。
