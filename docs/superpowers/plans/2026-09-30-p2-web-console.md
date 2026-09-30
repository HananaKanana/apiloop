# P2：Vue 3 管理台实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **本项目约定（覆盖 skill 的默认做法）**
> - **不写新测试**，也不装浏览器驱动去验证界面。既有的 `npm test` 必须全部通过。界面效果由用户自己手工确认，每个任务都附了核对清单。
> - **提交时只提交自己改过的文件**：`git commit -m "..." -- <文件...>`。禁止 `git add -A`、`git add .`、`git commit -a`，因为另一个会话正在同一个工作区里实现后端。

**目标**：用 Vue 3 重写管理台，做成 Postman 式的工作台：
- 左边是目录树；
- 中间是多标签的请求编辑器，下面是响应面板；
- 每个接口带一个 Mock 页签，用来管理示例和 mock 配置；
- 另外包括环境、历史、导入导出和用户管理。

**架构**：
- 源码放在仓库根目录的 `web/` 下，用 Vite 打包到 `lib/web/`。打包产物要提交进仓库，这样使用者装包后不需要自己构建。
- 页面是一个单页应用，用 hash 路由，所以后端的静态文件服务不用改。
- 开发时 `npm run dev:web` 启动 Vite 开发服务器，把 `/__admin` 和 `/mock` 的请求转发到 `http://127.0.0.1:8080`。开发期间旧版管理台继续可用，**直到最后一个任务才切换**。

**技术栈**：Vue 3（`<script setup>`，用 JS 不用 TS）、vue-router 4（hash 模式）、Pinia、Naive UI、CodeMirror 6（`codemirror`、`@codemirror/lang-json`、`@codemirror/lang-html`、`@codemirror/lang-xml`、`@codemirror/lang-javascript`）、Vite 5 或更新版本、`@vitejs/plugin-vue`。

**依据**：
- **接口契约**：[docs/design/2026-09-30-admin-api-v2.md](../../design/2026-09-30-admin-api-v2.md)，所有接口路径和数据形状都以它为准。
- **上游设计**：[调研文档](../../design/2026-09-30-api-workbench-research.md)。
- **后端进度**：由另一个会话按 [接入计划](2026-09-30-integration-api-v2.md) 实现。你用到还没实现的接口时，可以先按契约写，接口上线后再联调；**不要改后端代码**。

## 全局约束

- **文件范围**：只能改 `web/**`、`lib/web/**`、`package.json`，其中 `package.json` 只加 `devDependencies` 和 `scripts`；另外还有 `.gitignore` 和 `test/**`（仅限 Task 9 的维护）。**不许动** `lib/` 下除 `lib/web` 以外的任何文件，也不许动 `README.md`；开发说明写在 `web/README.md` 里。
- **所有前端依赖都放进 `devDependencies`**：它们会被打包进产物，使用者运行时不需要安装，所以 `dependencies` 保持不变。
- **完全离线可用**：不用 CDN，不引外部字体或图标库，只用系统字体。图标用 Naive UI 自带的，或者手写内联 SVG。
- **打包配置**：`web/vite.config.js` 里设置 `root: 'web'`、`base: '/'`、`build.outDir: '../lib/web'`、`build.emptyOutDir: true`、`build.assetsDir: '__apiloop'`。资源放在 `/__apiloop/` 下，是为了尽量少遮住用户项目根目录下的同名文件。
- **页面标题**：`<title>` 固定为 `apiloop 管理台`，品牌名从 `/meta.appName` 读取，不要写死在组件里。
- **界面风格**：面向开发者，信息密度适中，文案一律中文。跟随系统切换亮色和暗色（Naive UI 的 `useOsTheme`）。窄屏（1024px 以下）时，左侧树可以折叠起来。
- **未登录跳转**：在 API 封装层统一处理 401：跳到 `#/login?next=<当前 hash>`。登录成功后回到 `next`，但只接受以 `#/` 开头的值，否则回首页。

## 审阅重点

审阅时我会逐条推演下面这些场景，实现时要保证它们的行为如描述所示：

1. **标签页里有没保存的修改时**：关闭标签页、切换项目、刷新页面，都要先提示确认。刷新页面用 `beforeunload`。这种标签页要有明显的「未保存」标记。
2. **响应体很大（5MB）或者是二进制时**：界面不能卡死。JSON 超过 1MB 就不做格式化高亮，直接显示原文并加提示。base64 编码的图片直接预览，其他二进制只显示大小，并提供下载。
3. **HTML 响应的「预览」**：必须放在 `<iframe sandbox="" srcdoc=...>` 里渲染，不允许执行脚本。**不能用 `v-html`**，否则被调试接口返回的恶意 HTML 能在管理台的域名下执行脚本，偷走登录 cookie 之外的数据或冒用登录态发请求。
4. **变量缺失**：发送后，如果结果里 `missingVariables` 不为空，要在响应区顶部用醒目的方式提示「以下变量未定义：…」，并提供一个跳转到环境管理的入口。
5. **切换项目后的状态**：当前项目 id 存在 localStorage 里。如果这个项目已经被删除，要回到项目列表里的第一个，不能白屏。每个项目各自记住上次选中的环境。

