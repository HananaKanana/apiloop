# P8：执行 Postman 脚本 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **本项目约定**
> - **不写新测试**，也不装浏览器驱动做验证。既有的 `npm test` 必须全部通过。
> - 手工核对清单是交给用户的，不要自己执行；一次性探测脚本放在 `/tmp`，跑完删掉。
> - **只提交自己的文件**：用 `git commit -m ... -- <文件>`。不要用 `git add -A`、`commit -a`、`git stash`。

**分工**：
- **A 部分**是后端，由 session1 负责，排在 P7b 背压修复（M1）之后；
- **B 部分**是前端，由 session2 负责，现在就可以开工，按契约先写代码，等 A 交付之后再联调。

**规则全部在契约里**：[docs/design/2026-09-30-admin-api-v2.md](../../design/2026-09-30-admin-api-v2.md) 第 16 节。本计划只补充契约没写到的实现决定。

**已经验证过的技术前提**：我在临时目录里用 `quickjs-emscripten-core@0.32.0` 加 `@jitl/quickjs-wasmfile-release-asyncify@0.32.0`，在 Node 24/25 上实测了以下几点：

- **异步宿主函数**：`newAsyncifiedFunction` 可以让脚本以同步写法调用、并等到异步结果；
- **死循环**：`setInterruptHandler(shouldInterruptAfterDeadline(...))` 能按时打断；
- **内存上限**：`setMemoryLimit(32MB)` 对大块分配、大数组、超长字符串都能拦下；
- **沙箱隔离**：脚本里拿不到 `require`、`process`、`fetch`；
- **开销**：新建再销毁 50 个 context，一共只要 11ms。

写法上有一个坑：要用 `module.newContext()`，让 context 自己管理 runtime，最后只 `ctx.dispose()` 一次。自己先后释放 context 和 runtime，会在 `freeHostRef` 报错。

## 全局约束

- **新增依赖**只有这两个，写进 `dependencies`：`quickjs-emscripten-core`、`@jitl/quickjs-wasmfile-release-asyncify`，版本锁定为 `0.32.0`。改完 `package-lock.json` 要能通过 `npm ci`，这是 Docker 构建的要求。改 `package.json` 之前，先看一眼 `git diff package.json`，确认没有别人未提交的改动。
- **wasm 模块只加载一次**：在进程级缓存 `newQuickJSAsyncWASMModuleFromVariant` 的结果，每次执行只新建 context。
- **文件范围**：
  - A 部分：`lib/**`（`lib/web/**` 除外）、`package.json`、`package-lock.json`、`README.md`、`docs/api.md`；
  - B 部分：`web/**`、`lib/web/**`。

## 审阅重点

1. **沙箱逃逸与资源耗尽**：
   - 沙箱里只能用第 16 节列出的宿主函数；
   - 死循环、内存炸弹、无限递归都不能拖垮服务，也不能让 `/send` 卡死；
   - `pm.sendRequest` 的次数上限和超时要生效；
   - **CPU 时间上限不包括等待 `sendRequest` 的时间**：等待期间暂停计时，返回之后接着计。不能写成「按墙上时间一刀切」，否则前面一次慢请求就会把后面的脚本判成超时。
2. **执行顺序与变量优先级**：
   - 前置脚本和测试脚本都按「项目 → 目录（从外到内）→ 接口」的顺序执行；
   - `pm.variables.get` 的查找顺序是「本次请求的临时变量 > 环境 > 内层目录 > 外层目录 > 项目」；
   - 前置脚本改过的变量，要在替换变量之前生效。
3. **写回的权限**：viewer 执行的脚本不能写库；没有选中环境时，`pm.environment.set` 也不能写库，并且要给出警告；所有写回在一个事务里完成。
4. **历史打码**：别人查看历史时，`scripts.console` 是空的，变量里 `set` 的值是 `***`。
5. **不能影响 `/send` 原有的行为**：没有任何脚本时，`result.scripts` 是 `null`，而且完全不加载 wasm；`options.scripts = false` 时，一段脚本都不执行。

---

## A 部分：后端（session1）

### Task A1：沙箱与 `pm` 运行时

