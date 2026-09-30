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
| `apis` | 接口定义：方法、路径、mock 开关、延时、跨域…… |
| `examples` | 示例响应：状态码、响应头、响应体。**一处数据两用** —— 调试时是保存下来的响应，mock 时就是返回的数据 |
| `folders` | 分组（对应管理台侧边栏的分组，重命名会自动同步组内接口） |
| `users` / `sessions` | 用户与登录态 |
| `projects` / `project_members` | 项目与成员 |
| `legacy_imports` | 记下哪些旧配置文件已经导入过，避免重复导入 |
| `environments` / `history` / `mock_expectations` | 已建表，留给后续版本 |

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
请求要带上登录返回的 cookie：

登录与用户：

| 方法与路径 | 说明 |
| --- | --- |
| `POST /__admin/api/auth/login` | 登录，body `{username, password}`，成功种 cookie。**公开** |
| `POST /__admin/api/auth/logout` | 退出 |
| `GET /__admin/api/auth/me` | 当前登录用户 |
| `PUT /__admin/api/auth/password` | 改密码，body `{oldPassword, newPassword}` |
| `GET /__admin/api/users` | 用户列表 |
| `POST /__admin/api/users` | 新建用户；没传密码会随机生成并在响应里返回一次 |
| `PUT /__admin/api/users/:id` | 改显示名 / 角色 / 禁用 |
| `POST /__admin/api/users/:id/reset-password` | 重置密码并返回一次 |
| `DELETE /__admin/api/users/:id` | 删除用户 |

其余接口（**都需要登录**）：

| 方法与路径 | 说明 |
| --- | --- |
| `GET /__admin/api/meta` | 占位符、字段类型、响应模板、方法列表、配置路径 |
| `GET /__admin/api/routes` | 全部接口配置 |
| `POST /__admin/api/routes` | 新建 |
| `PUT /__admin/api/routes/:id` | 更新 |
| `DELETE /__admin/api/routes/:id` | 删除 |
| `POST /__admin/api/routes/:id/duplicate` | 复制 |
| `GET /__admin/api/groups` | 分组列表（含每个分组的接口数） |
| `POST /__admin/api/groups` | 新建分组，body `{ name }` |
| `PUT /__admin/api/groups/:name` | 重命名分组，body `{ name }`，该分组下接口一起改名 |
| `DELETE /__admin/api/groups/:name` | 删除分组；默认把接口移到未分组，加 `?routes=delete` 则连接口一起删 |
| `POST /__admin/api/groups/reorder` | 调整分组顺序，body `{ names: [...] }`，只传部分分组也可以 |
| `POST /__admin/api/preview` | 渲染一次响应体，返回 warnings 和 JSON 校验结果 |
| `POST /__admin/api/import/curl` | 解析 cURL |
| `POST /__admin/api/import/openapi` | 解析 OpenAPI / Swagger |
| `POST /__admin/api/import/routes` | 批量落库 |
| `GET /__admin/api/export` | 导出 routes.json |

统一返回 `{ ok: true, ... }` 或 `{ ok: false, error: "..." }`。

## 开发与测试

```bash
npm test
```

82 个用例，覆盖模板引擎与 JSON 容错、cURL / OpenAPI 导入、配置存储与热更新、旧配置迁移、分组管理、登录与用户管理、mock 按项目挂载、管理台 API、以及 CLI 端到端（`init` / `web` / `start` / 端口占用 / 帮助信息）。

测试一律用 `--db` 指到临时目录，**不会碰真实的 `~/.apiloop`**。

## 目录结构

```
bin/server            CLI 入口（yargs 17）
lib/app-info.js       产品名、数据目录、cookie 名等常量（改名只动这里）
lib/command.js        start / open / web / init / user 命令实现
lib/db/               全局库：连库、迁移、事务、变更广播（node:sqlite，零依赖）
lib/db/repos/         各表的增删改查
lib/routes-store.js   单个项目的门面（对外 API 与老版本一致）
lib/project-stores.js 每个项目只建一个 store 实例，缓存复用
lib/mock-host.js      按项目挂载 mock：根路径 + /mock/<slug>
lib/auth.js           密码哈希、会话、登录中间件、初始管理员
lib/admin-auth.js     /auth/* 与 /users/* 接口
lib/admin.js          管理台后端 API 与静态页
lib/legacy-import.js  把目录里的旧配置导入成项目
lib/legacy/           只读的 P0 格式库读取器
lib/mock-engine.js    模板渲染与随机数据生成
lib/mock-runtime.js   把配置编译成 Express 路由，支持热更新
lib/importers.js      cURL / OpenAPI(Swagger) 解析
lib/web/              管理台前端（零构建：index.html + app.js + style.css）
sample/               `apiloop init` 用的示例文件
test/                 node:test 测试
```

## License

ISC