---

## 文件结构（建议，可以按需要微调）

```
web/
  index.html
  vite.config.js
  README.md                     开发与构建说明
  src/
    main.js  App.vue  router.js
    api/client.js               fetch 封装：处理 JSON 和 401，统一抛出带中文 message 的错误
    api/*.js                    按契约分组：auth、users、projects、tree、apis、envs、send、history、importExport
    stores/                     Pinia：session、project、tree、tabs、env
    components/
      layout/                   TopBar、ProjectSwitcher、EnvSwitcher、UserMenu
      tree/                     ApiTree、TreeContextMenu
      request/                  RequestTab、UrlBar、KeyValueTable、BodyEditor、AuthEditor、ScriptsView
      response/                 ResponsePanel、BodyViewer、HeadersTable、TimingsBar
      mock/                     MockPanel、ExampleEditor、PlaceholderMenu
      common/                   CodeEditor（CodeMirror 6 的封装）、ConfirmDialog
    views/                      LoginView、WorkbenchView、UsersView、ProjectSettingsView
```

---

### Task 1: 工程骨架、登录、外壳

- [ ] **Step 1: 搭建工程**
  - `package.json` 增加两个脚本：`"dev:web": "vite --config web/vite.config.js"`、`"build:web": "vite build --config web/vite.config.js"`。
  - Vite 开发服务器端口 5173，`server.proxy` 把 `/__admin` 和 `/mock` 转发到 `http://127.0.0.1:8080`。
- [ ] **Step 2: API 客户端**
  - `api/client.js` 导出 `request(method, path, body?, { raw?: Blob, headers? })`。
  - 规则：
    - 所有路径都拼上 `/__admin/api` 前缀；
    - 响应是 `ok:false` 时抛出 `Error(data.error)`；
    - 状态码 401 时跳转到登录页，并返回一个永远不会 resolve 的 Promise；
    - 网络错误时抛出「网络请求失败：…」。
- [ ] **Step 3: 登录页 `#/login`**：调用 `/auth/login`。
- [ ] **Step 4: 外壳 `WorkbenchView`**
  - 顶栏：品牌名、项目切换（这一步先放占位）、环境切换（先放占位）、用户菜单（修改密码弹窗调用 `/auth/password`，退出登录）。
  - 主体是左右分栏，左栏可以拖动调整宽度。
- [ ] **Step 5: 用户管理页 `#/users`**（仅 admin 可见，用户菜单里放入口）
  - 用户列表；
  - 新建用户：如果服务端返回了自动生成的密码，用弹窗显示一次，并提供复制按钮；
  - 修改显示名、角色，启用或禁用；
  - 重置密码：同样只显示一次；
  - 删除用户。
  - 服务端返回的 400 错误（比如「不能对自己做…」）原样提示给用户。
- [ ] **Step 6: 验证**：`npm run build:web` 先临时打包到 `web/dist-check` 看能不能成功，**这一步不要覆盖 `lib/web`**，完成后删掉这个目录。`npm test` 全部通过后提交。

**手工核对**：`npm run dev:web` 之后能登录、退出、修改密码；admin 能增删改用户，普通用户看不到用户管理的入口。

---

### Task 2: 项目与环境

依赖后端接入计划的 Task 2。

- [ ] **项目切换器**：
  - 下拉列表显示项目名和 slug，根项目带「根」标记。
  - 可以新建项目。
  - 当前项目存在 localStorage 的 `apiloop.project` 里。
- [ ] **项目设置页 `#/projects/:pid/settings`**：
  - 可以改名称、标识、描述；
  - 项目变量用变量表格编辑：key、value、启用、secret；secret 的值默认用圆点遮住，点「眼睛」才显示；
  - 项目级鉴权用 AuthEditor 编辑；
  - 删除项目只对 admin 显示，并且要二次确认。
- [ ] **环境**：
  - 顶栏的环境切换器：选项是「无环境」加上所有环境；每个项目各自记住上次的选择，存在 `apiloop.env.<pid>`。
  - 「管理环境」弹窗：左边是环境列表，右边是变量表格；可以增删环境、改名。
- [ ] `npm test` 全部通过后提交。

**手工核对**：新建项目并切换，刷新后仍停留在这个项目；删掉当前项目后能回到其他项目，不白屏。

---

### Task 3: 目录树

依赖后端接入计划的 Task 3。

