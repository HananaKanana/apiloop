/**
 * 把一段 JSON 摊平成「字段列表」（第六轮第 1 节）。
 *
 * 响应面板的「字段」视图用它：一行一个字段，路径就是断言 / 提取要填的那个路径
 * （`data.list[0].id`），点一下就能给这个字段加断言或提取成变量。
 *
 * 为什么不直接用现成的树组件：我们要的是**路径**，不是好看的折叠树 ——
 * 路径得和后端 `lib/assertions.js` 的取值规则对得上，一处「显示的是 a.b、实际取的是 a.c」
 * 就会让用户对着一个永远不通过的断言发懵。
 *
 * 纯函数（不碰 DOM、不 import 任何东西），所以能单独跑断言。
 */

/** 最多列多少个字段：几万个字段的响应摊平了会把页面卡住，而且人也不会往下翻 */
export const MAX_ROWS = 500;

/** 一行里的值最长显示多少字（字符串字段可能很长） */
const PREVIEW_LIMIT = 160;

/**
 * 超出安全整数范围的整数保留原文（19 位雪花 ID 直接 JSON.parse 会变成 …7000）。
 * 和 `lib/assertions.js` / `lib/openapi-export.js` 是同一套写法。
 */
export function keepHugeIntegers(key, value, context) {
  if (typeof value === 'number' && !Number.isSafeInteger(value) &&
    context && typeof context.source === 'string' && /^-?\d+$/.test(context.source)) {
    return context.source;
  }
  return value;
}

export function parseJson(text) {
  const source = String(text === undefined || text === null ? '' : text);
  if (!source.trim()) return { ok: false, reason: '响应体是空的' };

  try {
    return { ok: true, value: JSON.parse(source, keepHugeIntegers) };
  } catch (err) {
    return { ok: false, reason: '响应不是合法的 JSON' };
  }
}

export function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

export function previewOf(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') {
    return value.length > PREVIEW_LIMIT ? value.slice(0, PREVIEW_LIMIT) + '…' : value;
  }
  if (typeof value === 'object') return '';
  return String(value);
}

/**
 * 摊平。
 *
 * @param {string|any} text 响应体原文（也可以是已经 parse 好的值）
 * @returns {{ok: true, rows: Array, truncated: boolean} | {ok: false, reason: string}}
 *   row = `{ path, label, depth, type, preview, value, container }`；
 *   `path` 就是给断言 / 提取用的路径；**根那一层不作为一行**（它没有路径）。
 */
export function buildJsonRows(text) {
  const parsed = typeof text === 'string' || text === undefined || text === null
    ? parseJson(text)
    : { ok: true, value: text };
  if (!parsed.ok) return { ok: false, reason: parsed.reason };

  const root = parsed.value;
  if (root === null || typeof root !== 'object') {
    // 顶层就是个标量（`"abc"`、`123`）：没有字段可点，但也算不上错误
    return { ok: true, rows: [], truncated: false };
  }

  const rows = [];
  let truncated = false;

  function push(row) {
    if (rows.length >= MAX_ROWS) {
      truncated = true;
      return false;
    }
    rows.push(row);
    return true;
  }

  function walk(value, path, label, depth) {
    const type = typeOf(value);

    if (type !== 'object' && type !== 'array') {
      push({ path, label, depth, type, preview: previewOf(value), value, container: false });
      return;
    }

    const container = type === 'array';
    const count = container ? value.length : Object.keys(value).length;
    push({
      path,
      label,
      depth,
      type,
      preview: count ? (container ? '[' + count + ' 项]' : count + ' 个字段') : '（空）',
      value,
      container: true
    });
    if (rows.length >= MAX_ROWS) return;

    if (container) {
      value.forEach(function (item, index) {
        walk(item, path + '[' + index + ']', '[' + index + ']', depth + 1);
      });
      return;
    }

    Object.keys(value).forEach(function (key) {
      walk(value[key], path ? path + '.' + key : key, key, depth + 1);
    });
  }

  if (Array.isArray(root)) {
    root.forEach(function (item, index) {
      walk(item, '[' + index + ']', '[' + index + ']', 0);
    });
  } else {
    Object.keys(root).forEach(function (key) {
      walk(root[key], key, key, 0);
    });
  }

  return { ok: true, rows, truncated };
}
