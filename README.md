# apiloop

**本地接口调试 + mock 工具。** 起一个服务，配好接口就能拿到假数据；调通的真实响应可以一键变成 mock。
数据全部放在本地 SQLite 里，不上云、不登录也能用。

## 安装

```bash
npm install -g apiloop
# 或者从本仓库安装
npm install -g .
```

要求 **Node 22.13 及以上**（用的是内置的 `node:sqlite`）。

## 快速开始

```bash
mkdir demo && cd demo
apiloop init      # 生成示例 router.js，并把示例接口灌进一个绑定该目录的项目
apiloop web       # 启动服务并打开管理台
```

首次启动会创建一个管理员 `admin` 并**把初始密码打印在终端**（只显示一次），
打开 <http://localhost:8080/index.html> 用它能登录。直接访问 <http://localhost:8080> 会自动跳过去。

也可以完全不用管理台，直接跑 `apiloop start`。

## 从 server-mock 迁移

**老命令 `mock` 仍然可用**（`apiloop` 和 `mock` 指向同一个 CLI）。升级到 apiloop 之后：

- 当前目录里如果有旧的 `routes.db`（更早的版本）或 `routes.json`，第一次启动会自动把它
  导入成一个绑定该目录的项目，**原文件保留不删**，以后再启动不会重复导入。
- 两个文件都在时只认 `routes.db`。
- 老的 `router.js`、`{{@...}}` 模板语法都照旧可用。
- 接口原来配在 `/api/xxx` 这类根路径下，升级后 URL 不需要改（根项目仍然挂在根路径）。

## 命令

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
apiloop web --tpl ejs                   # 模板引擎，默认 ejs
apiloop web --config routes.json        # 首次启动时要导入的旧配置文件
```

## 可视化管理台

`mock web` 之后访问 `http://localhost:<端口>/index.html`。只输入 `http://localhost:<端口>` 会自动 302 到这个页面。

> 注意：`web` 模式下根路径的 `index.html`、`app.js`、`style.css` 归管理台使用，项目里同名的文件会被遮住。`start` 模式不挂管理台，不受影响。

![管理台](docs/screenshot-console.jpg)

| 能力 | 说明 |
| --- | --- |
| 接口增删改查 | 左侧按分组列出接口，可搜索、可一键停用、可复制、可删除 |
| 分组管理 | 新建分组、重命名（该分组下接口一起改名）、删除分组（可选「接口移到未分组」或「连接口一起删除」）、拖动排序 |
| 入参表单 | Query / Body 字段表格：字段名、类型、必填、说明、示例值；`{{@xx}}` 路径参数自动识别 |
| 出参配置 | 响应类型（JSON / 纯文本 / HTML）、状态码、CORS 开关、响应延时、自定义响应头 |
| JSON 编辑器 | 语法高亮、实时校验（带行号）、格式化 / 压缩、Tab 缩进、滚动同步 |
| 随机 Mock 数据 | 「插入 Mock 字段」按分组列出所有占位符，点一下插到光标处；每次请求都会重新生成随机值 |
| 常用响应模板 | 标准成功 / 列表分页 / 对象详情 / 业务失败 / 登录成功 / 回显请求参数 / 空列表 |
| 从 cURL 导入 | 粘贴浏览器「Copy as cURL」，自动解析 method、路径、query、body 并生成回显响应 |
| 从 OpenAPI 导入 | 粘贴 OpenAPI 3 / Swagger 2 定义（JSON 或 YAML），按 schema 批量生成接口和随机数据结构 |
| 接口自测 | 在页面里真实发起请求，看状态码、耗时、响应头和响应体；URL 与参数按入参定义自动预填 |
| 即时生效 | 保存后服务端热更新路由，无需重启；外部直接用 `sqlite3` 改库也会自动生效 |
| 导入导出 | 一键导出 `routes.json`（数据库没法进 git diff，这是分享和留档的出口） |

删除分组时会让用户明确选择接口去向，避免误删：

![删除分组](docs/screenshot-group-delete.jpg)

界面完全离线可用：零构建、无 CDN、无外部字体和图标。

## 登录与用户

管理台需要登录（`/__admin/api/*` 全部要求登录，只有登录接口本身是公开的）。
**被 mock 的接口本身不需要登录** —— 被测试的前端要能直接访问。

