/**
 * runner 区域：`web/src/components/runner/` 下的界面文字
 * （批量运行标签页：要跑的请求、设置、汇总与结果）。
 *
 * 术语按 README.md 的术语表：Folder、Project、Environment、Assertion、
 * Test suite、History、Variable。
 * 专有名词不翻译：Mock、WebSocket。
 */
export default {
  /* ---------------- 共用 ---------------- */
  noEnvironment: '无环境',
  mockBuiltIn: 'Mock（内置）',

  /* ---------------- RunnerTab ---------------- */
  suiteName: '测试集 {stamp}',
  suiteSaved: '已存为测试集「{name}」',
  stopped: '已停止',
  failed: '失败',
  webBlocked: '网页版不能运行，请在客户端里使用',
  saveAsSuite: '存为测试集',
  stop: '停止',
  start: '开始运行',
  webBlockedHint: '网页版不能运行，请在客户端里使用（或让管理员在云端开启发送）',
  requestsTitle: '要跑的请求（{checked}/{total}）',
  unselectAll: '全不选',
  selectAll: '全选',
  unnamedApi: '(未命名接口)',
  emptyList: '这个{scope}里还没有接口',
  folder: '目录',
  project: '项目',
  environment: '环境',
  repeat: '次数',
  interval: '请求间隔',
  milliseconds: '毫秒',
  stopOnFail: '有断言失败时停下来',
  recordHistory: '记到历史里',
  progress: '共 {total} 个请求，已完成 {done}',
  assertions: '断言',
  passedWord: '通过',
  failedLabel: '失败 {n}',
  elapsed: '耗时 {time}',
  filterAll: '全部 {n}',
  filterFailed: '只看失败 {n}',
  roundNth: '第 {n} 次',
  noAssertions: '这个接口没有断言',
  running: '正在运行…',
  idleHint: '点右上角「开始运行」，按顺序把这些接口跑一遍',
  noFailedRequests: '没有失败的请求'
};
