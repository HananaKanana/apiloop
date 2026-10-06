/**
 * stores 区域：Pinia store 里的界面文字（`stores/`）—— 标签页标题、
 * 各调试页的状态 / 错误提示、默认名字。
 *
 * 这些地方拿不到 `useI18n()`，统一用 `@/i18n` 导出的 `t`；
 * 原来写死在模块顶层常量里的默认值都改成了**调用时再取**，切语言才会跟着变。
 */
export default {
  /* ---------------- 标签页标题 ---------------- */
  untitledApi: '未命名接口',
  newRequest: '新建请求',
  folderSettings: '目录设置',
  project: '项目',
  runnerTitle: '运行：{name}',
  testSuite: '测试集',
  loadTitle: '压测 · {name}',
  apiFallback: '接口',
  envDiff: '环境对比',
  historyRecord: '历史记录',

  /* ---------------- 提示 ---------------- */
  preflightRetried: 'token 失效，已自动登录并重发',
  newGroup: '新分组',
  loadNoProject: '还没有选中项目',
  loadFailed: '压测失败',
  runnerStopped: '已停止',
  runnerFailed: '请求失败',
  runnerWebBlocked: '网页版不能运行，请在客户端里使用',
  runnerNoSelection: '没有勾选任何接口',
  suiteRunFailed: '运行失败',
  disconnected: '已断开连接',

  /* ---------------- gRPC ---------------- */
  grpcCallFailed: '调用失败',
  grpcNoResult: '连接中断了，没有收到调用结果',
  grpcConnected: '已连接 {target}',
  grpcTls: '（TLS）',
  grpcMissing: '；这些变量没有值：{list}',
  grpcMetadata: '握手 metadata 已收到',
  grpcCallEnd: '调用结束：{status}',
  grpcUnknownStatus: '未知状态',
  grpcDetails: '（{details}）',
  grpcDuration: '，用时 {ms}ms',
  grpcTests: '；{passed}/{total} 条断言通过',
  grpcExtracted: '；提取了 {n} 个变量',
  grpcStreamFailed: '流式会话失败',
  grpcNoEndStatus: '连接中断了，没有收到结束状态',
  grpcDisconnected: '连接中断了',
  grpcNoSessionId: '服务端没有返回会话 id',
  grpcCreateFailed: '建会话失败',
  grpcHalfClosed: '已结束发送，等服务端把剩下的消息发完'
};