- 第一次启动时自动创建一个管理员 `admin`，密码取自环境变量 `APILOOP_ADMIN_PASSWORD`，
  没设就随机生成 16 位并打印在终端（**只显示这一次**）。
- 用户管理用 `apiloop user` 命令，也可以直接调 `/__admin/api/users/*`。
  界面上的用户管理留到后续版本。
- 密码用 scrypt 加盐哈希存储，会话只存 token 的 sha256，cookie 是 `HttpOnly` + `SameSite=Lax`。
- 连续 5 次登录失败会锁定该用户名 60 秒。
- 把用户禁用会立刻踢掉他所有已登录的会话。
- **不能**删除、禁用或降级自己；任何会让「可用的管理员」归零的操作都会被拒绝。

默认只监听 `127.0.0.1`。要开放给局域网得显式 `--host 0.0.0.0`，终端会额外提醒确认密码强度。

## 项目与权限

**一个项目只有它的成员能看到、能改。** 不是成员的话，接口一律返回 404（和「项目不存在」
长得一模一样，免得拿 id 挨个试就能问出「这里有个项目，只是你看不到」）。

每个成员在项目里有三种角色，高级角色包含低级角色的全部能力：

| 角色 | 能做什么 |
| --- | --- |
| `viewer` | 查看项目、目录树、接口、示例、期望、环境、历史；发请求（`/send`，以及发请求要用的文件上传）；导出 Postman |
| `editor` | 在 viewer 的基础上：增删改目录、接口、示例、期望、环境；改项目的 `variables` / `auth` / `description`；把数据导入到这个项目；清空历史 |
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

升级到这一版时会自动迁移成员表，**不会有人被锁在门外**：

- 所有现有项目 × 所有现有用户，全部先设成 **editor**；
- 项目的创建者（`created_by`）升成 **owner**；之前 `legacy` 导入时写进去的 owner 原样保留；
- 还是没有 owner 的项目（比如没有创建者的老项目），由**最早创建的那个 admin** 担任 owner。

迁移之后新建的用户不会自动加入任何项目 —— 要手动把他加进来。
项目第一次被建出来时如果库里还没有任何用户（`apiloop init` 就是这种顺序），
下次启动会自动把这个项目交给最早创建的 admin。

## 数据存储

数据全部放在**一个全局库**里，默认 `~/.apiloop/data.db`，可用 `--db` 指定，
环境变量 `APILOOP_DB` 也可以（优先级：`--db` > `APILOOP_DB` > 默认值）。

用 Node 内置的 `node:sqlite`，**不需要安装任何依赖**，但要求 **Node 22.13 及以上**
（`node:sqlite` 自 22.5.0 提供，22.13.0 之前还需要 `--experimental-sqlite` 标志）。

### 项目与 URL

库里可以放多个项目，接口按项目隔离：

| 项目 | 挂在哪 |
| --- | --- |
| 根项目 | 根路径，例如 `http://localhost:8080/api/users` |
| 其他项目 | `/mock/<项目标识>`，例如 `http://localhost:8080/mock/my-app/api/users` |

根项目是给老用法留的。每个项目有自己的项目标识（slug）：目录名里的中文或特殊字符会
退化成 `p-` 加一段短码，重名会自动加 `-2`、`-3`。

哪个项目当根项目，按这个顺序决定：`--project` 指定 → 当前目录的旧配置导入 →
已有的默认项目 → 新建一个默认项目。

### 表结构

| 表 | 存什么 |
| --- | --- |
| `apis` | 接口定义：方法、路径、请求参数、鉴权、脚本、mock 开关、延时、跨域…… |
| `examples` | 示例响应：状态码、响应头、响应体。**一处数据两用** —— 调试时是保存下来的响应，mock 时就是返回的数据 |
| `folders` | 目录，支持嵌套；`position` 只在同一个父目录内部有意义 |
| `environments` | 环境（一组变量），发送请求时叠加在项目变量之上 |
| `history` | 发送记录，每个项目只保留最新 500 条 |
| `users` / `sessions` | 用户与登录态 |
| `projects` / `project_members` | 项目与成员；`project_members` 记谁在哪个项目里是什么角色（viewer / editor / owner） |
| `legacy_imports` | 记下哪些旧配置文件已经导入过，避免重复导入 |
| `mock_expectations` | mock 期望：按请求条件决定这个接口返回哪一份示例 |

