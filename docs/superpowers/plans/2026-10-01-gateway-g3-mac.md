# 本地网关 G3（Mac 部分）实施计划

> 执行方式：session1 做 Task 1、2，session2 做 Task 3、4。**每个 Task 一个提交，只提交、不推送**；提交时只加自己改的路径（`git commit -- <路径>`），共享工作区里还有别人的改动。

**目标：** Mac 安装包收尾（Intel 版、G0 审阅留下的 N2–N4），云端页面能下载安装包，网关和云端版本不一致时提示更新；顺带修掉查询参数里 `{{变量}}` 被编码的老问题。

**设计稿：** `docs/design/2026-10-01-local-agent.md`（第 5、8 节）。和设计稿不同的两处，以本计划为准：
- **Windows 暂缓**（用户 2026-10-01：「windows 暂缓，我们先满足现在需求，改完最后再考虑 windows」）。
- **云端发送保留**（用户 2026-10-01：「云端发送不需要关掉，按现状提示即可」）。`docker-compose.yml` 里 `SERVER_SEND` 默认就是 1（f2bb415）。设计稿第 3、4 节里「云端默认关闭发送」「发送按钮不可用」作废。

## 全局约定

- 不写新测试；`npm test`（71 个）每个 Task 都要跑，必须全过。一次性探测脚本放在系统临时目录，跑完删掉。
- 界面行为由用户确认。回报写「代码写完、既有测试通过、审阅过，UI 行为待你确认」。
- 安装包里的 node：**任何一步都不能对它重新签名**。arm64 和 x64 两个包，展开后 `codesign -dv` 都必须是 `TeamIdentifier=HX7739G8FX`，sha256 和下载的那份一致。
- 改了前端的 Task 要重新打包 `lib/web` 一起提交（`npm run build:web`）。
- 用户看得到的文字一律中文。

## 审阅重点

1. **多用户的 Mac：** 第二个用户登录时网关照样能起来；日志各写各的，互不影响。
2. **覆盖安装：** 用户挪过 `apiloop.app`、装过旧的 Electron 版之后再装，结果仍然只有一个干净的 `/Applications/apiloop.app`。
3. **装错架构：** Intel 版装到 Apple 芯片上，或者反过来，安装器要直接拒绝，并用中文说明该下哪个。
4. **下载接口不能读到别的文件：** 文件名里带 `../`、带编码过的斜杠、或者不在列表里，一律 404。
5. **查询参数：** `{{变量}}` 在地址栏里原样显示；发出去的请求和以前完全一样（变量替换之后再编码）。

---

### Task 1（session1）：Mac 安装包收尾

**文件：** `agent-installer/mac/`（build.sh、com.apiloop.gateway.plist、scripts/postinstall、新增 scripts/preinstall、uninstall.command）、`lib/gateway/index.js`

1. **Intel 版：** `NODE_ARCH=x64 bash agent-installer/mac/build.sh` 产出 `apiloop-gateway-<版本>-x64.pkg`。
   - Distribution 里的 `hostArchitectures` 要映射：arm64 → `arm64`，x64 → `x86_64`（现在直接写 `$NODE_ARCH`，x64 时是个无效值）。
   - Distribution 加 `installation-check`：用 `system.sysctl('hw.optional.arm64')` 判断这台机器是不是 Apple 芯片，装错就拒绝，提示文字：
     - 「这是 Intel 芯片版。你的 Mac 是 Apple 芯片（M 系列），请下载 Apple 芯片版。」
     - 「这是 Apple 芯片版。你的 Mac 是 Intel 芯片，请下载 Intel 芯片版。」
   - 依赖里没有原生模块（quickjs 是 wasm），`npm ci` 的结果两种架构通用，不用分开装。
   - 启动器 applet 本身就是通用二进制，不用动。
   - 加一个 `agent-installer/mac/build-all.sh`：依次打两个包。
2. **N2：** postinstall 打开启动器改成 `launchctl asuser "$CONSOLE_UID" sudo -u "$CONSOLE_USER" open "$LAUNCHER_APP"`。
3. **N3：**
   - pkgbuild 加 `--component-plist`，把 `apiloop.app` 的 `BundleIsRelocatable` 设为 `false`；
   - 新增 `scripts/preinstall`（root 运行，永远 exit 0）：删掉旧的 `/Applications/apiloop.app`。
