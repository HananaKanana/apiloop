# 本地网关 G0 审阅

计划：`docs/superpowers/plans/2026-10-01-gateway-g0.md`；设计稿：`docs/design/2026-10-01-local-agent.md`。

## 第 1 轮：08f4f65（网关）、2336f87（Mac pkg）——打回一处安全问题

审阅方用假云端加网关做了一次性探测（脚本跑完已删），审阅重点第 1、2、3 条逐条用 curl 验证：

| 检查 | 结果 |
|---|---|
| `Host: evil.com` | 403 ✓ |
| `Sec-Fetch-Site: cross-site` | 403 ✓ |
| POST 不带 `X-Apiloop` | 403 ✓ |
| GET 不带 `X-Apiloop`（`/__admin/api/*`） | 403 ✓ |
| `OPTIONS` 预检 | 403，响应里没有任何 `Access-Control-*` 头 ✓ |
| `Origin: http://evil.com` 加 `X-Apiloop` | 403 ✓ |
| 正常请求：`Cookie` 和 `X-Apiloop` 原样转给云端 | ✓ |
| `Set-Cookie` 改写 | `Domain` 和 `Secure` 去掉，`Path`、`HttpOnly`、`SameSite` 保留 ✓ |
| 流式转发（假云端每 400ms 发一段） | 到达间隔 397 / 392ms，没有被缓冲 ✓ |
| **`/__ADMIN/API/meta`，不带 `X-Apiloop`** | **200，被转发到了云端 ✗** |
| **`POST /__ADMIN/API/projects/p/send/stream`，不带 `X-Apiloop`** | **在本机发出了请求，打到了目标 ✗** |

### B1（必须修）：路径大小写可以绕过 `X-Apiloop` 检查，一直打到「本机发送」

- **原因：** Express 的路由默认**不区分大小写**，所以 `app.use('/__admin/api')`、`app.post('/__admin/api/projects/:pid/send/stream')` 都会匹配 `/__ADMIN/API/...`。而安全闸门里的 `isUnder(req.path, API_PREFIX)` 是**区分大小写**的。大写前缀就不需要带头，直接放行。云端的 Express 同样不区分大小写，所以转发过去也照常返回数据。
- **影响：** 设计稿第 3.1 节把 `X-Apiloop` 当作核心防线，这条防线被绕过了。现在浏览器里能拦住它的，只剩下另外两道：
  - `Origin` 检查：跨站的 POST 都会带 `Origin`；
  - `Sec-Fetch-Site` 检查。

  所以从网页上实际利用比较难，但防线必须完整。
- **修法（两处都要做）：**
  1. 安全闸门里判断前缀时，先把路径转成小写：`var p = String(req.path).toLowerCase()`，再用 `isUnder(p, API_PREFIX)` 和 `isUnder(p, GATEWAY_PREFIX)`。
  2. `app.set('case sensitive routing', true)`。这样大小写不对的路径根本匹配不到任何路由，落到静态资源，返回 404。
- **修完后在回报里贴出：** 上表最后两行，以及 `/__Admin/api/...`、`/__admin/API/...` 这两种混合大小写的写法，不带头的都要返回 403；带头的也只能得到 404，不能被转发，也不能在本机发送。

### 小问题（N1 下次提交顺手改，N2–N6 记到对应阶段）

- **N1：** `build.sh` 里依赖缓存的标记文件 `.apiloop-lock-sha` 每次都被 `rm -f` 删掉，所以「锁文件没变就不重装」从来不会生效。标记文件应该放到 `$WORK` 下面，不要放在要打进安装包的 `$APP` 里。
- **N2（G3）：** postinstall 里 `sudo -u <用户> open` 是在 root 的会话里运行的，常常打不开图形界面的程序。改成 `launchctl asuser "$CONSOLE_UID" sudo -u "$CONSOLE_USER" open ...`。现在失败只会降级成「不自动打开浏览器」，并且写了日志。
- **N3（G3）：**
  - pkgbuild 默认允许 `.app` 被「重新定位」：用户挪过 `apiloop.app` 之后，覆盖安装会装到挪过去的那个位置。加一个组件 plist，把 `BundleIsRelocatable` 设为 `false`。
  - `/Applications/apiloop.app` 已经存在别的东西时（比如用户装过 D0 的 Electron 版），新旧文件会混在一起。加一个 preinstall，先删掉旧的 `/Applications/apiloop.app`。
