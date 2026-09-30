# P5「调通即 mock」后端实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **本项目约定（覆盖 skill 默认做法）**：**不写新测试**；既有的 `npm test` 必须全部通过。自测用一次性脚本，跑完删掉。**只提交自己的文件**：`git commit -m ... -- <文件>`，因为 P2 会话还在同一个工作区里做前端。

**目标**：做两件事。
1. 录制下来的真实响应，能一键变成「每次请求都随机、但结构和类型不变」的 mock 模板。
2. 同一个接口，可以按请求条件返回不同的示例。

**架构**：
- 模板化是一个纯函数模块 `lib/templatize.js`，外面包一个不写库的接口。
- 期望匹配分三块：数据读写放在 `lib/db/repos/expectations.js`；接口放在 `lib/api/expectations.js`；运行时的匹配放在 `lib/mock-runtime.js`，由 `routes-store` 在读取路由时把期望一起带上。

**技术栈**：沿用现有技术，不新增依赖。

**依据**：接口契约 [docs/design/2026-09-30-admin-api-v2.md](../../design/2026-09-30-admin-api-v2.md) 的**第 8、9 节**。路径、字段、状态码、匹配规则都以契约为准。

## 全局约束

- **文件范围**：只改 `lib/**`（`lib/web` 除外）、`test/**`、`README.md`。
- **写库必须带 `projectId`**：所有写操作都要带上正确的 `projectId`，否则 mock 运行时不会刷新。
- **运行时匹配出错不能影响正常返回**：期望匹配是在每个 mock 请求上都跑的代码。任何异常都必须在内部接住，接住后退回默认示例，不能让一次匹配失败把整个 mock 响应拖垮。上一轮修掉的进程崩溃问题，不能从这里重新带回来。

## 审阅重点

1. **模板化后的类型必须和原来一致**：原来是数字的，渲染后仍是数字；原来是字符串的，仍是字符串；数组仍是数组，对象仍是对象。凡是替换后渲染出来不是合法 JSON 的，必须退回原文，并在 `skipped` 里说明原因。
2. **不能替换带业务含义的值**：`{"code":0,"msg":"ok","success":true,"data":{"status":"PAID","page":1,"pageSize":20}}` 模板化之后应该**一个都不换**。
3. **期望匹配的边界情况**：
   - 请求体不是 JSON（比如表单、纯文本、没有请求体）时，`body` 条件一律不命中，不能报错；
   - header 的 key 大小写不同时也要能匹配上；
   - `gt` 遇到非数字时不命中；
   - 期望所指的示例被删除后，这条期望要跟着消失，运行时不能报错。
4. **同一个接口的期望改动后，mock 立即生效**：改的是期望这张表，但同样要带上 `projectId` 触发刷新。

---

### Task 1: 智能模板化

**文件**：新建 `lib/templatize.js`；在 `lib/admin.js` 或新建的 `lib/api/templatize.js` 里挂 `POST /templatize`。

**接口**：`templatize(text: string) -> { body, replacements: [{ path, from, placeholder }], skipped: string|null }`