- [ ] **ApiTree**：
  - 用 Naive UI 的 `n-tree` 展示 `/tree` 接口返回的数据，前端组装成树。排序规则：同一层先目录后接口，各自按 position 排。
  - 接口节点显示彩色的 method 标签和名称；mock 已启用的，节点上加一个小圆点。
  - 顶部有搜索框，按名称或 url 过滤；过滤时自动展开命中节点所在的目录。
- [ ] **右键菜单**：
  - 目录：新建子目录、新建接口、重命名、删除。删除时弹窗让用户选「子项移到上一级」还是「连同子项一起删除」，文案要和旧版删除分组的弹窗一致。
  - 接口：复制、重命名、删除。
- [ ] **拖拽**：用 `n-tree` 的 draggable。放下后，算出 `{ kind, id, parentId, index }` 调用 `/move`，**以服务端返回的新树为准**重新渲染。接口不能拖进另一个接口里面。
- [ ] `npm test` 全部通过后提交。

---

### Task 4: 请求编辑器与响应面板

这是本计划最核心的一个任务。

- [ ] **标签页**（tabs store）：
  - 点击树上的接口，就打开对应的标签页；已经打开的直接切过去。
  - 「新建请求」会打开一个还没保存的临时标签页，第一次保存时弹窗选择目录和名称，然后调用 `POST /projects/:pid/apis`。
  - 未保存的标签页显示圆点标记。
  - `Ctrl/Cmd+S` 保存，调用 `PUT /apis/:id`，**只提交改动过的字段**。
  - 关闭标签页的确认逻辑，见审阅重点第 1 条。
- [ ] **UrlBar**：
  - 左边是 method 下拉框，允许输入自定义方法；中间是 url 输入框；右边是「发送」按钮，请求进行中会变成「取消」。
  - url 里的 `:name` 会自动同步到 Params 页签的路径参数表：新增的参数自动加进去，url 里删掉的参数，如果它的值为空就一起删掉。
  - url 里的 `?a=1` 和 query 表格**双向同步**。
- [ ] **页签**：
  - Params：query 表和路径参数表；
  - Headers；
  - Body：
    - 模式切换：none / raw / urlencoded / formdata / binary / graphql；
    - raw 模式下可以选语言，用 CodeEditor 编辑；
    - formdata 的行可以切换成「文件」，选中文件后先调用 `/projects/:pid/files` 上传，拿到 `src` 填回去；
    - binary 模式同样先上传；
  - Auth：可选 继承 / 无 / Bearer / Basic / API Key；遇到不支持的鉴权类型，只读显示「导入的 xxx 鉴权暂不支持，发送时不生效」；
  - Scripts：只读展示，并提示「脚本不会执行」。
- [ ] **KeyValueTable**：通用的键值表格组件，每行有启用勾选、key、value、描述、删除按钮；最后永远有一行空行，在空行里输入内容时自动新增一行。
- [ ] **发送**：
  - 调用 `POST /projects/:pid/send`，参数是 `{ request: 当前编辑中的 spec, apiId?, environmentId }`。**发送的是编辑中的内容，不需要先保存。**
  - 用 `AbortController` 实现取消。
- [ ] **ResponsePanel**：
  - 顶部信息：状态码（2xx 绿色、4xx 橙色、5xx 红色）、总耗时、大小；有重定向时显示「重定向 N 次」，点开能看到重定向链。
  - `error` 不为空时，显示对应错误码的中文说明：TIMEOUT、ABORTED、DNS、CONNECT、TLS、INVALID_URL、INVALID_HEADER、FILE、OTHER。
  - 页签：
    - Body：美化、原文、预览三种视图，预览的实现方式见审阅重点第 3 条；
    - Headers；
    - 耗时：用条形图展示 dns、connect、tls、ttfb、download 各阶段；
    - 请求：实际发出的 method、url、headers 和请求体预览。
  - 大响应和二进制的处理，见审阅重点第 2 条；缺失变量的提示，见审阅重点第 4 条。
  - 「保存为示例」按钮：只有文本响应可以点，二进制时置灰。点击后调用 `POST /apis/:id/examples`，参数 `{ name: '<状态码> 录制于 <时间>', status, headers: 响应头转成的 Row[], body, responseType: 按 content-type 判断, source: 'recorded' }`。临时标签页要先保存才能用这个按钮。
- [ ] `npm test` 全部通过后提交。

**手工核对**：对一个真实接口发 GET 和 POST（JSON、表单、文件三种请求体）；切换环境后变量能正确替换；取消能生效；HTML 响应的预览里脚本不会执行。

---

### Task 5: Mock 页签

- [ ] **MockPanel**：
  - 「启用 mock」开关、mock 路径、延迟、CORS 开关。
  - mock 地址：根项目用 `location.origin + path`，其他项目用 `location.origin + '/mock/' + slug + path`；提供复制按钮。
  - 启用 mock 时如果服务端返回 400，原样提示用户。
