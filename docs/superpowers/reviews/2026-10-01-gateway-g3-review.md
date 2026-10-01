# 本地网关 G3（Mac 部分）审阅

计划：`docs/superpowers/plans/2026-10-01-gateway-g3-mac.md`。

## 第 1 轮：5298d31（Task 3 下载入口和版本提示）、71c9620（Task 4 查询参数里的变量）——通过；审阅方改了一处

### Task 3

- 版本比较收进 `stores/gateway.js` 的 `versionMismatch`，顶栏的「有新版本」和 G2 的横幅共用这一个判断 ✓。
- 下载用普通链接，不走 fetch；在网关上用云端的绝对地址；文件名做了 `encodeURIComponent` ✓。
- **审阅方改了（cb3a187）：** 安装步骤第 3 步写成了 L1 之后的样子（「装完可以直接用，云端地址已写死」），这是计划里的错，不是实现的错。现在装完第一次打开**还是要填云端地址**，按原来的文字，用户装完会不知道该干什么。已改成「第一次打开时要填云端地址，填 <当前网址>，然后用同一个账号登录」。L1 做完后再改回来。
- 依赖 session1 的 Task 2（`/downloads` 接口）。在它合进来之前，点开对话框会显示接口不存在的错误，所以**等 Task 2 合进来以后再一起部署**。

### Task 4

- `encodeQueryPart` 只此一份，地址栏和查询参数表两个方向用的是同一条规则 ✓。
- 发送不受影响：有查询参数行时，`buildUrl` 以参数行为准重新拼地址（b2fbfb7），而且是先替换变量、再编码 ✓。

### 共享工作区

- 5298d31 用宽泛的 `git add` 把审阅方还没提交的登录修复（`web/src/api/auth.js`、`web/src/views/LoginView.vue`）一起带进去了，而且那时打的 `lib/web` 不包含这个修复。内容本身没问题，审阅方在干净副本里按 HEAD 重新打了 `lib/web`（b703812）。
- **再次提醒：** 提交时只加自己改的路径（`git commit -- <路径>`）。`lib/web` 一定要在提交前重新构建。

`npm test` 71/71。

## 第 2 轮：78b757b（Task 1 Mac 安装包收尾）——通过；审阅方修了一处

### 确认没问题的

- **Intel 版：** node 是 x86_64，TeamIdentifier=HX7739G8FX，sha256 和下载的那份一致；启动器 applet 本来就是通用二进制。
- **N2：** `launchctl asuser` + `sudo -u` 打开启动器 ✓。
- **N3：** 补了 `CFBundleIdentifier`，pkgbuild 才认这是 bundle 组件，`relocatable="false"` 才生效。改完以后**只对启动器**重新 ad-hoc 签名，node 没碰（打包脚本最后的 sha256 比对兜底）；preinstall 删掉旧的 `/Applications/apiloop.app` ✓。
- **N4：** plist 去掉了 `StandardOutPath`；网关自己写 `~/Library/Logs/apiloop/gateway.log`，启动时超过 5MB 转存一份，`uncaughtException` 先写进日志再退出 ✓。

### B1（审阅方已修）：装错芯片版本时拦不住

- **检查函数返回的是字符串。** Installer JavaScript 的约定是：要拒绝时先填 `my.result`（`type = 'Fatal'`，以及 `title`、`message`），再返回 `false`。非空字符串会被当成「真」，结果照样放行。
- **Intel 版的 `hostArchitectures` 只写了 `x86_64`。** 在 Apple 芯片上，Installer 会先弹「需要安装 Rosetta」，中文提示轮不到出来。两个包都改成 `arm64,x86_64`，架构由检查函数来拦。
- 已重新打出两个包，打包脚本的自检全部通过。**装错版本时的实际表现要用户确认**：在 Apple 芯片的 Mac 上打开 x64 包，应该看到「这是 Intel 芯片版……」并且装不下去。

### 小问题（不改）

- 终端里跑网关时，stderr 的内容也写到了 stdout（`write` 一律走 `originalOut`）。只影响开发时看终端。
- postinstall 一开头 `: > "$LOG"` 会清空 preinstall 刚写的日志。只影响排查。

### 共享工作区

- 78b757b 提交 `lib/command.js` 时用的是整个文件，把审阅方「命令行新建用户要求改密码」那一行也带进去了（1186df5 的一部分）。内容是对的。