- [ ] **Step 1: 替换规则**

  只替换**叶子节点**，也就是字符串和数字；布尔值和 null 一律保留原样。判断顺序是**先看 key 保护名单，再看 key 名，最后看值的形态**。key 名匹配时不区分大小写，并忽略下划线和连字符，所以 `created_at`、`createdAt`、`CreatedAt` 视为同一个 key。

  1. **保护名单，命中就不换**：`code`、`msg`、`message`、`success`、`errno`、`errcode`、`errmsg`、`status`、`state`、`type`、`kind`、`level`、`page`、`pagesize`、`pagenum`、`size`、`limit`、`offset`、`total`、`count`、`version`、`currency`、`lang`、`locale`、`gender`、`sex`，以及所有以 `is` 或 `has` 开头的 key。
  2. **按 key 名替换**（命中第一条就停）：

     | key 名匹配（去掉下划线和连字符、转成小写后） | 值的条件 | 换成 |
     | --- | --- | --- |
     | `id` 或以 `id` 结尾 | 整数 | `{{@id}}` |
     | `id` 或以 `id` 结尾 | 形如 uuid | `{{@uuid}}` |
     | 包含 `phone`、`mobile`，或等于 `tel` | 任意 | `{{@phone}}` |
     | 包含 `email`，或等于 `mail` | 任意 | `{{@email}}` |
     | 等于 `name`、`username`、`nickname`、`realname`、`cname`、`fullname` | 含中文 | `{{@cname}}` |
     | 同上 | 不含中文 | `{{@ename}}` |
     | 包含 `avatar`、`image`、`img`、`pic`、`photo`、`cover`、`thumb` | 字符串 | `{{@image(200x200)}}` |
     | 包含 `url`、`link`、`href`、`website` | 字符串 | `{{@url}}` |
     | 等于 `city` / `province` | 字符串 | `{{@city}}` / `{{@province}}` |
     | 包含 `address` 或等于 `addr` | 字符串 | `{{@address}}` |
     | 包含 `company` | 字符串 | `{{@company}}` |
     | 等于 `job` 或 `position`（值是字符串时） | 字符串 | `{{@job}}` |
     | 等于 `title` | 字符串 | `{{@title}}` |
     | 包含 `desc`、`content`、`remark`、`summary`、`intro` | 字符串，长度大于 30 | `{{@paragraph}}` |
     | 同上 | 字符串，长度不大于 30 | `{{@sentence}}` |
     | 包含 `price`、`amount`、`money`、`fee`、`cost` | 数字 | `{{@price(1,999)}}` |
     | 包含 `token` | 字符串 | `{{@token}}` |
     | 等于 `ip` | 字符串 | `{{@ip}}` |
     | 包含 `color` | 以 `#` 开头 | `{{@color}}` |

  3. **按值的形态替换**（key 名没有命中时）：
     - `YYYY-MM-DD HH:mm:ss` 或 ISO 格式 → `{{@datetime}}`
     - `YYYY-MM-DD` → `{{@date}}`
     - 13 位整数，且 key 包含 `time` 或 `at` → `{{@timestamp}}`
     - 手机号格式 → `{{@phone}}`
     - 邮箱格式 → `{{@email}}`
     - uuid 格式 → `{{@uuid}}`
     - http(s) 地址且以 `.png`、`.jpg`、`.jpeg`、`.gif`、`.webp` 结尾 → `{{@image(200x200)}}`
  4. **其他情况一律不换。**
- [ ] **Step 2: 数组的处理**
  - 元素全是对象、并且长度 ≥ 2 的数组：只模板化第一个元素，然后用 `{{@repeat(n)}}…{{/repeat}}` 包起来，n 等于原数组的长度，最多 20。
  - `replacements` 只记第一个元素里的替换，path 写成 `list[0].xxx`。
  - 其他数组（元素是基本类型，或者只有一个元素）：递归处理每个元素，不用 repeat 包裹。
- [ ] **Step 3: 输出格式**
  - 自己写序列化，缩进 2 个空格。占位符一律输出成 `"{{@xxx}}"`：数值类占位符用引号包住，引擎渲染时会去掉引号，保持数字类型。
  - repeat 块的写法参照 `routes-store.createSampleRoutes` 里的示例：`[\n{{@repeat(3)}}    {...}\n{{/repeat}}  ]`。
  - **最后做一次自检**：用 `engine.render` 渲染一次，再用 `engine.repairJson` 修复，然后 `JSON.parse`。解析失败就返回原文，`skipped` 写「模板化后不是合法 JSON，已保持原样」。
- [ ] **Step 4: 接口**：`POST /templatize`，只要求登录，用 `respond.wrap`。body 不是字符串时返回 400。
- [ ] **Step 5: 自测**：用一次性脚本，至少覆盖这几种输入：
  - 审阅重点第 2 条那个例子，结果应该**零替换**；
  - 一个典型的用户列表：`{"code":0,"data":{"list":[{"id":1,"name":"张三","phone":"13800138000","avatar":"https://x/a.png","createdAt":"2026-01-01 10:00:00"}, ...共 3 个]}}`；
  - 非 JSON 文本；
  - 顶层就是数组的 JSON。

  每种都要确认：渲染后是合法 JSON，各字段类型和原来一致。
