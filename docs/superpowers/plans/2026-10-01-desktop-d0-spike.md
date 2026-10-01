# 桌面版 D0：技术验证 实施计划

> 给 session1。只提交、不推送。不写新测试；既有测试（`npm test`）照常要过。

**目标：** 先确认现有的服务端（`lib/`）能原样跑在 Electron 里，并且能在这台 Mac 上打出没签名的 Mac 安装包和 Windows 安装包。这一步决定后面 D1–D5 的技术路线。

**设计稿：** `docs/design/2026-10-01-desktop-sync.md`，主要看第 3 节和第 8 节。

**做法：** 新建一个独立目录 `desktop/`，里面有自己的 `package.json`，Electron 和打包工具都只装在这里。仓库根目录的 `package.json` 和 Docker 镜像都不受影响。Electron 主进程里直接 `require` 仓库里的 `lib/command.js`，把服务启动在 `127.0.0.1` 的一个随机端口上，然后用窗口打开它。

## 全局约束

- **根目录的 `package.json` 不加任何依赖。** Dockerfile 跑的是 `npm ci --omit=dev`，镜像里绝对不能去下载 Electron。
- 打出来的安装包和下载缓存不进仓库：`desktop/dist/`、`desktop/node_modules/`、`desktop/app/` 都写进 `.gitignore`。
- 安装包都不签名。
  - Mac：`.dmg`，arm64 和 x64 各出一个；
  - Windows：NSIS 安装程序 `.exe`，x64。
- Electron 选**当前最新的稳定版**，并在回报里写清楚版本号和它自带的 Node 版本。
- 这是验证阶段，代码可以粗糙，但目录结构要留给 D1 继续用。不要做成用完就扔的样子。

## 审阅重点

1. **`node:sqlite` 在 Electron 主进程里能不能直接用**：不加任何命令行参数，能建库、能写入、能读出来。
2. **QuickJS 的 wasm 文件在打包后能不能加载。** 打包后代码在 `app.asar` 里，wasm 可能读不到，需要配置 `asarUnpack`。要在**打包后的程序里**验证，不能只在开发模式下验证。
3. **`lib/command.js` 里的 `process.exit`**：端口被占用等情况下，会把整个 Electron 进程直接退出。D0 先记下来，不用改，D1 再处理。
4. **端口用随机的**：不能写死 8080，要避开用户本机正在用的端口。
5. **数据库文件放在 `app.getPath('userData')` 下面**，不要写进程序目录：Mac 上程序目录是只读的。

---

### Task 1：Electron 外壳 + 自检

**文件：**
- 新建 `desktop/package.json`：依赖 `electron`、`electron-builder`；`"main": "main.js"`
- 新建 `desktop/main.js`
- 新建 `desktop/scripts/stage.js`
- 修改 `.gitignore`

**接口：**
- `desktop/main.js` 启动时：
  1. 先取一个空闲端口：用 `net` 监听 `0`，读出端口号后关掉；
  2. 调用 `require(<应用目录>/lib/command.js)({ command: 'web', args: { port, host: '127.0.0.1', db: <userData>/apiloop.db } })`；
  3. 打开 `BrowserWindow`，加载 `http://127.0.0.1:<port>/`。
- **自检模式**：带 `--self-check` 参数启动时不开窗口，在主进程里依次检查下面这些项目，把结果以一行 JSON 打印到标准输出，然后退出：
  - `process.versions.electron`、`process.versions.node`；
  - `node:sqlite`：建一张表、写一行、读一行；
  - 加载 QuickJS，执行 `1 + 1`；
  - 用 `lib/executor.js` 往一个本地临时起的 HTTP 服务发一个 GET，拿到 200；
  - 用 `lib/executor.js` 往一个本地临时起的**自签名** HTTPS 服务发一个 GET，看能不能拿到响应。如果需要关闭证书校验，记下是哪个选项；
  - 跑一段 pre-request 脚本，例如 `pm.environment.set('a', '1')`，确认脚本沙箱在 Electron 里能用。
  - 每一项结果的格式是 `{ name, ok, detail }`，退出码：全部通过为 0，否则为 1。
- `desktop/scripts/stage.js`：把仓库根目录的 `lib/`、`bin/`、`package.json` 复制到 `desktop/app/`，然后在 `desktop/app/` 里跑 `npm ci --omit=dev`。打包时，electron-builder 用 `desktop/app/` 加上 `desktop/main.js` 作为应用内容。

- [ ] 执行 `cd desktop && npm install && node scripts/stage.js && npx electron . --self-check`。输出的 JSON 里**每一项都是 `ok: true`**，退出码 0。把这一行 JSON 原样贴进回报。
- [ ] 回到仓库根目录跑 `npm test`，确认全部通过。
- [ ] 提交（只提交自己的文件，用 `git commit -m ... -- <文件>`）：`feat(desktop): Electron 外壳与自检（D0）`

### Task 2：打包

**文件：**
- 修改 `desktop/package.json`：加 `build` 配置（electron-builder）和 `dist` 脚本

**接口：**
- `npm run dist` 依次执行 stage，然后打 Mac 的 `.dmg`（arm64、x64）和 Windows 的 `.exe`（x64）。
- `asarUnpack` 至少要包含 QuickJS 的 wasm 所在的包。是否还需要别的包，以自检结果为准。

- [ ] 执行 `cd desktop && npm run dist`，产出 3 个安装包。在回报里列出文件名和大小。
- [ ] 用**打包后的程序**跑自检：
  - Mac 上：`<解压或安装后的 apiloop.app>/Contents/MacOS/apiloop --self-check`
  - 全部 `ok: true`，结果贴进回报。
- [ ] Windows 的安装包在这台 Mac 上运行不了，只确认打包成功、文件生成出来了。双击安装、打开窗口，交给用户在 Windows 电脑上做。
- [ ] 提交：`build(desktop): electron-builder 打包 dmg / exe（D0）`

### 如果 `node:sqlite` 在 Electron 里用不了

不要硬改。在回报里写清楚报错信息，并评估备选方案：在安装包里带一份独立的 Node 22（Mac 用 arm64 和 x64 两份，Windows 用 x64），由 Electron 主进程以子进程方式启动 `bin/server web`，窗口照样打开 `127.0.0.1:<port>`。评估内容包括：
- 安装包大小会增加多少；
- 子进程的启动和退出要怎么管理（窗口关掉时要把子进程一起结束）。

先只评估，不实现，等审阅方确定方案。

## 完成后回报

- 两个提交号；
- Electron 版本、自带的 Node 版本；
- 开发模式和打包后两次自检的完整 JSON；
- 3 个安装包的文件名和大小；
- 打包时额外 unpack 了哪些包，原因是什么；
- 遇到的坑，以及第 3 条审阅重点里 `process.exit` 的现状。

## 交给用户的手工检查

- [ ] Mac：打开 dmg，把 apiloop 拖进「应用程序」。第一次打开会被拦下，到「系统设置 → 隐私与安全性」里点「仍要打开」。能看到 apiloop 的登录页。
- [ ] Windows：双击 exe 安装。SmartScreen 提示时点「更多信息 → 仍要运行」。能看到登录页。
- [ ] 登录后，新建一个接口，地址填本机或内网的地址（比如 `http://127.0.0.1:某端口` 或 `https://192.168.3.40:9091/...`），发送后能收到响应。