**Files:**
- Create: `lib/scripts/sandbox.js`（加载 wasm、新建 context、处理时间和内存限制）
- Create: `lib/scripts/prelude.js`（导出一段**在沙箱里执行**的 JS 源码字符串，实现 `pm` 对象、chai 子集、旧写法）
- Create: `lib/scripts/runner.js`

**Interfaces:**

```js
runner.runChain(phase, steps, env) → Promise<{ aborted: boolean, request?, state }>
// phase: 'prerequest' | 'test'
// steps: [{ source: '项目' | '目录「x」' | '接口', exec }]
// env:   { request, response?, scopes, sendRequest, info }
```

- **宿主和沙箱之间只传 JSON**：宿主把 `request`、`response`、各作用域的变量表序列化成 JSON 注入沙箱；每段脚本执行完之后，把修改后的数据取回来。
- 沙箱里能调用的宿主函数只有这几个：`__host.sendRequest(json) → json`（asyncified）、`__host.log(level, text)`、`__host.now()`。
- 前置脚本出现 `aborted: true`（抛了异常），就立即停下，不再执行后面的脚本。
- prelude 放在 `lib/scripts/prelude.js` 里，以普通 JS 源码字符串的形式导出，每个 context 执行一次。**prelude 里不能有任何宿主相关的东西**，它就是纯粹的 JS。
- **CPU 计时**：自己实现一个 interrupt handler，用「已经用掉的时间」和上限比较。进入 `sendRequest` 时暂停计时，返回之后恢复（审阅重点第 1 条）。
- 另外还有一个整条链共用的 30 秒挂钟上限，超过之后，后面的脚本都不再执行。

- [ ] 实现上面三个文件。chai 子集、旧写法的清单，以契约第 16 节为准。
- [ ] **自测**，写成一次性脚本：
  - 死循环 → 1 秒左右中止，报错信息说明是「超时」；
  - `new ArrayBuffer(1e9)` → 内存不足；
  - `require('fs')` → 报错；
  - 在 `sendRequest` 里等待 3 秒，再执行 0.5 秒的计算 → 不应该超时；
  - 调用 `pm.sendRequest` 11 次 → 第 11 次以 `err` 回调；
  - 编写契约里列出的每一种 `pm.expect` 断言，成功和失败的情况各一个；
  - `tests["x"] = true` 这种旧写法能被正确计入测试结果。
- [ ] 提交：`feat: Postman 脚本沙箱与 pm 运行时`。

### Task A2：接入发送流程、支持编辑、历史打码

**Files:** `lib/api/send.js`、`lib/api/projects.js`、`lib/api/tree.js`、`lib/api/dto.js`、`README.md`、`docs/api.md`

- [ ] **接入 `prepareSend` / `finishSend`**，按契约第 16 节的执行顺序：
  1. 在变量替换之前执行前置脚本；
  2. 执行器 resolve 之后执行测试脚本；
  3. 写回变量；
  4. 写入历史。

  **没有任何脚本时，完全不加载 wasm**（审阅重点第 5 条）。

  `/send/stream`：测试脚本在 `end` 事件之前执行完，结果放在 `end.result.scripts` 里。**取消的时候不执行测试脚本**，但前置脚本对变量的修改照样写回。
- [ ] **`pm.sendRequest`** 通过 `executor.execute` 发出。代理设置和这次请求相同，Cookie jar 用这次请求的那个，`timeoutMs: 10000`。这些请求**不记入历史**。
- [ ] **写回变量**：
  - 调用者的角色是 editor 及以上时才写，用 `access.roleOf` 判断；
  - 写回时读出最新的变量行，**只修改或删除涉及到的 key**，其他行保持原样，包括描述、启用状态和顺序；
  - 新增的变量追加到末尾，默认启用。
