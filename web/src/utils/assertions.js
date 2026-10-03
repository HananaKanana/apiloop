/**
 * 断言 / 提取变量这两张表的纯逻辑（第六轮第 1 节）。
 *
 * 和别的前端纯逻辑模块一样抽出来是为了能单独跑断言（`.vue` 里的东西不开浏览器验不了，
 * 见 skill `apiloop-selftest-harness`）。这里只放**规则**，不放界面。
 *
 * 三份清单（能选什么、每种「检查什么」下有哪些比较方式、哪些比较方式不用填期望值）
 * 和服务端 `lib/assertions.js` 是**同一套**，改一边记得改另一边 —— 服务端那份是执行时的
 * 依据，它会把界面上多送的行丢掉（`toAssertions`）。
 */

/** 检查什么 */
export const SOURCE_OPTIONS = [
  { label: '状态码', value: 'status' },
  { label: '响应时间（毫秒）', value: 'time' },
  { label: '响应头', value: 'header' },
  { label: 'JSON 字段', value: 'json' },
  { label: '响应文本', value: 'text' }
];

export const SOURCE_LABELS = {
  status: '状态码',
  time: '响应时间',
  header: '响应头',
  json: 'JSON 字段',
  text: '响应文本'
};

export const OP_LABELS = {
  eq: '等于',
  ne: '不等于',
  gt: '大于',
  lt: '小于',
  contains: '包含',
  notContains: '不包含',
  exists: '存在',
  notExists: '不存在',
  empty: '为空',
  notEmpty: '不为空',
  regex: '匹配正则',
  type: '类型是'
};

/**
 * 每种「检查什么」下真正有意义的比较方式。状态码、响应时间只比大小；「存在 / 不存在」
 * 只给响应头和 JSON 字段（响应文本和状态码永远存在，列出来只会让人选错）。
 */
export const OPS_BY_SOURCE = {
  status: ['eq', 'ne', 'gt', 'lt'],
  time: ['eq', 'ne', 'gt', 'lt'],
  header: ['eq', 'ne', 'contains', 'notContains', 'exists', 'notExists', 'empty', 'notEmpty', 'regex'],
  json: ['eq', 'ne', 'gt', 'lt', 'contains', 'notContains', 'exists', 'notExists',
    'empty', 'notEmpty', 'regex', 'type'],
  text: ['eq', 'ne', 'contains', 'notContains', 'empty', 'notEmpty', 'regex']
};

/** 不用填期望值的比较方式 */
export const NO_VALUE_OPS = { exists: true, notExists: true, empty: true, notEmpty: true };

export const TYPES = ['string', 'number', 'boolean', 'object', 'array', 'null'];

/** 「类型是」的下拉选项 */
export const TYPE_OPTIONS = TYPES.map(function (value) { return { label: value, value: value }; });

export const EXTRACT_SOURCE_OPTIONS = [
  { label: 'JSON 字段', value: 'json' },
  { label: '响应头', value: 'header' },
  { label: '响应文本里的正则第 1 组', value: 'regex' }
];

export const SCOPE_OPTIONS = [
  { label: '环境', value: 'environment' },
  { label: '项目', value: 'project' }
];

/** 那一列在不同来源下的标题不一样（同一个 `path` 字段三种用法） */
export const PATH_PLACEHOLDER = {
  status: '',
  time: '',
  header: '响应头名称，比如 X-Trace-Id',
  json: '字段路径，比如 data.list[0].id',
  text: ''
};

export const EXTRACT_PATH_PLACEHOLDER = {
  json: '字段路径，比如 data.token',
  header: '响应头名称，比如 Authorization',
  regex: '正则，取第 1 个括号里的内容'
};

/** 表格下面的一键添加 */
export const PRESETS = [
  { label: '状态码是 200', row: { source: 'status', op: 'eq', value: '200' } },
  { label: '响应时间 < 1000ms', row: { source: 'time', op: 'lt', value: '1000' } },
  { label: 'code 等于 0', row: { source: 'json', path: 'code', op: 'eq', value: '0' } }
];

/** 行的 id：只给界面用（高亮刚加的那一行、v-for 的 key），不进契约 */
export function newId(prefix) {
  return (prefix || 'r') + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export function newAssertion(partial) {
  return Object.assign({
    id: newId('a'),
    enabled: true,
    source: 'status',
    path: '',
    op: 'eq',
    value: ''
  }, partial || {});
}

export function newExtract(partial) {
  return Object.assign({
    id: newId('e'),
    enabled: true,
    source: 'json',
    path: '',
    scope: 'environment',
    name: ''
  }, partial || {});
}

/** 这个来源下可选的比较方式，转成下拉要的形状 */
export function opOptions(source) {
  return (OPS_BY_SOURCE[source] || []).map(function (value) {
    return { label: OP_LABELS[value] || value, value: value };
  });
}

/** 换「检查什么」时要顺手把比较方式修正到合法值，不然会留下一个服务端不认的组合 */
export function withSource(row, source) {
  const ops = OPS_BY_SOURCE[source] || [];
  const op = ops.indexOf(row.op) === -1 ? ops[0] : row.op;
  return Object.assign({}, row, { source: source, op: op });
}

/** 值转文本（预览和下发给服务端都用文本，和服务端 `textOf` 一个口径） */
export function valueText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch (err) {
      return String(value);
    }
  }
  return String(value);
}

/** 路径最后一段当变量名：`data.list[0].token` → `token`，`a.b` → `b` */
export function defaultVarName(path) {
  const text = String(path || '').replace(/\[[^\]]*\]/g, '');
  const parts = text.split('.').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

/**
 * 「为这个字段加断言」：原始值直接写成期望值，比较方式用「等于」（对象 / 数组这类
 * 容器没有可读的文本可比，用「存在」）。
 */
export function assertionFromField(path, value) {
  const container = Boolean(value) && typeof value === 'object';
  return newAssertion({
    source: 'json',
    path: String(path || ''),
    op: container ? 'exists' : 'eq',
    value: container ? '' : valueText(value)
  });
}

/** 「提取为变量」：变量名默认取字段名的最后一段 */
export function extractFromField(path) {
  return newExtract({
    source: 'json',
    path: String(path || ''),
    scope: 'environment',
    name: defaultVarName(path)
  });
}

/** 页签上的小圆点：有没有启用着的行 */
export function hasEnabled(rows) {
  return (rows || []).some(function (row) { return row && row.enabled !== false; });
}

/** 这一行是不是还缺东西（缺的行在下发前提示一下，服务端会直接丢掉它） */
export function rowIncomplete(row) {
  if (row.source === 'header' || row.source === 'json') return !String(row.path || '').trim();
  return false;
}
