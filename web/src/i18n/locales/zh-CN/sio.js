/**
 * sio 区域：`web/src/components/sio/` 下的界面文字
 * （Socket.IO 标签页）。
 *
 * 术语按 README.md：Socket.IO、WebSocket、Cookie、JSON、ack 等专有名词 / 协议术语不翻译。
 */
export default {
  /* ---------------- SioTab：状态 ---------------- */
  statusIdle: '未连接',
  statusOpen: '已连接',
  statusConnecting: '连接中…',
  statusError: '出错',
  statusClosed: '已断开',

  /* ---------------- SioTab：按钮 ---------------- */
  connect: '连接',
  reconnect: '重连',
  disconnect: '断开',
  save: '保存',
  send: '发送',
  saveAsCommon: '存为常用',

  /* ---------------- SioTab：提示 ---------------- */
  readonlyNotice: '只读角色：连接参数不能改，「连接」也不可用。',
  connectBlockedTooltip: '网页版不能连接，请在客户端里使用（或让管理员在云端开启发送）',
  connectBlocked: '网页版不能连接，请在客户端里使用',
  authInvalid: 'auth 不是合法的 JSON，暂时没有保存',
  connectFailed: '连接失败',
  notConnected: '还没有连接',
  eventNameRequired: '先写事件名',
  argsInvalid: '参数不是合法的 JSON',
  sendFailed: '发送失败',
  commonSaved: '已记下这条常用发送',
  saved: '已保存',

  /* ---------------- SioTab：选项 ---------------- */
  transportPolling: '先长轮询再升级',
  transportWebsocket: '只用 WebSocket',

  /* ---------------- SioTab：连接表单 ---------------- */
  titlePlaceholder: '接口名字',
  transportLabel: '传输方式',
  headerLabel: '请求头',
  headerPlaceholder: '头名',
  valuePlaceholder: '值',
  queryLabel: '查询参数',
  paramName: '参数名',
  authLabel: '鉴权（请求头 / 查询参数，和 HTTP 接口同一套规则）',
  handshakeAuthLabel: '握手 auth（JSON）',
  handshakeAuthNote: 'Socket.IO 的 auth 是握手时带过去的对象，和上面的鉴权不一样',
  listenEventsLabel: '监听的事件',
  listenEventsNote: '一行一个；留空表示监听全部事件',

  /* ---------------- SioTab：发送 ---------------- */
  eventNamePlaceholder: '事件名',
  waitAck: '等待确认（ack）',
  argsPlaceholder: '["你好", 1]',
  commonSends: '常用发送',
  noSends: '还没有常用发送。写一条事件、点「存为常用」，下次一点就发。',

  /* ---------------- SioTab：页签 ---------------- */
  tabConnect: '连接',
  tabSend: '发送',
  tabLog: '消息'
};
