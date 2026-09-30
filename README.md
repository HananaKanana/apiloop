# apiloop

**本地的接口调试工具：调通的接口，直接变成 mock。**

发一个真实请求，把回来的响应存成「示例」，这个接口立刻就能以 mock 的方式对外提供，
每次请求还会按模板生成随机数据。省掉「先在 Postman 里调通、再去另一个工具里手抄一遍
假数据」的那一步。数据全部放在本地 SQLite 里，不上云。

## 安装

```bash
npm install -g apiloop
```

或者从仓库装：

```bash
git clone https://github.com/jirengu/server-mock.git
cd server-mock && npm install -g .
```

要求 **Node 22.13 及以上**（用的是内置的 `node:sqlite`，不需要装任何数据库依赖）。

## 快速开始

### 本机

```bash
mkdir demo && cd demo
apiloop init      # 生成示例 router.js，并灌入一个绑定该目录的项目
apiloop web       # 启动服务并打开管理台
```

首次启动会创建管理员 `admin`，**随机初始密码只在终端打印一次**；也可以提前用
环境变量 `APILOOP_ADMIN_PASSWORD` 指定。然后打开 <http://localhost:8080/index.html> 登录
（访问 <http://localhost:8080> 会自动跳过去）。

不用管理台也行：`apiloop start` 只起服务，接口配置文件照旧走 `router.js`。

### Docker

```bash
cp .env.example .env        # 可选：改端口、指定 admin 初始密码
./deploy.sh                 # 构建镜像并后台启动；国内网络加 --cn
./deploy.sh logs            # 首次启动时，admin 的随机密码会在日志里（搜「初始密码」）
```

启动后打开 <http://localhost:8080>。细节见下面的[「Docker 部署」](#docker-部署)。

## 核心工作流

「调通即 mock」是四步，都在管理台里点：

```bash
# 1. 发请求：接口里填好 method / URL / 参数 / 请求体，点「发送」
#    服务端代发（浏览器直发会被 CORS 拦住），能看到状态码、耗时、响应头和响应体
#
# 2. 存成示例：响应面板点「保存为示例」
#    可选「智能模板化」，把录到的死数据换成「每次请求都随机、但结构不变」的模板
#
# 3. 打开 mock：在接口上启用 mock，访问下面这个地址就能拿到数据
curl 'http://localhost:8080/api/users?page=2'          # 根项目，挂在根路径
curl 'http://localhost:8080/mock/my-app/api/users'     # 其他项目，挂在 /mock/<项目标识>
#
# 4. 按条件返回不同示例（期望）：例如 ?id=404 就返回「不存在」那份示例
curl -i 'http://localhost:8080/api/users?id=404'
# X-Apiloop-Mock: expectation:id%20%E6%98%AF%20404
```

**示例一处数据两用**：调试时它是保存下来的响应，mock 时它就是返回的数据。
接口只有配上示例才算「启用」，没有示例的接口不会挂到 mock 上。

