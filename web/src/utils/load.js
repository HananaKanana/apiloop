/**
 * 简单压测的纯逻辑（第八轮第 2 节）。
 *
 * 和别的前端纯逻辑模块一样抽出来是为了能单独跑断言（`.vue` 里的东西不开浏览器验不了）。
 * 这里只放**规则**：参数范围与校验、标签页状态的形状、格式化、复制成文本、图表的坐标。
 * 真正跑的那一段在 `stores/load.js`，界面在 `components/load/`。
 */

/**
 * 参数范围：和服务端 `lib/load-runner.js` 的 `LIMITS` 是同一套。
 * 服务端那份是**把关的**（越界一律 400），这一份只用来限制输入框和提前提示。
 */
export const LOAD_LIMITS = {
  concurrency: { min: 1, max: 200, def: 10 },
  count: { min: 1, max: 100000, def: 1000 },
  durationSec: { min: 5, max: 600, def: 30 },
  rampUpSec: { min: 0, max: 60, def: 0 },
  timeoutMs: { min: 1, max: 300000, def: 10000 }
};

/** 设置项的初值（`okStatusText` 空 = 2xx / 3xx 算成功） */
export const DEFAULT_SETTINGS = {
  concurrency: LOAD_LIMITS.concurrency.def,
  mode: 'count',
  count: LOAD_LIMITS.count.def,
  durationSec: LOAD_LIMITS.durationSec.def,
  rampUpSec: LOAD_LIMITS.rampUpSec.def,
  timeoutMs: LOAD_LIMITS.timeoutMs.def,
  okStatusText: ''
};

/** 设置按接口记住，下次打开接着用 */
const STORE_PREFIX = 'apiloop.load.';

/** 环境名里出现这些字就当成生产环境，开始前要弹红色确认框 */
const PRODUCTION_WORDS = ['生产', '线上', 'prod'];

/** 数字输入的上下限（界面上直接绑给 n-input-number） */
export function limitOf(name) {
  return LOAD_LIMITS[name] || { min: 0, max: 0, def: 0 };
}

/** 把设置限制在范围内：界面上的输入框和 localStorage 里的旧值都过一遍 */
export function clampSettings(input) {
  const raw = input || {};
  const out = Object.assign({}, DEFAULT_SETTINGS, raw);

  Object.keys(LOAD_LIMITS).forEach(function (name) {
    const range = LOAD_LIMITS[name];
    const value = Number(out[name]);
    out[name] = Number.isFinite(value)
      ? Math.min(range.max, Math.max(range.min, Math.round(value)))
      : range.def;
  });

  out.mode = out.mode === 'duration' ? 'duration' : 'count';
  out.okStatusText = String(out.okStatusText || '').trim();
  return out;
}

export function readSettings(apiId) {
  if (!apiId) return null;
  try {
    const raw = localStorage.getItem(STORE_PREFIX + apiId);
    return raw ? clampSettings(JSON.parse(raw)) : null;
  } catch (err) {
    // 隐私模式 / 存坏了：当没存过
    return null;
  }
}

export function writeSettings(apiId, settings) {
  if (!apiId) return;
  try {
    localStorage.setItem(STORE_PREFIX + apiId, JSON.stringify(clampSettings(settings)));
  } catch (err) {
    // 存不下就只在这次生效
  }
}

/**
 * 「算成功的状态码」那一格：空 = 2xx / 3xx；否则是逗号分隔的状态码。
 * 写法不对**不静默忽略**：返回 error，界面在开始前就提示（服务端也会 400）。
 */
export function parseOkStatus(text) {
  const parts = String(text === undefined || text === null ? '' : text)
    .split(/[,，\s]+/)
    .filter(Boolean);

  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const value = Number(parts[i]);
    if (!Number.isInteger(value) || value < 100 || value > 599) {
      return { error: '「算成功的状态码」只能填 100 ~ 599 之间的整数，用逗号分开（比如 200,201）' };
    }
    if (out.indexOf(value) === -1) out.push(value);
  }
  return { value: out };
}

/** 发给服务端的 `load` 部分 */
export function loadPayload(settings) {
  const checked = clampSettings(settings);
  const okStatus = parseOkStatus(checked.okStatusText);
  if (okStatus.error) return { error: okStatus.error };

  return {
    value: {
      concurrency: checked.concurrency,
      mode: checked.mode,
      count: checked.count,
      durationSec: checked.durationSec,
      rampUpSec: checked.rampUpSec,
      timeoutMs: checked.timeoutMs,
      okStatus: okStatus.value
    }
  };
}

