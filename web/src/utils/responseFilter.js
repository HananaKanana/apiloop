import { JSONPath } from 'jsonpath-plus';

/**
 * 响应体的筛选（T37）：JSONPath 求值和「按关键字切行」两件事的**纯函数**，
 * 组件只负责显示。放在 utils 里是为了能单独拿真实数据跑一遍（不进仓库的临时脚本）。
 *
 * 两个模式：
 * - **JSONPath**：`$.data.list[*].id` 这种表达式，取出来的每个结果都带**它自己的路径**
 *   （jsonpath-plus 给的是 `$['data']['list'][0]['id']` 这种括号写法，这里转成 `$.data.list[0].id`）；
 * - **关键字**：把响应体按行切开，只留命中行（带行号）。JSON 响应会先格式化再切 ——
 *   没格式化的 JSON 是**一行**，按行筛等于没筛。
 */

/** 关键字模式最多显示多少行（再多就是「全中」，显示出来也没意义） */
export const MAX_FILTER_LINES = 5000;

/** 每个接口最多记几条最近用过的 JSONPath */
export const RECENT_LIMIT = 5;

/** localStorage 的键前缀（按接口 id 分开存） */
const RECENT_PREFIX = 'apiloop.jsonpath.';

/**
 * 把响应体变成「按行筛」用的多行文本：JSON 先按 2 空格缩进格式化，其余原样。
 *
 * 格式化失败（用户手动把格式选成了 JSON 但其实不是）就退回原文 —— 筛选不该因此报错。
 */
export function toFilterText(text, language) {
  const source = String(text === undefined || text === null ? '' : text);
  if (language !== 'json') return source;
  try {
    return JSON.stringify(JSON.parse(source), null, 2);
  } catch (err) {
    return source;
  }
}

/**
 * 关键字筛选。
 *
 * @param {string} text 已经格式化好的多行文本（见 `toFilterText`）
 * @param {string} keyword
 * @param {{caseSensitive?: boolean}} [options]
 * @returns {{ lines: Array<{no: number, text: string}>, total: number, truncated: boolean }}
 *          `lines` 已经截到 `MAX_FILTER_LINES` 条，`total` 是命中总数
 */
export function filterByKeyword(text, keyword, options) {
  const needle = String(keyword === undefined || keyword === null ? '' : keyword);
  if (!needle) return { lines: [], total: 0, truncated: false };

  const caseSensitive = Boolean(options && options.caseSensitive);
  const find = caseSensitive ? needle : needle.toLowerCase();
  const all = String(text === undefined || text === null ? '' : text).split('\n');

  const hits = [];
  for (let i = 0; i < all.length; i++) {
    const line = all[i];
    const hay = caseSensitive ? line : line.toLowerCase();
    if (hay.indexOf(find) === -1) continue;
    hits.push({ no: i + 1, text: line });
    // 命中太多就别再往下扫了：反正也只显示前 5000 条，扫完整个几百 KB 的响应白费
    if (hits.length > MAX_FILTER_LINES) break;
  }

  return {
    lines: hits.slice(0, MAX_FILTER_LINES),
    total: hits.length,
    truncated: hits.length > MAX_FILTER_LINES
  };
}

/**
 * jsonpath-plus 给的是 `$['data']['list'][0]['id']`，转成用户眼熟的 `$.data.list[0].id`。
 * 名字不是合法标识符（带空格、带点）时保留括号写法。
 */
export function toDotPath(path) {
  return String(path === undefined || path === null ? '' : path)
    .replace(/\[(?:'([^']*)'|"([^"]*)")\]/g, function (whole, single, double) {
      const name = single === undefined ? double : single;
      if (name === undefined) return whole;
      return /^[A-Za-z_$][\w$]*$/.test(name) ? '.' + name : "['" + name + "']";
    });
}

/**
 * JSONPath 求值。
 *
 * @param {string} text 响应体原文（不是格式化后的 —— 这里自己 parse）
 * @param {string} expression
 * @returns {{ ok: boolean, error: string, results: Array<{path: string, value: any}> }}
 *          `error` 是给用户看的原文（jsonpath-plus 的报错），调用方前面再加一句中文说明
 */
export function evaluateJsonPath(text, expression) {
  const expr = String(expression === undefined || expression === null ? '' : expression).trim();
  if (!expr) return { ok: true, error: '', results: [] };

  let json;
  try {
    json = JSON.parse(String(text === undefined || text === null ? '' : text));
  } catch (err) {
    // 调用方在非 JSON 时会把 JSONPath 模式灰掉，正常走不到这里
    return { ok: false, error: 'not-json', results: [] };
  }

  try {
    const raw = JSONPath({ path: expr, json: json, resultType: 'all', wrap: true });
    const list = Array.isArray(raw) ? raw : [];
    return {
      ok: true,
      error: '',
      results: list.map(function (item) {
        return { path: toDotPath(item.path), value: item.value };
      })
    };
  } catch (err) {
    return { ok: false, error: (err && err.message) || 'invalid', results: [] };
  }
}

/* ---------------- 最近用过的表达式（按接口存 localStorage） ---------------- */

function storage() {
  try {
    return window.localStorage;
  } catch (err) {
    return null;
  }
}

/** 这个接口最近用过的 JSONPath，最新的在前。读不出来就是空数组 */
export function readRecentPaths(apiId) {
  if (!apiId) return [];
  const box = storage();
  if (!box) return [];

  try {
    const parsed = JSON.parse(box.getItem(RECENT_PREFIX + apiId) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(function (item) { return typeof item === 'string' && item; }).slice(0, RECENT_LIMIT);
  } catch (err) {
    return [];
  }
}

/**
 * 记一条用过的表达式（去重、最新的在前、最多 5 条）。返回更新后的列表。
 *
 * 什么时候算「用过」由调用方决定（这里在筛选真的算出结果时才记）。
 */
export function pushRecentPath(apiId, expression) {
  const expr = String(expression === undefined || expression === null ? '' : expression).trim();
  if (!apiId || !expr) return readRecentPaths(apiId);

  const next = [expr].concat(readRecentPaths(apiId).filter(function (item) { return item !== expr; }))
    .slice(0, RECENT_LIMIT);

  const box = storage();
  if (box) {
    try {
      box.setItem(RECENT_PREFIX + apiId, JSON.stringify(next));
    } catch (err) {
      // 存不下就算了，这次会话里照样能用
    }
  }
  return next;
}
