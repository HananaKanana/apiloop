# HAR 导入 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **本项目约定**
> - **不写新测试**，也不装浏览器驱动做验证。既有 `npm test` 必须全部通过。
> - 手工核对清单是交给用户的，不要自己执行。审阅用的一次性探测脚本放 `/tmp`，跑完删掉，不进仓库。
> - **只提交自己的文件**：`git commit -m ... -- <文件>`，不要用 `git add -A` 或 `commit -a`。session1 同时在做 C 阶段和一个 `lib/proxy-settings.js` 的修复，**不要碰 `README.md`、`CHANGELOG.md`、`docs/`**。

**执行者**：session2，前后端都由你来做。

**目标**：把浏览器导出的 HAR 文件导入成接口和示例。导入之后，每个接口都能直接当 mock 使用。

**规则全部在契约里**：[docs/design/2026-09-30-admin-api-v2.md](../../design/2026-09-30-admin-api-v2.md) 第 13 节。包括过滤、合并、凭据清理、请求体模式、示例去重和上限、stats 字段、警告文案。**本计划不重复这些规则**，有冲突时以契约为准；发现契约写得不清楚，先来问我。

**做法**：HAR 解析成和 `postman.parse` 产出的 `collection` **完全相同的结构**，然后走同一个写库函数 `tree.writeTree`。写库、事务、mock 设置、权限，都复用 Postman 导入已经验收过的代码。

## 全局约束

- **文件范围**：
  - 新建：`lib/har.js`、`lib/api/har.js`、`lib/api/import-collection.js`；
  - 修改：`lib/api/postman.js`（只允许抽取公共函数，行为不变）、`lib/admin.js`（挂载路由和解析器）、`web/**`、`lib/web/**`。
- **`lib/admin.js` 是和 session1 共用过的文件**。提交前先执行 `git diff lib/admin.js`，如果里面有不是你改的内容，停下来告诉我。
- **不引入新依赖**。HAR 就是 JSON，直接用 `JSON.parse`。
- 前端每次提交都要执行 `npm run build:web`，把 `lib/web` 和源码放在同一个提交里。

## 审阅重点

1. **凭据默认不保留**：不勾选「保留凭据」时，导入后的项目里，所有接口的请求头、所有示例的响应头里，都搜不到任何 `Cookie`、`Authorization`、`Proxy-Authorization`、`Set-Cookie`。**请求头名不区分大小写**：HTTP/2 下 HAR 里的请求头名是小写的 `cookie`。
2. **大文件**：
   - 一个 30MB、几千条记录的 HAR，预览和导入都不能卡死，也不能被 4MB 的请求体上限挡住；
   - 50MB 以内的文件，前端用 `FileReader` 读成文本，不能先解析成对象、再序列化一遍。
3. **残缺的 HAR 不能导致 500**：
   - 以下情况都要能处理：`headers` 为 null、`postData` 没有 `text`、`content` 缺失、`startedDateTime` 缺失或写错、`url` 是相对地址或解析不了；
   - 能导入的照常导入；解析不了的条目计入 `skipped`；
   - 只有顶层结构不对时，才返回 400。
4. **合并的键**：
   - `GET /users?id=1` 和 `GET /users?id=2` 合并成一个接口；
   - `GET /users` 和 `POST /users` 是两个接口；
   - 不同主机上的相同路径，分在两个主机目录下，互不合并。
5. **`into` 模式的权限**：和 Postman 导入共用同一个 `resolveTargetProject`。viewer 返回 403；不是成员或者项目不存在，返回同一个 400。

---

### Task 1: 后端——解析器与接口

**Files:**
- Create: `lib/har.js`
- Create: `lib/api/import-collection.js`
- Create: `lib/api/har.js`
- Modify: `lib/api/postman.js`、`lib/admin.js`

**Interfaces:**
- `lib/har.js` 导出 `parse(input, options) → { kind: 'har', name, collection, stats, warnings }`
  - `input` 可以是字符串或对象；`options` 是 `{ keepCredentials?: boolean, now?: Date }`，`now` 用来生成默认项目名；
  - `collection` 的结构和 `postman.parse(...).collection` 相同：`{ name, description, variables: [], auth: null, scripts: null, extra: {}, children: [文件夹节点] }`，文件夹、接口、示例节点的字段见 `lib/postman.js` 的 `toFolder` / `toApi` / `toExamples`；
  - 顶层结构不对时，抛出 `Error('不是 HAR 文件：缺少 log.entries')`。
