# server-mock —— 项目长期笔记

## 是什么
一个「启动 Web 服务器 + mock 数据」的 npm 包，写法参考 Express，另内置零构建的**可视化管理台**（默认入口 `/index.html`），不写代码即可配接口。
- 仓库：github.com/jirengu/server-mock，作者 ruoyu；本地 owner 提交署名 liuxiuqi <503560552@qq.com>
- 版本：1.2.0，License ISC
- 三个 bin：`mock` / `server-mock` / `server` → `./bin/server`（yargs 17）

## 模块结构
```
bin/server            CLI 入口
lib/command.js        start / open / web / init 命令实现
lib/db.js             SQLite 持久化层（node:sqlite，零依赖）
lib/routes-store.js   SQLite 读写、校验、文件监听、分组管理
lib/mock-engine.js    模板渲染与随机数据生成（占位符引擎）
lib/mock-runtime.js   把配置编译成 Express 路由，支持热更新
lib/importers.js      cURL / OpenAPI(Swagger) 解析
lib/admin.js          管理台后端 API（挂在 /__admin/api/*）
lib/web/              管理台前端，零构建：index.html + app.js(约 105KB) + style.css
sample/               `mock init` 用的示例文件
test/                 node:test 测试
```

## 关键约定
- **存储是 SQLite，不再是 routes.json。** 库文件默认 `routes.db`，`--config` 指定。用 Node 内置 `node:sqlite`，**零依赖**，但要求 **Node ≥ 22.13**（22.5 起提供、22.13 起免 `--experimental-sqlite` 标志）。
- 内存里的 `routes` / `declaredGroups` 数组是唯一真相，库文件只是镜像：**读全量读、写全量写**（事务内清空再灌入）。所以分组增删改排序等逻辑与存储无关。
- **首次建库时自动导入旁边的 `routes.json`**（`routes.db` ↔ `routes.json`），原 JSON 保留不删；库已存在则不重复导入。迁移结果通过 `getMigratedFrom()` / `getMigrationWarnings()` 报给调用方（**不要用 `emit('error')`**，无监听器时会直接抛）。
- 「导出 JSON」固定导出 `routes.json` 格式，是分享/留档的唯一出口（数据库没法进 git diff）。
- `routes.db` 及其 `-journal` / `-wal` / `-shm` 已在 `.gitignore`。
- **默认界面入口**：`mock web` 后管理台在 `/index.html`，访问 `/` 由 `lib/command.js` 显式 **302** 跳过去。跳转必须注册在 routes.json / router.js 之前，否则用户配 `ALL /*` 兜底路由会把入口吃掉。
- 管理台静态资源挂在根路径的那一份**必须 `index: false`**（`admin.rootStatic`）。一旦让 express.static 处理目录首页，`/` 会直接返回 200，跳转永远不执行。
- 管理台自己占用的前缀是 **`/__admin`**，定义在 `lib/routes-store.js` 的 `RESERVED_PREFIX`（唯一出处，`lib/admin.js` 引用它拼 `API_PATH`）。配 mock 路由时不许用这个前缀。老的 `/__mock` 已彻底下线，页面和 API 都不在了。
- `web` 模式下根路径的 `index.html` / `app.js` / `style.css` 归管理台独占，会遮住使用者项目里的同名文件；`start` 模式不挂管理台，不受影响。
- **测试**：`npm test` → `node --test --test-timeout=30000 test/*.test.js`。**基线 79/79 全绿**（2026-09-30 复核）。
- 目录结构里新增 `lib/db.js`（SQLite 持久化层）。`lib/admin.js` 的 `API_PATH` 引用 `storeModule.RESERVED_PREFIX`。
- **前端零依赖**：管理台不引 CDN、不引外部字体图标、无构建步骤。改前端就直接改 lib/web 下三个文件。
- **路由优先级**：先匹配数据库里的接口，未命中再交给用户目录的 `router.js`（router.js 里不要自己套 `setRouter(app)` 外壳）。
- **配置热更新**：保存后服务端热更新路由，无需重启；外部直接用 `sqlite3` 改库也会自动生效（靠内存快照对比区分自写与外部改）。
- 分组存在 `groups` 表（名字 + position，允许空分组）；旧 `routes.json` 无 `groups` 时从接口的 `group` 推导，写了新分组名会自动登记。
- 路径不能以 `/__admin` 开头（管理台占用）。
- 管理台 API 统一返回 `{ ok: true, ... }` / `{ ok: false, error: "..." }`；分组写接口会回带最新 groups + routes，避免前端脏状态。
- 前端对话框一律用自研组件，**不使用 `window.prompt`**；危险操作用红色按钮。

