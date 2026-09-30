# C 阶段：清理旧接口 + 2.0.0 发布准备 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **本项目约定**
> - **不写新测试**，也不装浏览器驱动做验证。既有 `npm test` 必须全部通过。**既有测试因为接口被删而失效时，把它改成走新接口，这属于维护，照做。**
> - 手工核对清单是交给用户的，不要自己执行。
> - **只提交自己的文件**：`git commit -m ... -- <文件>`，不要用 `git add -A` 或 `commit -a`。工作区里 `web/`、`lib/web/` 下有 session2 正在改、还没提交的文件，不要动。

**开工前提**：P7a 复审第 2 轮的 M2（apikey 打码）已经交付并验收。

**目标**：旧版管理台已经下线，删掉只给它用的那批接口和代码；把项目整理成可以发布 2.0.0 的状态，包括版本号、依赖、npm 包内容、README、CHANGELOG 和迁移说明。

**依据**：
- [路线图](../../design/2026-09-30-roadmap.md) 的阶段 C；
- [接口契约](../../design/2026-09-30-admin-api-v2.md)：新版管理台只用契约里列出的接口。

## 已经定下来的决定（不用再讨论）

1. **要删除的接口**（都在 `lib/admin.js` 里，只作用于根项目）：
   - `/routes` 下的全部接口：`GET`、`POST`、`PUT /:id`、`DELETE /:id`、`POST /:id/duplicate`；
   - `/groups` 下的全部接口：`GET`、`POST`、`POST /reorder`、`PUT /:name`、`DELETE /:name`；
   - 根级的 `POST /import/routes` 和 `GET /export`。

   `guardRoot` 这个辅助函数没有别的调用方的话，一起删掉。
2. **要保留的**：
   - `POST /preview`、`POST /import/curl`、`POST /import/openapi`、`GET /meta`，因为新版管理台还在用；
   - `POST /projects/:pid/import/routes`；
   - `lib/legacy-import.js` 和 `lib/legacy/`，第一次启动导入旧版 `routes.db` / `routes.json` 时要用；
   - CLI 的 `mock` 这个别名。
3. **`routes-store` 瘦身规则**：删完接口以后，`createStore` 返回的对象上，凡是 `lib/` 和 `bin/` 里已经没有调用方的方法，一律删掉。按目前的调用情况：
   - 保留：`load`、`getRoutes`、`replaceAll`（`init` 命令在用）、`on`、`off`、`startWatching`、`stopWatching`、`close`；
   - 删除：`getRoute`、`create`、`update`、`remove`、`duplicate`、`addMany`、`getGroups`、`addGroup`、`renameGroup`、`reorderGroups`、`removeGroup`。

   删完之后，再按同样的规则处理模块级的函数：没有调用方的删掉，`insertRoutes`、`normalizeRoute`、`createSampleRoutes` 这类还有调用方的保留。**以 grep 的结果为准，不要照抄上面的名单。**
4. **Docker 不改成多阶段构建，`lib/web` 的构建产物继续提交进仓库。** 理由：
   - npm 包和 `npm i -g <git 地址>` 都需要现成的构建产物；
   - 只保留一份产物，不会出现「镜像里构建的」和「仓库里提交的」两份不一致的情况；
   - 镜像构建时不用装前端的 devDependencies，构建更快。

   产物是否过期，由「每个前端提交都带上 `lib/web`」这条规矩保证，我审阅时会重新构建比对哈希。
5. **版本号定为 `2.0.0`**。`package.json` 的 `files` 里去掉 `docs`：设计文档、计划和旧截图都不应该进 npm 包。
6. **依赖清理**：
   - 删除没有被 `require` 的依赖：`concat-files`、`eval`、`express-velocity`。
   - 删除 `handlebars`：它没有导出 express 需要的 `__express`，所以 `--tpl handlebars` 本来就用不了。
   - 保留 `ejs` 和 `jade`：`app.set('view engine', tpl)` 会按名字动态加载模板引擎，兼容 `router.js` 时要用。
   - `yargs` 是在 `bin/server` 里 require 的，保留。
   - 删之前**逐个 grep 确认一次**，包括字符串形式的动态 require。用 `npm uninstall` 删除，让 `package-lock.json` 一起更新，因为 Docker 构建用的是 `npm ci`。
