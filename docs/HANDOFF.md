# apiloop 交接文档

写于 2026-10-02，最后一个提交 `45ccc07`。给接手的 Claude 会话看：开工前从头读一遍。

仓库要从 `server-mock` 正式改名成 `apiloop`（目录、git 远端都改）。改名后，Claude 的「记忆」目录
（按项目路径存，原来在 `~/.claude/projects/-Users-kana-code-server-mock/memory/`）**不会跟过来**，
所以以前记忆里的东西都抄在下面了。

---

## 1. 和用户协作的规矩（最重要）

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

## 2. 项目是什么

团队用的接口调试工具（定位类似 Postman，**但界面和文档里不许出现「Postman」字样**，用户明确要求）：

- **云端**（Docker 部署在 `http://leonaz.top:8765`，端口映射 8765:8080）：管理台网页、Mock 服务、
  账号与用户管理、多端同步的中心、客户端安装包下载。
- **本机网关**（`node bin/server gateway`，监听 `127.0.0.1:47321`）：客户端里跑的就是它。
  请求从用户自己的电脑发出（内网、本机地址都能调）；数据存在本机 SQLite，登录后和云端双向同步。
- **桌面壳**：只是一个窗口，打开 `127.0.0.1:47321`。
  - Mac：Swift + WKWebView（`agent-installer/mac/shell/`），安装包是 `.pkg`，带官方 Node。
  - Windows：C# .NET Framework 4.8 + WebView2（`agent-installer/windows/`），安装包是 `.exe`，
    装到 `%LOCALAPPDATA%\Programs\apiloop`，不需要管理员。
- 前端只有一份（`web/` → 构建到 `lib/web/`），云端和网关用同一份。

早期试过 Electron 方案（D0），已经放弃（macOS 上未签名的 app 拿不到局域网权限），试验代码已删。

## 3. 关键机制与容易踩的坑

**本机空间（`lib/gateway/space.js`）**
- 三种状态：`unbound`（没登录过，`spaces/local`）、`signedIn`、`signedOut`（退出后数据留着照常用）。
  账号空间目录 `spaces/<host>~<port>~<userId>`。
- 退出登录后本机库里那个用户行还在 —— 前端显示「是否登录」要看 `gateway.signedIn`，不能看 session 里的名字
  （`45ccc07` 刚修过头像的这个问题）。
- 云端地址优先级：`--cloud` 参数 → 安装包里写死的 `cloud.json` → `gateway.json`。用新云端地址登录时，
  旧空间的数据会并过去（`mergeUnbound`）。

**同步（`lib/gateway/sync/`）**
- 先拉（state / snapshot / changes）再推，按 `sync_base` 基线三方合并，同一字段两边都改了算冲突，用户选
  「用我的 / 用云端的 / 另存副本」。
- 回声识别：拉下来的行 `rev` 等于基线 rev，就是自己刚推上去的，不当云端改动。
- 本机删掉的项目不会因为「云端有、本机没有」再被拉回来；`mirrorMembers` 跳过本机没有的项目。
- 状态里的 `dataVersion` 变了，前端就重新拉项目、目录树、环境（后台同步拉到别处的改动后页面自动刷新）。
- 没用过的自动项目（名字是「默认项目」「我的项目」且是空的）同步时会被丢掉，防止多端各建一个造成重复。

**版本与一键更新（`lib/gateway/update.js`）**
- 云端所有管理台响应（包括 401）都带 `X-Apiloop-Version` 头，网关读成 `/__apiloop/status` 的 `cloudVersion`。
  版本号来自 `package.json`。
- 只有云端版本比本机新才给「更新」：从云端 `/__admin/downloads/<安装包名>` 下载，
  Mac `open` 那个 pkg（要输一次密码），Windows 运行 `exe /update`（静默）。
- Windows 上必须等下载文件 `close` 之后再运行，否则 `spawn EBUSY`；杀毒软件锁文件时会重试 10 次
  （`d6bfbe2`）。

**Mock**
- Mock 服务**只在云端**（`/mock-<项目ID>/...`），网关不提供 `/mock-*`。所以未登录（`unbound`）时 Mock 用不了。
- 页面上所有 Mock 地址都用 `web/src/utils/mock.js` 的 `mockBaseUrl()`（网关上是云端地址），
  **不要用 `window.location.origin`** —— 那在客户端里是 `127.0.0.1:47321`。
- 内置「Mock」环境（`environmentId: 'mock'`）：变量默认 `host = mock 地址`，改过的存在项目的
  `extra.mockVariables`，值里用占位符 `$MOCK_BASE` 代表 mock 地址（`lib/api/mock-env.js`），云端地址变了也不过期。

**前端约定**
- 确认框一律用 `@/utils/dialog` 的 `useDialog`（统一样式），不要直接用 naive-ui 的。
- 复制用 `@/utils/clipboard` 的 `copyText`：线上是 http，没有 `navigator.clipboard`。
- Vue 模板的 `{{ }}` 插值里**不能出现 `}}`**（比如拼 `'{{@' + name + '}}'`），会被提前截断 —— 写成函数放到 script 里。
  SFC 的 `<script>` 里也不能出现字面量 `</script>`，注释里也不行。
- **改了 `web/` 必须 `npm run build:web`，把 `lib/web` 一起提交**。Docker 镜像和安装包都直接用仓库里的产物。
- 用户可见的文字一律中文，参考 Postman 的交互，但不出现 Postman 字样（导入导出叫「JSON 文件」「导出为 JSON」，
  接口路径是 `/import/json`、`/export/json`；老的 `/postman` 路径为兼容旧客户端保留着）。