`position` 只在同级内比较：同一个父目录下，先按 `position` 列子目录，
再按 `position` 列接口。

想直接看或改数据，用 `sqlite3` 命令行即可（改完服务会自动热更新）：

```bash
sqlite3 ~/.apiloop/data.db 'select position, method, mock_path from apis order by position'
```

### 接口字段

| 字段 | 说明 |
| --- | --- |
| `method` | `GET` `POST` `PUT` `DELETE` `PATCH` `HEAD` `OPTIONS` `ALL` |
| `path` | Express 风格，支持 `:id` 路径参数；不能以 `/__admin` 开头（管理台占用） |
| `status` | 100~599 |
| `delay` | 响应延时，毫秒 |
| `cors` | 打开后自动补 `Access-Control-Allow-*`，并处理 `OPTIONS` 预检 |
| `responseType` | `json` / `text` / `html` |
| `response` | 响应体模板，支持下面的占位符语法，**每个请求都会重新渲染** |
| `query` / `body` | 只是入参描述，用于文档和自测面板预填，不做强制校验 |
| `enabled` | 关掉后返回 404。**没有示例的接口不算启用** |

「导出 JSON」导出的仍是老的 `routes.json` 格式，可以直接拿去分享或留档，
也正是首次启动时能自动导入的那种格式。

## Mock 数据模板

写在 `response` 里，每次请求都会重新生成。

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

## 智能模板化

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
* 接口是纯计算、**不写库**：`POST /templatize`，body `{ body: string }`，
  返回 `{ body, replacements, skipped }`，`replacements` 列出每一处替换（`path` 形如 `data.list[0].phone`），
  前端拿它展示给用户确认。

## Mock 期望

同一个接口，按请求条件返回不同的示例。比如「`?id=404` 就返回 404 那份示例」
「带 `X-Role: admin` 就返回管理员数据」。这是「调通即 mock」的另一半：
示例是数据，期望是「什么时候用哪份数据」。

```json
{
  "name": "id 是 404",
  "exampleId": "e_xxx",
  "conditions": [{ "in": "query", "key": "id", "op": "eq", "value": "404" }]
}
```

* 一条期望里的多个条件是「且」的关系；多条期望按 `position` 依次检查，**第一条命中的生效**；
  一条都没命中，就用接口上默认示例（`mock.exampleId`）那份。
* `in`：`query` / `header` / `body` / `path`。
* `op`：`eq` / `ne` / `contains` / `regex` / `exists` / `notExists` / `gt` / `lt`。
* `header` 的 key 不区分大小写（`X-Role` 和 `x-role` 一样）。
* `body` 支持 `user.age` 这种嵌套取值，而且**只在请求体是 JSON 对象时才判断**：
  表单、纯文本、没有请求体一律不命中（`exists` / `notExists` 也一样）。
* `gt` / `lt` 按数字比较，任意一边不是数字就不命中。
* 期望指向的示例被删除时，这条期望会跟着消失。
* mock 响应多一个响应头 `X-Apiloop-Mock`，一眼看出命中的是哪一条：
  命中期望时是 `expectation:<期望名>`（名字经过 URL 编码），没命中是 `default`。

```bash
curl -i 'http://localhost:8080/api/users?id=404'
# X-Apiloop-Mock: expectation:id%20%E6%98%AF%20404
```

## Cookie 与代理

调试「先登录、再调业务接口」这类接口时，不用再手动从浏览器里复制 cookie。

**Cookie 是自动的**：发请求前从库里取出匹配的 cookie 放进请求头，响应里的 `Set-Cookie`
再写回库 —— 每一跳都这么做，所以「登录接口 302 跳转到首页」这种链路，跳过去的那一跳
就已经带上新 cookie 了。请求头里手写了 `Cookie` 时以手写的为准（整个请求都不再自动补），
但响应里的 `Set-Cookie` 照样写回库。不想要这一套时，在 `/send` 里传 `options.cookies: false`。

* **作用范围：每个用户在每个项目里各有一份，互相看不见。** cookie 往往就是登录凭证，
  同一个项目的两个成员登录的是不同账号，共用一份等于把两个人的登录态搅在一起。
