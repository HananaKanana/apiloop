# P3/P4 核心审阅意见（第 1 轮）

> 审阅范围：`lib/variables.js`、`lib/url-utils.js`、`lib/executor.js`、`lib/postman.js`，对应提交 a3fd436、f32ee63、48c058a。另外，Task 4 的导出代码被 P1 会话的提交 33f9223 一起带了进去，见文末「流程问题」。
> 审阅方式：顺着调用链读代码，用一次性脚本起本地 HTTP 服务实际验证（脚本已删）。`npm test` 82 个用例全部通过，没有改动计划以外的文件。

## 总体评价

质量高，修完下面 2 个必修项即可。

- **变量替换**：`{{@...}}` 原样保留，缺失的变量去重记录，内置动态变量每次重新生成，都符合计划。
- **URL 处理**：已编码的 `%xx` 不会被二次编码，`host:8080` 里的端口号不会被误当成路径参数。
- **执行器**：
  - 每个请求用独立连接，计时准确；
  - 超时或取消时「先记下结果，再销毁请求」，顺序正确；
  - 大响应截断后仍会读完，`size` 记录的是真实大小；
  - 二进制响应用 base64 返回；
  - `headersToObject` 那条「http.request 的 headers 只能传对象」的注释很有价值。
- **Postman 解析**：各种不规范写法都能兜住，v2.0 和 v2.1 的鉴权写法都能识别，识别到 v1 格式有清楚的提示。

---

## 必修

### M1. 执行器在请求头不合法时会 reject，违反「永远 resolve」的约定

- **位置**：`lib/executor.js:417`。`transport.request(...)` 遇到不合法的请求头名或值时会**同步抛错**，抛在 Promise 的执行函数里，于是整个 Promise 变成 reject。
- **实测**：
  - 请求头 `X-Name: 张三` → reject，错误码 `ERR_INVALID_CHAR`；
  - `auth: { type: 'apikey', key: '' }` → reject，错误码 `ERR_INVALID_HTTP_TOKEN`。
- **影响**：国内用户在请求头里写中文值很常见。接入管理台后，这会变成接口里一个没被捕获的异常。
- **修法**：
  1. **发送前逐条校验。** 组装好 `headerList` 后，用 Node 自带的 `http.validateHeaderName` / `http.validateHeaderValue` 逐条检查。不合法时返回新增的错误码 **`INVALID_HEADER`**，错误信息要写明是哪个请求头，比如：「请求头 X-Name 的值含有 HTTP 不允许的字符（非 ASCII 字符需要先编码）」。这个错误码是我同意新增的，扩充到 `ExecResult.error.code` 的取值里。
  2. **apikey 的 key 为空时**，放 header 和放 query 两种情况都不加，和放 query 时的现有行为保持一致。
  3. **兜底**：把 `transport.request(...)` 包进 try/catch，捕获到的异常走 `fail(mapErrorCode(err.code), err.message)`。

### M2. 跨主机重定向时会把凭据带给第三方

- **位置**：`lib/executor.js:456-478`。
- **实测**：请求 A 主机带 `Bearer SECRET`，A 返回 302 跳到 B 主机，B 收到了 `Authorization: Bearer SECRET`。
- **修法**：重定向时比较新旧地址的「协议 + 主机名 + 端口」。只要有一项不同，就从后续请求头里去掉 `Authorization`、`Cookie`、`Proxy-Authorization`（不区分大小写）。curl 和 Node 自带的 fetch 都是这么做的。
  - **顺带**：因为 303 等情况丢弃请求体、改成 GET 时，`Content-Type` 也要一起去掉。

---

## 建议修（这一轮一起改掉）

### S1. `extra` 把不同层的字段混在一个包里，导出时会放错层

- **实测**：
  - Postman 导出里的 `info._exporter_id`、`info._collection_link`（现代导出几乎都有这两个字段），导出后跑到了**顶层**；
  - 接口里除了 `proxy` / `certificate` 以外的未知 request 字段，导出后跑到了 item 上。
- **为什么自测没发现**：「解析 → 导出 → 再解析」比较两次解析结果，再解析时这些字段又合回了同一个包，结果看起来相等，但实际的 Postman 文件结构已经变了。
- **修法**：`extra` 按来源分层保存，不再合并：
  - 集合：`extra = { root: {...}, info: {...} }`；
  - 接口：`extra = { item: {...}, request: {...} }`；
  - 文件夹：只有一层，保持平铺。
  - 导出时各回各层。`INFO_EXTRA_KEYS` 和 `REQUEST_EXTRA_KEYS` 这两个硬编码列表可以删掉。
  - 现在还没有数据落库，改结构没有任何迁移成本。

### S2. 示例的 `originalRequest`、`cookie`、`responseTime`、`id` 等字段在往返中丢失

- **修法**：`toExamples` 给每个示例加上 `extra`，内容是除 `name / code / status / header / body` 以外的所有字段，`_postman_previewlanguage` 也放进去。导出时先摊开 `extra`，再用已映射的字段覆盖。
- **说明**：P1 的 `examples` 表还没有 `extra` 列，接入阶段会通过迁移 v2 补上。你这边只需要产出这个字段。

### S3. 执行器读取本地文件的范围要能限制（为接入阶段做准备）

- **背景**：导入进来的 Postman 集合里，`formdata[].src` 和 `file.src` 可以是任意本地路径。一份恶意的共享集合，可以在用户点「发送」时把 `~/.ssh/id_rsa` 这类文件发到攻击者的服务器上。Postman 默认也只允许读取工作目录内的文件。这一点是我在调研文档里漏考虑的。
- **修法**：`execute` 增加选项 `fileRoots?: string[]`。
  - 传了这个选项时，文件路径经 `fs.realpathSync` 解析后必须落在某个根目录之内，否则返回 `FILE` 错误：「文件不在允许读取的目录内：…」。
  - 不传时不限制，保持模块本身的纯粹；**接入管理台时必须传**，这一条我会写进接入计划。

### S4. 路径参数名把 `.` 也当成了名字的一部分

- **位置**：`lib/url-utils.js:17`，`PATH_PARAM`。
- **问题**：Express 和 Postman 的写法里，`/:id.json` 表示参数 `id` 后面跟一个字面量 `.json`。现在的正则会把 `id.json` 整体当成参数名，结果替换不上。
- **修法**：参数名的字符集改成 `[\w-]+`。

---

## 流程问题（我来协调，不需要你改代码）

两个会话共用同一个工作区。P1 会话在「项目更名」那次提交时，把你还没提交的 `lib/postman.js` 导出部分一起提交了。代码内容没有受到影响，但提交历史混在了一起。

从现在起，你提交时**只用带路径的方式**，只提交自己的文件，比如 `git commit -m "..." -- lib/executor.js lib/postman.js`，不要用 `git add -A` 或 `git commit -a`。

---

## 交付要求

- 按 M1、M2、S1–S4 的顺序修，**放在一个提交里**：`fix: P3/P4 核心审阅第 1 轮`，只提交 `lib/executor.js`、`lib/postman.js`、`lib/url-utils.js` 这三个文件。
- 不写新测试；`npm test` 全部通过。M1、M2、S1 用一次性脚本自测后删掉。
- 修完回报提交号，我复审 M1、M2、S1。
