# apiloop 协作约定

每次会话自动加载。项目背景、机制、发布流程见 `docs/HANDOFF.md`，开工前读一遍。

## 规矩

全局规矩在 `~/.claude/CLAUDE.md`，这里只补本项目积累下来的。

- **一律用中文回复。** 用户英语不好。代码、命令、标识符保持原样。
- **不写测试代码。** 新功能不配测试，计划里也不排「先写失败的测试」。既有测试照常跑：
  `npm test`（目前 71 个，全过）。接口变了导致既有测试失效，改测试算维护，照做。
- **UI 验证是用户的事。** 不装 Playwright / Puppeteer / headless 浏览器，不截图比对。
  报完工固定说：「代码写完、既有测试通过、审阅过，UI 行为待你确认」，不要替用户宣称验证过。
- **一次性探测脚本**放在会话的 scratchpad 里，跑完删掉，不进仓库。
  起临时云端：`APILOOP_HOME=<scratchpad>/x APILOOP_ADMIN_PASSWORD=adminpass123 node bin/server web --port 18xxx`；
  起临时网关：`APILOOP_HOME=<scratchpad>/y node bin/server gateway --cloud=http://127.0.0.1:18xxx --port=18yyy`。
  **绝对不要碰真实的 `~/.apiloop`**（用户本机客户端的数据）。
- **改了 `.vue` 文件，审阅时要真的把组件跑一遍**（不开浏览器）：`npm run build:web` 只查语法，
  「声明之前就用了」这类错误要组件创建时才炸（2026-10-04：`BodyViewer.vue` 的 `fieldTree` 写在
  `watch(..., { immediate: true })` 后面，所有文本响应的 Body 一片空白，构建、审阅全都没发现）。
  办法：scratchpad 里写一个 `.mjs`，用 vite 的 `createServer({ configFile: 'web/vite.config.js',
  server: { middlewareMode: true }, ssr: { external: ['vue', 'naive-ui', '@vicons/tabler', 'pinia', 'vue-router', 'codemirror'] } })`
  + `ssrLoadModule('/src/…/X.vue')` 加载组件；`vue`、`vue/server-renderer`、`naive-ui`、`pinia`、`vue-router`
  用 `createRequire(项目的 package.json).resolve` 拿到路径再原生 `import()`；套上 `NConfigProvider`、`NMessageProvider`、
  `NDialogProvider`，`app.use(createPinia())` + 内存路由，`app.config.errorHandler` 只记第一个错误，`renderToString`。
  报 `before initialization` / `is not a function` 就是真问题；`document is not defined`（CodeMirror）是 SSR 自己的限制，可以忽略。
  一次能扫全部 `.vue`，几秒钟。
  **不传 props 的全量扫描会漏**（2026-10-04 第二次：`BodyEditor.vue` 的 `watch(mode, …)` 写在 `const mode` 前面，
  请求的 Body 一片空白；扫描时组件先因为没有 `spec` 报了别的错，把这个挡住了）。所以另外再做一遍**静态检查**：
  用 `@vue/compiler-sfc` 取出 `<script setup>`、`@babel/parser` 解析，找「创建时就会执行」的代码里用到的、后面才声明的
  `const` / `let` —— 顶层语句、`watch` 的源和 `immediate` 回调、`watchEffect`、顶层直接调用的函数、被马上读到的
  `computed` 的 getter 都算；pinia 的 setup store（`defineStore` 里那个函数）同样要查。写好后先拿上面两个出过事的旧版本
  （`git show 91bac1b~1:web/src/components/response/BodyViewer.vue`、`git show e857e0a~1:web/src/components/request/BodyEditor.vue`）
  验证它抓得到，再扫全量。
- **攒一批再打包。** 修完一个问题只提交、推送，不打安装包。等用户说「问题说完了 / 打个包」才统一打包。
- **推送：** 只有主会话推送。推之前单独跑一次 `git log origin/master..HEAD` 看范围，**不要把
  commit 和 push 串在一条命令里**。用路径限定提交：`git commit -m "..." -- <自己改的文件>`，
  不要 `git add -A` 整个仓库（`.workbuddy/` 下有用户别的工具的改动，不归我们管）。
- 用户如果再开多个实现会话（session1 / session2）共用一个工作区，主会话负责写计划、审阅、推送；
  交接给实现会话的每一条都要写明「只提交，不要推送」「只用路径限定提交」。
- **用户说「你安排就好」时**，按合理的默认做，做完把做了什么说清楚；不要为小事反复问。
- 提交信息用中文，`feat(web): ...` / `fix(gateway): ...` 这种格式。
- shell 是 zsh：`$VAR` 不会按空格拆成多个参数（要拆用 `${=VAR}`），`=====` 这种开头的参数会被当成命令展开；
  删 scratchpad 里的东西写 `rm -rf "${SP:?}/xxx"`（安全检查会拦 `$SP/*` 这种写法）。
  scratchpad 里 `python3 -m http.server` 起不来，要静态文件服务就用几行 node。