4. **N4 日志：**
   - plist 去掉 `StandardOutPath` 和 `StandardErrorPath`。多个用户共用 `/tmp/apiloop-gateway.log` 时，第二个用户的 launchd 打不开这个文件，网关可能根本起不来；
   - 网关模式下由网关自己写日志：Mac 上写到 `~/Library/Logs/apiloop/gateway.log`（目录不存在就建）；启动时文件超过 5MB 就先改名成 `gateway.log.1`（只留一份旧的）。把 stdout、stderr 和 `uncaughtException` 都写进去，写完再退出，让 launchd 重新拉起。
   - 非 Mac、或者用 `--log-file -` 启动时，照旧输出到终端。开发时直接在终端跑的行为不变。
   - `uninstall.command` 卸载时把日志一起删掉。
5. **回报：**
   - 两个包的 `codesign -dv` 输出（TeamIdentifier）和 sha256 比对结果；
   - 展开 x64 包后 `file .../node/bin/node` 的结果；
   - **不要真装**（要管理员密码，会改动系统）：用 `pkgutil --expand` 展开，读 Distribution 核对 installation-check 和 hostArchitectures。真装由用户来做。

### Task 2（session1）：云端提供安装包下载

**文件：** 新增 `lib/api/downloads.js`，挂到 `lib/admin.js`；`README.md` 写一段「怎么放安装包」

- **安装包放在哪：** `<数据目录>/downloads/`。Docker 下就是宿主机的 `./data/downloads/`，不进镜像。目录不存在时，列表返回空，不报错。
- **`GET /__admin/api/downloads`**（要登录，挂在 `requireLogin` 之后）：
  ```json
  { "version": "2.0.0", "files": [ { "name": "apiloop-gateway-2.0.0-arm64.pkg", "platform": "mac", "arch": "arm64", "version": "2.0.0", "size": 58274112 } ] }
  ```
  - 只认 `^apiloop-gateway-(\d+\.\d+\.\d+)-(arm64|x64)\.pkg$`，其他文件不列；
  - `version` 是云端自己的版本；
  - 同一架构有多个版本时只列最新的。
- **`GET /__admin/downloads/:name`**（**不要求登录**，链接可以直接发给同事）：
  - 文件名必须在上面的列表里，否则 404；
  - 用 `res.download`，带 `Content-Disposition: attachment`。
- 网关不转发 `/__admin/downloads/`，页面在网关上时用云端的绝对地址下载（见 Task 3）。

### Task 3（session2）：下载入口 + 版本提示

**文件：** `web/src/components/layout/ConnectionStatus.vue`，新增 `web/src/components/layout/InstallDialog.vue`，`web/src/api/` 加 `downloads.js`

- **直接打开云端时**（灰点「云端发送」）：点它打开「安装本机 apiloop」对话框。
  - 列出 `/downloads` 返回的包：arm64 显示「Apple 芯片（M1、M2…）」，x64 显示「Intel 芯片」，带大小和下载按钮；
  - 列表为空时显示「管理员还没有上传安装包」；
  - 对话框里写清楚这几步：
    1. 下载后双击安装。如果提示「无法打开，因为来自身份不明的开发者」：打开「系统设置 → 隐私与安全性」，在下方点「仍要打开」；
    2. 装完会自动用浏览器打开 `127.0.0.1:47321`；以后从「应用程序」里点 apiloop 打开；
    3. 第一次打开要填云端地址：显示 `location.origin`，旁边一个复制按钮；
    4. 第一次访问局域网地址时，系统会弹「允许 node 查找本地网络上的设备」，点允许。
- **在网关上时：**
  - 网关版本（`gateway.status.version`）和云端版本（`/meta` 的 `version`）不一致时，状态点旁边显示黄色「有新版本」；
  - 点开同一个对话框；下载链接用 `cloudUrl + '/__admin/downloads/' + name`；
  - 「云端地址」那一步换成「装完覆盖安装即可，数据不受影响」。
- 状态点原来的菜单「云端地址…」保留。

### Task 4（session2）：查询参数里的 `{{变量}}` 在地址栏原样显示

**文件：** 拼地址的那一处（G2 审阅记录：`onQueryChange` 用 `encodeURIComponent` 拼地址）

- 拼地址时 `{{…}}` 保持原样不编码，其他字符照旧编码。这样地址栏里变量能高亮。
- **发送不受影响：** 服务端 `buildUrl` 在变量替换之后才编码。回报里贴一次「查询参数里写 `{{token}}`」时，目标服务器实际收到的地址。
- 反过来也要对：在地址栏里手写 `?q={{token}}`，查询参数表里显示的也是 `{{token}}`。

---

## 不在这次范围

- Windows 安装包（用户要求放到最后）。
- 前置脚本里 `pm.sendRequest` 不替换变量（G1 审阅待办）。
- 第二期（G4、G5）。
