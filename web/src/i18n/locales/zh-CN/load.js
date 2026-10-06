/**
 * load 区域：`web/src/components/load/` 下的界面文字
 * （压测设置、运行中的数字、结果汇总、实时曲线）。
 *
 * 术语按 README.md 的术语表：Environment、Variable。
 * 专有名词不翻译：QPS、Mock。
 *
 * 注意：消息里出现 `{{变量}}` 这种字面量时，vue-i18n 的 `{}` 是插值语法，
 * 必须写成 `{'...'}` 字面量转义（`{{` 写成 `{'{'}{'{'}`），否则编译报
 * 「Not allowed nest placeholder」。
 */
export default {
  /* ---------------- 共用 ---------------- */
  noEnvironment: '无环境',
  mockBuiltIn: 'Mock（内置）',
  listSeparator: '、',

  /* ---------------- LoadTab ---------------- */
  environment: '环境',
  concurrency: '并发数',
  stopCondition: '停止条件',
  byCount: '按次数',
  byDuration: '按时长',
  seconds: '秒',
  rampUp: '预热',
  timeout: '超时',
  milliseconds: '毫秒',
  countAsSuccess: '算成功',
  okStatusPlaceholder: '留空是 2xx 和 3xx，也可以写 200,201',
  hint: '压测只看状态码和响应时间：不跑脚本、不跑断言、不记历史。变量在开始时按环境算一次。',
  stop: '停止',
  start: '开始压测',
  blockedNotice: '网页版不能压测，请在客户端里使用。',
  blockedHint: '网页版不能压测，请在客户端里使用',
  pressureWarning: '压测会对目标服务器产生真实压力，请先和接口负责人确认',
  varExample: "{'{'}{'{'}名字{'}'}{'}'}",
  missingVariables: '这些变量没有值，地址里会原样带着 {example} 发出去：{vars}',
  prodTitle: '压测生产环境',
  prodConfirm: '你要压测的是生产环境：{env}。确定继续吗？',
  prodContinue: '继续压测',
  statusFinished: '跑完了',
  statusStopped: '已停止',
  statusError: '出错了',
  resultCopied: '已复制结果',
  copyResult: '复制结果',
  sent: '已发',
  success: '成功',
  failed: '失败',
  currentQps: '当前 QPS',
  avgResponse: '平均响应',
  active: '进行中',
  elapsedTime: '已用时间',
  totalRequests: '总请求',
  errorRate: '错误率',
  totalDuration: '总用时',
  avgQps: '平均 QPS',
  min: '最小',
  avg: '平均',
  max: '最大',
  statusCodesTitle: '状态码分布',
  noResponses: '没有拿到任何响应',
  errorsTitle: '错误分组',
  noNetworkErrors: '没有网络错误（状态码不对的都算失败，见左边的状态码分布）',
  aborted: '有 {n} 个请求在停止时被取消，它们既不算成功也不算失败。',
  previousTitle: '上次结果',
  previousSummary:
    '总请求 {sent} · 成功 {ok} · 失败 {failed}（{rate}）· 平均 {avg} · P95 {p95} · QPS {qps} · 用时 {duration}',

  /* ---------------- LoadChart ---------------- */
  legendQps: '每秒请求数',
  legendMs: '每秒平均响应时间',
  legendFailed: '有失败的那一秒',
  chartEmpty: '还没有数据',
  chartAria: '压测曲线'
};