* 匹配按 RFC 6265：`Domain` 和请求主机对得上、`Path` 是请求路径的前缀、`Secure` 的只能走
  https、过期的不再发送（并会从库里删掉，`Max-Age=0` 就是立即删除）。
  没写 `Domain` 的是 host-only，只发给完全相同的主机名。
* `Secure` 的 cookie 只走 https：http 响应里带 `Secure` 的 `Set-Cookie` 会被直接丢掉
  （中间人可能借此往你身上钉一个会话），http 响应也不能覆盖已有的同名 `Secure` cookie。

**历史记录里的打码**（历史是项目里所有成员都能看的，所以写进去之前先处理，
**返回给发送者本人的结果保持原样**）：

| 位置 | 处理 |
| --- | --- |
| 请求头 `Cookie` / `Authorization` / `Proxy-Authorization` | 值换成 `***` |
| 响应头 `Set-Cookie` | 保留 cookie 名和各项属性，只把值换成 `***`，例如 `sid=***; Path=/; HttpOnly` |
| 原始请求 `request.spec` | `params.headers` 里上面那三种请求头的值、`auth` 里的 token / password / value 换成 `***` |

`request.spec` 是「用户输入的原始请求」，**库里存的是完整原文**（发起人点重放要用），
只在 `GET /history/:id` 里按查看者区分：不是发起人（包括管理员）才看到打码后的版本。
另外，**响应体里的内容不做处理** —— 那是服务端回显回来的数据，我们无从判断里面
哪一段是凭据，看到什么就是什么。

**代理**支持 http 代理：目标是 http 时直接转发，目标是 https 时用 `CONNECT` 建隧道
（隧道里目标服务器的证书仍然按「是否校验证书」处理，隧道只解决怎么连过去）。
代理设置在「设置」里改，`GET /settings/proxy` 登录即可读、`PUT /settings/proxy` 只有
管理员能改。地址里的密码在任何输出里都是 `***`，提交时也填 `***` 表示「密码不变」。

* 默认值从环境变量 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` 读（大小写两种写法都认），
  只要读到任何一个就视为启用。**读到的默认值不会写进库** —— 否则以后改环境变量就不生效了。
* 地址只支持 `http://` 形式；`socks://`、`https://` 在保存时就返回 400。
* `noProxy` 用逗号分隔，每项可以是精确主机名、`.` 开头的后缀、`host:port`，或者 `*`（全部直连）。
  目标主机命中 noProxy 就直连，重定向之后换了主机也会重新判断。
* `/send` 里传 `options.proxy: false` 可以让这一次请求直连。
* 连不上代理、或者 `CONNECT` 返回的不是 2xx，错误码都是 `PROXY`（不会让请求「失败得很含糊」）。

### 已知限制

**不内置公共后缀列表**。`Domain` 那条规则只要求「至少含一个点」，所以 `Domain=co.uk`
这样的写法仍然会被放行 —— 而我们没有任何办法在本地判断 `co.uk` 是公共后缀。真要严格，
得带上几百 KB 的公共后缀表并持续更新，代价比收益大。自己控制的域名常规用不会有影响，
**不要把别人的响应直接当成可信数据导入**。

## 兼容手写 router.js

老的用法完全保留：当前目录存在 `router.js` 时照旧加载（`router` 就是 Express app）。

```javascript
router.get('/hello', function (req, res) {
  res.send({ status: 0, msg: 'hello hunger valley' })
})

router.use('/hi', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*')
  res.send('world')
})
```

两者可以共存：**先匹配数据库里的接口，没命中的再交给 `router.js`**。更多路由写法见 <http://expressjs.com/en/guide/routing.html>。

> 注意：`router.js` 里只写路由即可，不要自己套 `function setRouter(app){...}` 外壳。检测到已包装会打印 Warning 并按原样使用。

## 管理台 API

管理台前端用的就是这些接口，也可以直接调。**除登录接口外都需要先登录**，
请求要带上登录返回的 cookie。路径都省略前缀 `/__admin/api`，统一返回
`{ ok: true, ... }` 或 `{ ok: false, error: "..." }`。

字段名、状态码与各种规则的完整定义见 **[管理台接口 v2 契约](docs/design/2026-09-30-admin-api-v2.md)**，
下面只列路径与一句话说明。

### 登录与用户

