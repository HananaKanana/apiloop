/**
 * 英文翻译：导入、导出与备份（第十六轮 T31）。
 *
 * 键是中文原文（见 `lib/i18n/index.js`）。这一块是**第三步**（最后一步）：
 * 导入（cURL / OpenAPI / YApi / Apifox / 集合 / HAR / 旧配置）、导出（接口文档
 * Markdown / HTML / Word、OpenAPI、集合 JSON）和备份恢复。
 *
 * 两条和别处不一样的约定：
 *
 * 1. **导出的文档正文也跟着语言走** —— 标题、表头、「请求参数」「示例响应」这类固定文字
 *    都过 `lib/export-doc.js` 里的 `T()`（就是 `i18n.m`），语言取发起导出那一刻的
 *    `i18n.locale()`。用户自己写的接口名 / 说明一个字不动。
 * 2. 因为导出文档里大量是「标签 + 值」的拼接（`- 状态：xxx`），这里**保留了一部分
 *    短片段**（比如 `- 状态：{status}`）—— 它们在英文里语序和中文一致，整句反而更啰嗦。
 *    真正有语序问题的那些都写成了整句 + 占位符。
 */

module.exports = {
  /* ---------------- 状态名 / 发送格式 / 行尾（导出文档里的下拉取值） ---------------- */
  '设计中': 'Designing',
  '开发中': 'In development',
  '已完成': 'Done',
  '已废弃': 'Deprecated',
  '文本': 'Text',
  '十六进制': 'Hex',
  '不加': 'None',

  /* ---------------- 导出文档：通用词 ---------------- */
  '接口文档': 'API docs',
  '-接口文档-': '-api-docs-',
  '目录（文档）': 'Contents',
  '- 导出时间：{time}': '- Exported: {time}',
  '- 接口数量：{apis} 个（{folders} 个目录）': '- {apis} APIs in {folders} folders',
  '导出时间：{time}　接口数量：{apis} 个（{folders} 个目录）{scope}':
    'Exported: {time}　{apis} APIs in {folders} folders{scope}',
  '- 范围：目录「{name}」': '- Scope: folder "{name}"',
  '　范围：目录「{name}」': '　Scope: folder "{name}"',
  '密码、token 这类值已自动遮住；环境变量的值、脚本不会出现在文档里。':
    'Passwords and tokens are masked automatically; environment values and scripts never appear in the document.',
  '（未分组）': '(ungrouped)',
  '未命名目录': '(unnamed folder)',
  '未设置': 'Not set',
  '是': 'Yes',
  '否': 'No',
  '随机': 'random',
  '默认': 'Default',
  '示例': 'Example',
  '示例 {n}': 'Example {n}',
  '变量': 'Variables',
  '变量：': 'Variables:',
  '表单': 'form',
  '小端': 'little-endian',
  '大端': 'big-endian',
  '不适用（UDP 一个数据报就是一条消息）': 'Not applicable (one UDP datagram is one message)',
  '不分帧（收到一块算一条）': 'No framing (each chunk received is one message)',
  '按分隔符切（{delimiter}）': 'Split by delimiter ({delimiter})',
  '长度前缀（{n} 字节，{endian}，长度不含前缀本身）':
    'Length prefix ({n} bytes, {endian}, the length does not include the prefix itself)',
  'TLS：开': 'TLS: on',

  /* ---------------- 导出文档：接口那一节 ---------------- */
  '- 状态：{status}': '- Status: {status}',
  '- 鉴权：{type}': '- Auth: {type}',
  '- Mock 地址：{url}': '- Mock URL: {url}',
  'Mock 地址：{url}': 'Mock URL: {url}',
  '- 服务：{name}': '- Service: {name}',
  '服务：{name}': 'Service: {name}',
  '- 方法：{name}': '- Method: {name}',
  '方法：{name}': 'Method: {name}',
  '- 协议版本：{value}': '- Protocol version: {value}',
  '协议版本：{value}': 'Protocol version: {value}',
  '客户端 ID：{value}': 'Client ID: {value}',
  '- 分帧：{value}': '- Framing: {value}',
  '分帧：{value}': 'Framing: {value}',
  '- 默认发送格式：{encoding}　行尾：{ending}': '- Default send format: {encoding}　Line ending: {ending}',
  '默认发送格式：{value}': 'Default send format: {value}',
  '行尾：{value}': 'Line ending: {value}',
  '- 本机端口：{port}　允许广播：{broadcast}': '- Local port: {port}　Allow broadcast: {broadcast}',
  '本机端口：{value}': 'Local port: {value}',
  '允许广播：{value}': 'Allow broadcast: {value}',
  '　负责人：{name}': '　Owner: {name}',
  '　鉴权：{type}': '　Auth: {type}',
  '请求消息': 'Request message',
  '订阅主题': 'Subscribed topics',
  '常用发布': 'Saved publishes',
  '常用发送': 'Saved sends',
  '路径参数': 'Path parameters',
  '查询参数': 'Query parameters',
  '请求头': 'Request headers',
  '请求体': 'Request body',
  '请求体（GraphQL）': 'Request body (GraphQL)',
  '请求体（{kind}）': 'Request body ({kind})',
  '响应字段说明': 'Response field notes',
  '示例响应{name} · HTTP {status}': 'Example response{name} · HTTP {status}',
  '（{name}）': ' ({name})',
  '{name}：{topic}（QoS {qos}{retain}）': '{name}: {topic} (QoS {qos}{retain})',
  '- {name}：{topic}（QoS {qos}{retain}）': '- {name}: {topic} (QoS {qos}{retain})',
  '，retain': ', retain',
  '(未填主题)': '(no topic)',
  '{name}（{encoding}）': '{name} ({encoding})',
  '- {name}（{encoding}）': '- {name} ({encoding})',

  /* ---------------- 导出文档：表头 ---------------- */
  '名字': 'Name',
  '示例值': 'Example',
  '必填': 'Required',
  '说明': 'Notes',
  '值': 'Value',
  '字段': 'Field',
  '类型': 'Type',
  '主题': 'Topic',
  '启用': 'Enabled',
  '（继承）': ' (inherited)',
  '（必有）': ' (required) ',

  /* ---------------- 导入：通用 ---------------- */
  '导入': 'Imported',
  '不是合法的 JSON：{reason}': 'Not valid JSON: {reason}',
  '内容为空，请粘贴一条 cURL 命令': 'The content is empty; paste a cURL command',
  '没有在 cURL 命令里找到 URL': 'No URL found in the cURL command',
  'URL 解析失败: {url}': 'Could not parse the URL: {url}',
  '原始请求体': 'Raw request body',
  '（导入时把数字路径段转成了 :id，可自行调整）':
    ' (numeric path segments were turned into :id while importing; adjust if needed)',
  '由 cURL 导入{note}': 'Imported from cURL{note}',
  '内容为空，请粘贴 OpenAPI/Swagger 定义': 'The content is empty; paste an OpenAPI/Swagger definition',
  '解析失败：看起来不是 JSON，且当前环境没有 js-yaml，无法解析 YAML。':
    'Failed to parse: it does not look like JSON, and js-yaml is not available here so YAML cannot be parsed. ',
  '原始错误：': 'Original error: ',
  '既不是合法 JSON 也不是合法 YAML：{reason}': 'Neither valid JSON nor valid YAML: {reason}',
  '不是有效的 OpenAPI/Swagger 文档：缺少 paths 字段':
    'Not a valid OpenAPI/Swagger document: the paths field is missing',
  '文档里没有解析到任何接口（paths 为空？）': 'No APIs were found in the document (is paths empty?)',

  /* ---------------- 导入：YApi ---------------- */
  'YApi 导入': 'YApi import',
  '未命名分类': '(unnamed category)',
  '「{name}」的请求体 schema 解析不了，请求体没有导入':
    '"{name}": the request body schema could not be parsed, so the request body was not imported',
  '「{name}」的请求体是文件上传，没有导入（要自己选文件）':
    '"{name}": the request body is a file upload and was not imported (pick the file at run time)',
  '「{name}」的响应 schema 解析不了，示例没有导入':
    '"{name}": the response schema could not be parsed, so no example was imported',
  '这不是 YApi 导出的 JSON：顶层应该是一个分类数组（每项有 name 和 list）':
    'This is not a YApi export: the top level should be an array of categories (each with name and list)',
  '「{name}」没有 path，跳过了': '"{name}" has no path; skipped',
  '这份 YApi 文件里没有解析到任何接口': 'No APIs were found in this YApi file',
  '有 {n} 个接口的请求体是文件上传，表单里的文件行没有值（运行时自己选文件）':
    '{n} APIs have a file-upload request body; the file rows have no value (pick the file at run time)',
  '有 {n} 个接口的响应里带着 YApi 自己的 Mock 模板语法（`{{...}}`），没有转成 apiloop 的占位符，原样存进了示例':
    '{n} APIs have responses that use YApi\'s own mock template syntax (`{{...}}`); they were not converted to apiloop placeholders and were stored in the examples as-is',
  '从 YApi 导出的 JSON 导入（{folders} 个分类、{apis} 个接口）':
    'Imported from a YApi JSON export ({folders} categories, {apis} APIs)',

  /* ---------------- 导入：Apifox ---------------- */
  'Apifox 导入': 'Apifox import',
  '未知操作': 'unknown action',
  '服务地址': 'Service URL',
  '这不是 Apifox 导出的 JSON：顶层应该有 apiCollection 数组':
    'This is not an Apifox export: the top level should have an apiCollection array',
  '「{name}」没有地址，跳过了': '"{name}" has no URL; skipped',
  '「{name}」没有请求方法，跳过了': '"{name}" has no request method; skipped',
  '未命名分组': '(unnamed group)',
  '有不认识的内容（既不是目录也不是接口），跳过了':
    'There is content that is neither a folder nor an API; skipped',
  '这份 Apifox 文件里没有解析到任何接口': 'No APIs were found in this Apifox file',
  '测试用例（{cases} 个）和测试场景（{scenes} 个）这一轮不导入':
    'Test cases ({cases}) and test scenarios ({scenes}) are not imported in this round',
  '数据模型（{n} 个）已经按引用展开到接口里了，没有单独建成模型':
    'The data models ({n}) were expanded into the APIs by reference and were not created as separate models',
  '有 {n} 个 cookie 参数没有导入（Cookie 在 Cookie 管理器里配）':
    '{n} cookie parameters were not imported (set cookies in the cookie manager)',
  '有 {n} 个接口的响应里既没有示例也没有 schema，没有生成示例响应':
    '{n} APIs have neither an example nor a schema in their responses; no example response was generated',

  /* ---------------- 导入：集合（Postman） ---------------- */
  '未命名集合': '(unnamed collection)',
  '未命名接口': '(unnamed API)',
  '未命名环境': '(unnamed environment)',
  '以下鉴权类型暂不支持：': 'These auth types are not supported yet: ',
  ' 个脚本已导入，发送请求时会执行（沙箱内运行，见 README 的「脚本」一节）':
    ' scripts were imported and will run when you send a request (inside the sandbox; see the "Scripts" section of the README)',
  '不是合法的 JSON：': 'Not valid JSON: ',
  '无法识别的 JSON 文件：顶层不是一个对象': 'Unrecognized JSON file: the top level is not an object',
  '无法识别的 JSON 文件：既不是集合，也不是环境或全局变量':
    'Unrecognized JSON file: it is neither a collection, nor an environment or globals',
  '这是旧的 Collection v1 格式，请重新导出为 Collection v2.1 之后再导入':
    'This is the old Collection v1 format; export it again as Collection v2.1 and import that',

  /* ---------------- 导入：HAR ---------------- */
  'HAR 导入 {time}': 'HAR import {time}',
  '不是 HAR 文件：缺少 log.entries': 'Not a HAR file: log.entries is missing',
  '跳过了 {n} 条静态资源或非 http 请求': 'Skipped {n} static assets or non-http requests',
  '已去掉 {n} 处 Cookie / Authorization 等凭据；如需保留，导入时勾选『保留凭据』':
    'Removed credentials such as Cookie / Authorization in {n} places; tick "Keep credentials" when importing to keep them',
  '{n} 条记录没有可用的文本响应体，没有生成示例':
    '{n} records have no usable text response body, so no example was generated',
  '有 {n} 个示例因为重复或超出每个接口 {max} 条的上限被丢弃':
    '{n} examples were dropped as duplicates or because they exceeded the limit of {max} per API',
  '有 {n} 个上传的文件字段被置空（HAR 里没有文件内容）':
    '{n} uploaded file fields were cleared (a HAR file does not contain the file contents)',

  /* ---------------- 导入：旧配置迁移 ---------------- */
  '旧配置 ': 'Old config ',
  '旧配置里有 ': 'In the old config, ',
  ' 不是合法 JSON，已跳过迁移：': ' is not valid JSON; migration skipped: ',
  ' 条接口无法解析，已跳过': ' API entries could not be parsed and were skipped',
  '读取旧配置 ': 'Reading old config ',
  '读取旧配置失败：{reason}': 'Failed to read the old config: {reason}',

  /* ---------------- 导出 OpenAPI ---------------- */
  '变量，导入方自己替换': 'Variable; whoever imports this replaces it',
  '公共请求头': 'Common request header',
  'WebSocket 接口「{name}」：OpenAPI 里没有 WebSocket':
    'WebSocket API "{name}": OpenAPI has no WebSocket',
  'Socket.IO 接口「{name}」：OpenAPI 里没有 Socket.IO':
    'Socket.IO API "{name}": OpenAPI has no Socket.IO',
  'gRPC 接口「{name}」：OpenAPI 里没有 gRPC': 'gRPC API "{name}": OpenAPI has no gRPC',
  'MQTT 接口「{name}」：OpenAPI 里没有 MQTT': 'MQTT API "{name}": OpenAPI has no MQTT',
  '{method} 接口「{name}」：OpenAPI 里没有 {method}':
    '{method} API "{name}": OpenAPI has no {method}',
  '{method} {path}（{name}）：和前面一个接口重了':
    '{method} {path} ({name}): duplicates an earlier API',
  '响应 {status}': 'Response {status}',
  '当前环境没有 js-yaml，无法导出 YAML；可以改用 JSON 格式':
    'js-yaml is not available here, so YAML cannot be exported; use the JSON format instead',
  '# 以下接口没有导出（同一「方法 + 路径」只导第一个；WebSocket / Socket.IO / gRPC 不在 OpenAPI 里）：\n':
    '# These APIs were not exported (only the first of each method + path is exported; WebSocket / Socket.IO / gRPC are not in OpenAPI):\n',

  /* ---------------- 同步（OpenAPI 更新） ---------------- */
  '有更新': 'Has updates',
  '新增 ': 'added ',
  '删除 ': 'removed ',
  '有 ': 'there are ',
  ' 个字段的说明': ' field descriptions',
  '补了 ': 'added notes for ',
  '名称': 'Name',
  '地址': 'URL',
  '参数': 'Parameters',
  '请求体字段': 'Request body fields',
  '请求体里有很长的数字，自动合并会改坏它，请手动检查':
    'The request body contains very long numbers that auto-merge would corrupt; check it by hand',
  '请求体不是合法 JSON（可能带 {{变量}} 或注释），无法自动合并，请手动检查':
    'The request body is not valid JSON (it may contain {{variables}} or comments), so it cannot be auto-merged; check it by hand',
  '请求体的顶层不是对象，无法自动合并，请手动检查':
    'The request body is not an object at the top level, so it cannot be auto-merged; check it by hand',
  '这个接口的请求体类型和文档对不上，无法自动合并，请手动检查':
    'This API\'s request body type does not match the document, so it cannot be auto-merged; check it by hand',

  /* ---------------- 备份与恢复 ---------------- */
  '项目不存在': 'Project not found',
  '这不是 apiloop 的备份文件': 'This is not an apiloop backup file',
  '备份来自更新的版本，请先升级': 'The backup comes from a newer version; upgrade first',
  '恢复的项目': 'Restored project',
  '（恢复）': ' (restored)',
  '覆盖恢复需要这个项目的 owner 权限': 'Overwriting a project needs owner rights on it',
  'mode 只能是 new 或 overwrite': 'mode can only be new or overwrite',
  '接口': 'API',
  '期望': 'Expectation',
  '环境': 'Environment',
  '测试集': 'Test suite',
  '未命名示例': '(unnamed example)',
  '未命名期望': '(unnamed expectation)',
  '未命名测试集': '(unnamed test suite)',
  '不是数组，已忽略': ' is not an array and was ignored',
  '目录「{name}」的上级目录不在备份里，已放到项目根目录':
    'The parent folder of "{name}" is not in the backup; it was placed at the project root',
  '接口「{name}」所在的目录不在备份里，已放到项目根目录':
    'The folder of API "{name}" is not in the backup; it was placed at the project root',
  '示例「{name}」所属的接口不在备份里，已跳过':
    'The API that example "{name}" belongs to is not in the backup; skipped',
  'Mock 期望「{name}」所属的接口不在备份里，已跳过':
    'The API that mock expectation "{name}" belongs to is not in the backup; skipped',
  '接口「{name}」指定用于 Mock 的示例不在备份里，Mock 已关掉':
    'The example API "{name}" uses for mock is not in the backup, so mock was turned off',

  /* ---------------- 整句拼出来的那些片段（导出文档与导入提示共用） ---------------- */
  ' 个接口）': ' APIs)',
  ' 个目录、': ' folders, ',
  ' 个步骤指向的接口不在备份里，已去掉':
    ' steps pointed at APIs that are not in the backup and were removed',
  ' 处「': ' places of "',
  ' 失败：': ' failed: ',
  ' 格式不对（应为 { "routes": [...] } 或直接是数组），已跳过迁移':
    ' has the wrong shape (expected { "routes": [...] } or a bare array); migration skipped',
  '(未命名接口)': '(unnamed API)',
  '」操作没有导入（和我们的断言 / 提取对不上）':
    '" actions were not imported (they do not map to our assertions / extracts)',
  '」里有 ': '" contains ',
  '从 Apifox 导出导入（': 'Imported from an Apifox export (',
  '有 {n} 个接口的请求体是文件上传，文件行没有值（运行时自己选文件）':
    '{n} APIs have a file-upload request body; the file rows have no value (pick the file at run time)',
  '测试集「': 'Test suite "',
  '状态：{status}': 'Status: {status}',
  '示例 ': 'Example ',
  '项目 ': 'project ',

  /* ---------------- 自动备份（后台任务） ---------------- */
  '备份编号不合法': 'Invalid backup id',
  '这份备份不在了：': 'That backup is gone: ',
  '这份备份文件坏了，读不出内容': 'This backup file is corrupt and cannot be read',
  ' 备份失败：': ' backup failed: ',
  '自动备份：写出 ': 'Auto backup: wrote ',
  ' 份、跳过 ': ' copies, skipped ',
  ' 份、清理 ': ' copies, cleaned up ',
  ' 个文件': ' files',
  '自动备份失败：': 'Auto backup failed: ',
  '正则写得不对：': 'Invalid regex: '
};