**每次请求都重新渲染**：示例里写的 `{{@...}}` 占位符（随机姓名、手机号、时间戳……）
每次请求都会重新生成，所以同一份示例既是「当时真实返回的样子」，也是「以后随机数据的模板」。
语法见[「Mock 数据模板」](#mock-数据模板)。

**mock 调用日志**：管理台的「调用日志」页签能看到最近打到 mock 上的请求 ——
命中了哪个接口、哪条期望，或者 `matched: null`（说明这个地址根本没命中任何接口，
地址拼错时最有用）。日志**只存在内存里**，每个项目保留 200 条，重启即清空。

## 项目、成员与角色

库里可以放多个项目，接口按项目隔离。一根服务同时挂多个项目：

| 项目 | 挂在哪 |
| --- | --- |
| 根项目 | 根路径，例如 `http://localhost:8080/api/users` |
| 其他项目 | `/mock/<项目标识>`，例如 `http://localhost:8080/mock/my-app/api/users` |

根项目是给老用法留的：老接口本来就配在 `/api/xxx` 这种根路径下，升级后 URL 不用改。
每个项目有自己的标识（slug）：目录名里的中文或特殊字符会退化成 `p-` 加一段短码，
重名会自动加 `-2`、`-3`。哪个项目当根项目，按这个顺序决定：`--project` 指定 →
当前目录的旧配置导入 → 已有的默认项目 → 新建一个默认项目。

**一个项目只有它的成员能看到、能改。** 不是成员的话，接口一律返回 404（和「项目不存在」
长得一模一样，免得拿 id 挨个试就能问出「这里有个项目，只是你看不到」）。

每个成员在项目里有三种角色，高级角色包含低级角色的全部能力：

| 角色 | 能做什么 |
| --- | --- |
| `viewer` | 查看项目、目录树、接口、示例、期望、环境、历史、调用日志；发请求（`/send`，以及发请求要用的文件上传）；导出 Postman |
| `editor` | 在 viewer 的基础上：增删改目录、接口、示例、期望、环境；改项目的 `variables` / `auth` / `description`；把数据导入到这个项目；清空历史与调用日志 |
| `owner` | 在 editor 的基础上：改项目的 `name` / `slug`；管理成员；删除项目 |

系统角色 **admin** 对所有项目都拥有 owner 的全部能力，而且**不需要是任何项目的成员** ——
没被加进项目也不会把自己锁在门外。在项目里看到的 `myRole` 就是上面这四种之一
（admin 在哪个项目里都显示 `admin`）。

几条具体规则：

- **不是成员 → 404；是成员但角色不够 → 403「需要 <角色> 权限」**，两者不会混。
- 任何操作都不能让一个项目的 owner 变成 0 个，否则返回 400「项目至少要保留一个 owner」。
  自己退出只要 viewer 权限，但如果你是最后一个 owner，一样会被这条规则拦下来。
- 建项目的人自动成为该项目的 owner；`POST /projects` 和 Postman 的 `new` 导入都是这样。
- 被删除的用户，他的成员关系一起消失。如果因此某个项目没了 owner，由 admin 从成员接口补上。
- **被 mock 的接口本身始终不鉴权** —— 要测的前端得能直接访问，这条不受项目权限影响。

### 从旧版本升级

升级到 2.0 时会自动迁移成员表，**不会有人被锁在门外**：

- 所有现有项目 × 所有现有用户，全部先设成 **editor**；
- 项目的创建者（`created_by`）升成 **owner**；之前 `legacy` 导入时写进去的 owner 原样保留；
- 还是没有 owner 的项目（比如没有创建者的老项目），由**最早创建的那个 admin** 担任 owner。

迁移之后新建的用户不会自动加入任何项目 —— 要手动把他加进来。
项目第一次被建出来时如果库里还没有任何用户（`apiloop init` 就是这种顺序），
下次启动会自动把这个项目交给最早创建的 admin。

## 目录设置：鉴权与变量

目录不只是分类。每个目录都能单独配**鉴权**和**变量**，让「这一组接口」共用同一套登录方式和同一批变量。

**鉴权继承**：接口的鉴权选「继承父级」时，从接口所在目录往上逐层找，**最近的一层生效**
（所在目录 → 上级目录 → … → 项目）。某一层明确配了鉴权就停下来 —— 包括 `noauth`，
它的意思正是「不加鉴权」，继续往上找反而会把上层目录的鉴权又捞回来。

**变量优先级**（后写的覆盖前面同名的）：

```
项目  <  目录（从外到内）  <  环境
```

同名的变量，外层目录盖过项目、内层目录盖过外层、选中的环境盖过全部。
发送时把 `{{var}}` 换成对应的值，替换不了的会列进响应里的 `missingVariables`。

Postman 集合的 `variable` 就落在顶层目录上，所以用「导入到当前项目」的方式导进来时，
集合变量不会丢。

## 导入与导出

| 来源 / 去向 | 说明 |
| --- | --- |
| cURL | 粘贴浏览器「Copy as cURL」，自动解析 method、路径、query、body，并生成回显响应 |
| OpenAPI / Swagger | 粘贴 OpenAPI 3 / Swagger 2 定义（JSON 或 YAML），按 schema 批量生成接口和随机数据结构 |
| Postman Collection v2.0 / v2.1 | 导入成项目（`new`）或导入到已有项目下（`into`）；也会带上 `variable`、目录结构、保存的示例 |
| Postman Environment / Globals | 导入成环境 / 并入项目变量 |
| HAR | 浏览器开发者工具导出的 HAR 文件，把真实录到的一串请求批量变成接口和示例，见下面「[HAR 导入](#har-导入)」 |
| 导出 | 接口可以导出成 Postman Collection，环境导出成 Postman Environment —— 随时能迁回 Postman |

导入前会先预览：文件夹数、接口数、示例数、未支持的鉴权类型和脚本数量，确认后才写库。
同名项目会问你是新建还是合并。整个导入在一个事务里，中途失败整体回滚。

**前置脚本和测试脚本会执行**，跑在 QuickJS 的 wasm 沙箱里（见「[脚本](#脚本)」）——
沙箱里没有 `require` / `process` / `fetch`，也不能碰文件系统，单段脚本 1 秒 CPU、32MB 内存。
导入时脚本跟着接口一起进来，**照常执行**；预览里会提示带进来了多少个。

## HAR 导入

浏览器里对着一个页面录一遍操作，就能把这一串真实的请求批量变成接口和示例。

**怎么导出**：打开开发者工具的「网络 / Network」面板，做完要录的操作（登录、翻页、提交表单），
右键任意一条请求 → **Save all as HAR with content**（Chrome / Edge 是「保存所有为 HAR（包含内容）」，
Firefox 是「全部另存为 HAR」），得到一个 `.har` 文件。注意要选**带内容**的那个，
不然响应体是空的，示例里就没有数据。

**怎么导入**：管理台「导入」对话框里的 **HAR** 页签，选中文件后先预览（主机数、接口数、示例数、
去掉了多少凭据），确认后再写库。两种方式：

- **新建项目**（默认）：按 HAR 里第一个页面的标题建一个新项目，导入者自动成为 owner；
- **导入到当前项目**：需要 editor 权限，会在该项目下建一个以页面标题命名的顶层目录，
  各主机目录都放在它下面。

**导入规则**：

- **每个主机一个顶层目录**（非默认端口会带上端口号）；
- **`方法 + 协议 + 主机 + 路径` 相同的条目合并成一个接口**，名字是 `方法 路径`（例如 `GET /api/users`），
  查询串进「查询参数」那一栏；同一组里由最早的那一条决定接口的请求内容；
- **静态资源会被过滤掉**：图片、字体、音视频、CSS、JS、HTML、WASM 一律不留。Chrome / Edge 导出的
  HAR 里带 `_resourceType` 字段，直接按它筛；没有这个字段时按响应的 mimeType 判断；
- **每个接口最多保留 5 条示例**，状态码和响应体完全相同的只留最早的那一条；
- 请求头里的 `host`、`content-length`、`connection`、`keep-alive` 会被去掉 —— 这些是连接层的头，
  不是业务头；
- 导入进来的接口默认开启 mock（有示例的前提下），访问 `/mock/<项目标识>/<路径>` 就能拿到录到的数据。

### 凭据默认不保留

HAR 是从**真实的浏览器会话**里录下来的，里面带着你的登录态，而导入的项目是**项目里所有成员都能看到的**。
所以默认会去掉：

- 请求头里的 `Cookie`、`Authorization`、`Proxy-Authorization`；
- 示例响应头里的 `Set-Cookie`。

去掉了多少处，预览和导入结果里都会告诉你。确实需要把这些留在项目里时，勾选导入对话框里的
**「保留凭据」** —— **勾了之后，项目里的所有成员都能看到它们**，导入前先确认这个项目里的人都该拿到这份凭据。

> **示例的响应体是原样保存的，不做任何处理。** 登录接口返回的 `token`、会话 ID 就在响应体里，
> 我们无从判断哪一段是凭据，所以也不去猜。**导入前请自己检查一遍**：如果录到的 HAR 来自真实环境、
> 带着生产凭据，先不要往团队项目里导 —— 或者干脆新建一个只放这份 HAR 的项目，成员只加自己。

## Cookie 与代理

调试「先登录、再调业务接口」这类接口时，不用再手动从浏览器里复制 cookie。

**Cookie 是自动的**：发请求前从库里取出匹配的 cookie 放进请求头，响应里的 `Set-Cookie`
再写回库 —— 每一跳都这么做，所以「登录接口 302 跳转到首页」这种链路，跳过去的那一跳
就已经带上新 cookie 了。请求头里手写了 `Cookie` 时以手写的为准（整个请求都不再自动补），
但响应里的 `Set-Cookie` 照样写回库。不想要这一套时，在 `/send` 里传 `options.cookies: false`。

* **作用范围：每个用户在每个项目里各有一份，互相看不见。** cookie 往往就是登录凭证，
  同一个项目的两个成员登录的是不同账号，共用一份等于把两个人的登录态搅在一起。
* 匹配按 RFC 6265：`Domain` 和请求主机对得上、`Path` 是请求路径的前缀、过期的不再发送
  （并会从库里删掉，`Max-Age=0` 就是立即删除）。没写 `Domain` 的是 host-only，
  只发给完全相同的主机名。
* `Secure` 的 cookie 只走 https：http 响应里带 `Secure` 的 `Set-Cookie` 会被直接丢掉
  （中间人可能借此往你身上钉一个会话），http 响应也不能覆盖已有的同名 `Secure` cookie。

**历史记录里的打码**（历史是项目里所有成员都能看的，所以写进历史时先处理，
**返回给发送者本人的结果保持原样**）：

| 位置 | 处理 |
| --- | --- |
| 请求头 `Cookie` / `Authorization` / `Proxy-Authorization` | 值换成 `***` |
| 请求头里 apikey 用的那个头名（名字由接口的鉴权配置决定） | 值换成 `***` |
| 响应头 `Set-Cookie` | 保留 cookie 名和各项属性，只把值换成 `***`，例如 `sid=***; Path=/; HttpOnly` |
| 原始请求 `request.spec` | `params.headers` 里上面那几种请求头的值、`auth` 里的 token / password / value 换成 `***` |

apikey 放在 query 里时，地址里那个参数的值同样会被打码。
`request.spec` 是「用户输入的原始请求」，**库里存的是完整原文**（发起人点重放要用），
只在 `GET /history/:id` 里按查看者区分：不是发起人（包括管理员）才看到打码后的版本。
另外，**响应体里的内容不做处理** —— 那是服务端回显回来的数据，我们无从判断里面
哪一段是凭据，看到什么就是什么。

**代理**支持 http 代理：目标是 http 时直接转发，目标是 https 时用 `CONNECT` 建隧道
（隧道里目标服务器的证书仍然按「是否校验证书」处理，隧道只解决怎么连过去）。
代理设置在管理台的「设置」里改，`GET /settings/proxy` 登录即可读、`PUT /settings/proxy`
只有管理员能改。地址里的密码在任何输出里都是 `***`，提交时也填 `***` 表示「密码不变」——
但**只有协议、主机、端口、用户名都没变时才允许这样沿用**，改了其中任何一项都要重新输入密码
（否则换了代理却忘了改密码，旧密码就会被发到新代理上）。

* 默认值从环境变量 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` 读（大小写两种写法都认），
  只要读到任何一个就视为启用。**读到的默认值不会写进库** —— 否则以后改环境变量就不生效了。
* 地址只支持 `http://` 形式；`socks://`、`https://` 在保存时就返回 400。
* `noProxy` 用逗号分隔，每项可以是精确主机名、`.` 开头的后缀、`host:port`，或者 `*`（全部直连）。
  目标主机命中 noProxy 就直连，重定向之后换了主机也会重新判断。
* `/send` 里传 `options.proxy: false` 可以让这一次请求直连。
* 连不上代理、或者 `CONNECT` 返回的不是 2xx，错误码都是 `PROXY`。

这一节的已知限制（公共后缀列表、响应体不打码、`Secure` cookie）统一列在后面的
「[已知限制](#已知限制)」里。

## 流式发送与 WebSocket 调试

### 流式发送（SSE 与大响应）

管理台的「发送」走的是 `POST /send/stream`：仍然由服务端代发，但响应以 NDJSON 事件流的形式
一段段回来（`head` / `chunk` / `end`，具体形状见[管理台 API 参考](docs/api.md)）。

- **响应头一到就显示状态码和响应头**，不用等整个响应体下载完；
- **响应进行中，「发送」按钮变成「取消」。** 点它会真的断掉**上游**的连接，不让服务端继续等一个
  没人要的结果；取消照样记一条历史，错误码是 `ABORTED`。关掉标签页、切换接口时也会自动取消；
- **`content-type` 是 `text/event-stream` 时，响应面板切到「事件」视图**：按 SSE 的格式
  （`event` / 多行 `data` / `id` / 以 `:` 开头的注释行 / `\r\n`）解析成表格，实时往里追加，
  点一行可以展开看格式化后的 JSON；随时能切回原始文本视图；
- **下载大文件不会把页面卡死**：进行中只显示「接收中… N KB」，不把内容一段段拼进 DOM。

**超时只管到响应头为止。** `options.timeoutMs`（默认 30 秒）在响应头到达之后就不再生效 ——
SSE 本来就是要一直连着的，连多久由你决定（不想等了就点「取消」）。连不上、DNS 解析不了这类
发生在响应头之前的问题，仍然受它约束。

已经转发出去的内容**不受 `maxBodyBytes` 限制**，但写进历史的响应体仍然按 256KB 截断。
Cookie、代理、打码的行为和原来的 `/send` 完全一样 —— 两条路径走的是同一段代码。

### WebSocket

浏览器不能给 WebSocket 设自定义请求头，也不能绕开跨域限制，所以由服务端代连。
点「新建 WebSocket」，填地址（只接受 `ws://` 和 `wss://`）、请求头、查询参数、鉴权，点「连接」。

- 地址、请求头、鉴权都支持变量，**鉴权继承和 bearer / basic / apikey 的处理和普通请求完全一样**；
- 请求头里的 `Sec-WebSocket-Protocol` 会按逗号拆开，作为子协议协商出去；
- **Cookie 默认开启**：按目标地址从 Cookie 库里取匹配的 cookie 带上；自己手写了 `Cookie` 就以手写的为准；
- **消息日志**显示方向（↑发出 / ↓收到）、时间、大小和内容摘要，点开看格式化后的 JSON，
  被截断的会标出来；「清空日志」只清界面上的显示；
- **会话只有创建者本人能访问**，别人（**包括管理员**）访问都是 404 —— 会话里带着你的凭据。
  创建者被移出项目之后同样返回 404。每个用户同时最多保持 10 个会话。

**会话什么时候消失**：上游断开满 60 秒、或者没有任何「事件」连接满 60 秒（关掉标签页之后会走到
这一条）、或者你点了「断开」。会话只存在内存里，服务重启就没了。
前端在 events 连接意外断开时会按 1 秒、2 秒、5 秒的间隔重连，每次都带上 `after=<最后一条 seq>`，
靠服务端的事件缓冲把漏掉的补齐。

这一节的已知限制（握手时的 `Set-Cookie`、代理、证书校验、调试标签页不是接口、取消时的响应体）
统一列在后面的「[已知限制](#已知限制)」里。

## SSE 与 WebSocket 的 mock 回放

普通的 mock 只能回一段静态响应，SSE 和 WebSocket 是**按节奏推**的 —— 所以它们的示例
存的是「怎么推」而不是「推什么」。

### SSE 示例

示例的响应类型选 **SSE**，body 是一段 JSON：

```json
{
  "events": [
    { "delay": 0,    "event": "start", "data": "{\"n\":1}" },
    { "delay": 500,  "data": "{\"n\":2}" },
    { "delay": 1000, "id": "7", "data": "多行也没问题\n第二行" }
  ],
  "repeat": false
}
```

- `delay` 是**和上一条之间的间隔**（毫秒，0~60000），第一条相对于响应头；
- `event` / `id` 可选，会变成同名的 SSE 字段；`data` 必填且必须是字符串，多行会拆成多行 `data:`；
- `repeat: true` 时最后一条发完从头再来，一直到客户端断开；
- **每条的 `data` 在发送的那一刻才渲染**，所以里面写 `{{@cname}}` 这类占位符，
  每次请求拿到的随机值都不一样；
- 命中之后响应头里的 `Content-Type` / `Cache-Control` / `X-Accel-Buffering` 会被强制覆盖成
  SSE 该有的值；示例上配的其他响应头照发。

### WebSocket 示例

接口的 `method` 选 **WS**，它和普通接口一样存进目录树、可以配 mock 路径，但**不注册 HTTP 路由**
（普通 HTTP 请求打过去是 404），而是由 mock 服务端在 `upgrade` 事件上接走。

示例的响应类型选 **WebSocket**，body 是一段 JSON：

```json
{
  "onOpen": [
    { "delay": 0, "send": "欢迎 {{@cname}}" }
  ],
  "rules": [
    { "match": { "type": "equals", "value": "ping" },
      "reply": [{ "delay": 0, "send": "pong" }] }
  ],
  "fallback": "none"
}
```

- `onOpen`：连接建立后按 `delay` 依次推送（第一条相对于 `open` 事件）；
- `rules`：每收到一条消息，**按顺序匹配，第一条命中的生效**，然后按 `delay` 推它的 `reply`
  （第一条 reply 相对于收到的这条消息）。`match.type` 可以是
  `equals`（全等）、`contains`（包含）、`regex`（正则，保存时会校验能不能编译）、`any`（全都匹配）；
- 一条都没匹配上时按 `fallback`：`none` 什么都不回，`echo` 把收到的原样发回去；
- 所有 `send` 都在**发送的那一刻**渲染模板；
- **二进制消息只按 `any` 规则和 `echo` 处理**。

连接数、步骤数、事件数和 `delay` 的上限见「[已知限制](#已知限制)」的 mock 回放。

### 怎么录下来

- 在 **SSE 事件视图**里点「保存为 SSE 示例」：按每个事件的到达时间算出 `delay`，
  第一条从 `head` 到达开始算；
- 在绑定了 WS 接口的 **WebSocket 标签页**里点「保存为 mock」：第一次发送之前收到的消息进
  `onOpen`，之后每条发出去的消息生成一条 `equals` 规则（`reply` 是它下次发送之前收到的消息），
  二进制消息会被跳过并提示跳过了几条。

## 脚本

接口、目录、项目三层都可以挂**前置脚本**（`prerequest`）和**测试脚本**（`test`），
用 Postman 那套 `pm.*` 写法。发送请求时按 **项目 → 目录（从外到内）→ 接口** 的顺序执行。

```
前置脚本  →  替换变量  →  发送  →  测试脚本  →  写回变量  →  写历史
```

- 接口那一层的脚本取自**请求体里带的 `request.scripts`**，所以编辑器里没保存的改动也会生效；
- **前置脚本出错，请求就不发送了**，错误码是 `SCRIPT`；测试脚本出错只记下这个错误，
  已经跑过的测试结果照样保留；
- 界面上「设置」页签里的**「执行脚本」关掉之后，这次发送一段脚本都不执行**（`options.scripts: false`）。

### 环境

脚本跑在 **QuickJS（wasm）** 沙箱里，每个 context 之间互不影响：

| 限制 | 值 |
| --- | --- |
| 单段脚本的 CPU 时间 | 1 秒（**等 `pm.sendRequest` 的时间不算在内**，否则前面一次慢请求会把后面的脚本误判成超时） |
| 一次发送里所有脚本的挂钟时间 | 30 秒 |
| 每个 context 的内存 | 32MB |
| `pm.sendRequest` 的次数 | 一次发送最多 10 次，第 11 次直接以 `err` 回调 |

沙箱里**没有 `require`、`process`、`fetch`，也不能读文件**；`setTimeout`、`URL` 这些浏览器
才有的全局同样没有（`pm` 自己实现了需要的部分）。死循环会被按时打断，内存炸弹会被拦下，
不会拖垮服务、也不会让这次发送卡住。

### 支持的 API

- **变量**：`pm.variables`（本次请求的临时变量，不保存）、`pm.environment`、
  `pm.collectionVariables`、`pm.globals`；每个都有 `get / set / unset / has / toObject`，
  只有 `pm.variables` 有 `clear`。
- **`pm.request`**：`method`、`url`（`toString()` / `getHost()` / `getPath()` / `query.*`，也可整体赋值）、
  `headers`（`get / has / add / upsert / remove / toObject`）、`body.mode` 与 `body.raw`。
- **`pm.response`**（只在测试脚本里有）：`code`、`status`、`responseTime`、`size()`、`text()`、`json()`、
  `headers.get / has / toObject`，以及 `to.have.status(n)`、`to.have.header(name)`、`to.be.ok`。
- **测试**：`pm.test(name, fn)`，以及 `pm.expect(value)` 的一个 chai 子集
  （`equal` / `eql` / `include` / `a` / `property` / `lengthOf` / `above` / `below` / `least` /
  `most` / `match` / `oneOf` / `ok` / `true` / `false` / `null` / `undefined` / `exist` / `empty`，
  加上 `not` 与 `deep`，还有 `to be been is that which and has have with at of same` 这些连接词）。
- **`pm.sendRequest(req, callback)`**：`req` 可以是地址字符串，也可以是
  `{ url, method, header, body }`；回调签名是 `callback(err, res)`。它**走服务端代发**，
  代理设置和 Cookie jar 与这次请求相同，超时 10 秒，**不记入历史**。
  脚本以同步写法调用它，宿主会挂起沙箱等结果。
- **老写法**：`tests["名称"] = 布尔值`、`responseBody`、`responseCode.code`、`responseHeaders`、
  `responseTime`，以及 `postman.setEnvironmentVariable` / `getEnvironmentVariable` /
  `clearEnvironmentVariable` / `setGlobalVariable` / `getGlobalVariable` / `clearGlobalVariable`。
- `console.log / info / warn / error` 都会记下来（最多 200 条，每条最长 2KB），在响应面板的
  「控制台」页签里看。
- **没列出来的 API 一律不支持**：调用时会抛「apiloop 暂不支持 xxx」，不会静默失效。
  `postman.setNextRequest` 只给一条警告，不做跳转。

### 变量写回

| 用什么写 | 写到哪 |
| --- | --- |
| `pm.variables.set` | 只在本次请求内有效，**不保存** |
| `pm.environment.set` | 当前选中的环境 |
| `pm.collectionVariables.set`、`pm.globals.set` | 项目变量 |

- **没选中环境时**，`pm.environment.set` 只在本次请求内有效，并给一条警告。
- **只有 editor 及以上角色才会保存。** viewer 执行同样的脚本，修改只在本请求内有效，
  并提示「只读角色：脚本对变量的修改没有保存」。
- 保存时**只动脚本涉及到的那些 key**：其他变量的描述、启用状态、顺序都保持原样，
  新增的追加到末尾、默认启用。所有写回在一个事务里完成，**请求失败或被取消也照样写回**
  —— 前置脚本已经执行过了。

### 结果与打码

发送结果里的 `scripts` 有 `tests`（每条的名称、通过与否、失败原因）、`console`、`errors`、
`warnings`、以及 `variables`（哪一级动了哪些 key，`persisted` 表示是否真的存进了库）。
**没有任何脚本时它是 `null`**（这时也完全不加载 wasm）。

历史对项目里所有成员可见，而脚本最常干的就是"把 token 打印出来"和"把 token 写进变量"，
所以**别人查看你的历史时**：`scripts.console` 是空的，`variables` 里 `set` 的值是 `***`
（key 保留，方便看出脚本动过哪些变量）。

> **测试脚本在取消时不执行。** 取消的那次请求仍然会写历史（`ABORTED`），
> 但前置脚本对变量的修改照样写回。

## 已知限制

各功能「做不到什么、为什么会这样」集中列在这里。Docker 镜像自身的限制在
「[Docker 部署](#docker-部署)」那一节。

### Cookie 与代理

- **代理只支持 `http://`**。目标是 http 时直接转发，目标是 https 时用 `CONNECT` 建隧道；
  `socks://`、`https://` 形式的代理地址在保存时就返回 400。
- **不内置公共后缀列表**。cookie 的 `Domain` 那条规则只要求「至少含一个点」，
  所以 `Domain=co.uk` 这样的写法仍然会被放行 —— 而我们没有任何办法在本地判断 `co.uk`
  是公共后缀。真要严格，得带上几百 KB 的公共后缀表并持续更新，代价比收益大。
  自己控制的域名常规用不会有影响，**不要把别人的响应直接当成可信数据导入**。
- **历史里的响应体不打码**：那是服务端回显回来的数据，我们无从判断里面哪一段是凭据。
- **http 响应不能设置 `Secure` cookie**：本机用 `http://localhost` 调试时，如果服务端
  给 cookie 加了 `Secure` 属性，这个 cookie 会被丢掉（浏览器对 localhost 有例外，我们没有）。

### WebSocket

- **握手响应里的 `Set-Cookie` 拿不到，不会写回 Cookie 库。** 浏览器的 WebSocket API
  不给看握手响应头，Node 的实现也没有把它暴露出来。所以「连上就种 cookie」这类用法在
  WebSocket 里拿不到登录态 —— 需要登录态的地址请把 Cookie 手填进请求头，
  或者先用普通请求登录一次。
- **WebSocket 不走系统代理。** 目标地址支持自定义请求头（这也是它存在的意义），但代理不行；
  如果按系统设置这个目标本来应该走代理，`open` 事件里会带一句说明。
- **WebSocket 不能关闭证书校验**：自签名的 `wss://` 连不上（普通请求是可以的）。
- **调试用的 WebSocket 标签页不是接口**：它不写历史、不执行脚本，也不进目录树。
  要让 WebSocket 也进目录树，新建一个 `method` 为 `WS` 的接口（见
  「[SSE 与 WebSocket 的 mock 回放](#sse-与-websocket-的-mock-回放)」）。
- **流式发送取消时，已经收到的响应体不会写进历史**：历史里有一条 `ABORTED` 记录，但
  `result.response` 是空的。响应体是在响应收完的时候才组装起来的，中途取消就没有这一段。

### Postman 脚本

- **只支持 `pm.*` 的一个子集**，清单见「[脚本](#脚本)」：没列出来的 API 调用时会抛
  「apiloop 暂不支持 xxx」，不会静默失效；`postman.setNextRequest` 只给一条警告、不做跳转。
- **沙箱里没有 `require`、`process`、`fetch`，也不能读文件**；`setTimeout`、`URL`
  这些浏览器才有的全局同样没有。单段脚本 1 秒 CPU、32MB 内存，一次发送挂钟 30 秒，
  `pm.sendRequest` 最多 10 次。
- **脚本只作用于 HTTP 发送**：WebSocket 调试会话、`WS` 接口的 mock 回放都不执行脚本。
- **取消发送时不执行测试脚本**（前置脚本已经跑过了，它对变量的修改照样写回）。

### mock 回放

- **SSE**：一条示例最多 **5000** 个事件，`delay` 取值 0~60000 毫秒；
- **WebSocket**：每个项目最多同时保持 **100** 条 mock 连接，超了直接拒绝（客户端看到连不上）；
  步骤总数（`onOpen` 的条数 + 各条规则 `reply` 的条数，**规则本身不计**）不超过 **1000**；
  二进制消息只按 `any` 规则和 `echo` 处理；
- **mock 的 SSE / WebSocket 不走期望匹配**，一个接口同时只有一套场景，就是它当前选中的那条示例；
- `WS` 接口**不写发送历史**，连接只会进「调用日志」（状态码 101）；
- SSE 回放的计时器在客户端断开时立刻清理，`repeat: true` 的也不会在断开之后继续跑；
- `/__admin`、`/__apiloop` 开头的 upgrade 请求直接断开。

## Mock 数据模板

写在示例的响应体里，每次请求都会重新生成。

### 文本

| 写法 | 说明 |
| --- | --- |
| `{{@cname}}` | 随机中文姓名 |
| `{{@firstname}}` | 随机中文姓氏 |
| `{{@ename}}` | 随机英文姓名 |
| `{{@word}}` | 随机词语 |
| `{{@words(3)}}` | 3 个随机词语（空格分隔） |
| `{{@sentence}}` | 随机一句话 |
| `{{@paragraph}}` | 随机一段话 |
| `{{@title}}` | 随机标题 |
| `{{@company}}` | 随机公司名 |
| `{{@job}}` | 随机职位 |
| `{{@university}}` | 随机大学 |
| `{{@city}}` | 随机城市 |
| `{{@province}}` | 随机省份 |
| `{{@address}}` | 随机详细地址 |

### 数字

| 写法 | 说明 |
| --- | --- |
| `{{@int(1,100)}}` | 区间内随机整数 |
| `{{@float(1,100,2)}}` | 区间内随机小数，保留 2 位 |
| `{{@price(1,999)}}` | 随机价格（两位小数） |
| `{{@id}}` | 自增 ID，从 1 开始，每次请求递增；`{{@id(1000)}}` 可指定起点 |

### 其他

| 写法 | 说明 |
| --- | --- |
| `{{@bool}}` | 随机 `true` / `false` |
| `{{@pick(待付款,已付款,已发货)}}` | 从候选值里随机取一个 |

### 时间

| 写法 | 说明 |
| --- | --- |
| `{{@date}}` | 今天日期 `YYYY-MM-DD` |
| `{{@time}}` | 当前时间 `HH:mm:ss` |
| `{{@datetime}}` | 当前日期时间 |
| `{{@timestamp}}` | 当前毫秒时间戳 |
| `{{@dateOffset(-3)}}` | 相对今天偏移 n 天的日期 |
| `{{@datetimeOffset(7)}}` | 相对当前时间偏移 n 天的日期时间 |

### 网络 / 标识

| 写法 | 说明 |
| --- | --- |
| `{{@uuid}}` | 随机 UUID |
| `{{@phone}}` | 随机手机号 |
| `{{@email}}` | 随机邮箱 |
| `{{@url}}` | 随机 URL |
| `{{@image(200x200)}}` | 随机图片地址 |
| `{{@ip}}` | 随机 IP |
| `{{@color}}` | 随机十六进制颜色 |
| `{{@token}}` | 32 位随机 token |

### 输入回显

| 写法 | 说明 |
| --- | --- |
| `{{@query(id)}}` | 回显 URL 查询参数 |
| `{{@body(name)}}` | 回显请求体字段，支持 `{{@body(user.name)}}` 取嵌套 |
| `{{@params(id)}}` | 回显路径参数 |
| `{{@header(token)}}` | 回显请求头 |

### 列表重复

```json
{
  "list": [
{{@repeat(3)}}    { "id": "{{@id}}", "name": "{{@cname}}" }
{{/repeat}}  ]
}
```

* `{{@repeat(3)}}` 重复 3 份，`{{@repeat(2-5)}}` 随机 2~5 份，支持嵌套。
* 重复出来的多个 JSON 值之间**不必写逗号**，服务端会自动补上，也会忽略多余的尾逗号，所以不用纠结最后一个元素后面要不要逗号。

### 类型自动匹配

占满整个 JSON 字符串的数值类占位符会自动去掉引号：

```json
{ "age": "{{@int(18,60)}}", "vip": "{{@bool}}" }
```

实际返回 `{ "age": 42, "vip": true }`（数字和布尔，而不是字符串）。写在文字中间则保持字符串，例如 `"msg": "你好 {{@cname}}"`。

### 智能模板化

录制或保存下来的真实响应是「死数据」：每次请求返回的都一样。**一键模板化**把它变成
「每次请求都随机、但结构和类型不变」的 mock 模板。

判断顺序是三步：**先看 key 保护名单，再看 key 名，最后看值的形态**。
保护名单上的 key（`code`、`msg`、`status`、`page`、`pageSize`、`total`，以及所有以
`is` / `has` 开头的）和所有布尔值、`null` **一个都不换** —— 带业务含义的值随机化之后，
联调的前端就没法用了。

下面这份响应里，`code`、`msg`、`success`、`page`、`pageSize`、`status` 都会原样保留：

```json
{ "code": 0, "msg": "ok", "success": true, "data": { "status": "PAID", "page": 1, "pageSize": 20 } }
```

而一份录下来的用户列表：

```json
{"code":0,"data":{"list":[{"id":1,"name":"张三","phone":"13800138000","avatar":"https://x/a.png","createdAt":"2026-01-01 10:00:00"}]}}
```

模板化之后是这样（元素全是对象的数组只模板化第一个元素，外面包一层 `{{@repeat(n)}}`）：

```json
{
  "code": 0,
  "data": {
    "list": [
{{@repeat(3)}}      {
        "id": "{{@id}}",
        "name": "{{@cname}}",
        "phone": "{{@phone}}",
        "avatar": "{{@image(200x200)}}",
        "createdAt": "{{@datetime}}"
      }
{{/repeat}}    ]
  }
}
```

* key 名不区分大小写、忽略 `_` 和 `-`，所以 `created_at`、`createdAt`、`CreatedAt` 是同一个 key。
* `id` / `price` / `timestamp` 这类数值占位符渲染出来仍是数字，不会变成字符串。
* 换完之后会**自己渲染一次并解析一遍**；解析不过就原样返回，并在 `skipped` 里说明原因。
* 已经写过 `{{@...}}` 的值不会再动它，所以重复模板化不会越换越歪。

### Mock 期望

同一个接口，按请求条件返回不同的示例。比如「`?id=404` 就返回 404 那份示例」
「带 `X-Role: admin` 就返回管理员数据」。

```json
{
  "name": "id 是 404",
  "exampleId": "e_xxx",
  "conditions": [{ "in": "query", "key": "id", "op": "eq", "value": "404" }]
}
```

* 一条期望里的多个条件是「且」的关系；多条期望按顺序依次检查，**第一条命中的生效**；
  一条都没命中，就用接口上默认示例那份。
* `in`：`query` / `header` / `body` / `path`。
* `op`：`eq` / `ne` / `contains` / `regex` / `exists` / `notExists` / `gt` / `lt`。
* `header` 的 key 不区分大小写（`X-Role` 和 `x-role` 一样）。
* `body` 支持 `user.age` 这种嵌套取值，而且**只在请求体是 JSON 对象时才判断**：
  表单、纯文本、没有请求体一律不命中（`exists` / `notExists` 也一样）。
* `gt` / `lt` 按数字比较，任意一边不是数字就不命中。
* 期望指向的示例被删除时，这条期望会跟着消失。
* mock 响应多一个响应头 `X-Apiloop-Mock`，一眼看出命中的是哪一条：
  命中期望时是 `expectation:<期望名>`（名字经过 URL 编码），没命中是 `default`。
  跨域时前端 JS 也能读到它（服务端配了 `Access-Control-Expose-Headers`）。

### 兼容手写 router.js

老的用法完全保留：当前目录存在 `router.js` 时照旧加载（`router` 就是 Express app）。

```javascript
router.get('/hello', function (req, res) {
  res.send({ status: 0, msg: 'hello hunger valley' })
})
```

优先级：**先匹配数据库里的接口，没命中再交给 `router.js`**。`router.js` 里不要再套
`setRouter(app)` 那种外壳。

## 从 server-mock 迁移

**老命令 `mock` 仍然可用**（`apiloop` 和 `mock` 指向同一个 CLI）。升级到 apiloop 之后：

- **现在必须登录。** 管理台第一次启动会创建管理员 `admin`，随机密码只打印一次，
  也可以用 `APILOOP_ADMIN_PASSWORD` 预设、或 `apiloop user reset-password admin` 重置。
  **被 mock 的接口本身不需要登录**，被测试的前端照旧直接访问。
- 数据从「当前目录」搬到了全局库 `~/.apiloop/data.db`（可以用 `APILOOP_HOME` 整体换目录）。
- 当前目录里如果有旧的 `routes.db`（更早的版本）或 `routes.json`，第一次启动会自动把它
  导入成一个绑定该目录的项目，**原文件保留不删**，以后再启动不会重复导入；
  两个文件都在时只认 `routes.db`。
- 老的 `router.js`、`{{@...}}` 模板语法都照旧可用；根项目仍然挂在根路径，
  接口原来的 URL 不用改。
- 旧版管理台专用的接口（`/__admin/api/routes`、`/groups`、`/export` 等）**已经删除**。
  如果有脚本在调它们，改用[管理台 API 参考](docs/api.md)里的新接口
  （接口是 `POST /projects/:pid/apis` + `POST /apis/:id/examples`）。
- `--tpl handlebars` 从来没有生效过（handlebars 没导出 express 需要的 `__express`），
  现在明确不支持；可用的是 `ejs` 和 `jade`。

## 命令参考

| 命令 | 作用 |
| --- | --- |
| `apiloop web` | 启动服务 + 可视化管理台（默认入口 `/index.html`） |
| `apiloop start` | 只启动服务 |
| `apiloop open` | 启动服务并自动打开目录里的 html |
| `apiloop init` | 生成示例 `router.js`，并把示例接口灌进一个绑定当前目录的项目 |
| `apiloop user add <用户名>` | 新建用户（`--admin` 建管理员，`--password xx` 指定密码，不指定就随机生成并打印一次） |
| `apiloop user list` | 列出用户 |
| `apiloop user reset-password <用户名>` | 重置密码并打印新密码 |

通用参数：

```bash
apiloop web --port 3000                 # 端口，默认 8080
apiloop web --host 0.0.0.0              # 监听地址，默认 127.0.0.1
apiloop web --db ~/.apiloop/data.db     # 数据库文件，默认 ~/.apiloop/data.db
apiloop web --project my-project        # 指定哪个项目当根项目（按 slug）
apiloop web --public public             # 静态目录，默认当前目录
apiloop web --views views               # 模板目录，默认当前目录
apiloop web --tpl ejs                   # 模板引擎，支持 ejs / jade，默认 ejs
apiloop web --config routes.json        # 首次启动时要导入的旧配置文件
```

管理台需要登录（`/__admin/api/*` 全部要求登录，只有登录接口本身是公开的）。
默认只监听 `127.0.0.1`；要开放给局域网得显式 `--host 0.0.0.0`，终端会额外提醒确认密码强度。

账号相关的规则：密码用 scrypt 加盐哈希存储，会话只存 token 的 sha256，
cookie 是 `HttpOnly` + `SameSite=Lax`；连续 5 次登录失败锁定该用户名 60 秒；
禁用用户会立刻踢掉他所有已登录的会话；**不能**删除、禁用或降级自己，
任何会让「可用的管理员」归零的操作都会被拒绝。

## Docker 部署

数据库挂载到项目目录下的 `./data`，用 `deploy.sh` 封装常用操作。

| 命令 | 作用 |
| --- | --- |
| `./deploy.sh up [--cn]` | 构建并启动；加 `--cn` 使用国内 npm 镜像源 |
| `./deploy.sh logs` / `restart` / `stop` / `status` | 查看日志 / 重启 / 停止 / 查看状态 |
| `./deploy.sh user list` | 在容器里管理用户：`user add alice`、`user reset-password admin` 等 |

不想用脚本时，直接执行 `mkdir -p data && docker compose -p apiloop up -d --build`。
**注意 `mkdir -p data` 这一步不能省**，原因见下面「目录权限」。

### 数据

所有数据都放在宿主机的 **`./data`** 目录，对应容器里的 `/app/data`，由环境变量 `APILOOP_HOME` 指定：

| 文件 | 内容 |
| --- | --- |
| `data/data.db`（以及 `-wal`、`-shm` 两个辅助文件） | SQLite 数据库：用户、项目、接口、示例、环境、Cookie、历史 |
| `data/files/` | 管理台上传的文件，发送 formdata 或 binary 请求时用 |

- 删除容器、重新构建镜像都不会丢数据；升级镜像后，启动时会自动迁移数据库结构。
- **备份**：先 `./deploy.sh stop`，再打包 `data/` 目录，最后重新启动。不要在服务运行时直接复制 `data.db`，因为 WAL 模式下还有一部分数据暂存在 `-wal` 文件里，只复制 `data.db` 会不完整。
- **目录权限**：容器以 uid 1000 运行。`./data` 必须能被 uid 1000 写入：
  - 如果启动前目录不存在，Docker 会以 root 身份创建它，容器就写不进去了。`deploy.sh` 会先执行 `mkdir -p data` 避免这个问题。
  - 如果宿主机用户的 uid 不是 1000，把 `docker-compose.yml` 里 `user:` 那一行的注释去掉，改成 `id -u`:`id -g` 的结果。

### 沿用老的 server-mock 项目

把老项目目录挂载到 `/app/workspace`，`docker-compose.yml` 里已经写好了一行注释，去掉注释即可。启动时服务会：

- 把目录里的 `routes.db` 或 `routes.json` 导入成一个项目，并挂在根路径下；
- 继续加载目录里的 `router.js`，同时会往这个目录写一个 `.router.js`，所以目录同样需要 uid 1000 可写。

### 网络与安全

- **容器内的服务固定监听 `0.0.0.0`**，否则从容器外访问不到。所以启动日志里总会出现「局域网内可访问」的提示，这是正常的。
- **对外端口由 `.env` 里的 `PORT` 决定**。映射出去以后，局域网里的其他人也能访问：管理台需要登录，**mock 接口不需要登录**。如果只想让本机访问，把 compose 里的端口映射改成 `"127.0.0.1:${PORT:-8080}:8080"`。
- **用随机初始密码时，这个密码会留在容器日志里**。第一次登录后请立刻修改。

### 部署相关的限制

- **镜像不编译前端**，直接使用仓库里已提交的 `lib/web` 构建产物。这是有意的：npm 包和
  `npm i -g <git 地址>` 都需要现成的产物；只保留一份产物就不会出现「镜像里构建的」和
  「仓库里提交的」两份不一致；镜像构建时也不必装前端的 devDependencies，构建更快。
  **改了 `web/` 下的前端代码后，要先执行 `npm run build:web`，并把 `lib/web` 一起提交。**
- **健康检查请求的是 `/index.html`，只在 `web` 模式下有效。** 如果把启动命令改成 `start`，需要同时去掉或改写健康检查。
- **构建时用 `npm ci`**，要求 `package-lock.json` 和 `package.json` 保持一致。
- **时区默认是 `Asia/Shanghai`**，会影响 mock 模板里的日期和时间。

## 数据存储

数据全部放在**一个全局库**里，默认 `~/.apiloop/data.db`。

| 环境变量 | 作用 |
| --- | --- |
| `APILOOP_HOME` | 换整个数据目录（库文件、上传文件都在里面），默认 `~/.apiloop` |
| `APILOOP_DB` | 只换库文件路径，默认 `<APILOOP_HOME>/data.db`；`--db` 优先级更高 |
| `APILOOP_ADMIN_PASSWORD` | 首次启动时给 `admin` 指定的密码 |

用 Node 内置的 `node:sqlite`，**不需要安装任何依赖**，但要求 **Node 22.13 及以上**
（`node:sqlite` 自 22.5.0 提供，22.13.0 之前还需要 `--experimental-sqlite` 标志）。

想直接看或改数据，用 `sqlite3` 命令行即可（改完服务会自动热更新）：

```bash
sqlite3 ~/.apiloop/data.db 'select position, method, mock_path from apis order by position'
```

主要几张表：

| 表 | 存什么 |
| --- | --- |
| `apis` | 接口定义：方法、路径、请求参数、鉴权、脚本、mock 开关、延时、跨域…… |
| `examples` | 示例响应：状态码、响应头、响应体。一处数据两用 |
| `folders` | 目录，支持嵌套；`position` 只在同一个父目录内部有意义 |
| `mock_expectations` | mock 期望：按请求条件决定这个接口返回哪一份示例 |
| `environments` | 环境（一组变量）。发送时变量按「项目 < 目录 < 环境」覆盖同名项 |
| `history` | 发送记录，每个项目只保留最新 500 条 |
| `cookies` | 每个用户在每个项目里的 cookie |
| `users` / `sessions` | 用户与登录态 |
| `projects` / `project_members` | 项目与成员角色 |

`position` 只在同级内比较：同一个父目录下，先按 `position` 列子目录，再按 `position` 列接口。

## 管理台 API

管理台前端用的接口都列在 **[管理台 API 参考](docs/api.md)** 里，可以直接调。
所有接口统一返回 `{ ok: true, ... }` 或 `{ ok: false, error: "..." }`。

## 开发

```bash
npm install          # 装依赖（含前端的 devDependencies）
npm test             # 跑测试
npm run dev:web      # 前端开发服务器（Vite，热更新）
npm run build:web    # 构建前端产物到 lib/web
```

**改完前端要执行 `npm run build:web`，并把 `lib/web` 一起提交** —— 仓库里只有一份构建产物，
npm 包和 Docker 镜像都直接用它。

```
bin/server            CLI 入口（yargs 17）
lib/app-info.js       产品名、数据目录、cookie 名等常量（改名只动这里）
lib/command.js        start / open / web / init / user 命令实现
lib/db/               全局库：连库、迁移、事务、变更广播（node:sqlite，零依赖）
lib/db/repos/         各表的增删改查
lib/api/              管理台接口 v2，按资源拆
lib/access.js         项目权限判定：角色是什么、资源属于哪个项目
lib/cookies.js        Cookie 的解析、匹配与内存 jar（纯函数）
lib/proxy-settings.js 代理设置：存 meta 表，没有设置时从环境变量现算
lib/tree.js           目录树业务逻辑：移动、删除目录、复制接口
lib/routes-store.js   单个项目的门面：把库里的一条记录编译成 mock 路由
lib/mock-host.js      按项目挂载 mock：根路径 + /mock/<slug>
lib/mock-runtime.js   把配置编译成 Express 路由，支持热更新，并做 mock 期望的匹配
lib/mock-log.js       Mock 调用日志：按项目存的内存环形缓冲
lib/mock-sse.js       SSE 示例的校验与回放
lib/mock-ws.js        WebSocket 接口的 mock：挂在 upgrade 事件上按 mockPath 回放
lib/executor.js       请求执行器：由服务端代发真实 HTTP 请求
lib/ws-sessions.js    WebSocket 调试会话：连接上游、事件缓冲、生命周期回收
lib/api/ndjson.js     NDJSON 流式响应：/send/stream 与 /ws/:id/events 共用
lib/scripts/          Postman 脚本：sandbox.js（QuickJS 沙箱）/ prelude.js（沙箱内的 pm 实现）/ runner.js（按层执行）
lib/har.js            HAR 导入：解析、过滤静态资源、按主机归目录
lib/importers.js      cURL / OpenAPI(Swagger) 解析
lib/postman.js        Postman 集合 / 环境的解析与生成
lib/web/              管理台前端的构建产物（由 npm run build:web 生成）
sample/               `apiloop init` 用的示例文件
test/                 node:test 测试
```

## License

ISC