| 方法与路径 | 说明 |
| --- | --- |
| `POST /auth/login` | 登录，body `{username, password}`，成功种 cookie。**公开** |
| `POST /auth/logout` | 退出 |
| `GET /auth/me` | 当前登录用户 |
| `PUT /auth/password` | 改密码，body `{oldPassword, newPassword}` |
| `GET /users` | 用户列表。仅管理员 |
| `GET /users/lookup?q=` | 搜人（按用户名或显示名模糊匹配，最多 20 条，不含被禁用的）。登录即可，加项目成员时用 |
| `POST /users` | 新建用户；没传密码会随机生成并在响应里返回一次。仅管理员 |
| `PUT /users/:id` | 改显示名 / 角色 / 禁用。仅管理员 |
| `POST /users/:id/reset-password` | 重置密码并返回一次。仅管理员 |
| `DELETE /users/:id` | 删除用户。仅管理员 |

### 项目（契约第 2 节）

| 方法与路径 | 说明 |
| --- | --- |
| `GET /projects` | 项目列表；只返回自己参与的项目（admin 返回全部） |
| `POST /projects` | 新建项目；任何登录用户都可以，创建者自动成为 owner |
| `GET /projects/:pid` | 项目详情，`:pid` 可以是 id 或 slug |
| `PUT /projects/:pid` | 改描述 / 变量 / 鉴权要 editor；改名字 / 标识要 owner。标识被占用会报错，不自动改名 |
| `DELETE /projects/:pid` | 删除项目。owner；根项目与默认项目不能删 |
| `GET /projects/:pid/members` | 成员列表。viewer |
| `PUT /projects/:pid/members/:userId` | 加成员或改角色。owner；不是成员就加进来 |
| `DELETE /projects/:pid/members/:userId` | 移除成员。owner，或者自己退出 |

### 目录树、接口与示例（契约第 3 节）

| 方法与路径 | 说明 |
| --- | --- |
| `GET /projects/:pid/tree` | 整棵树，返回扁平的目录与接口列表，前端自己组装 |
| `POST /projects/:pid/folders` | 新建目录，同一父目录下不允许重名 |
| `PUT /folders/:id` | 改名字 / 描述 / 鉴权 / 变量 |
| `DELETE /folders/:id?apis=move\|delete` | 删目录。`move`（默认）把内容移到父目录，`delete` 递归删 |
| `POST /projects/:pid/move` | 移动目录或接口到指定位置，并重排 position；移进自己的子孙会被拒 |
| `GET /apis/:id` | 接口详情（含请求定义、mock 配置、全部示例） |
| `POST /projects/:pid/apis` | 新建接口 |
| `PUT /apis/:id` | 更新接口；改 url 时 `mock.path` 的跟随规则、开启 mock 的前提见契约 |
| `DELETE /apis/:id` | 删除接口 |
| `POST /apis/:id/duplicate` | 复制接口（示例整份复制，名字加「 副本」） |
| `POST /apis/:id/examples` | 新增示例；这是第一个示例时会自动成为 mock 用的那条 |
| `PUT /examples/:id` | 更新示例 |
| `DELETE /examples/:id` | 删除示例；删掉 mock 正在用的那条会自动改指或关掉 mock |
| `POST /projects/:pid/import/routes` | 把解析出来的 route 批量落进项目，可指定目录 |

### 环境（契约第 4 节）

| 方法与路径 | 说明 |
| --- | --- |
| `GET /projects/:pid/environments` | 环境列表 |
| `POST /projects/:pid/environments` | 新建环境 |
| `PUT /environments/:id` | 改名字 / 变量 |
| `DELETE /environments/:id` | 删除环境 |

> 「当前选中哪个环境」由前端存在 localStorage，服务端不存。

### 发送、历史与文件（契约第 5 节）

| 方法与路径 | 说明 |
| --- | --- |
| `POST /projects/:pid/send` | 由服务端代发请求，返回执行结果并写一条历史；浏览器断开时取消在途请求 |
| `GET /projects/:pid/history` | 历史列表，`?limit=50&before=<id>` 翻页，`limit` 最大 200 |
| `GET /history/:id` | 历史详情（原始的请求定义 + 完整执行结果） |
| `DELETE /projects/:pid/history` | 清空该项目的历史 |
| `POST /projects/:pid/files` | 上传文件（`application/octet-stream` + `X-Filename`），返回服务端绝对路径 |