7. **顺手修复路线图里的小瑕疵**：mock 响应加上 `Access-Control-Expose-Headers: X-Apiloop-Mock`。「body 里值为空串的字段被当成不存在」那一条，按 P5 审阅的结论，等有用户反馈再修，这次不动。

## 全局约束

- **文件范围**：
  - `lib/**`（`lib/web/**` 除外）、`test/**`、`bin/**`；
  - `README.md`、`CHANGELOG.md`（新建）、`docs/api.md`（新建）；
  - `docs/docker.md`、`docs/screenshot-*.jpg`（删除）；
  - `package.json`、`package-lock.json`。
- **`package.json` 是和 session2 共用的文件**（session2 可能会加 devDependencies）。提交前先执行 `git diff package.json package-lock.json`，如果里面有不是你改的内容，停下来告诉我，不要一起提交。
- **Node 版本要求不变**：`>=22.13.0`。

## 审阅重点

1. **删除接口不能误伤新版管理台**：
   - 在 `web/src` 里 grep 每一个要删除的路径，确认新版管理台一处都没有调用。已知 `web/src/api/*.js` 用到的 `/import/routes` 都是 `/projects/:pid/import/routes`，要逐条核对。
   - 删除之后，请求旧路径应该返回管理台 API 统一的 404 JSON，而不是被 mock 运行时接走。
2. **旧数据导入链路不能断**：
   - 带着旧的 `routes.json` 或 `routes.db` 第一次启动时，仍然能导入成根项目；
   - `apiloop init` 仍然能灌入示例接口。

   这两条都依赖 `insertRoutes`、`replaceAll` 和 `normalizeRoute`，瘦身的时候最容易误删。
3. **测试是改写，不是删除**：`server.test.js` 和 `cli.test.js` 原来通过 `/routes` 造 mock 数据，改成通过契约第 3 节的接口（新建接口和示例）来造，**断言的 mock 行为保持不变**。只有专门测试已删除接口本身的用例（比如分组的重命名、排序）可以删掉。回报时列出删掉了哪些用例、各自原来测的是什么。
4. **npm 包里的文件清单**：
   - 要有：`lib/web/index.html` 和 `lib/web/__apiloop/*`；
   - 不能有：`web/`、`docs/`、`test/`、`*.db`、`data/`、`.env`。
5. **README 里的每条命令和每个接口路径，都要和代码对得上**，特别是删掉的旧接口不能再出现在 README 里。

---

### Task 1: 删除旧版管理台接口，给 routes-store 瘦身

**Files:**
- Modify: `lib/admin.js`（删除第 204–360 行附近的旧接口，以实际位置为准）
- Modify: `lib/routes-store.js`
- Modify: `test/server.test.js`、`test/cli.test.js`、`test/routes-store.test.js`（维护）

- [ ] 按「决定 1」删除接口，按「决定 3」删除 store 方法和模块级函数。
- [ ] 改写测试：凡是通过 `/routes` 或 `/groups` 造数据的地方，改成契约第 3 节的接口。如果多个用例都要造数据，在测试文件里抽一个小的辅助函数。只测已删除接口本身的用例可以删掉（审阅重点第 3 条）。
- [ ] 在 `web/src` 里 grep 确认新版管理台没有调用任何被删除的路径（审阅重点第 1 条）。
- [ ] `npm test` 全部通过。
- [ ] 提交：`refactor: 删除旧版管理台接口`。

### Task 2: 小修复、依赖清理、2.0.0 与 npm 包内容

**Files:**
- Modify: `lib/mock-runtime.js`（第 59–61 行附近的 CORS 响应头）
- Modify: `package.json`、`package-lock.json`

- [ ] 在 mock 响应的 CORS 响应头旁边加上 `Access-Control-Expose-Headers: X-Apiloop-Mock`。
- [ ] 按「决定 6」清理依赖。
- [ ] 修改 `package.json`：
  - `version` 改为 `2.0.0`；
  - `files` 去掉 `docs`；
  - `keywords` 改成和 apiloop 相关的词：`api`、`mock`、`postman`、`http-client`、`api-testing`；
  - `description`、`repository`、`author`、`license` 不改。
- [ ] 执行 `npm pack --dry-run`，按审阅重点第 4 条核对文件清单。回报时附上 `total files` 和 `package size` 两项数字。
- [ ] `npm test` 全部通过。
- [ ] 提交前执行 `git diff package.json package-lock.json` 自查（见「全局约束」）。
- [ ] 提交：`chore: 2.0.0；清理不用的依赖；mock 响应暴露 X-Apiloop-Mock`。

