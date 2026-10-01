# 桌面版 D0 审阅

## 第 1 轮：acb30fd（Task 1 Electron 外壳与自检）

结论：方向对，开发模式下自检全部通过（Electron 44.5.1 / Node 24.21.0，`node:sqlite` 不需要加参数就能用）。下面两处要在 Task 2 里一起改，D0 做完之前先不推送。

- **B1（打包后会找不到服务端代码）**：`APP_ROOT` 在打包后取的是 `process.resourcesPath/app`。可是 `asar: true` 加上 `directories.app: "."`，`app/**` 会被打进 `resources/app.asar/app/`，磁盘上并不存在 `resources/app/`。所以打包后的自检和正常启动都会报「找不到服务端代码」。
  - 修法：两种形态下统一用 `path.join(__dirname, 'app')`。打包后 `__dirname` 就是 `.../app.asar`。`asarUnpack` 出来的文件，Electron 读取时会自动转到 `app.asar.unpacked`。
  - 以打包后的自检结果为准。
- **B2（用户装好之后登不进去）**：第一次启动时，`bootstrapAdmin` 生成的随机密码只打印在控制台里。双击打开安装包的用户看不到控制台，登录页就卡住了，计划里「交给用户的手工检查」做不下去。
  - D0 的修法：在 `main.js` 里 `require` 服务端之前，如果没有设置 `APILOOP_ADMIN_PASSWORD`，就设成固定值 `apiloop`。这只在库里还没有用户的时候生效。回报里写明「D0 安装包的初始账号是 admin / apiloop」。
  - D1 会改成桌面模式不需要登录本地服务，这一段到时候删掉。
- **N1**：`files` 里包含了 `scripts/fixtures/**`，自签名证书的私钥会被打进安装包。D0 可以这样，D1 要改成运行时生成证书，或者不把自检打包进正式版。先记在这里。
- **N2**：`package.json` 里的 `dist` 脚本指向的 `scripts/dist.js` 还不在这个提交里。Task 2 补上。
- 已经确认没问题的：
  - 根目录 `package.json` 没有加依赖；
  - `.gitignore` 正确；
  - 端口随机；
  - 数据目录用 `userData`；
  - 在 `require` 服务端之前设置 `APILOOP_HOME`（`app-info` 在模块加载时读取它，顺序是对的）；
  - `chdir` 到一个空的静态目录，避免把整个磁盘当成静态目录挂出去；
  - 清掉 `ELECTRON_RUN_AS_NODE` 的处理很好。