### Postman 导入导出（契约第 6 节）

| 方法与路径 | 说明 |
| --- | --- |
| `POST /import/postman/preview` | 解析并统计，不写库 |
| `POST /import/postman` | 导入 collection / environment / globals；整个导入是一个事务 |
| `GET /projects/:pid/export/postman` | 导出成 Postman Collection |
| `GET /environments/:id/export/postman` | 导出成 Postman Environment |

### Mock 期望与智能模板化（契约第 8、9 节）

| 方法与路径 | 说明 |
| --- | --- |
| `POST /templatize` | 把 JSON 文本模板化（纯计算，不写库），返回 `{ body, replacements, skipped }` |
| `POST /apis/:id/expectations` | 新增期望；`exampleId` 必须是这个接口自己的示例 |
| `PUT /expectations/:id` | 改名字 / 启用状态 / 条件 / 所指示例 |
| `DELETE /expectations/:id` | 删除期望，返回更新后的接口 |
| `POST /apis/:id/expectations/reorder` | 按 `{ ids: [...] }` 重排期望顺序 |
| `GET /apis/:id` | 响应里带 `expectations`，按 `position` 排序 |

### Cookie（契约第 12 节）

| 方法与路径 | 说明 |
| --- | --- |
| `GET /projects/:pid/cookies` | 列出**自己**在这个项目里的 cookie；已过期的不返回（并顺手从库里删掉） |
| `POST /projects/:pid/cookies` | 手动新增或更新一条；按 `domain + path + name` 定位。`domain` 以 `.` 开头是域 cookie，否则 host-only |
| `DELETE /cookies/:id` | 删一条自己的。不是自己的、与不存在，都是同一个 404「Cookie不存在」 |
| `DELETE /projects/:pid/cookies?domain=` | 清空自己在这个项目下的 cookie；带 `domain` 时只清这个域名的 |

