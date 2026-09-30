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
- **Node 版本要求**：`>=22.13.0`（用内置的 `node:sqlite`）。
- `--tpl handlebars` 从来没有生效过，现在明确不支持（可用 `ejs` / `jade`）。

### 新功能

- SQLite 替换 `routes.json`：全局一份库，多项目、多用户，外部改库自动热更新。
- 用户与登录：账号、会话、管理员后台，密码 scrypt 加盐哈希。
- 项目与角色：viewer / editor / owner 三档，一个项目只有成员可见。
- 请求执行器：服务端代发请求，分阶段耗时、重定向链、gzip/br 解压、文件上传。
- 接口与示例：接口定义 + 多份示例响应，示例一处数据两用（调试时是保存的响应，
  mock 时是返回的数据）。
- 目录树：嵌套目录、拖动排序、复制接口。
- 环境变量与项目变量：`{{var}}` 与 mock 占位符 `{{@xxx}}` 各管各的。
- Postman 导入导出：Collection v2.0 / v2.1、Environment、Globals；
  不含前置 / 测试脚本（原样保存并提示数量）。
- cURL 与 OpenAPI / Swagger 导入。
- 智能模板化：把真实响应一键换成「结构不变、值随机」的模板。
- Mock 期望：按 query / header / body / path 条件返回不同的示例。
- Cookie 自动管理：按「用户 × 项目」存，每一跳自动带上并写回；http 响应不能
  设置 `Secure` cookie。
- 代理：支持 http 代理，https 目标走 `CONNECT` 隧道，`noProxy` 可配。
- Mock 调用日志：看到最近哪些请求打到了 mock、命中了哪个接口哪条期望、或者根本没命中。
- 可视化界面：Vue 3 + Vite 重写，多标签页、环境切换、响应查看器、调用日志面板。

### 修复

- 模板渲染出的长响应被截成 4KB 预览时，整段原始响应无法回收（V8 SlicedString），
  长时间运行内存会一直涨。
- 历史记录里 `Authorization`、`Cookie`、`Proxy-Authorization`、apikey 的值
  以及 `request.spec` 里的凭据，对非发起人一律打码。
- 跨域时前端读不到 `X-Apiloop-Mock` 响应头（补 `Access-Control-Expose-Headers`）。
- 请求主机是 IP 地址（含 IPv6）时，cookie 的 `Domain` 必须完全相同，不再做后缀匹配。
- mock 路径在写入时就校验能不能被 Express 编译，运行时再逐条兜底 ——
  一条坏路径不会再让整个进程退出。
- 示例状态码越界、路径不合法的数据在写入时挡掉，导入时降级并给出 warnings。

## 1.x

1.x 的变更见 git 历史。