/** 环境名像不像生产 */
export function isProductionEnv(name) {
  const text = String(name || '').toLowerCase();
  return PRODUCTION_WORDS.some(function (word) { return text.indexOf(word) !== -1; });
}

/* ------------------------------------------------------------------ 状态 */

export function emptyLive() {
  return { sent: 0, ok: 0, failed: 0, active: 0, qps: 0, avgMs: 0, p95Ms: 0, elapsedMs: 0 };
}

/**
 * 一个压测标签页的运行状态，挂在 `tab.load` 上。
 *
 * **它比组件活得久**：运行中切到别的标签页，工作台会把正文组件卸载掉，
 * 跑的那一段必须活在 store 里才不会断（和「运行」标签页同一个道理）。
 */
export function emptyLoad(settings) {
  return {
    /** 选的环境。`undefined` 表示「跟当前环境」，用户在设置里选过就是那个 id */
    envId: undefined,
    settings: clampSettings(settings),
    running: false,
    status: '',
    error: '',
    missingVariables: [],
    /** 运行中每秒刷新的那几个数 */
    live: emptyLive(),
    /** 图上的点：一秒一个 `{ t, qps, avgMs, failed }` */
    ticks: [],
    /** 这一次的汇总 */
    summary: null,
    /** 上一次的汇总（留在下面「上次结果」里对比） */
    previous: null,
    /** 这次压的请求快照（开始那一刻拍的，之后改接口不影响） */
    request: null,
    startedAt: 0,
    finishedAt: 0,
    /** 取消句柄：关标签页 / 点停止时 abort 它 */
    controller: null
  };
}

/** 一秒一条 tick 折算成图上的一点 */
export function tickPoint(event) {
  return {
    t: event.t,
    qps: event.qps || 0,
    avgMs: event.secondAvgMs || 0,
    failed: event.failedInSecond || 0
  };
}

/* ------------------------------------------------------------------ 格式化 */

export function formatMs(value) {
  // 没有值就写「—」，别显示成 0 —— 「没测到」和「耗时是 0」是两回事
  if (value === null || value === undefined || value === '') return '—';

  const ms = Number(value);
  if (!Number.isFinite(ms)) return '—';
  if (ms < 1000) return Math.round(ms) + ' ms';
  return (ms / 1000).toFixed(2) + ' s';
}

export function formatCount(value) {
  return Number(value || 0).toLocaleString('zh-CN');
}

export function formatPercent(rate) {
  const value = Number(rate);
  if (!Number.isFinite(value)) return '—';
  return (value * 100).toFixed(2) + '%';
}

/** 用时：不到一分钟写秒，超过写「x 分 y 秒」 */
export function formatDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0));
  if (total < 60000) return (total / 1000).toFixed(1) + ' 秒';
  const minutes = Math.floor(total / 60000);
  const seconds = Math.round((total % 60000) / 1000);
  return minutes + ' 分 ' + seconds + ' 秒';
}

/** 「复制结果」用的纯文本 */
export function summaryText(summary, meta) {
  if (!summary) return '';
  const info = meta || {};
  const lines = [];

  lines.push('压测结果' + (info.method ? '（' + info.method + ' ' + (info.url || '') + '）' : ''));
  if (info.envName) lines.push('环境：' + info.envName);
  lines.push('并发 ' + summary.concurrency + ' · ' +
    (summary.mode === 'duration' ? '按时长 ' + summary.durationSec + ' 秒' : '按次数 ' + formatCount(summary.count)) +
    (summary.rampUpSec ? ' · 预热 ' + summary.rampUpSec + ' 秒' : ''));
  lines.push('总请求 ' + formatCount(summary.sent) + '　成功 ' + formatCount(summary.ok) +
    '　失败 ' + formatCount(summary.failed) + '　错误率 ' + formatPercent(summary.errorRate));
  lines.push('用时 ' + formatDuration(summary.durationMs) + '　QPS ' + summary.qps);
  lines.push('响应时间：最小 ' + formatMs(summary.minMs) + '　平均 ' + formatMs(summary.avgMs) +
    '　最大 ' + formatMs(summary.maxMs));
  lines.push('P50 ' + formatMs(summary.p50Ms) + '　P90 ' + formatMs(summary.p90Ms) +
    '　P95 ' + formatMs(summary.p95Ms) + '　P99 ' + formatMs(summary.p99Ms));

  if ((summary.statusCodes || []).length) {
    lines.push('状态码：' + summary.statusCodes.map(function (item) {
      return item.status + ' × ' + formatCount(item.count);
    }).join('，'));
  }
  (summary.errors || []).forEach(function (item) {
    lines.push('错误：' + item.group + ' × ' + formatCount(item.count) +
      (item.sample ? '（' + item.sample + '）' : ''));
  });

  return lines.join('\n');
}