> 每个用户在每个项目里各有一份，接口里没有任何一处能看到别人的。规则见
> [Cookie 与代理](#cookie-与代理)。

### 系统设置（契约第 12 节）

| 方法与路径 | 说明 |
| --- | --- |
| `GET /settings/proxy` | 读取代理设置。登录即可，地址里的密码显示为 `***` |
| `PUT /settings/proxy` | 修改代理设置。**仅管理员**；密码提交 `***` 表示不变 |

### Mock 调用日志（契约第 11 节）

| 方法与路径 | 说明 |
| --- | --- |
| `GET /projects/:pid/mock-log?after=<seq>&limit=100` | 最近打到这个项目 mock 上的请求，按 `seq` 升序；`limit` 默认 100、最大 200。viewer |
| `DELETE /projects/:pid/mock-log` | 清空该项目的日志（只清内存）。editor |

联调时最常问的一句话是「我明明发了请求，怎么没反应」。日志回答的就是它：每条记下完整
原始地址（含 `/mock/<slug>` 前缀与查询串）、查询参数、请求头、请求体预览、命中了哪个
接口的哪条期望（`matched: null` 表示在 `/mock/<slug>` 下根本没有命中，这正是地址写错、
slug 拼错时最需要看到的）、状态码与耗时。请求头里的 `Authorization`、`Cookie`、
`Proxy-Authorization` 一律打码成 `***`，请求体与响应体各只留前 4KB。

**日志只存在内存里**：每个项目保留最近 200 条，服务重启后清空；多个进程共用同一个库时，
各自只记录打到自己端口上的请求。前端每 2 秒带 `after=上次返回的 lastSeq` 轮询一次，
只拿新增的记录。

### 元信息与纯解析

| 方法与路径 | 说明 |
| --- | --- |
| `GET /meta` | 占位符、字段类型、响应模板、方法列表、当前用户与根项目、mock 前缀 |
| `POST /preview` | 渲染一次响应体，返回 warnings 和 JSON 校验结果 |
| `POST /import/curl` | 解析 cURL |
| `POST /import/openapi` | 解析 OpenAPI / Swagger |

### 旧版管理台专用（**P2 之后移除**）

这几个接口只作用于根项目，是给尚未迁移的旧版页面用的，新版管理台不再调用：

| 方法与路径 | 说明 |
| --- | --- |
| `GET /routes` | 全部接口配置 |
| `POST /routes` | 新建 |
| `PUT /routes/:id` | 更新 |
| `DELETE /routes/:id` | 删除 |
| `POST /routes/:id/duplicate` | 复制 |
| `GET /groups` | 分组列表（含每个分组的接口数） |
| `POST /groups` | 新建分组，body `{ name }` |
| `PUT /groups/:name` | 重命名分组，body `{ name }`，该分组下接口一起改名 |
| `DELETE /groups/:name` | 删除分组；默认把接口移到未分组，加 `?routes=delete` 则连接口一起删 |
| `POST /groups/reorder` | 调整分组顺序，body `{ names: [...] }`，只传部分分组也可以 |
| `POST /import/routes` | 批量落库（旧版，作用于根项目；新版用 `POST /projects/:pid/import/routes`） |
| `GET /export` | 导出 routes.json |

## 开发与测试

```bash
npm test
```

82 个用例，覆盖模板引擎与 JSON 容错、cURL / OpenAPI 导入、配置存储与热更新、旧配置迁移、分组管理、登录与用户管理、mock 按项目挂载、管理台 API、以及 CLI 端到端（`init` / `web` / `start` / 端口占用 / 帮助信息）。

按项目约定**不新增测试**：管理台接口 v2 的每一批改动都用一次性脚本自测完即删，
覆盖范围写在对应的提交信息里。既有的 82 个用例每个 Task 结束都必须全绿。

测试一律用 `--db` 指到临时目录，**不会碰真实的 `~/.apiloop`**。

## 目录结构

```
bin/server            CLI 入口（yargs 17）
lib/app-info.js       产品名、数据目录、cookie 名等常量（改名只动这里）
lib/command.js        start / open / web / init / user 命令实现
lib/db/               全局库：连库、迁移、事务、变更广播（node:sqlite，零依赖）
lib/db/repos/         各表的增删改查
lib/api/              管理台接口 v2，按资源拆：projects / environments / tree / send / postman / expectations / members / mock-log / cookies / settings / templatize
lib/api/guard.js      项目权限中间件：guard(level, locate)，判定逻辑在 lib/access.js
lib/api/respond.js    接口的响应约定（ok / fail / wrap / notFound）
lib/api/dto.js        repo 行 → 接口 DTO，以及入参清洗
lib/access.js         项目权限判定：角色是什么、资源属于哪个项目
lib/cookies.js        Cookie 的解析、匹配与内存 jar（纯函数，now 由调用方传）
lib/proxy-settings.js 代理设置：存 meta 表，没有设置时从环境变量现算
lib/tree.js           目录树业务逻辑：移动、删除目录、复制接口、树的读取与写入
lib/routes-store.js   单个项目的门面（对外 API 与老版本一致，供旧版管理台使用）
lib/project-stores.js 每个项目只建一个 store 实例，缓存复用
lib/mock-host.js      按项目挂载 mock：根路径 + /mock/<slug>
lib/auth.js           密码哈希、会话、登录中间件、初始管理员
lib/admin-auth.js     /auth/* 与 /users/* 接口
lib/admin.js          管理台后端：挂载 v2 接口、旧版接口与静态页
lib/legacy-import.js  把目录里的旧配置导入成项目
lib/legacy/           只读的 P0 格式库读取器
lib/mock-engine.js    模板渲染与随机数据生成
lib/mock-runtime.js   把配置编译成 Express 路由，支持热更新，并做 mock 期望的匹配
lib/mock-log.js       Mock 调用日志：按项目存的内存环形缓冲，每个项目 200 条
lib/templatize.js     智能模板化：把真实响应换成「结构不变、值随机」的占位符模板（纯函数）
lib/importers.js      cURL / OpenAPI(Swagger) 解析
lib/executor.js       请求执行器：由服务端代发真实 HTTP 请求
lib/postman.js        Postman 集合 / 环境的解析与生成
lib/variables.js      变量替换（{{name}}），与 mock 占位符 {{@xxx}} 区分
lib/url-utils.js      URL 拼装与 mock 路径推导
lib/web/              管理台前端（零构建：index.html + app.js + style.css）
sample/               `apiloop init` 用的示例文件
test/                 node:test 测试
```

## License

ISC