- 脚本两段叫「请求前 / 响应后」（存储里仍是 `prerequest` / `test`），默认打开「响应后」。

**账号**
- 自助注册建的是待审核（`users.pending = 1`，迁移 v8）的普通成员，管理员在「用户管理」里通过或拒绝（拒绝 = 删除）。
  待审核的人密码对了登录返回 403。
- 自己不能禁用、删除、降级、重置自己。

## 4. 构建、部署、发布

**云端部署**（服务器上）：`git pull && ./deploy.sh up --cn`。数据在部署目录的 `./data`。
其他命令见 README「部署云端」。

**打安装包**（在用户这台 Mac 上，产物在 `agent-installer/dist/`，不入库）：

```bash
APILOOP_CLOUD_URL=http://leonaz.top:8765 bash agent-installer/mac/build-all.sh      # arm64 + x64 两个 .pkg
APILOOP_CLOUD_URL=http://leonaz.top:8765 bash agent-installer/windows/build.sh      # win-x64 .exe（要 dotnet SDK）
```

- 云端地址打包时写死进安装包，必须给。打完习惯上挪到 `agent-installer/dist/leonaz.top/` 交给用户。
- 很慢（几分钟），用后台任务跑，日志写到 scratchpad。
- Mac 壳用 `swiftc -Xfrontend -disable-autolinking-runtime-compatibility` 编（命令行工具缺 x86_64 兼容库）。
  如果有人在 macOS 12 上打不开 app，先查这个。
- 安装包都不签名：Mac 第一次要去「隐私与安全性」点「仍要打开」；Windows 点「更多信息 → 仍要运行」。

**发版顺序**：
1. 改 `package.json` 版本：`npm version x.y.z --no-git-tag-version`，提交。
2. 打包。
3. 用户把包传到服务器 `data/downloads/` 并 `chmod 644`。
4. 服务器 `git pull && ./deploy.sh up --cn`。
5. 客户端提示有新版本，一键更新。

测一键更新时，云端版本要比已装的高。

## 5. 现在的状态（2026-10-02）

- 版本 **2.0.2**（`3244f93`）。2.0.2 的安装包在 `agent-installer/dist/leonaz.top/`：
  - 两个 Mac pkg 是在 `3244f93` 打的；
  - Windows exe 在 `d6bfbe2` 重打过（带一键更新的 EBUSY 修复），用户需要重新上传覆盖。
- 用户的 Windows 装的是 2.0.0，它的一键更新有 EBUSY 问题，这一次要手动下载安装 2.0.2。
- **2.0.2 打包之后才提交、还没进任何安装包的改动**（下次打包会带上）：
  - `b96925d` 导入导出接口新路径 `/json`；
  - `d6bfbe2` 一键更新 EBUSY 修复（Windows 包已带，Mac 包没带，对 Mac 无影响）；
  - `45ccc07` 未登录时头像显示灰色人形。
- 线上账号里还有之前重复同步留下的空项目（「默认项目」「我的项目」），用户装好新版后自己删。

## 6. 改名为 apiloop 要处理的地方

产品名早就是 apiloop（`lib/app-info.js` 统一管名字，数据目录 `~/.apiloop`、cookie、环境变量都已是 apiloop），
剩下的是仓库层面：

- [x] 本地目录 `/Users/kana/code/server-mock` → `/Users/kana/code/apiloop`。
- [x] git 远端已改为 `http://leonaz.top:3000/liuxiuqi/apiloop.git`（用户的 Gitea）。
- [x] `package.json` 的 `repository` / `bugs` / `homepage` 三个地址跟着改。
- [ ] 服务器上的部署目录如果也叫 server-mock，改不改都行。Compose 项目名早已固定为 `apiloop`（`deploy.sh` 里 `-p apiloop`），
      数据在 `./data`。整个目录挪走时连 `data/` 和 `.env` 一起带上，挪完 `./deploy.sh up --cn`。
- [x] `.gitignore`、`.dockerignore` 里的 `server-mock-*.tgz` 改成 `apiloop-*.tgz`。
- [x] `bin/server` 第 88 行注释、`test/*.test.js` 里临时目录前缀改成 `apiloop-`。
- [x] `docs/design/`、`docs/superpowers/`（已实现的设计稿、计划、审阅记录）已删除，要查看翻 git 历史（`46d1d56` 及以前）。
- [x] 第 1 节的规矩已抄成仓库根目录的 `CLAUDE.md`，每次会话自动加载。

## 7. 延后 / 待用户决定的事

- Windows 代码签名、线上换 https（都延后了）。
- 命令行帮助还是英文，还列着 `open` / `start` / `init` 这些老命令（带 `router.js` 的旧玩法）。要不要整理，用户没定。
- 客户端退出登录后，顶栏仍显示「系统设置」齿轮（本机那个用户是管理员）。只是本机代理设置，没改，问过用户。

## 8. 文档地图

| 文档 | 内容 |
| --- | --- |
| `README.md` | 对外介绍：功能、部署云端、发布客户端、开发 |
| `CHANGELOG.md` | 用户看得到的版本变化 |
| `docs/api.md` | 管理台接口参考（含本机网关 `/__apiloop/*`） |
| `web/README.md` | 前端目录与约定 |
| `CLAUDE.md` | 协作规矩（本文第 1 节的副本，每次会话自动加载） |
| 应用内「?」帮助 | 给最终用户的用法：变量、脚本、Mock 函数、导入导出 |
