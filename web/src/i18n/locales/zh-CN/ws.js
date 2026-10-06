/**
 * ws 区域：`web/src/components/ws/` 下的界面文字
 * （WebSocket 标签页、消息日志、保存为 mock 的预览弹窗）。
 *
 * 术语按 README.md：WebSocket、Mock、Cookie 等专有名词不翻译。
 *
 * 注意：消息里出现 `{{变量}}` 这种字面量时，vue-i18n 的 `{}` 是插值语法，
 * 必须写成 `{'...'}` 字面量转义（`{{` 写成 `{'{'}{'{'}`）。
 */
export default {
  /* ---------------- 共用 ---------------- */
  connect: '连接',
  disconnect: '断开',
  save: '保存',
  saveToFolder: '保存到目录',
  conflictText: '这个接口和云端有冲突',
  resolve: '处理',
  recent: '最近',
  urlPlaceholder: "wss://echo.example.com/socket，支持 {'{'}{'{'}变量{'}'}{'}'}",
  connectBlockedTooltip: '网页版不能连接，请在客户端里使用（或让管理员在云端开启发送）',
  connectBlocked: '网页版不能连接，请在客户端里使用',
  noProject: '还没有选中项目',
  rootFolder: '（根目录）',
  apiNameRequired: '请填写接口名称',
  readonlyCannotSave: '当前角色是只读，不能保存修改',

  /* ---------------- WsTab：状态 ---------------- */
  statusIdle: '未连接',
  statusConnecting: '连接中…',
  statusOpen: '已连接',
  statusClosed: '已断开',
  statusEnded: '会话已结束',
  statusError: '出错',
  channelRetrying: '事件流断了，正在重连…',
  channelEnded: '会话已被服务端回收',

  /* ---------------- WsTab：连接 ---------------- */
  urlRequired: '请先填写 WebSocket 地址',
  schemeRequired: '地址必须以 ws:// 或 wss:// 开头',

  /* ---------------- WsTab：页签 ---------------- */
  tabSettings: '设置',
  headerPlaceholder: '请求头',
  valuePlaceholder: '值',
  paramName: '参数名',
  protocolHint: 'Sec-WebSocket-Protocol 会作为子协议协商，不会当成普通请求头发出去。',
  cookieOptionTitle: '自动带 Cookie',
  cookieOptionDesc: '连接时按目标地址从 Cookie 库里取匹配的 cookie。握手响应里的 Set-Cookie 拿不到，不会写回。',

  /* ---------------- WsTab：日志与发送 ---------------- */
  messageLog: '消息日志',
  saveScenarioTitle: '按消息日志生成回放场景，存成 ws 类型的示例',
  saveAsMock: '保存为 mock',
  clearLog: '清空日志',
  composerPlaceholder: '要发送的内容，Ctrl+Enter 发送',
  send: '发送',

  /* ---------------- WsTab：保存 ---------------- */
  saved: '已保存',
  renamed: '已重命名',
  savedToFolder: '已保存到目录',
  wsRecordedName: 'WS 录制于 {time}',
  savedWsExample: '已存为 WebSocket 示例',
  nameLabel: '名称',
  apiNamePlaceholder: '接口名称',
  folderLabel: '目录',

  /* ---------------- WsMessageLog ---------------- */
  directionOut: '↑ 发出',
  directionAck: '↩ 确认',
  directionIn: '↓ 收到',
  logOverflow: '只显示最近 2000 条，更早的 {n} 条已经丢弃。',
  truncatedNote: '这条消息超过了 64 KB，服务端只保留了前面一部分，长度显示的是原始大小。',
  empty: '还没有消息。',
  logBinarySummary: '（二进制内容，{size}）',
  logConnected: '已连接',
  logConnectedProtocol: '已连接，子协议 {protocol}',
  logClosed: '连接已关闭：code {code}',
  logClosedReason: '，{reason}',
  logError: '出错：{message}',

  /* ---------------- WsScenarioDialog ---------------- */
  scenarioTitle: '保存为 mock',
  scenarioPushLead: '连接后会推送',
  scenarioPushMid: '条，生成',
  scenarioRuleTail: '条规则',
  scenarioSkipLead: '，跳过',
  scenarioSkipTail: '条二进制消息',
  scenarioPeriod: '。',
  scenarioBinaryNote: '二进制消息没法按文本匹配，回放时不会出现。',
  scenarioCappedDelays: '有 {n} 处间隔超过 60 秒，按 60 秒保存（契约规定的上限）。',
  scenarioTruncated: '步骤总数超过 1000，只保留了前 1000 步，还有 {n} 步没有保存。',
  scenarioDuplicates: '有 {n} 条重复的发送消息。规则是「第一条匹配上的生效」，重复的那条和它收到的回复都回放不到，只保留了第一条规则。',
  scenarioGenerated: '生成的场景'
};
