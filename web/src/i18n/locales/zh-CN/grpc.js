/**
 * grpc 区域：`web/src/components/grpc/` 下的界面文字
 * （gRPC 标签页、响应区、流式消息列表、grpc-util 里给人看的 label / 说明）。
 *
 * 术语按 README.md 的术语表：Project、Folder、API、Environment、Variable、Mock、
 * Test suite、Assertion、Extract、Example、Expectation、Workbench。
 *
 * 注意：消息里出现 `{{变量}}` 这种字面量时，vue-i18n 的 `{}` 是插值语法，
 * 必须写成 `{'...'}` 字面量转义（`{{` 写成 `{'{'}{'{'}`），否则编译报
 * 「Not allowed nest placeholder」。示例里的变量名跟着语言走（zh `变量` / en `variables`）。
 */
export default {
  /* ---------------- GrpcTab ---------------- */
  varHint: "{'{'}{'{'}变量{'}'}{'}'}",
  namePlaceholder: '接口名字',
  copyAsGrpcurl: '复制为 grpcurl',
  save: '保存',
  saved: '已保存',
  serviceMethodPlaceholder: '服务 / 方法',
  disconnect: '断开',
  connect: '连接',
  call: '调用',
  readonlyNotice: '只读角色：能看已配好的内容，但参数改不了、也存不了，调用同样不可用。',
  webNoCallPrefix: '网页版不能调用 gRPC，请在客户端里使用；而且',
  webNoCallBold: '在客户端里打开才能解析 proto',
  webNoCallSuffix: '，这里服务 / 方法下拉只显示已保存的那一个。',
  parsingProto: '正在解析 proto…',
  reflectEmpty: '存下来的描述里没有解析出服务，重新「从服务获取」一次。',
  parseEmpty: '还没有解析出服务。检查下面的 proto 文件内容对不对。',
  messages: '消息',
  generateExample: '生成示例',
  savedMessages: '常用消息',
  saveAsSaved: '存为常用',
  send: '发送',
  endSend: '结束发送',
  streamHalfClosed: '已经结束发送，等服务端回完',
  streamSendHint: '先「连接」，再逐条发；发完点「结束发送」',
  streamConnectFirst: '先点上面的「连接」',
  metadataHintPrefix: '调用时带过去的 metadata（键和值都能写 ',
  metadataHintSuffix: '）',
  keyPlaceholder: '键',
  valuePlaceholder: '值',
  tabDefinition: '服务定义',
  fetchFromServer: '从服务获取',
  fetchedAt: '获取于 {time}',
  notFetchedYet: '还没获取过',
  autoReparse: '改动之后会自动重新解析',
  reflectedGot: '拿到 ',
  reflectedServicesSuffix: ' 个服务、',
  reflectedMethodsAt: ' 个方法，获取于 {time}。',
  reflectedSaved: '描述已经随接口保存，之后打开不用再连服务端。',
  noReflectionYet: '还没从服务端获取过描述',
  webNoReflectHint: '网页版没有这个接口：服务 / 方法下拉只显示已保存的那一个，要重新获取请在客户端里打开。',
  importProto: '导入 .proto',
  newFile: '新建',
  noProtoFiles: '还没有 proto 文件',
  fileNameLabel: '文件名（import 别人的时候按这个名字找）',
  tabAssertions: '断言',
  assertionsHint:
    '调用结束之后按下面的「响应」跑断言、提取变量（和 HTTP 接口的用法一样）： 状态码是 gRPC 的状态码，响应头是 metadata 和 trailers 合起来，响应体是一元那条消息、 服务端流是全部消息组成的数组。',
  tabSettings: '设置',
  timeoutLabel: '超时（毫秒）',
  timeoutNote: '到点就取消这次调用，状态里会写 DEADLINE_EXCEEDED。默认 {n} 毫秒。',
  methodUnparsed: '{service} / {method}（未解析）',
  sourceProto: '导入 proto 文件',
  sourceReflection: '服务端反射',
  fillTargetFirst: '先填服务地址（host:port）',
  reflectTooLarge: '描述太大没有保存，每次打开需要重新获取',
  reflectedCount: '已获取到 {n} 个服务',
  reflectFailed: '获取失败',
  parseFailed: '解析失败',
  noMethodForExample: '先选一个方法（proto 解析成功之后才有示例）',
  parseProtoInClient: '解析 proto 要在客户端里打开这个接口',
  messageEmpty: '消息是空的，先写一条',
  saveAsSavedTitle: '存为常用消息',
  saveAsSavedLabel: '给这条消息起个名字，下次从「常用消息」里一点就填进来',
  savedMessageDefaultName: '常用消息 {n}',
  savedMessagePlaceholder: '查 1 号用户',
  savedMessageSaved: '已存为常用消息',
  savedMessageSavedLocal: '已存为常用消息（保存到目录之后才会留下来）',
  webNoStream: '网页版不能连接 gRPC，请在客户端里使用',
  webNoCall: '网页版不能调用 gRPC，请在客户端里使用',
  readonlyNoCall: '只读角色不能发起调用',
  selectServiceMethod: '先选服务和方法',
  writeMessageFirst: '先写一条消息',
  copiedGrpcurl: '已复制 grpcurl 命令',

  /* ---------------- GrpcResponse ---------------- */
  responseLabel: '响应',
  notCalledYet: '还没调用',
  calling: '调用中…',
  cancelled: '已取消',
  failed: '失败',
  passed: '通过',
  dropped: '（消息太多，前面的 {n} 条已省略）',
  missingVars: '这些变量没有值：{vars}（原样发出去的，检查当前环境）',
  listSeparator: '、',
  messagesCount: '（{n}）',
  noMessages: '没有消息',
  waitingResponse: '正在等响应…',
  noMetadata: '没有 Metadata',
  noTrailers: '没有 Trailers',
  noTestsOrExtracts: '没有断言和提取（在「断言」页签里加）',
  extractedVars: '提取到的变量',
  testsLabel: '测试结果',
  testsCount: '（{passed}/{total}）',
  testsExtracted: ' · 提取 {n}',

  /* ---------------- GrpcStreamList ---------------- */
  entrySent: '发出',
  entryReceived: '收到',
  entrySystem: '提示',
  clear: '清空',
  noMessagesYet: '还没有消息',

  /* ---------------- grpc-util ---------------- */
  methodClientStream: ' · 客户端流（不支持）',
  methodServerStream: ' · 服务端流',
  grpcurlPlaceholder: '<服务>/<方法>',
  grpcurlStreamingNote:
    '这条命令是客户端流 / 双向流：跑起来之后逐条粘贴 JSON 消息、每行一条，空行表示结束发送',
  grpcurlReflectionNote:
    '用的是服务端反射，所以不带 -proto；服务端没开反射的话要先导出 proto 文件再改成 -proto 的写法',
  grpcurlMultiProtoNote:
    '这个接口有 {n} 个 proto 文件，命令里只带了第一个；把 import 到的其它文件也放到 -import-path 那一层',
  grpcurlLocalProtoNote: '先把 {name} 存到当前目录（proto 存在接口里，grpcurl 读的是本地文件）'
};
