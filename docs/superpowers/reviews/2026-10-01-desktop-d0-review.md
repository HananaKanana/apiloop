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

## 第 2 轮：752c64c（Task 2 打包，含 B1、B2）通过

- **B1**：`APP_ROOT` 统一改成 `__dirname/app`。打包后自检 6/6 全部通过，`appRoot` 落在 `app.asar/app`，wasm 正常读到。
- **B2**：库里还没有用户时，初始密码固定为 `apiloop`。session1 已经用打包后的程序验证：挪开 userData 重新首次启动，登录接口返回 200。
- **`asarUnpack` 两个包都是必需的**：session1 做了对照实验，分别移走两个包，都会出现「找不到模块」。
- **Mac 安装包**：arm64 的 dmg 有 125 MB，打包后自检通过。x64 的 dmg 已经产出，但这台机器没装 Rosetta，跑不了自检。
- **Windows 安装包没生成**：electron-builder 下载的 makensis 是 x86_64 程序，这台 M2 没有 Rosetta，运行不了（错误 -86）。`win-unpacked/` 已经产出，只差拼成安装程序这一步。等用户决定是否安装 Rosetta。
- **D1 要处理的**（都已经记下）：
  - `command.js` 里两处 `process.exit`：开库失败、端口被占。这两种情况现在会直接把整个程序退出，用户看不到任何提示；
  - N1：自签名证书被打进了安装包；
  - stage.js 改成「原地覆盖」之后，上游删掉的文件会残留在暂存目录里。
- 打包前要清掉 `ELECTRON_RUN_AS_NODE` 和 `NODE_OPTIONS`，这是本机 IDE 环境注入的，不是代码问题。`dist.js` 里已经写明。

## 第 3 轮：用户实测——Mac 版发往局域网的请求被系统拦截（审阅方排查）

用户装好 arm64 的安装包后，发 `http://192.168.17.3:8080` 报 `EHOSTUNREACH`，**不弹「本地网络」授权框**，「系统设置 → 本地网络」里也没有 apiloop。同一台机器上用 curl 访问这个地址是通的。

已经做的修复（都已推送）：
- a29d93a：Info.plist 加 `NSLocalNetworkUsageDescription`；
- 11fad49：签名改成 ad-hoc（`identity: '-'`）。之前 `identity: null` 时，electron-builder 改了 Info.plist 却没有重新签名，签名是坏的，标识还是 `Electron`；
- b7df95f：有未保存修改时程序关不掉，原因是 `will-prevent-unload` 没处理，已经修好。

修完之后仍然不行。审阅方加了一个临时的探测模式（没有提交），实测结果如下：

| 启动方式 | 签名 | Node `net` | Electron `net` | 弹不弹授权框 |
|---|---|---|---|---|
| 从终端直接运行二进制（借用终端的权限） | ad-hoc | 能连上 | 200 | — |
| 当作独立程序启动（`open`，和双击一样） | ad-hoc | EHOSTUNREACH | ERR_ADDRESS_UNREACHABLE | **不弹** |
| 当作独立程序启动 | 自己生成的代码签名证书 | EHOSTUNREACH | ERR_ADDRESS_UNREACHABLE | **不弹** |

**结论：** 在 macOS 15 及以后的版本上，没有苹果签发的签名，系统就不会为这个程序弹「本地网络」授权框，而是直接拒绝它访问局域网。这和发请求的方式无关：Node 和 Chromium 两条路都被拦了。这是**桌面版在 Mac 上成立的前提条件**。Windows 没有这项限制。

可选的办法见对用户的回复：Developer ID 签名加公证（每年 99 美元）、免费的 Apple Development 证书（待验证）、或者绕过的办法。

## 第 4 轮：找到不用自己签名的办法——让官方 Node 以后台任务的方式发请求（2026-10-01 实测）

| 测试 | 结果 |
|---|---|
| 不签名的 .app 里，调用系统自带的 `/usr/bin/curl`、`/usr/bin/nc` | EHOSTUNREACH。子进程的连接照样算到 .app 头上 |
| Docker 容器里的 node | **能连上**（借 Docker Desktop 的权限） |
| 终端里运行的 node | 能连上（借终端的权限） |
| **官方 Node（Node.js 基金会签名，Team ID `HX7739G8FX`）用 `launchctl submit` 作为后台任务启动** | 第一次：EHOSTUNREACH，同时系统**弹出授权框**；用户点「允许」之后再跑：**能连上** |

**结论：** 只要真正发请求的那个进程是「带苹果签名的官方 Node」，并且由 launchd 直接启动（这样它自己就是「负责进程」），macOS 就会正常弹授权框，允许一次之后就能访问同网段地址。我们自己的程序不需要签名。

**落到方案上要注意：**
- 安装包里带的必须是 **nodejs.org 的官方构建**，签名要原样保留：
  - 打包工具不能对它重新签名；
  - 不能用 Homebrew 的 node（那是 ad-hoc 签名，会被拦）。
- 授权框里显示的名字是「node」，不是「apiloop」。使用说明里要写清楚。
- **第一次发往局域网的请求一定会失败**，因为授权框还没被点掉。代理要识别出这种情况，提示「请在系统弹窗里点允许，然后重试」，不能只报「连不上」。
- 测试用的后台任务已经移除，脚本也删了，没有留下任何东西。
