# P7b M1、P8、P9 后端审阅（9d0c11a、12322fa、94c5841、1b082ee、7a1f1bb）：全部通过

> 用 `git archive HEAD` 导出的干净副本，在 fake 环境里实际跑过：本地起了一个上游服务，准备了 alice（owner）、bob（viewer）、root（admin）三个账号，用 Node 自带的 WebSocket 当客户端。探测脚本已删除。

## 实测结果

| 项目 | 结果 |
| --- | --- |
| **P7b M1 背压** | 上游推送 300MB，客户端读一口之后停下 4 秒，服务端 RSS 从 97MB 到 100MB（修复前是 83MB 涨到 568MB）；恢复读取之后，`end.result.response.size` 为 314572800，数据完整 |
| 登录拿 token | 测试脚本里 `pm.environment.set("token", pm.response.json().token)`，环境里写入了 token；下一个请求用 `{{token}}` 做 bearer 鉴权，上游收到的是 `Bearer TOKEN-…` |
| 写回变量不破坏原有行 | 环境里原有的一行 `keep` 是停用状态，带 `desc` 和 `secret`，写回之后这些都原样保留；新增的 token 追加在末尾 |
| 测试写法 | `pm.test` + `pm.expect(...).to.be.a("string")` 和旧写法 `tests["x"] = responseCode.code === 200` 都计入了测试结果 |
| viewer | `persisted: false`，给出警告「只读角色：脚本对变量的修改没有保存」；环境和项目变量都没有被修改 |
| 前置脚本抛出异常 | `error: { code: 'SCRIPT', message: 'boom' }`，上游一次都没有收到请求 |
| 死循环 / 内存炸弹 | 1003ms 后返回「脚本执行超时（单段脚本最多 1000 毫秒）」；内存炸弹返回 `out of memory`；服务照常可用 |
| **绕过 `pm.sendRequest`、直接调用 `__host.sendRequest` 15 次** | 上游实际只收到 10 次。次数上限是在宿主那一侧强制执行的（runner 和 send.js 各有一层），在 prelude 里改不了 |
| CPU 计时扣除等待时间 | 先调用一次 `pm.sendRequest`，再计算 600ms，没有超时 |
| 历史打码 | 发起人 alice 能看到 console；bob 看到的 console 为 `[]`，变量显示为 `{"sec":"***"}` |
| `options.scripts = false` | `result.scripts` 为 `null`，一段会抛出异常的前置脚本也没有执行 |
| SSE 校验 | `delay` 为 70000 时返回 400：「第 1 条事件的 delay 必须在 0 到 60000 之间」 |
| **SSE 回放** | 事件到达时间分别为 3、505、1507ms（设置的是 0、500、1000）；多行 `data` 拆成了多行 `data:`；`event: tick` 正确；`{{@cname}}` 在每次请求时渲染，两次的值不同；`Content-Type` 为 `text/event-stream` |
| SSE 断开 | `res.on('close', stop)` 会清掉计时器；每次写入之前都会检查 `destroyed`；写缓冲满了会等 `drain` 再继续写，SSE 回放本身也有背压 |
| WS 校验 | 1000 步加 2 条空规则返回 200；1001 步返回 400，报错里说明了「规则本身不计」，**计数方式和前端一致**；不合法的正则返回 400，并附上原因 |
| **WS 回放** | 子协议协商为 `chat`；`onOpen` 的消息在 4ms 和 305ms 到达；`zzz` 走 echo 兜底；正则规则回复 `subbed`；`ping` 在约 200ms 后收到 `pong`；`{{@cname}}` 正常渲染 |
| WS 路由 | 地址是 `/mock/probe/ws/42`，按 `:room` 参数匹配上了；不存在的路径和 `/__admin/...` 都被拒绝；用 HTTP GET 访问 WS 接口的路径返回 404；`/send` 请求 WS 接口返回 400 |

`npm test` 71/71。

## 代码层面

- **沙箱**：
  - 只暴露了 `__host.log`、`__host.now`、`__host.sendRequest` 三个宿主函数；
  - 宿主和沙箱之间只传 JSON；
  - 每段脚本都用一个新的 context，执行完在 `finally` 里释放；
  - wasm 模块在进程里只加载一次，而且要等第一次真正执行脚本时才实例化。有 `hasRunnable` 把关，没有脚本的请求不会走到这一步。
- **`pm.sendRequest` 的子请求**：请求体只取 `raw`，脚本无法借 formdata 或 binary 读取本地文件；鉴权不继承主请求，这一点和 Postman 一致。
- **WS mock 和 HTTP mock 用同一套规则把地址解析到项目**：都走 `mock-host.resolve`，同一个地址在两边不会落到不同的项目上。
- **与契约不一致、但我接受的一处**：一个项目的 mock 连接数达到上限时，在握手阶段直接返回 503；契约写的是先接受连接，再用 1013 关闭。握手阶段就拒绝更省资源，客户端也能直接看到原因。

## 结论

P7b（加上 M1）、P8、P9 的后端部分**全部验收**。联调由 session2 按各自计划末尾的核对清单来做，界面效果由用户确认。
