/**
 * response 区域：`web/src/components/response/` 下的界面文字
 * （响应体、响应头、字段视图、响应面板、SSE 事件、耗时、可视化）。
 *
 * 术语按 README.md 的术语表：Project、Folder、API、Environment、Variable、Mock、
 * Test suite、Assertion、Extract、Example、Expectation、Workbench。
 */
export default {
  /* ---------------- BodyViewer ---------------- */
  formatText: '原文',
  formatAuto: '自动识别（{format}）',
  formatTextLabel: '原文（不格式化、不高亮）',
  preview: '预览',
  fields: '字段',
  fieldsTitle: '按字段列出响应，可以给某个字段加断言、提取成变量',
  image: '图片',
  wrapTitle: '自动换行',
  searchTitle: '在响应里查找（⌘F / Ctrl+F）',
  copyBodyTitle: '复制响应体',
  downloadBodyTitle: '下载响应体',
  copiedBody: '已复制响应体',
  truncatedNotice: '响应体超过上限，界面里只保留了前面一部分；大小显示的是完整长度。',
  tooBigNotice: '响应超过 1 MB，为了不卡住界面就不做美化了，直接显示原文。',
  needsScriptNotice: '这个页面要运行脚本才能显示，预览里不执行脚本。',
  openInBrowser: '在浏览器中打开',
  imageAlt: '响应图片',
  binaryNotice: '这是二进制响应，界面里不展示内容。',
  binarySize: '大小：{size}',
  download: '下载',
  fieldReasonNotText: '这段响应不是文本',
  fieldReasonNotJson: '这段响应不是 JSON，没有字段列表',
  fieldReasonTooBig: '响应超过 1 MB，为了不卡住界面不列字段',

  /* ---------------- HeadersTable ---------------- */
  noHeaders: '没有响应头',
  headerName: '名称',
  headerValue: '值',

  /* ---------------- JsonTreeView ---------------- */
  fieldsNotObject: '这是一段顶层不是对象的 JSON，没有字段可以点。',
  addAssertion: '加断言',
  addAssertionTitle: '在「断言」里加一行：JSON 字段 · 这个路径',
  addExtract: '提取为变量',
  addExtractTitle: '在「断言」页签的提取表里加一行',
  fieldsTruncated: '字段太多，只列出前 500 个。',

  /* ---------------- ResponsePanel ---------------- */
  errorTimeout: '请求超时，对方在限定时间内没有返回。',
  errorAborted: '请求已取消。',
  errorDns: '域名解析失败，检查一下主机名。',
  errorConnect: '连不上目标服务器，检查地址和端口，或者对方没在监听。',
  errorTls: 'TLS 握手失败，证书可能有问题（自签名证书默认是放行的，说明不是这个原因）。',
  errorInvalidUrl: 'URL 不合法。',
  errorInvalidHeader: '请求头不合法。',
  errorFile: '读取本地文件失败。',
  errorProxy: '代理不可用：连不上代理，或者 CONNECT 隧道被拒绝了。检查系统设置里的代理地址，或者关掉这次请求的「使用系统代理」。',
  errorScript: '「请求前」脚本出错，请求没有发送。改完脚本再发，或者在「设置」页签里关掉这次请求的「执行脚本」。',
  errorOther: '请求失败。',
  errorWithCode: '{message}（{code}：{detail}）',
  serverSendDisabled: '云端不发送请求，请从本机的 apiloop 打开',
  idleHint: '点击发送，或按 Enter，查看响应',
  localNetworkTitle: '需要允许本地网络访问',
  localNetworkBody:
    '系统刚才弹出了「允许 node 访问本地网络」，请点「允许」后重新发送。 如果没看到弹框：打开「系统设置 → 隐私与安全性 → 本地网络」，把 node 打开。',
  resend: '重新发送',
  cancelledNotice: '这次请求已经取消。服务端会照常记一条历史（状态是「已取消」），里面是断开前收到的部分。',
  historyTruncatedNotice: '这条历史里的响应体超过了 256 KB，落库时做了截断，下面是截断后的内容。',
  recordErrorTag: '未保存历史',
  receiving: '接收中… {size}',
  duration: '耗时 {time}',
  size: '大小 {size}',
  viaProxy: '经由代理 {url}',
  redirectCount: '重定向 {n} 次',
  connecting: '正在连接…',
  notSentYet: '还没发送',
  saveExample: '保存为示例',
  saveHintTemp: '临时标签页要先保存成接口，才能存示例',
  saveHintSendFirst: '先发一次请求',
  saveHintBinary: '二进制响应不能存成示例',
  bodyTab: 'Body',
  visualizeTab: '可视化',
  eventsTab: '事件',
  testResults: '测试结果 {passed}/{total}',
  testPassed: '通过',
  testFailed: '失败',
  consoleTab: '控制台',
  cookiesTab: 'Cookies',
  cookieName: '名称',
  cookieValue: '值',
  cookieDomain: 'Domain',
  cookiePath: 'Path',
  cookieExpires: '过期',
  cookieAttributes: '属性',
  cookieSession: '会话',
  noCookies: '这次响应没有设置 Cookie',
  headersTab: 'Headers',
  timingsTab: '耗时',
  requestTab: '请求',
  requestBody: '请求体',
  scriptErrorPrerequest: '「请求前」脚本出错',
  scriptErrorResponse: '「响应后」脚本出错',
  maxAge: 'Max-Age {value} 秒',

  /* ---------------- SseEventsTable ---------------- */
  sseOverflow: '只显示最近 2000 条，更早的 {n} 条已经丢弃。',
  sseCount: '共 {n} 条事件',
  sseTip: '点一行展开看完整 data',
  sseSave: '保存为 SSE 示例',
  sseSaveTitle: '按每个事件的到达时间算出 delay，存成 sse 类型的示例',
  sseTime: '时间',
  sseLength: '长度',
  sseEmpty: '还没有收到事件。',

  /* ---------------- TimingsBar ---------------- */
  totalTiming: '总耗时',
  timingDns: 'DNS 解析',
  timingConnect: '建立连接',
  timingTls: 'TLS 握手',
  timingTtfb: '等待首字节',
  timingDownload: '下载响应',

  /* ---------------- VisualizerView ---------------- */
  templateRenderError: '模板渲染失败：{message}'
};