- `lib/api/import-collection.js` 导出 `createCollectionImporter(ctx) → { resolveTargetProject(req), importCollection(req, collection, mode) → project }`
  - 从 `lib/api/postman.js` 原样抽出：`resolveTargetProject`，以及 collection 分支里 `new` 和 `into` 两段写库逻辑；
  - Postman 的路由改成调用它，**行为和返回值都不变**。
- `lib/api/har.js` 导出 `createRouter(ctx)`，提供契约第 13 节的两个路由。

- [ ] **抽取公共函数**：先把 `lib/api/postman.js` 的写库逻辑抽到 `import-collection.js`，改完跑一次 `npm test`。既有的 Postman 导入测试必须全部通过，这是抽取没有改变行为的证据。
- [ ] **实现 `lib/har.js`**：按契约第 13 节实现。下面几点契约没有写到：
  - 请求体转换成 Body 结构时，字段名要和 `postman.toBody` 的产出一致：`{ mode: 'raw', raw, language }`、`{ mode: 'urlencoded', form: [...] }` 等。`form` 里的行结构参考 `toFormRows`；
  - `responseType` 直接复用 `postman.js` 里的 `guessResponseType`。需要的话从 `postman.js` 的导出里补上这个函数，只加导出，不改实现；
  - 查询串的行结构和 `toQueryRows` 一致；
  - 示例去重只比较状态码和响应体字符串，不要引入哈希依赖；
  - 条目按 `startedDateTime` 排序时，时间无效的条目排在最后，并且保持它们原来的相对顺序。
- [ ] **实现 `lib/api/har.js` 并挂载**：在 `lib/admin.js` 里，**在全局的 `express.json({ limit: '4mb' })` 之前**，挂一个只作用于 `/import/har` 前缀的 `express.json({ limit: '50mb' })`。body-parser 看到 `req._body` 已经被设置，就会跳过，所以后面那个 4MB 的全局解析器不会重复解析。然后在 Postman 路由旁边，挂上 `harApi.createRouter(ctx)`。
- [ ] **自测**：写一次性脚本，放在 `/tmp`，跑完删掉。用一个真实的 Chrome 导出的 HAR，另外手工构造一个涵盖审阅重点第 3 条各种残缺情况的 HAR，分别调用 preview 和 import 两个接口，核对 stats 和写入的数据。**凭据那一条（审阅重点第 1 条），要在库里全文搜索确认。**
- [ ] `npm test` 全部通过。
- [ ] 提交：`feat: HAR 导入（后端）`。

### Task 2: 前端——导入对话框里加 HAR

**Files:**
- Modify: `web/src/api/importExport.js`、`web/src/components/importExport/ImportDialog.vue`

- [ ] `importExport.js` 新增两个函数：`previewHar(text, options)` 和 `importHar(text, { mode, projectId, options })`。
- [ ] 导入对话框新增「HAR」页签，交互和 Postman 页签保持一致：
  - 选择文件（`accept=".har,application/json"`），或者粘贴文本；
  - 点「预览」，展示主机数、接口数、示例数，以及服务端返回的全部警告；
  - 选择「新建项目」或「导入到当前项目」。viewer 看不到后者，沿用 `canEdit` 的判断；
  - 点「导入」。`new` 模式导入成功后切换到新项目，和 Postman 一致。
- [ ] **「保留凭据」复选框**，默认不勾选。
  - 勾选时，旁边用警告色显示：「Cookie、Authorization 会原样写进项目，项目里的所有成员都能看到」。
  - 切换勾选状态后，要重新预览，因为 `stats.credentialsStripped` 会变。
- [ ] 文件超过 50MB 时，在前端直接提示，不发请求。
- [ ] 执行 `npm run build:web`，然后提交：`feat(web): HAR 导入`，源码和 `lib/web` 放在同一个提交里。

## 手工核对清单（交给用户）

- [ ] 在 Chrome 开发者工具的 Network 面板里，浏览一个真实的网站。右键选择「Save all as HAR with content」，把导出的文件导入。
  - 目录按主机分组；
  - 只有接口请求，没有图片、CSS、JS；
  - 打开一个接口，Mock 页签里有录下来的示例，用 mock 地址能访问到。
- [ ] 在不勾选「保留凭据」的情况下，打开几个需要登录的接口，确认请求头里没有 Cookie 和 Authorization。
- [ ] 用 viewer 身份打开导入对话框，确认只能选择「新建项目」。

## 完成后回报

- 两个提交的提交号；
- 自测用的真实 HAR 的规模（条目数、文件大小），预览和导入各自的耗时；
- **README 和 `docs/api.md` 里需要补充的内容**：给我一小段文字，说明用法和凭据规则。我会转给 session1，放进它正在重写的文档里。你不要直接改这两个文件。
- 契约第 13 节里写得不清楚，或者和实际 HAR 对不上的地方。