/* ------------------------------------------------------------------ 图表 */

/**
 * 把每秒小结算成 SVG 的坐标（纯函数，好验）。
 *
 * 两条线共用横轴：左边是每秒请求数，右边是每秒平均响应时间；有失败的那一秒在底下
 * 画一根红条（高度按失败数占最大值的比例）。**不加图表库**，几百个点直接拼 path 就够了。
 *
 * @param {Array<{t, qps, avgMs, failed}>} rows
 * @returns {{width, height, plot: object, qpsPath, msPath, bars, xLabels, leftTicks, rightTicks, maxQps, maxMs}}
 */
export function chartGeometry(rows, options) {
  const opts = options || {};
  const width = opts.width || 680;
  const height = opts.height || 190;
  const pad = { top: 12, right: 46, bottom: 22, left: 46 };

  const list = (rows || []).filter(Boolean);
  const plotW = Math.max(1, width - pad.left - pad.right);
  const plotH = Math.max(1, height - pad.top - pad.bottom);

  function top(values) {
    const max = Math.max.apply(null, values.concat([0]));
    return max > 0 ? max : 1;
  }
  const maxQps = top(list.map(function (row) { return row.qps || 0; }));
  const maxMs = top(list.map(function (row) { return row.avgMs || 0; }));
  const maxFailed = top(list.map(function (row) { return row.failed || 0; }));

  const count = list.length;
  function xOf(index) {
    if (count <= 1) return pad.left + plotW / 2;
    return pad.left + (index * plotW) / (count - 1);
  }
  function yOf(value, max) {
    const ratio = Math.min(Math.max(value, 0), max) / max;
    return pad.top + plotH - ratio * plotH;
  }

  function pathOf(values, max) {
    return list.map(function (row, index) {
      const value = typeof values === 'function' ? values(row) : values;
      return (index ? 'L' : 'M') + xOf(index).toFixed(1) + ' ' + yOf(value, max).toFixed(1);
    }).join(' ');
  }

  /** 一根柱子的宽度：点少的时候别拉成一堵墙 */
  const barWidth = Math.max(2, Math.min(10, plotW / Math.max(count, 1) * 0.6));

  const bars = list.map(function (row, index) {
    if (!row.failed) return null;
    const value = (row.failed / maxFailed) * Math.min(26, plotH / 3);
    return {
      x: (xOf(index) - barWidth / 2).toFixed(1),
      y: (pad.top + plotH - value).toFixed(1),
      width: barWidth.toFixed(1),
      height: Math.max(2, value).toFixed(1),
      failed: row.failed,
      t: row.t
    };
  }).filter(Boolean);

  /** 横轴最多 6 个刻度 */
  const step = Math.max(1, Math.ceil(count / 6));
  const xLabels = [];
  for (let i = 0; i < count; i += step) {
    xLabels.push({ x: xOf(i).toFixed(1), text: list[i].t + 's' });
  }

  return {
    width: width,
    height: height,
    plot: { x: pad.left, y: pad.top, width: plotW, height: plotH },
    qpsPath: pathOf(function (row) { return row.qps || 0; }, maxQps),
    msPath: pathOf(function (row) { return row.avgMs || 0; }, maxMs),
    bars: bars,
    xLabels: xLabels,
    leftTicks: axisTicks(maxQps, pad.top, plotH),
    rightTicks: axisTicks(maxMs, pad.top, plotH),
    maxQps: maxQps,
    maxMs: maxMs
  };
}

/** 4 条横向刻度线（两条纵轴共用位置，值各算各的） */
function axisTicks(max, topY, plotH) {
  const ticks = [];
  for (let i = 0; i <= 4; i++) {
    const ratio = i / 4;
    ticks.push({
      y: (topY + plotH - ratio * plotH).toFixed(1),
      value: Math.round(max * ratio)
    });
  }
  return ticks;
}
