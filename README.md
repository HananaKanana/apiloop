# server-mock

启动一个 Web 服务器并 mock 数据，写法参考 Express，另外内置一个**可视化管理台**——不写代码也能配出接口。

## 安装

```bash
npm install -g server-mock
# 或者从本仓库安装
npm install -g .
```

## 快速开始

```bash
mkdir demo && cd demo
mock init      # 生成示例 router.js 和示例数据库 routes.db
mock web       # 启动服务并打开管理台
```

打开 <http://localhost:8080/index.html> 就能在页面上增删改接口，保存后立即生效，不用重启。直接访问 <http://localhost:8080> 会自动跳到这个页面。

也可以完全不用管理台，直接跑 `mock start`，它读的是同一个数据库。

## 命令

| 命令 | 作用 |
| --- | --- |
| `mock web` | 启动服务 + 可视化管理台（默认入口 `/index.html`） |
| `mock start` | 只启动服务（也读同一个数据库） |
| `mock open` | 启动服务并自动打开目录里的 html |
| `mock init` | 生成示例文件：`router.js` 和示例数据库 `routes.db` |

通用参数：

```bash
mock web --port 3000              # 端口，默认 8080
mock web --public public          # 静态目录，默认当前目录
mock web --views views            # 模板目录，默认当前目录
mock web --tpl ejs                # 模板引擎，默认 ejs
mock web --config mock/routes.db   # 接口数据库文件，默认当前目录的 routes.db
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

## 数据存储

管理台的所有配置都存进一个 SQLite 库文件，默认是当前目录的 `routes.db`，可用 `--config` 指定。

用的是 Node 内置的 `node:sqlite`，**不需要安装任何依赖**，但要求 **Node 22.13 及以上**
（`node:sqlite` 自 22.5.0 提供，22.13.0 之前还需要 `--experimental-sqlite` 标志）。

库里三张表：`routes` 存接口、`groups` 存分组名与顺序、`meta` 存格式版本。

### 从老的 routes.json 迁移

`routes.db` **不存在**时，如果同目录下有 `routes.json`，首次启动会自动把它导进去，
原 JSON 保留不删，启动日志里会说明导入了哪份文件。库里已经有数据就不会重复导入。

想直接看或改数据，用 `sqlite3` 命令行即可（改完服务会自动热更新）：

```bash
sqlite3 routes.db 'select position, method, path from routes order by position'
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

`groups` 表里存的是分组的名字与顺序，决定侧边栏里分组的名字和顺序。它可以为空，
也可以包含还没有接口的分组；接口上只要写了新分组名，会自动登记进来。

「导出 JSON」导出的就是老的 `routes.json` 格式，可以直接拿去分享或留档，也是首次启动时能自动导入的那种格式。

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

管理台前端用的就是这些接口，也可以直接调：

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

79 个用例，覆盖模板引擎与 JSON 容错、cURL / OpenAPI 导入、配置存储与热更新、旧配置迁移、分组管理、管理台 API、以及 CLI 端到端（`init` / `web` / `start` / 端口占用 / 帮助信息）。

## 目录结构

```
bin/server            CLI 入口（yargs 17）
lib/command.js        start / open / web / init 命令实现
lib/db.js             SQLite 持久化（node:sqlite，零依赖）
lib/routes-store.js   配置读写、校验、分组管理、文件监听
lib/mock-engine.js    模板渲染与随机数据生成
lib/mock-runtime.js   把配置编译成 Express 路由，支持热更新
lib/importers.js      cURL / OpenAPI 解析
lib/admin.js          管理台后端 API
lib/web/              管理台前端（零构建：index.html + app.js + style.css）
sample/               mock init 用的示例文件
test/                 node:test 测试
```

## License

ISC
