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

## 第 3 轮：e77abb8（Task 3 本机空间和跳过登录）——通过

- **本机模式下请求不会漏到云端（审阅重点 1）：** 调度器排在网关自己的发送、WebSocket、转发之前；本机管理台末尾有兜底的 404，不会 `next()` 到转发；本机库打不开时明确返回 503 ✓。
- **只有 `POST /__admin/api/auth/login` 例外：** 用完整路径比较。大小写变体、末尾多 `/` 的会落到本机库，本机用户没有密码，必然失败，不会出安全问题 ✓。
- **本机用户没有密码（审阅重点 2）：** `password_hash` 为空串，`verifyPassword` 第一行就返回 false ✓。
- 登录云端返回 2xx 才切到 `cloud` 模式，并写回 `gateway.json` ✓。重启后如果是 `local` 模式，启动时就打开本机空间 ✓。
- 不调用 `bootstrapAdmin`；同一个进程里只打开一次本机库 ✓。
- 已经用 `APILOOP_CLOUD_URL=http://localhost:8080` 打了 arm64、x64 两个包（用户要求「先用本地地址调通，最后一起上云」），放进了 `agent-installer/dist/` 和云端的下载目录。

## 第 4 轮：262bf72（Task 8 内置 Mock 环境前端）——通过；用户试用 L1 发现的四个问题，审阅方已修（4488b3e）

### Task 8

- `mockBaseUrl`：在网关上用云端地址，直接打开云端时用当前网址。发送、WebSocket、从历史重放三处都会带上 `mockBase` ✓。
- 本机模式下这一项是灰的、点了没反应；Mock 环境没有「编辑」，管理页里也不列 ✓。
- 可以接受的边角：页面刚打开时，网关状态可能还没探测完，`env.load` 恢复记住的 `mock` 时 `isLocal` 还是 false。本机项目本来就选不了 Mock，所以不会真的出现。

### 用户试用 L1 发现的四个问题（4488b3e）

1. **跳过登录后弹「项目不存在」：** `localStorage` 里记着云端的项目 id。目录树、环境这些 `watch(currentId, …, { immediate: true })` 的组件，一挂载就拿它去请求本机库。改成项目列表回来之前 `currentId` 保持为空。
2. **本机模式下还有「Mock 日志」按钮：** 现在隐藏，也不再轮询（第 1 轮记下的小问题）。
3. **登录后浏览器弹「确定要离开此页面吗」：** `reloadTo` 先赋 `location.hash`，触发了一次路由跳转，工作台挂载后装上了「有没保存的修改」拦截，接着刷新就弹框。改成 `history.replaceState` 再刷新。有没保存的标签页时，切换前用页面自己的对话框问一句。
4. **云端停了、直接落到登录页时没有「跳过登录」：** 网关状态原来只在工作台里探测。改成登录页自己探测；连不上云端时提示可以跳过登录。

- 已推送、部署；两个安装包已重新打好（10:32）。

## 第 5 轮：d426a3f（L2 Task 6 迁移 v7）——通过；审阅方修了两个用户报的问题

### Task 6

- 触发器写得比计划更稳：修改触发器限定为 `AFTER UPDATE OF <要同步的列>`。触发器里给 `rev` 加一的那条 UPDATE 只改 `rev`，所以不会再触发自己，不依赖 `recursive_triggers` 的设置；只改 `updated_at` 的更新也不会产生记录 ✓（审阅重点 3）。
- 推送时显式写入 `rev` 的，由 `WHEN NEW.rev = OLD.rev` 挡住，不会再加一 ✓。
- 部署后云端库是 v7，`changes` 表为空（老数据的 `rev` 都是 1）✓。
- **小问题（记着，L3 再定）：** 清理只在 `apiloop web` 里跑，网关本机库的变更记录不会清理。L3 再决定本机要不要这张表。

### 审阅方修的（用户报的）

- **c87146b 默认带 `Accept-Encoding: gzip, deflate, br`：** llama.cpp 的页面不带这个头就回 415。解压本来就支持；另外 HEAD、204、304、`Content-Length: 0` 的响应不解压，免得空响应体报「unexpected end of file」。一次性脚本验证了 7 种情况。
- **10dd85e 点历史记录打开的是空请求：** 历史里存的是 `{ spec, environmentId }`（从 7732226 第一版起就是这样），而前端从 P2（f46d3b3）起就把整个对象当成 spec 用。所以「从历史还原」一直没有正确工作过，现在才被发现。