- [ ] **示例列表**：
  - 可以新建、重命名、删除示例，可以设为 mock 当前使用的示例；
  - 用标签区分来源：手工、录制、导入。
- [ ] **ExampleEditor**：
  - 可以编辑状态码、响应类型、响应头（用 KeyValueTable）、响应体（用 CodeEditor）。
  - 移植旧版管理台的两个菜单：
    - 「插入 Mock 字段」：数据来自 `/meta.placeholders`，按分组列出，点击后插入到光标所在位置；
    - 「常用模板」：数据来自 `/meta.templates`。
  - 「预览」：调用 `POST /preview`，参数是 `{ route: { response: body, responseType } }`，展示渲染结果、警告，以及 JSON 是否合法。
- [ ] `npm test` 全部通过后提交。

**手工核对**：把一个录制的示例设为 mock 使用的示例，打开 mock 地址能拿到对应内容；在示例里插入 `{{@cname}}` 后预览，每次得到的值都不一样。

---

### Task 6: 历史

- [ ] 右侧抽屉或底部面板，展示 `/projects/:pid/history` 的列表，支持滚动到底部时自动加载更多（`before` 参数）。每条显示 method、url、状态码或错误码、耗时和时间。
- [ ] 点击一条历史，打开一个临时标签页：请求内容用历史里保存的 spec，响应面板直接显示当时的结果；`historyTruncated` 为 true 时加一句提示。
- [ ] 提供「清空历史」按钮，需要二次确认。
- [ ] `npm test` 全部通过后提交。

---

### Task 7: 导入与导出

- [ ] **导入弹窗**，包括三个页签：
  - **Postman**：可以粘贴 JSON，也可以选择文件。先调用 `/import/postman/preview`，展示类型、名称、统计数字和警告。如果是集合，让用户选择「新建项目」还是「导入到当前项目」；如果是环境或 Globals，固定导入到当前项目。然后调用 `/import/postman`。导入成功后，新建项目的情况要自动切换到新项目。
  - **cURL**：`/import/curl` → 展示解析结果 → `POST /projects/:pid/import/routes`；如果当前在目录树里选中了某个目录，就传它的 `folderId`。
  - **OpenAPI**：流程同上，解析用 `/import/openapi`。
- [ ] **导出**：项目菜单里提供「导出为 Postman 集合」；环境管理里提供「导出为 Postman 环境」。导出时用 Blob 在浏览器里生成文件下载，文件名取服务端返回的 `filename`。
- [ ] `npm test` 全部通过后提交。

---

### Task 8: 移植剩下的零散功能

旧版管理台还有几个功能新版没覆盖：接口的启用和停用开关（等同于 mock 开关，已经在 Task 5 做了）、配置文件路径显示、版本号显示。逐一检查，缺的补上：
- 在顶栏的用户菜单里，放一个「关于」弹窗，显示版本号和数据库路径，数据来自 `/meta`。

完成后 `npm test` 全部通过，然后提交。

---

### Task 9: 切换

这一步完成后，旧版管理台就被新版替换了。

- [ ] `npm run build:web`：打包产物会覆盖 `lib/web/`，这一步会删掉旧的 `app.js`、`style.css`、`login.html`。检查 `lib/web` 里只剩 `index.html` 和 `__apiloop/` 目录。
- [ ] **维护测试**：`test/cli.test.js` 和 `test/server.test.js` 里对 `/index.html` 内容的断言，以及对 `/app.js`、`/style.css`、`/login.html` 的断言，改成检查新的页面：`<title>` 里包含「管理台」，并且能取到 `/__apiloop/` 下的资源。
- [ ] 写 `web/README.md`：怎么安装依赖、怎么启动开发服务器（要先 `mock web --port 8080`）、怎么打包；并说明**改完前端必须重新打包，并把 `lib/web` 一起提交**。
- [ ] `npm test` 全部通过后提交：`feat(web): 切换到 Vue 管理台`。提交时带上 `lib/web` 下的删除和新增，但**只写这几个路径**：`-- lib/web web package.json package-lock.json test/cli.test.js test/server.test.js`。

**手工核对（交给用户，完整一遍）**：
1. 登录；
2. 新建项目 → 建目录 → 建接口 → 发请求 → 保存为示例 → 启用 mock → 访问 mock 地址；
3. 导入一个 Postman 集合，导出后重新导入，两次结果一致；
4. 在用户管理里新建一个普通用户，用它登录，确认看不到用户管理入口。

---

## 完成后回报

- 每个 Task 的提交号；
- 打包产物的大小（`lib/web/__apiloop` 目录的总大小，以及 gzip 后的估计值）；
- 用到了、但契约里没写或者写得不对的接口细节，列出来交给我，由我修订契约。