- **N4（G3）：** 日志放在 `/tmp/apiloop-gateway.log`。多个用户共用 `/tmp`，第二个用户可能写不进去；重启后日志也没了。改成网关自己写到 `~/Library/Logs/apiloop/`。
- **N5（G1）：** 局域网授权的提示只在 URL 里**直接写私有 IP** 时才出现。如果写的是解析到私有地址的主机名（比如 `http://dev.lan`），就没有提示。改成从错误信息里取出实际的 IP 来判断（错误信息形如 `connect EHOSTUNREACH 192.168.17.3:8080`）。
- **N6（G2）：** 第一次设置完云端地址之后，页面上没有地方能改，只能用 `--cloud` 参数或者手动改 `gateway.json`。G2 在页面上加一个入口。

### 确认没问题的

- 安全闸门排在所有路由之前；`/send/stream` 排在转发之前；转发路径上没有全局解析请求体（大文件靠管道传）。
- 浏览器断开时，会同时掐断转发给云端的请求，以及本机正在发的请求。
- 本机发送不给 `fileRoots`，页面没法借它读本机文件。
- 前端所有请求都经过 `client.js` / `stream.js`，没有绕过 `X-Apiloop` 头直接访问 `/__admin/api` 的地方。
- 安装包里的 node：打包流程里没有任何 `codesign` 和 `--sign`。打包后展开核对 `TeamIdentifier=HX7739G8FX`，并和下载的那份逐字节比对 sha256。
- LaunchAgent 的第一段是 node 的绝对路径，属于用户域（`gui/<uid>`），只在图形会话里运行。
- 卸载不删 `~/.apiloop`，并且提示了这一点。
- `npm test` 71/71；前端产物和源码一致（index-BCmKfwmC.js）。

### 推送

两个提交**暂不推送**，等 B1 修好后一起推。用户可以先用已经打好的 pkg 做手工验证：B1 不影响「官方 Node 能不能拿到本地网络授权」这件事，而且浏览器里另外两道防线还在。

## 第 2 轮：30653c7（B1、N1）通过；审阅方加了 7adfd47（默认 User-Agent）

- **B1 修好了：**
  - 安全闸门里先把路径转小写，再判断前缀；
  - `app.set('case sensitive routing', true)` 放在第一个 `app.use` 之前（第 702 行，闸门在第 705 行）。Express 4 的路由器是第一次注册路由时才创建的，这个设置放在后面就不起作用，这里的顺序是对的。
- **审阅方复测（一次性探测，已删）：**
  - `/__ADMIN/API/meta`、`/__Admin/api/meta`、`/__admin/API/meta`，不带头：都是 403；
  - 大写前缀带头：404，没有被转发，也没有在本机发送；
  - 大写前缀的 `send/stream` 不带头：403；带头：404，没有打到目标；
  - 正常的转发和本机发送都不受影响。
  - `/__admin/api/projects/p/SEND/STREAM` 带头时会被转发给云端（由云端发送）。这条带了暗号头，不算绕过；G1 关掉云端发送之后就不存在了。
- **N1 修好了：** 标记文件放到了 `$WORK`。中间产物也挪到了 `/tmp/apiloop-agent-build`，因为工作区里一次删太多文件会被 IDE 的保护拦下来。
- **用户实测（第 1 轮打的 pkg）：**
  - 安装 → 设置云端 → 登录 → 发同网段的 `192.168.17.3:8080`：授权之后收到了目标的响应，和 curl 的结果一样；
  - 公网的百度也能访问。**G0 的核心问题验证通过。**
- **7adfd47（审阅方）：** 用户发现只写 `apiloop` 的 User-Agent 会让百度只回一个跳转页。默认值改成「Chrome 的格式 + `apiloop/<版本>`」，实测返回完整首页；请求头里自己写了 User-Agent 时以用户的为准。`npm test` 71/71。
- **待用户确认：** Safari 走一遍，以及重启后能不能直接打开。下一次打 pkg（G1 之后）会带上 B1 和默认 User-Agent 的修改。