- [ ] **Step 6**：`npm test` 全部通过后提交：`feat: 智能模板化`

---

### Task 2: 期望的读写与接口

**文件**：新建 `lib/db/repos/expectations.js`、`lib/api/expectations.js`；修改 `lib/api/dto.js`（Api DTO 带上 `expectations`）、`lib/admin.js`（挂载新接口）。

- [ ] **Step 1: repo**
  - `listByApi(h, apiId)`、`get`、`insert(h, apiId, { name, enabled, conditions, exampleId, position? })`（id 前缀 `x`）、`update`、`remove`、`setPositions(h, orderedIds)`。
  - 表在 v1 迁移里已经建好了，**不需要新的迁移**。
- [ ] **Step 2: 接口**：按契约第 9 节实现。
  - 条件的清洗：
    - `in`、`op` 不在枚举范围内 → 400；
    - key 为空 → 400（所有操作都要求 key，包括 `exists` / `notExists`）；
    - `regex` 用 `new RegExp(value)` 校验，失败 → 400「正则不合法：…」。
  - `exampleId` 必须属于这个接口，否则返回 400。
  - 所有写操作的事务都带上该接口的 `projectId`。
- [ ] **Step 3**：`npm test` 全部通过后提交：`feat(api): mock 期望的增删改与排序`

---

### Task 3: 运行时匹配

**文件**：修改 `lib/routes-store.js`（`readRoutes`）、`lib/mock-runtime.js`；修改 `lib/mock-engine.js`，把已有的 `readInput` 导出（嵌套取值要用它）。

- [ ] **Step 1**：`readRoutes` 给每条 route 增加一个字段 `expectations: [{ name, conditions, status, headers, responseType, response }]`：只取 enabled 的、按 position 排好的期望，并把每条期望所指示例的内容展开进来。旧版 UI 会忽略这个多出来的字段，不影响它。
- [ ] **Step 2**：在 `mock-runtime.js` 里新增 `matchExpectation(expectations, req) -> expectation|null`：
  - 按契约第 9 节的规则逐条检查；
  - 整个函数包在 try/catch 里，出错就返回 null，并 `console.warn`（同样的报错只打印一次）。
  - 取值来源：
    - `query`：`req.query`
    - `header`：`req.headers`，key 转成小写再取
    - `body`：`req.body` 是对象时用 `engine.readInput(req.body, key)` 取值；不是对象时视为取不到
    - `path`：`req.params`
- [ ] **Step 3**：`createHandler` 在 `send` 里先调 `matchExpectation`：
  - 命中时，用期望的 `status`、`headers`、`responseType`、`response` 代替路由上的默认值，其余逻辑不变；
  - 设置响应头 `X-Apiloop-Mock`，值按契约规定。
- [ ] **Step 4: 自测**：给一个接口配三条期望，分别对应 `query id=404`、`header x-role eq admin`、`body user.age gt 18`，外加一个默认示例；用 fetch 逐条请求，确认命中的示例正确、`X-Apiloop-Mock` 的值正确；审阅重点第 3 条的几种边界情况逐条验证。
- [ ] **Step 5**：`npm test` 全部通过后提交：`feat: mock 期望的运行时匹配`

---

### Task 4: README

- [ ] 在 README 的「Mock 数据模板」一章之后新增两节：「智能模板化」和「Mock 期望」。每节用一段话说明是什么，加一个例子。接口表也补上这几个新接口。
- [ ] `npm test` 全部通过后提交：`docs: README 补充智能模板化与 mock 期望`

## 完成后回报

- 每个 Task 的提交号；
- Task 1 自测时各种输入的替换结果（贴出 replacements 列表），方便我判断规则是否太激进或太保守。