- [ ] **编辑接口**：`PUT /projects/:pid`、`PUT /folders/:id`、`PUT /apis/:id` 都接受 `scripts` 字段，校验规则见契约。项目的 DTO 加上 `scripts`。
- [ ] **历史打码**：在 `lib/redact.js` 里加一个 `redactScriptsResult`，在 `GET /history/:id` 里判断「查看者不是发起人」的那条分支上调用。
- [ ] **README**：新增一节「脚本」，写清楚支持的 API 范围、限制（沙箱、时间、内存、`sendRequest` 的次数上限），以及变量写回的规则。原来那句「脚本已保存但不会执行」，改掉所有出现的地方。Postman 导入时给出的警告文案也要跟着改。
- [ ] **自测**：
  - 导入一个真实的「登录拿 token → 写入环境变量 → 后续请求使用」的集合：发送登录请求之后，环境里有了 token；再发送下一个请求，请求头里带上了这个 token；
  - viewer 执行同样的流程时，环境变量没有被改，并且收到警告；
  - 前置脚本抛出异常时，请求没有发出去，`error.code` 是 `SCRIPT`；
  - bob 查看 alice 的历史时，console 是空的，变量的值是 `***`；
  - `options.scripts = false` 时，一段脚本都没有执行。
- [ ] 提交：`feat: 发送时执行 Postman 脚本；脚本可编辑`。

---

## B 部分：前端（session2）

### Task B1：脚本编辑与执行结果

**Files:** `web/src/components/request/*`、`web/src/components/folder/FolderTab.vue`、`web/src/views/ProjectSettingsView.vue`、`web/src/components/response/*`，新组件可以放在 `web/src/components/scripts/`

- [ ] **脚本编辑器**：把原来只读的 `ScriptsView` 换成可编辑的，放在接口标签页、目录标签页、项目设置三个地方。
  - 分成「前置脚本」和「测试」两个子页签，使用 CodeMirror 的 JavaScript 模式，项目里已经有 `@codemirror/lang-javascript`；
  - 旁边放一个「常用片段」下拉，插入到光标位置，至少包括：
    - 设置环境变量；
    - 从 JSON 响应里取值并存成环境变量；
    - 检查状态码是 200；
    - 检查响应时间小于 500ms；
    - 检查响应体包含某个字段；
    - 用 `pm.sendRequest` 取 token。
  - viewer 只能看，不能改。
  - 保存沿用各自标签页原有的保存机制（接口 `PUT /apis/:id`、目录 `PUT /folders/:id`、项目 `PUT /projects/:pid`），也要标记「未保存」。
- [ ] **「设置」页签**：加一个开关「执行脚本」，对应 `options.scripts`，默认开启。
- [ ] **响应面板**：
  - 新增「测试结果」页签，标题上显示「通过数 / 总数」，全部通过是绿色，有失败的是红色；每一条显示名称、通过或失败，失败的显示原因；
  - 新增「控制台」页签，显示每一行的来源、级别和内容；
  - 脚本出错时，在响应面板顶部显示「前置脚本出错」或「测试脚本出错」、来源和错误信息；
  - `warnings` 在顶部显示成黄色提示；
  - `error.code === 'SCRIPT'` 时，给出中文说明：「前置脚本出错，请求没有发送」。
- [ ] **变量被修改之后**：如果 `result.scripts.variables.persisted` 为 true，就重新拉取当前环境和项目的变量，这样「缺少变量」的提示和环境管理弹窗里显示的值都是最新的。
- [ ] 执行 `npm run build:web`，然后提交：`feat(web): 脚本编辑、测试结果与控制台`。

## 手工核对清单（交给用户）

- [ ] 导入一个带「登录 → 保存 token」脚本的 Postman 集合。先发登录请求，环境里出现 token；再发需要登录的请求，能成功返回。
- [ ] 在一个接口的测试脚本里写 `pm.test("状态码 200", () => pm.response.to.have.status(200))`，发送之后，「测试结果」里显示 1/1 通过；把期望改成 201，显示失败原因。
- [ ] 写一个死循环脚本，发送之后大约 1 秒报出「超时」，服务照常可以使用。
- [ ] 用 viewer 账号执行一个会设置环境变量的脚本，看到「没有保存」的提示，环境变量没有被改。

## 完成后回报

- 每个 Task 的提交号；
- A 部分：安装依赖后 `node_modules` 的体积变化；Docker 镜像大小的变化（量镜像时用 `git archive` 导出的干净副本来构建）；
- B 部分：`lib/web/__apiloop` 经 gzip 压缩后的体积变化；
- 契约第 16 节里写得不清楚，或者和实际的 Postman 行为对不上的地方。
