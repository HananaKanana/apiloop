/**
 * 变量作用域（契约第 5 节）。
 *
 * 优先级是「项目 < 目录（从外到内）< 环境」，后面的覆盖前面的 —— 和发送时服务端
 * 的解析顺序一致，前端算出来的「已定义 / 未定义」才不会和实际发出去的请求打架。
 *
 * 这里的三条规则要和后端 `lib/variables.js` **保持一致**（否则界面上的高亮会和
 * 实际发出去的请求对不上）：
 * - 变量名认 Unicode 字母（`\p{L}`），所以数据驱动里 CSV 的中文列名 `{{账号}}` 也算变量；
 * - `{{$手机号}}` 这类内置动态变量**不算未定义**（发送时每次重新生成）；
 * - 只有动态变量能带 `(...)` 参数，普通变量名里出现括号就不是变量。
 */

import { folderChain } from './tree';
import { DYNAMIC_NAMES } from './suggestions';

/** 和 lib/variables.js、lib/url-utils.js 同一套占位符写法 */
const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;

/** 变量名允许的字符：Unicode 字母、数字、下划线、点、短横、美元符 */
const NAME_PATTERN = /^[\p{L}\p{N}_.\-$]+$/u;

/** 动态变量的参数写法：`$randomInt(1,100)` */
const CALL_PATTERN = /^([\p{L}\p{N}_.\-$]+)\s*\(([^()]*)\)$/u;

function text(value) {
  return value === undefined || value === null ? '' : String(value);
}

/**
 * 把项目、目录链、环境上的变量合并成一份「名字 → 值」。
 *
 * @param {{project?: object, folders?: Array, folderId?: string|null, environment?: object}} input
 *        `folderId` 是**接口所在的目录**；`environment` 是当前选中的环境（没选就不传）
 * @returns {Map<string, {value: string, source: string, secret: boolean}>}
 */
export function resolveScope(input) {
  const options = input || {};
  const map = new Map();

  function add(rows, source) {
    (rows || []).forEach(function (row) {
      if (!row || row.enabled === false) return;
      const key = text(row.key);
      if (!key) return;
      map.set(key, {
        value: text(row.value),
        source: source,
        secret: row.secret === true
      });
    });
  }

  add(options.project && options.project.variables, '项目');

  // folderChain 给的是「从内到外」，拼变量要反过来：外层先，内层覆盖外层
  folderChain(options.folders, options.folderId).reverse().forEach(function (folder) {
    add(folder.variables, '目录「' + folder.name + '」');
  });

  if (options.environment) {
    add(options.environment.variables, '环境「' + options.environment.name + '」');
  }

  return map;
}

/**
 * 找出文本里所有的 `{{...}}`。
 *
 * 分四类，界面按类别上不同的颜色：
 * - `mock`    `{{@xxx}}`，mock 占位符（只在 mock 渲染时展开），不是变量；
 * - `dynamic` `{{$手机号}}` 这类内置动态变量，发送时每次重新生成，**不算未定义**；
 * - `var`     真正的变量，要去作用域里查；
 * - `literal` 名字里有不允许的字符（比如带了括号又不是动态变量），原样发出去。
 *
 * @returns {Array<{from: number, to: number, name: string, kind: 'var'|'dynamic'|'mock'|'literal'}>}
 */
export function findVariables(value) {
  const source = text(value);
  const list = [];

  // 带 g 的正则是有状态的，每次进来都要重置，否则第二次调用会从上次的位置继续
  PLACEHOLDER.lastIndex = 0;
  let matched = PLACEHOLDER.exec(source);
  while (matched) {
    const raw = text(matched[1]).trim();
    if (raw) {
      const from = matched.index;
      const to = matched.index + matched[0].length;

      if (raw.charAt(0) === '@') {
        list.push({ from: from, to: to, name: raw.slice(1), kind: 'mock' });
      } else {
        const call = CALL_PATTERN.exec(raw);
        const base = call ? call[1] : raw;
        const args = call ? call[2] : null;

        if (DYNAMIC_NAMES.has(base.toLowerCase())) {
          list.push({ from: from, to: to, name: base, args: args, kind: 'dynamic' });
        } else if (args === null && NAME_PATTERN.test(base)) {
          list.push({ from: from, to: to, name: base, kind: 'var' });
        } else {
          // 带括号的普通名字、或者名字里有空格这类字符：不是变量，发送时原样保留
          list.push({ from: from, to: to, name: base, args: args, kind: 'literal' });
        }
      }
    }
    matched = PLACEHOLDER.exec(source);
  }

  return list;
}

/** 一个请求里所有可能出现变量的地方 */
function specTexts(spec) {
  if (!spec) return [];

  const texts = [text(spec.url)];
  const params = spec.params || {};

  ['path', 'query', 'headers'].forEach(function (group) {
    (params[group] || []).forEach(function (row) {
      if (row && row.enabled !== false) texts.push(text(row.value));
    });
  });

  const body = spec.body || {};
  if (body.mode === 'raw') texts.push(text(body.raw));
  if (body.mode === 'graphql' && body.graphql) {
    texts.push(text(body.graphql.query));
    texts.push(text(body.graphql.variables));
  }
  (body.form || []).forEach(function (row) {
    if (row && row.enabled !== false) texts.push(text(row.value));
  });

  const auth = spec.auth || {};
  ['token', 'username', 'password', 'value'].forEach(function (key) {
    texts.push(text(auth[key]));
  });

  return texts;
}

/**
 * 这个请求里用到、但作用域里没有的变量（去重，按出现顺序）。
 * 发送**之前**就能算出来，用来在地址栏下面提前提示。
 *
 * 动态变量（`{{$手机号}}`）和 mock 占位符不算 —— 它们不需要定义。
 */
export function missingVariables(spec, scope) {
  const known = scope instanceof Map ? scope : new Map();
  const out = [];

  specTexts(spec).forEach(function (value) {
    findVariables(value).forEach(function (item) {
      if (item.kind !== 'var') return;
      if (known.has(item.name)) return;
      if (out.indexOf(item.name) === -1) out.push(item.name);
    });
  });

  return out;
}
