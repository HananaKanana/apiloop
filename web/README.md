# apiloop 管理台（前端）

Vue 3 + Vite + Naive UI 写的单页应用。打包产物放在 `lib/web/`，云端（Docker 镜像）和
客户端安装包都直接用这份产物，部署时不需要再构建前端。

## 目录

```
web/
  index.html        页面骨架（标题固定「apiloop 管理台」）
  vite.config.js    root 是 web/，产物落到 ../lib/web，资源目录 __apiloop
  src/
    api/            fetch 封装与按契约分组的接口调用
    stores/         Pinia：session、project、env、tree、tabs、ws、ui
    components/     layout / tree / request / response / mock / scripts / history / importExport / ws / folder / env / sync / help / common
    views/          LoginView、WorkbenchView、UsersView、ProjectSettingsView、SettingsView、ChangePasswordView
    utils/          树组装、下载、确认框（dialog.js）、剪贴板、SSE 解析、鉴权继承、Mock 地址
```

## 开发

```bash
npm install          # 在仓库根目录执行，前端依赖都在 devDependencies 里
```

开发服务器要把接口请求代理到后端，所以**先另开一个终端把后端跑起来**：

```bash
# 终端 1：后端（管理台接口和 mock 都在这个端口上）
node bin/server web --port 8080

# 终端 2：前端开发服务器，默认 http://localhost:5173
npm run dev:web
```

`/__admin` 和 `/mock` 会被代理到 `http://127.0.0.1:8080`，所以浏览器里只需要开 5173。
要调客户端里的行为（本机空间、同步、一键更新），用构建好的产物直接打开本机网关：
`node bin/server gateway --cloud=http://127.0.0.1:8080`，然后访问 `http://127.0.0.1:47321`。

## 打包

```bash
npm run build:web
```

产物直接写进 `lib/web/`，并且会**先清空**这个目录。

> **改完前端一定要重新打包，并把 `lib/web` 一起提交。**
> 后端只认 `lib/web` 里的产物，源码改了不打包等于没改。

想只验证「能不能构建成功」而不动 `lib/web`，可以临时换个输出目录，看完删掉：

```bash
npx vite build --config web/vite.config.js --outDir dist-check
rm -rf web/dist-check
```

## 几个约定

- **依赖全放 `devDependencies`**：它们会被打包进产物，运行时不需要安装，
  所以 `dependencies` 保持原样。
- **完全离线可用**：不引 CDN、不引外部字体，只用系统字体；图标用 `@vicons/tabler`（打包进产物）。
- **确认框一律用 `@/utils/dialog` 的 `useDialog`**，不要直接用 naive-ui 的：统一了样式（无图标、
  取消不抢焦点、危险操作红色按钮）。
- **复制到剪贴板用 `@/utils/clipboard` 的 `copyText`**：http 页面上没有 `navigator.clipboard`。
- **模板表达式里不要写 `function (x) { ... }`**。Vue 编译器解析这种写法会报
  `Unexpected token`（Babel 单独解析同一段是没问题的），一律用箭头函数。
  `<script setup>` 里不受影响。
- **响应里的 HTML 只能用 `<iframe sandbox="">` 预览**，不许用 `v-html` ——
  被调试接口返回的恶意 HTML 会拿到管理台自己的域。
- **亮暗色跟随系统**（Naive UI 的 `useOsTheme`），所以自定义样式里不要写死背景色，
  用 `var(--n-border-color, ...)` 这类变量或者半透明色。
- 当前项目存在 `localStorage.apiloop.project`，每个项目选中的环境存在
  `apiloop.env.<项目 id>`，WebSocket 标签页最近用过的地址存在
  `apiloop.ws.<项目 id>`；这些是界面状态，服务端不存。
- **发送请求一律走 `POST /send/stream`**（`api/stream.js` 读 NDJSON），
  `POST /send` 服务端保留但管理台不用了 —— 只有流式那条路才能一边下一边显示、
  并且随时可以取消。WebSocket 的 `events` 长连接用的是同一个读取函数。

## 接口契约

所有管理台接口的形状以 `docs/design/2026-09-30-admin-api-v2.md` 为准。
实现中觉得契约有问题，先提出来改文档，不要各自改代码。
