/**
 * 英文翻译：发送、断言、脚本与各种调试会话（第十六轮 T30）。
 *
 * 键是中文原文（见 `lib/i18n/index.js`）。这一块的消息散落在「按下发送之后」的整条链上：
 * 断言结果、脚本报错、数据库操作、压测与测试集，以及 WebSocket / Socket.IO / gRPC /
 * MQTT / TCP / UDP 这些**会话**产生的事件。
 *
 * 会话类的事件是在请求结束之后由 socket 回调产生的，所以代码里用的是
 * `i18n.mIn(session.locale, …)` —— 语言在**建会话那一刻**记在会话上（见各 sessions 文件）。
 * 断言、脚本、发送这些还在请求里的，直接用 `i18n.m(…)`。
 *
 * 语气：这些大多出现在响应面板的「控制台 / 测试结果」里，是**给用户看的一句解释**，
 * 不是日志。所以写「the response body is empty」这种整句，不要写成 `EMPTY_BODY`。
 */

module.exports = {
    'Base64 格式不对：只能有 A-Z a-z 0-9 + / =，长度要是 4 的倍数':
        'Invalid Base64: only A-Z a-z 0-9 + / = are allowed, and the length must be a multiple of 4',
    'DNS 解析失败':
        'DNS lookup failed',
    'JSON 字段':
        'JSON field',
    'JSON 数据的顶层要是数组（对象数组）':
        'JSON data must be an array at the top level (an array of objects)',
    'MQTT 接口不能在测试集里运行，请在 MQTT 标签页里连接':
        'MQTT APIs cannot run in a test suite; connect from the MQTT tab',
    'MQTT 连接还没有打开，或者已经关闭':
        'The MQTT connection is not open, or has already closed',
    'Mock（内置）':
        'Mock (built-in)',
    'Socket.IO 连接还没有打开，或者已经关闭':
        'The Socket.IO connection is not open, or has already closed',
    'TCP 接口不能在测试集里运行，请在它自己的标签页里连接':
        'TCP APIs cannot run in a test suite; connect from their own tab',
    'TLS 握手失败，检查对方是不是 TLS 服务':
        'TLS handshake failed; check whether the other side is a TLS service',
    'TLS 握手失败，检查证书和协议（mqtts:// 或 wss://）':
        'TLS handshake failed; check the certificate and protocol (mqtts:// or wss://)',
    'UDP 接口不能在测试集里运行，请在它自己的标签页里连接':
        'UDP APIs cannot run in a test suite; connect from their own tab',
    'URL 不合法：{url}':
        'Invalid URL: {url}',
    'WebSocket 连接还没有打开，或者已经关闭':
        'The WebSocket connection is not open, or has already closed',
    'apiloop 暂不支持 {label}':
        'apiloop does not support {label} yet',
    'broker 不可用，请稍后再试':
        'The broker is unavailable; try again later',
    'broker 不支持这个功能':
        'The broker does not support this feature',
    'broker 不支持这个协议版本，请换一个协议版本（3.1 / 3.1.1 / 5）':
        'The broker does not support this protocol version; pick another one (3.1 / 3.1.1 / 5)',
    'broker 主动断开了连接':
        'The broker closed the connection',
    'broker 拒绝了这次发布（原因码 {code}）':
        'The broker rejected this publish (reason code {code})',
    'broker 拒绝了这次订阅':
        'The broker rejected this subscription',
    'broker 拒绝了这次订阅（原因码 {code}）':
        'The broker rejected this subscription (reason code {code})',
    'broker 正在关闭':
        'The broker is shutting down',
    'broker 正忙，请稍后再试':
        'The broker is busy; try again later',
    'broker 返回了未指明的错误':
        'The broker returned an unspecified error',
    'gRPC 接口不能在测试集里运行，请在 gRPC 标签页里调用':
        'gRPC APIs cannot run in a test suite; call them from the gRPC tab',
    'gRPC 调用还没有建立':
        'The gRPC call has not been established yet',
    'pm.response 只在测试脚本里可用（前置脚本执行时还没有响应）':
        'pm.response is only available in test scripts (there is no response yet when the pre-request script runs)',
    'pm.sendRequest 失败':
        'pm.sendRequest failed',
    'pm.sendRequest 当前不可用':
        'pm.sendRequest is not available right now',
    'pm.sendRequest 的第一个参数必须是地址或对象':
        'The first argument of pm.sendRequest must be a URL or an object',
    'pm.sendRequest 返回了无法解析的内容':
        'pm.sendRequest returned something that cannot be parsed',
    'pm.test 的第二个参数必须是一个函数':
        'The second argument of pm.test must be a function',
    'postman.setNextRequest 不会生效：apiloop 不支持跳转执行':
        'postman.setNextRequest has no effect: apiloop does not support jumping between requests',
    'proto 文件名不能为空':
        'The proto file name cannot be empty',
    'proto 解析失败':
        'Failed to parse the proto file',
    'proto 里 import 了没有提供的文件':
        'The proto file imports a file that was not provided',
    'proto 里没有服务「{service}」':
        'The proto files have no service named "{service}"',
    'proto 里用到了没定义的类型：{reason}':
        'The proto files use an undefined type: {reason}',
    '{actual} {label}':
        '{actual} {label}',
    '{actual} {label} {expected}':
        '{actual} {label} {expected}',
    '{actual} 上有属性 {key}':
        '{actual} has property {key}',
    '{actual} 包含 {expected}':
        '{actual} contains {expected}',
    '{actual} 匹配 {pattern}':
        '{actual} matches {pattern}',
    '{actual} 是 {items} 之一':
        '{actual} is one of {items}',
    '{actual} 深等于 {expected}（实际是 {actual}）':
        '{actual} deep equals {expected} (actual: {actual})',
    '{actual} 的属性 {key} 是 {value}（实际是 {got}）':
        '{actual} has property {key} of {value} (actual: {got})',
    '{actual} 的类型是 {type}（实际是 {got}）':
        '{actual} has type {type} (actual: {got})',
    '{actual} 的长度是 {expected}（实际是 {got}）':
        '{actual} has length {expected} (actual: {got})',
    '{actual} 等于 {expected}（实际是 {actual}）':
        '{actual} equals {expected} (actual: {actual})',
    '{code}：{message}':
        '{code}: {message}',
    '{details}（{hint}）':
        '{details} ({hint})',
    '{file} 第 {line} 行：{reason}':
        '{file} line {line}: {reason}',
    '{head}…（只显示前 {n} 个字）':
        '{head}… (showing only the first {n} characters)',
    '{label} —— {summary}':
        '{label} — {summary}',
    '{label} 失败：{reason}':
        '{label} failed: {reason}',
    '{label}要在 {min} ~ {max} 之间（收到 {got}）':
        '{label} must be between {min} and {max} (got {got})',
    '{label}要填整数':
        '{label} must be an integer',
    '{name}：{reason}':
        '{name}: {reason}',
    '{reason}（对方可能不是 Socket.IO 服务端，或者是 Socket.IO 2.x 及更早的版本 —— 本客户端能连的是 3.x / 4.x）':
        '{reason} (the other side may not be a Socket.IO server, or may be Socket.IO 2.x or earlier — this client can connect to 3.x / 4.x)',
    '{reason}：{detail}':
        '{reason}: {detail}',
    '{summary}，{ms} ms':
        '{summary}, {ms} ms',
    '…（响应体超过 {kb} KB，已截断）':
        '… (the response body is over {kb} KB, truncated)',
    '「{name}」{statement}':
        '"{name}" {statement}',
    '「算成功的状态码」只能填 100 ~ 599 之间的整数（收到 {got}）':
        '"Status codes counted as success" accepts only integers between 100 and 599 (got {got})',
    '一个对象上有属性 {key}':
        'an object has property {key}',
    '一次发送中最多调用 {n} 次 pm.sendRequest':
        'pm.sendRequest can be called at most {n} times per send',
    '不为空':
        'is not empty',
    '不包含':
        'does not contain',
    '不包含「{value}」':
        'does not contain "{value}"',
    '不匹配：{value}':
        'no match: {value}',
    '不大于':
        'is not greater than',
    '不存在':
        'does not exist',
    '不小于':
        'is not less than',
    '不是合法的 JSON：{reason}':
        'Not valid JSON: {reason}',
    '不是空的':
        'is not empty',
    '不等于':
        'does not equal',
    '不认识的数据库类型：{type}':
        'Unknown database type: {type}',
    '不认识的数据格式：{format}':
        'Unknown data format: {format}',
    '不认识的比较方式：{op}':
        'Unknown comparison: {op}',
    '两边一样':
        'both sides are the same',
    '为空':
        'is empty',
    '主机':
        'host',
    '主题名不合法':
        'Invalid topic name',
    '主题过滤器不合法':
        'Invalid topic filter',
    '二进制响应不能存成示例':
        'A binary response cannot be saved as an example',
    '从 {start} 起连着 {tries} 个端口都被占用了，请手动指定一个':
        'The {tries} ports starting at {start} are all in use; specify one manually',
    '代理 {proxy} 拒绝了 CONNECT（HTTP {status}）':
        'Proxy {proxy} refused CONNECT (HTTP {status})',
    '代理不可用':
        'Proxy unavailable',
    '代理地址不可用（只支持 http:// 形式的代理）':
        'The proxy address is unusable (only http:// proxies are supported)',
    '代理地址不合法：{address}':
        'Invalid proxy address: {address}',
    '代理地址变了，请重新输入密码':
        'The proxy address changed; enter the password again',
    '代理地址只支持 http:// 形式':
        'Only http:// proxy addresses are supported',
    '代理地址只支持 http:// 形式（https 目标会走 CONNECT 隧道）':
        'Only http:// proxy addresses are supported (https targets go through a CONNECT tunnel)',
    '会话不存在':
        'Session not found',
    '会话准备失败':
        'Failed to prepare the session',
    '会话已经结束':
        'The session has already ended',
    '其他错误':
        'Other error',
    '准备请求失败':
        'Failed to prepare the request',
    '分帧出错：{reason}':
        'Framing error: {reason}',
    '前置接口':
        'Pre-request API',
    '前置接口「{name}」没跑成功：{reason}。主请求照常发出':
        'Pre-request API "{name}" did not succeed: {reason}. The main request is still sent',
    '前置接口「{name}」：{test}':
        'Pre-request API "{name}": {test}',
    '前置脚本出错':
        'Pre-request script error',
    '前面有步骤失败，这一轮剩下的步骤跳过了':
        'An earlier step failed; the rest of this iteration was skipped',
    '包含':
        'contains',
    '包含「{value}」':
        'contains "{value}"',
    '匹配正则':
        'matches regex',
    '十六进制格式不对：位数是奇数（{n} 位）':
        'Invalid hex: odd number of digits ({n})',
    '十六进制格式不对：出现了「{bad}」':
        'Invalid hex: found "{bad}"',
    '参数超出范围':
        'Argument out of range',
    '反射拿到的描述里没有服务「{service}」':
        'The descriptor fetched from reflection has no service named "{service}"',
    '反射数据损坏，请重新获取':
        'The reflection data is corrupt; fetch it again',
    '反射数据是空的，请重新获取':
        'The reflection data is empty; fetch it again',
    '反射请求发不出去':
        'The reflection request could not be sent',
    '反射请求被拒绝':
        'The reflection request was rejected',
    '反射调用出错':
        'The reflection call failed',
    '反射超时：{ms} 毫秒内没问完':
        'Reflection timed out: it did not finish within {ms} ms',
    '反射返回的描述读不出来':
        'The descriptor returned by reflection cannot be read',
    '反射连接建不起来':
        'Could not establish the reflection connection',
    '发布的主题不能带通配符':
        'A publish topic cannot contain wildcards',
    '发送失败：{reason}':
        'Failed to send: {reason}',
    '只支持 http / https，收到 {protocol}':
        'Only http / https are supported, got {protocol}',
    '同一个 clientId 在别处登录，被 broker 断开':
        'The same clientId signed in elsewhere, so the broker disconnected this one',
    '同时最多保持 {n} 个 MQTT 会话':
        'At most {n} MQTT sessions can be open at once',
    '同时最多保持 {n} 个 Socket.IO 会话':
        'At most {n} Socket.IO sessions can be open at once',
    '同时最多保持 {n} 个 TCP / UDP 会话':
        'At most {n} TCP / UDP sessions can be open at once',
    '同时最多保持 {n} 个 WebSocket 会话':
        'At most {n} WebSocket sessions can be open at once',
    '同时最多保持 {n} 个 gRPC 流式会话':
        'At most {n} gRPC streaming sessions can be open at once',
    '命令是空的':
        'The command is empty',
    '响应 401，已自动调用前置接口「{name}」并重发':
        'The response was 401, so the pre-request API "{name}" was called and the request was sent again',
    '响应 {status}':
        'Response {status}',
    '响应不是合法的 JSON':
        'The response is not valid JSON',
    '响应不是文本，没有解析':
        'The response is not text, so it was not parsed',
    '响应体是空的':
        'The response body is empty',
    '响应太大，没有解析':
        'The response is too large, so it was not parsed',
    '响应头':
        'Response header',
    '响应文本':
        'Response text',
    '响应时间':
        'Response time',
    '因为变量 {name} 没有值':
        'because the variable {name} has no value',
    '因为响应 401':
        'because the response was 401',
    '地址不合法':
        'Invalid address',
    '地址不是合法的地址，要写成 tcp://主机:端口':
        'Not a valid address; write it as tcp://host:port',
    '地址里没有主机名，要写成 tcp://主机:端口':
        'The address has no host name; write it as tcp://host:port',
    '地址里要写端口':
        'The address must include a port',
    '地址里要写端口，例如 tcp://127.0.0.1:9000':
        'The address must include a port, for example tcp://127.0.0.1:9000',
    '域名解析不了':
        'The host name cannot be resolved',
    '大于':
        'is greater than',
    '存在':
        'exists',
    '实际值不是数字：{value}':
        'The actual value is not a number: {value}',
    '实际是 {value}':
        'Actual: {value}',
    '实际类型是 {type}':
        'The actual type is {type}',
    '客户端 ID 不合规，broker 拒绝了这次连接':
        'The client ID is not acceptable, so the broker rejected this connection',
    '客户端流、双向流请用流式会话（POST /grpc/streams）':
        'For client-streaming or bidirectional-streaming, use a streaming session (POST /grpc/streams)',
    '密码':
        'password',
    '对方返回 HTTP {status}':
        'The other side returned HTTP {status}',
    '对方重置了连接':
        'The other side reset the connection',
    '小于':
        'is less than',
    '已提取 {name} = {value}':
        'Extracted {name} = {value}',
    '已自动调用前置接口「{name}」（{reason}）':
        'The pre-request API "{name}" was called automatically ({reason})',
    '并发数':
        'concurrency',
    '建立 MQTT 连接失败：{reason}':
        'Failed to establish the MQTT connection: {reason}',
    '建立 Socket.IO 连接失败：{reason}':
        'Failed to establish the Socket.IO connection: {reason}',
    '建立 WebSocket 连接失败：{reason}':
        'Failed to establish the WebSocket connection: {reason}',
    '建立 gRPC 调用失败':
        'Failed to establish the gRPC call',
    '引号没有配对':
        'Unbalanced quotes',
    '当前 Node 没有全局 WebSocket（需要 Node 22.4 以上）':
        'This Node has no global WebSocket (Node 22.4 or newer is required)',
    '录制 {status} · {time}':
        'Recorded {status} · {time}',
    '录制已经停止':
        'Recording has stopped',
    '影响 {count} 行，{ms} ms':
        '{count} rows affected, {ms} ms',
    '总请求数':
        'total requests',
    '执行失败':
        'Execution failed',
    '执行超时（{n} 秒）':
        'Execution timed out ({n} s)',
    '执行超时：里面的正则太复杂了，换个写法再试':
        'Execution timed out: a regex inside is too complex; rewrite it and try again',
    '找不到这个地址，检查 broker 的主机名':
        'That address cannot be found; check the broker host name',
    '找不到这条记录（可能已经被清空）':
        'That record cannot be found (it may have been cleared)',
    '报文格式不对，broker 拒收':
        'Malformed packet, rejected by the broker',
    '报文里的属性不合法':
        'Invalid properties in the packet',
    '接口已删除':
        'The API has been deleted',
    '提取「{name}」：{reason}':
        'Extract "{name}": {reason}',
    '提取「{name}」：没有这个字段':
        'Extract "{name}": no such field',
    '提取「{name}」：没有选环境，这个变量没有保存':
        'Extract "{name}": no environment was selected, so this variable was not saved',
    '提取「{name}」：这次没有结果可提取':
        'Extract "{name}": there is no result to extract from this time',
    '提取变量':
        'Extract variable',
    '数据丢失或损坏':
        'Data loss or corruption',
    '数据库':
        'Database',
    '数据库名':
        'database',
    '数据库操作':
        'Database operations',
    '数据库操作只在客户端里执行，这次跳过了':
        'Database operations only run in the desktop client, so this one was skipped',
    '数据库操作：{label}':
        'Database operation: {label}',
    '数据是空的':
        'The data is empty',
    '数据有 {n} 行，最多 {max} 行':
        'The data has {n} rows; the maximum is {max}',
    '数据超过 {mb} MB 了，拆小一点':
        'The data is over {mb} MB; split it up',
    '数组里的元素要是对象（比如 [{"账号":"a"}]）':
        'Elements in the array must be objects (for example [{"name":"a"}])',
    '文件不在允许读取的目录内：{path}':
        'The file is not inside a directory that may be read: {path}',
    '文件太大（超过 20MB）':
        'The file is too large (over 20 MB)',
    '断言':
        'Assertion',
    '断言和提取变量':
        'Assertions and extracts',
    '断言执行出错：{reason}':
        'The assertion failed to run: {reason}',
    '无法解析':
        'cannot be parsed',
    '时长（秒）':
        'duration (seconds)',
    '是 false':
        'is false',
    '是 null':
        'is null',
    '是 true':
        'is true',
    '是 undefined':
        'is undefined',
    '是真值':
        'is truthy',
    '是空的':
        'is empty',
    '有这个字段':
        'the field exists',
    '服务「{service}」里没有方法「{method}」':
        'Service "{service}" has no method "{method}"',
    '服务端内部错误':
        'Internal server error',
    '服务端当前状态不允许这个操作':
        "The server's current state does not allow this operation",
    '服务端找不到请求的东西':
        'The server cannot find what was requested',
    '服务端没有这个方法，检查服务名、方法名和 proto 版本':
        'The server does not have this method; check the service name, method name and proto version',
    '服务端的操作被中止了，可以重试':
        'The server aborted the operation; you can retry',
    '服务端资源不够（限流、配额），稍后再试':
        'The server is out of resources (rate limit, quota); try again later',
    '服务端返回了未知错误':
        'The server returned an unknown error',
    '期望 {describe}':
        'expected {describe}',
    '期望「不」{describe}':
        'expected NOT {describe}',
    '期望值不是 {types} 之一':
        'The expected value is not one of {types}',
    '期望值不是数字：{value}':
        'The expected value is not a number: {value}',
    '期望响应头里有 {name}，实际没有':
        'Expected the response header {name} to be present, but it is not',
    '期望状态码是 2xx，实际是 {got}':
        'Expected a 2xx status code, got {got}',
    '期望状态码是 {want}，实际是 {got}':
        'Expected status code {want}, got {got}',
    '未命名接口':
        '(unnamed API)',
    '未命名连接':
        '(unnamed connection)',
    '未选连接':
        '(no connection selected)',
    '本机端口 {port} 被占用':
        'Local port {port} is in use',
    '正则写得不对：{reason}':
        'The regex is invalid: {reason}',
    '正则没有匹配到内容':
        'The regex matched nothing',
    '正在录制的是项目「{name}」，请到那个项目里停止':
        '"{name}" is being recorded; stop it from that project',
    '正在录制项目「{name}」，先停掉再开始':
        'Project "{name}" is being recorded; stop it first',
    '没有找到这个连接':
        'That connection was not found',
    '没有指定文件路径':
        'No file path was given',
    '没有收到响应':
        'No response was received',
    '没有权限发布这个主题':
        'Not allowed to publish to this topic',
    '没有权限绑定这个端口（1024 以下要管理员）':
        'Not allowed to bind this port (ports below 1024 need administrator rights)',
    '没有权限订阅这个主题':
        'Not allowed to subscribe to this topic',
    '没有权限，检查 metadata 里的账号或角色':
        'Permission denied; check the account or role in the metadata',
    '没有耗时':
        'No timing available',
    '没有这个响应头':
        'No such response header',
    '没有这个字段':
        'No such field',
    '没通过':
        'not passed',
    '没通过身份验证，检查 metadata 里的凭据':
        'Authentication failed; check the credentials in the metadata',
    '流式响应（SSE）不能存成示例':
        'A streaming response (SSE) cannot be saved as an example',
    '流式响应，未录制内容':
        'Streaming response, body not recorded',
    '消息不是合法的 JSON：{reason}':
        'The message is not valid JSON: {reason}',
    '消息必须是一个 JSON 对象，比如 {json}':
        'The message must be a JSON object, for example {json}',
    '状态码':
        'Status code',
    '用户名':
        'username',
    '用户名或密码不对':
        'Wrong username or password',
    '用户名或密码不对，或者这个用户没有连接权限':
        'Wrong username or password, or this user is not allowed to connect',
    '目标地址要以 http:// 或 https:// 开头':
        'The target address must start with http:// or https://',
    '目标端口不对':
        'The target port is wrong',
    '端口':
        'port',
    '端口 {port} 被占用':
        'Port {port} is in use',
    '端口要填 0~65535 的整数（0 表示自动）':
        'The port must be an integer between 0 and 65535 (0 means automatic)',
    '第 {line} 行有 {got} 列，但表头（第一行）是 {want} 列':
        'Line {line} has {got} columns, but the header (first line) has {want}',
    '第 {n} 个元素不是对象':
        'Element {n} is not an object',
    '第一行是列名，现在是空的':
        'The first line holds the column names and is empty',
    '等于':
        'equals',
    '类型是':
        'is of type',
    '结束发送失败：{reason}':
        'Failed to finish sending: {reason}',
    '缺少 Socket.IO 地址':
        'Missing the Socket.IO address',
    '缺少 WebSocket 地址':
        'Missing the WebSocket address',
    '缺少 broker 地址':
        'Missing the broker address',
    '缺少 gRPC 服务地址':
        'Missing the gRPC service address',
    '缺少 proto 文件：{name}（被 import 了，但没有一起提供）':
        'Missing proto file: {name} (it is imported but was not provided)',
    '缺少主题':
        'Missing topic',
    '缺少事件名':
        'Missing event name',
    '缺少发布的主题':
        'Missing the publish topic',
    '缺少地址':
        'Missing address',
    '网络不可达':
        'Network unreachable',
    '网络不通，检查 broker 的地址':
        'Network unreachable; check the broker address',
    '网络不通，检查地址':
        'Network unreachable; check the address',
    '脚本出错':
        'Script error',
    '脚本总时长超过 {n} 秒，后面的脚本没有执行':
        'The scripts ran longer than {n} seconds in total; the rest were not executed',
    '脚本总时长超过上限':
        'The scripts exceeded the total time limit',
    '脚本执行超时（单段脚本最多 {ms} 毫秒）':
        'Script timed out (each script may run at most {ms} ms)',
    '脚本把请求方法改成了不支持的值：{method}':
        'The script changed the request method to an unsupported value: {method}',
    '脚本状态导出失败':
        'Failed to export the script state',
    '脚本状态导出失败：{reason}':
        'Failed to export the script state: {reason}',
    '要保存到的接口不存在':
        'The API to save into does not exist',
    '要创建的东西已经存在':
        'What you are trying to create already exists',
    '要发广播请勾选「允许广播」':
        'To broadcast, tick "Allow broadcast"',
    '解析失败':
        'Failed to parse',
    '订阅失败':
        'Subscription failed',
    '订阅的主题名不合法':
        'Invalid subscription topic name',
    '证书 / TLS 握手失败':
        'Certificate / TLS handshake failed',
    '证书不受信任，可以勾选「忽略证书错误」':
        'The certificate is not trusted; you can tick "Ignore certificate errors"',
    '语句是空的':
        'The statement is empty',
    '请先勾选要保存的记录':
        'Tick the records you want to save first',
    '请先导入 proto 文件':
        'Import a proto file first',
    '请先导入 proto 文件，或者用反射拉一份描述':
        'Import a proto file first, or fetch a descriptor with reflection',
    '请填写 gRPC 服务地址（host:port）':
        'Enter the gRPC service address (host:port)',
    '请求参数不合法，检查消息内容':
        'Invalid request argument; check the message body',
    '请求参数不是合法 JSON':
        'The request argument is not valid JSON',
    '请求失败：系统还没有允许 node 访问本地网络。请在系统弹出的「本地网络」授权框中点「允许」，然后重新发送。如果没看到弹框，到「系统设置 → 隐私与安全性 → 本地网络」里把 node 打开。':
        'Request failed: the system has not yet allowed node to access the local network. Click "Allow" in the "Local Network" prompt, then send again. If you did not see a prompt, turn node on under System Settings → Privacy & Security → Local Network.',
    '请求头 {name} 的值含有 HTTP 不允许的字符（非 ASCII 字符需要先编码）':
        'The value of the request header {name} contains characters HTTP does not allow (non-ASCII characters must be encoded first)',
    '请求头不合法':
        'Invalid request header',
    '请求头名称不合法：{name}':
        'Invalid request header name: {name}',
    '请求已被取消':
        'The request was cancelled',
    '请求构造失败':
        'Failed to build the request',
    '请求超过 {ms} 毫秒未完成':
        'The request did not finish within {ms} ms',
    '读取响应失败：{reason}':
        'Failed to read the response: {reason}',
    '读取文件失败：{path}（{reason}）':
        'Failed to read the file: {path} ({reason})',
    '读取本地文件失败':
        'Failed to read the local file',
    '读取目标响应时出错':
        "Error while reading the target's response",
    '调用失败':
        'The call failed',
    '调用被取消了':
        'The call was cancelled',
    '超时':
        'Timed out',
    '超时了，检查服务端有没有响应，或者把超时时间调大':
        'Timed out; check whether the server responded, or raise the timeout',
    '超时毫秒':
        'timeout (ms)',
    '超时（15 秒）':
        'Timed out (15 s)',
    '返回 {count} 行':
        'Returned {count} rows',
    '返回 {count} 行（只取了前 {max} 行）':
        'Returned {count} rows (only the first {max} were taken)',
    '返回 {value}':
        'Returned {value}',
    '返回对象':
        'Returned an object',
    '返回数组（{n} 项）':
        'Returned an array ({n} items)',
    '返回空':
        'Returned empty',
    '这一段太长，{n} 字节的长度前缀装不下':
        'This chunk is too long for the {n}-byte length prefix',
    '这个地址返回的是网页，不是接口定义。请填 JSON / YAML 的地址，比如 /v3/api-docs 或 /swagger.json':
        'That address returns a web page, not an API definition. Use the JSON / YAML address, such as /v3/api-docs or /swagger.json',
    '这个数组是空的，一行数据都没有':
        'The array is empty; there is not a single row',
    '这个测试集一个步骤都没有':
        'This test suite has no steps',
    '这份测试集没有用数据':
        'This test suite does not use data',
    '这条操作没有选连接':
        'This operation has no connection selected',
    '这条记录没拿到响应，不能存成示例':
        'This record has no response and cannot be saved as an example',
    '连不上 broker，检查地址和端口':
        'Cannot reach the broker; check the address and port',
    '连不上 broker，检查地址和端口（连接超时）':
        'Cannot reach the broker; check the address and port (connection timed out)',
    '连不上 {target}：{reason}':
        'Cannot reach {target}: {reason}',
    '连不上服务，检查地址、端口、TLS 开关':
        'Cannot reach the service; check the address, port and TLS switch',
    '连不上，检查地址和端口':
        'Cannot connect; check the address and port',
    '连接「{name}」没有填主机':
        'Connection "{name}" has no host',
    '连接「{name}」没有填用户名':
        'Connection "{name}" has no username',
    '连接「{name}」的{fields}里还有没替换的变量，检查当前环境里有没有这些变量':
        'Connection "{name}" still has unreplaced variables in {fields}; check whether the current environment defines them',
    '连接不存在：{id}':
        'Connection not found: {id}',
    '连接代理 {proxy} 失败：{reason}':
        'Failed to connect to proxy {proxy}: {reason}',
    '连接出错':
        'Connection error',
    '连接失败':
        'Connection failed',
    '连接已断开':
        'The connection was closed',
    '连接已断开，正在重连':
        'The connection was closed; reconnecting',
    '连接已经被对方关闭':
        'The other side already closed the connection',
    '连接被中断':
        'The connection was interrupted',
    '连接被拒绝':
        'Connection refused',
    '连接被重置':
        'Connection reset',
    '连接超时':
        'Connection timed out',
    '连接还没有打开，或者已经关闭':
        'The connection is not open yet, or has already closed',
    '选中的目录不存在':
        'The selected folder does not exist',
    '重定向地址不合法：{url}':
        'Invalid redirect address: {url}',
    '重定向次数超过 {n} 次，已停止跟随':
        'More than {n} redirects; stopped following',
    '预热秒数':
        'ramp-up (seconds)',
    '（二进制 {n} 字节）':
        '(binary, {n} bytes)',
};
