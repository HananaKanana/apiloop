# C 阶段审阅意见（9ad5ba5、4edd993、9075750）

> 本轮只审代码，并在最小的 fake 环境里实际运行，**没有替用户做手工核对**。计划末尾的手工核对清单仍然交给用户。

## 结论：通过，另有一个小的收尾提交（C-4）

### 实测

用 `git archive HEAD` 导出一份**干净副本**来跑，排除工作区里 session2 还没提交的 HAR 代码的干扰。

- **旧数据导入**：在临时目录里放一份旧版 `routes.json`（内容取自 `createSampleRoutes()`），然后启动 `web`：
  - 日志显示「已把 routes.json 导入为项目」；
  - `GET /api/users` 和 `POST /api/users` 都返回 200，响应体是模板渲染后的数据；
  - 响应头里有 `Access-Control-Expose-Headers: X-Apiloop-Mock` 和 `X-Apiloop-Mock: default`。
- **被删除的接口**：登录后请求 `GET /routes`、`GET /groups`、`GET /export`、`POST /import/routes`，都返回管理台统一的 404 JSON，没有被 mock 运行时接走。
- **保留的接口**：`POST /import/curl` 返回 200。
- **`init` 命令**：在空目录里执行 `init`，生成了 `router.js`，示例接口灌进了项目。
- **没有误删**：`web/src` 里 grep 不到任何一个被删除的路径。`routes-store` 保留下来的 8 个方法，以及 `insertRoutes`、`normalizeRoute`、`createSampleRoutes` 这几个函数，都能找到调用方。
- `npm test` 71/71。

### 测试的增删

删掉了 14 个，新增了 3 个，总数从 82 变成 71，净减 11。

- **删掉的 14 个**：都只测已经删除的接口，或者已经删除的 store 方法。对照你给的清单逐条核过。
- **新增的 3 个**：本来测 `insertRoutes` 和目录接口的那几条用例，原先是借旧接口造数据的，现在改成用新接口造数据，覆盖的是**仍然保留的**代码。这属于维护，接受。

### 文档

- README 按计划的 14 节组织；
- 旧接口只在迁移说明里以「已删除」的身份出现；
- 命令和参数与 `bin/server` 一致；
- Docker 那一节保留了数据目录、备份、uid、网络四块内容；
- Dockerfile 只改了一行注释，事先说明了，接受。

## 你列出的 5 处出入，我的决定

| # | 问题 | 决定 |
| --- | --- | --- |
| 1 | `/__admin` 前缀只在导入路径上拦截 | **统一拦截**：在 `mock-runtime.js` 的 `validateRoutePath` 里加一条规则，mock 路径以 `/__admin` 或 `/__apiloop` 开头的一律视为不合法。新接口和导入走的是同一个校验，所以规则自然统一：新接口返回 400，导入时降级并给出 warning。不管是不是根项目都拦，因为一个项目以后可能被 `--project` 指定成根项目。 |
| 2 | 新旧接口对空 url 的规则不同 | **不改**。新接口允许空 url 是为了保存草稿，这是契约有意这样设计的。 |
| 3 | README 里指向 `docs/api.md` 的链接，在 npm 包里是死链 | `package.json` 的 `files` 里**只加 `docs/api.md` 这一个文件**，设计文档和计划仍然不进包。 |
| 4 | `mock-host.js` 里的 `rootProject()` 已经没有调用方 | 删掉。 |
| 5 | CLI 帮助里写的是 pug，实际安装的依赖是 jade | 帮助文本改成 `support ejs, jade`，三处都要改。**这次不换成 pug**，换的话需要单独评估模板语法的兼容性。 |

## 小瑕疵（不强制）

- CHANGELOG 的「修复」一节里，有几条修的是 2.0.0 才新增的功能，比如 mock 日志的 SlicedString、历史打码。对 1.x 的用户来说，这些不算「修复」。可以删掉，或者并进对应的新功能条目里。

## 交付（C-4）

- 一个提交：`chore: C 阶段收尾——保留前缀统一拦截、api.md 进包、清理死代码`；
- 只提交你自己的文件：`lib/mock-runtime.js`、`lib/mock-host.js`、`bin/server`、`package.json`，以及顺手改的 `CHANGELOG.md`；
- 提交之前要先执行 `git diff`，确认 `package.json` 里没有 session2 的改动；
- 回报时附上两项：
  - `POST /projects/:pid/apis` 用 `mock.path = '/__admin/x'` 时的返回结果；
  - `npm pack --dry-run` 的文件数。

  **量 `npm pack` 时绝对不要执行 `git stash`**：工作区是共用的，stash 会把 session2 正在写的 HAR 文件一起收走。做法是先把 HEAD 导出成一份干净副本，在副本里量：`git archive HEAD | tar -x -C <临时目录>`，然后进入这个目录执行 `npm pack --dry-run`。否则工作区里未跟踪的文件会被算进去（这个坑是你自己发现的）。

---

# C-4 复审（470b84a）：通过

- 保留前缀的规则统一放在 `validateRoutePath` 里，所以新建、更新、导入三条写入路径都会拦截；`/__administrator` 和 `/api/__admin` 这类路径照常放行，判断准确。
- 新增 `files: docs/api.md`，npm 包的文件数从 63 变为 64，是在干净副本上统计的。
- 删除了 `rootProject()`；`--tpl` 的帮助文字三处都改成了 jade。
- CHANGELOG 里 2.0.0 才新增的功能的修复项，已经并进对应的功能条目，这个处理方式好。
- 小瑕疵（不强制）：Express 的路由默认不区分大小写，所以 `/__ADMIN/x` 这样的 mock 路径也会被管理台接走，而 `reservedPrefixOf` 是区分大小写比较的。建议比较前先转成小写。

**C 阶段验收完成。**