### Task 3: 文档——README 重写、API 参考、CHANGELOG、迁移指南

**Files:**
- Rewrite: `README.md`
- Create: `docs/api.md`、`CHANGELOG.md`
- Delete: `docs/docker.md`、`docs/screenshot-console.jpg`、`docs/screenshot-group-delete.jpg`（旧版管理台的截图）

- [ ] **README 面向使用者，按下面的顺序组织**：
  1. 一句话介绍：本地的接口调试工具，调通的接口直接变成 mock。
  2. 安装：npm 全局安装，以及从仓库安装。
  3. 快速开始，分两种方式：
     - 本机：`apiloop web`，首次登录说明 admin 的初始密码怎么获取；
     - Docker：`./deploy.sh`。
  4. 核心工作流：发请求 → 保存为示例（可选智能模板化）→ 通过 mock 地址访问 → 用期望按条件返回不同示例 → 查看 mock 调用日志。
  5. 项目、成员与角色。
  6. 导入与导出：Postman、cURL、OpenAPI。注明不执行 Postman 脚本。
  7. Cookie 与代理：包括打码规则和已知限制。
  8. Mock 数据模板语法：沿用现有内容。
  9. 从 server-mock 迁移（详见下一条）。
  10. 命令参考。
  11. Docker 部署：把 `docs/docker.md` 的内容并进来，数据目录、备份、uid、网络安全这几段都要保留。「已知限制」里那句「P2 之后评估多阶段构建」，改成「决定 4」的结论和理由。
  12. 数据存储：数据库位置、`APILOOP_HOME`、备份。
  13. 开发：前端改完要执行 `npm run build:web`，并把 `lib/web` 一起提交。
  14. License。
- [ ] **管理台 API 参考迁到 `docs/api.md`**：README 原来「管理台 API」那一整节搬过去，删掉「旧版管理台专用」那一小节。README 里留一行链接指过去。契约文档 `docs/design/...` 是内部设计文档，不要在 README 里链接。
- [ ] **从 server-mock 迁移**：在 README 原有那一节的基础上补充下面几条：
  - 现在必须登录；admin 初始密码的获取方式；
  - 数据存放在 `~/.apiloop/data.db`，或 `APILOOP_HOME` 指定的目录；
  - 旧版的 `routes.db` / `routes.json` 在第一次启动时自动导入，原文件保留；
  - `router.js` 和模板语法不变，根项目仍然挂在根路径，原有 URL 不用改；
  - `mock` 命令仍然可用；
  - `/__admin/api/routes` 这类旧版管理台接口已经删除，如果有脚本在调用，改用 `docs/api.md` 里的新接口；
  - `--tpl handlebars` 从来没有生效过，现在明确不支持。
- [ ] **新建 `CHANGELOG.md`**，写 `## 2.0.0（未发布）` 一节，日期由用户发布时填写。分为三块：
  - **不兼容变更**：改名、必须登录、数据位置、删除旧接口、Node 版本要求 `>=22.13.0`；
  - **新功能**：按 P1–P7a 和 mock 调用日志，每项一行；
  - **修复**。

  1.x 的历史只写一行：「1.x 的变更见 git 历史」。
- [ ] 删除 `docs/docker.md` 和两张旧截图之前，grep 确认没有其他地方引用它们（Dockerfile、deploy.sh、`.env.example` 的注释等）。
- [ ] 按审阅重点第 5 条自查 README。
- [ ] 提交：`docs: 2.0.0 README 重写；新增 CHANGELOG 与 API 参考`。

## 手工核对清单（交给用户）

- [ ] 在一个干净目录执行 `npm pack`，然后 `npm i -g ./apiloop-2.0.0.tgz`，运行 `apiloop web`，确认能登录、管理台能打开。
- [ ] 在一个放着旧版 `routes.json` 的目录启动，确认旧接口已经导入成根项目，原来的 URL 仍然能访问。
- [ ] `./deploy.sh` 重新构建镜像，确认能启动，数据仍然在 `./data` 里。
- [ ] 通读 README，重点看快速开始和迁移指南是否好懂。新版管理台的截图，如果需要请自行补充。

## 完成后回报

- 每个 Task 的提交号；
- Task 1 删掉的测试用例清单；
- Task 2 的 `npm pack --dry-run` 数字；
- 发现 README 或契约里和代码对不上的地方，列出来交给我。