## 项目最终目标（产品名已定为 apiloop）

产品名 **apiloop**（2026-09-30 定名，此前用 httpman 占位）。数据目录 `~/.apiloop`、
库 `~/.apiloop/data.db`、cookie `apiloop_sid`、环境变量 `APILOOP_DB` /
`APILOOP_ADMIN_PASSWORD` —— 全部从 `lib/app-info.js` 派生，**其他地方不许硬编码产品名**。

**把 server-mock 改造成本地 Postman 类工具：能调接口、能存接口，调通的响应一键变成 mock。** 参照 Apifox（接口定义 / 调试 / mock 三合一），但数据全放本地 SQLite、不上云。

七条已定决策：
- **D1** 用户体系：默认免登录（本机即 local owner）；`--auth` 后要求登录，此时才允许 `--host 0.0.0.0`。
- **D2** 前端要引入构建工具：**Vue 3 + Vite**，产物随 npm 包发布。现在的 `lib/web/app.js`（约 2800 行原生 JS 单文件）用原生 JS 继续写会失控。**P2 重构期间不要再往 app.js 加功能**，否则两边都要改。
- **D3** 数据库**全局一份**，放 `~/.server-mock/data.db`，`--db` 可改。**注意：P0 是按当前目录放 `routes.db`，与此不一致，P1 要对齐。**
- **D4** 「接口调试」和「mock 路由」合并成一个实体「接口」（Apifox 模式）= 请求定义 + 若干示例响应 + mock 配置。
- **D5** 多项目时 mock 前缀为 `/mock/<项目标识>/...`，另有一个默认项目挂在根路径，保持老用户行为不变。
- **D6** Postman 脚本第一版**不执行**，只原样保存并提示数量。

核心数据模型（users / projects / project_members / environments / folders / apis / examples /
mock_expectations / history / meta）：**一条老 route ≈ 1 个 api + 1 个 example**（老的
`response` 模板就是 example 的 body，`is_template=1`）。「示例」一处数据两用——调试时是保存的
响应，mock 时是返回的数据，这就是「调通即 mock」的落点。

分期：**P0** SQLite 替换 routes.json（✅ 已完成）→ **P1 数据底座**（新模型 + 迁移机制 +
DAO 改按表增删改查 + mock 运行时改读新模型）→ P2 前端重构 → P3 请求执行器 →
P4 Postman 导入导出 → P5 调通即 mock → P6 多用户 → P7 扩展。

## P0 的定位（重要）

**P0 是过渡方案，P1 会把它换掉。** 现在 `lib/db.js` 的「全量读 + 全量写」对历史记录、
多项目、多用户不可行，P1 要换成按表增删改查，并补一个按 `meta.schema_version` 顺序
执行的迁移机制。**不要再往这套全量读写方案里加功能。**

不可破坏的兼容面：`mock start`、`router.js`、旧 `routes.json` 自动迁移、`{{@...}}` 模板语法。


## 已完成的里程碑（近期提交，新→旧）

1. `27319a7` 补上 package.json 的 engines（Node >= 22.13）
2. `bbfa82b` 测试对齐 SQLite，README 改写存储章节
3. `136bcc1` mock init 改为生成示例数据库；删 sample/index.html
4. `5610fa1` routes-store 持久化改走 SQLite
5. `b3d2efc` 新增 lib/db.js（SQLite 持久化层）
6. `9ba37ad` 管理台改为默认界面 /index.html，API 迁到 /__admin/api
7. `7641c1b` 分组改为可管理实体：增删改 + HTML5 拖动排序；顺手修掉「JSON 校验直接 parse 模板文本导致 `{{@repeat}}` 误报」的真 bug
8. `273ec80` 修正管理台宽屏对齐
9. `a76c5a6` 新增 Web 可视化管理台（配置 mock 接口的输入输出）
10. `eb4f33e` 修正 package.json 的 main 指向
11. `2240405` 纳入 mock init 示例文件
12. `abaa2ec` 修复 CLI 在 yargs 17 下不可用
13. `d92fe6a` 修复 router.js 被二次包装导致路由全失效

## 已知坑
- lib/web/app.js 是单文件大文件（约 105KB），改动要定位到具体函数，避免整体重写。
- 分组删除有两种模式：`move`（默认，接口移到未分组）与 `delete`（连接口一起删）。
