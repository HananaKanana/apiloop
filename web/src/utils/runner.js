/**
 * 批量运行的纯逻辑（第 2 节）：状态形状、一行结果的形状、以及把服务端返回的一次发送
 * 折算成「这一行过没过」。
 *
 * 放在 utils 里而不是 store 里，是因为**标签页的创建**（`stores/tabs.js` 的 openRunner）
 * 也要造一份初始状态 —— 两边各写一份形状迟早会对不上。这里不碰 store、不碰网络，
 * 真正跑的那一段在 `stores/runner.js`。
 */

/**
 * 一个「运行」标签页的运行状态。全部挂在 `tab.runner` 上：**它比组件活得久** ——
 * 运行中切到别的标签页，组件会被卸载，但跑的那一段不能断。
 */
export function emptyRunner() {
  return {
    /** 勾掉的接口 id（默认全选，所以记的是「不跑哪些」） */
    excluded: [],
    /** 选的环境。`undefined` 表示「跟当前环境」，用户在设置里选过就是那个 id */
    envId: undefined,
    /** 每个接口跑几遍（1–100） */
    repeat: 1,
    /** 每个请求之间等多久（毫秒） */
    intervalMs: 0,
    /** 有断言失败就停下来 */
    stopOnFail: false,
    /** 记到历史里（默认不勾：一次几十个请求，全记下来会把历史刷满） */
    recordHistory: false,

    running: false,
    /** 用户点了「停止」（或者标签页被关掉）：当前请求收尾后不再往下发 */
    stopRequested: false,
    /** 一行一次请求，按发出的顺序 */
    results: [],
    startedAt: 0,
    finishedAt: 0,
    /** 计划发几个（接口数 × 次数）和已经发完几个 */
    total: 0,
    done: 0,
    /** 正在跑的那次请求的取消句柄（关标签页时直接 abort 它） */
    controller: null,
    /** 没跑起来的原因（比如一个接口都没勾） */
    error: ''
  };
}

/**
 * 一行结果。`round` 是第几遍（次数 > 1 时同一个接口会出现多行）。
 *
 * 字段随执行过程被就地填上（`applyRunnerResult`），所以先用占位值建出来，
 * 界面上一行立刻出现、显示成「…」，跑完再变成结果 —— 不然一屏请求要等最后才有反馈。
 */
export function runnerRow(round, node) {
  return {
    key: round + ':' + node.id,
    round: round,
    apiId: node.id,
    name: node.name || '(未命名接口)',
    method: String((node.api && node.api.method) || 'GET').toUpperCase(),
    url: (node.api && node.api.url) || '',
    pending: true,
    /** 响应状态码；没收到响应时是 null */
    status: null,
    statusText: '',
    /** 这次请求的耗时（毫秒） */
    ms: null,
    passed: 0,
    total: 0,
    tests: [],
    console: [],
    /** 请求本身失败（连不上、超时……）或者有断言没过 */
    failed: false,
    /** 被「停止」中断 */
    aborted: false,
    error: '',
    /** 展开看断言详情 */
    open: false
  };
}

/**
 * 把服务端 `/send` 返回的 `result` 折算到一行上。
 *
 * 「失败」有两种，都要算：**请求本身出错**（`result.error`）和**断言没过**。
 * 一个断言都没有的接口不算失败 —— 它只是没得可断言。
 */
export function applyRunnerResult(row, result) {
  row.pending = false;

  if (!result) {
    row.error = '服务端没有返回结果';
    row.failed = true;
    return row;
  }

  if (result.response) {
    row.status = result.response.status;
    row.statusText = result.response.statusText || '';
  }
  row.ms = result.timings ? result.timings.total : null;

  const scripts = result.scripts || null;
  row.tests = (scripts && scripts.tests) || [];
  row.console = (scripts && scripts.console) || [];
  row.passed = row.tests.filter(function (item) { return item.passed; }).length;
  row.total = row.tests.length;

  if (result.error) row.error = result.error.message || result.error.code || '请求失败';
  row.failed = Boolean(result.error) || row.passed !== row.total;

  return row;
}

/** 顶部汇总：几个请求、断言通过 / 失败多少 */
export function runnerSummary(runner) {
  const rows = (runner && runner.results) || [];
  let passed = 0;
  let total = 0;
  let failedRows = 0;

  rows.forEach(function (row) {
    if (row.failed) failedRows += 1;
    passed += row.passed || 0;
    total += row.total || 0;
  });

  return {
    requests: rows.length,
    failedRows: failedRows,
    passed: passed,
    total: total,
    failed: total - passed
  };
}
