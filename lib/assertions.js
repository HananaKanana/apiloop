/**
 * 可视化断言与提取变量（第六轮第 1 节）。
 *
 * 测试同事、前端同事多数不会写 JavaScript，也记不住 `pm.*` 的写法，所以把两件最常用的
 * 事做成表格：
 *
 *   - **断言**：状态码 / 响应时间 / 响应头 / JSON 字段 / 响应文本，用一组固定的比较方式判定；
 *   - **提取变量**：把响应里的某个值（JSON 字段 / 响应头 / 正则第 1 组）存进环境或项目变量，
 *     下一个请求就能 `{{token}}` 用上。
 *
 * 这个文件**全是纯函数**（不读库、不发请求、不碰 req/res），执行时由 `lib/send-core.js`
 * 调用。放这么干净是为了能拿一份假响应直接跑断言 —— `.vue` 和 send-core 里的逻辑没法这么验。
 *
 * 三个容易想歪的地方，先说清楚：
 *
 * 1. **「取不到值」和「值为空」是两件事**：JSON 路径取不到 → 那个值算「不存在」，
 *    所以 `存在` 不通过、`不存在` 通过，而别的方式一律不通过并写明「没有这个字段」；
 *    `为空` 指的是**存在但为空**（空串 / null / 空数组 / 空对象）。混在一起的话，
 *    「接口少返回了一个字段」和「字段返回了但是空」在结果里长得一模一样。
 * 2. **数字比较两边都转数字**：`code 等于 0` 时响应里的 `0` 是数字、用户填的 `"0"` 是字符串，
 *    不转的话永远不通过。转不了就**不通过并写清是谁转不了**，不猜。
 * 3. **JSON 解析要保住超出安全范围的整数**：`JSON.parse` 会把 19 位雪花 ID 变成
 *    `…7000`，于是「id 等于 12345678901234567890」永远不通过（`lib/openapi-export.js`
 *    里有同一套写法）。
 */

var variables = require('./variables');

/** 检查什么（顺序也是界面上下拉的顺序） */
var SOURCES = ['status', 'time', 'header', 'json', 'text'];

/** 比较方式 */
var OPS = ['eq', 'ne', 'gt', 'lt', 'contains', 'notContains',
    'exists', 'notExists', 'empty', 'notEmpty', 'regex', 'type'];

/**
 * 每种「检查什么」下真正有意义的比较方式。界面按这个过滤，服务端按这个校验 ——
 * 两边不会各写一套。
 *
 * - 状态码、响应时间：只比大小，没有「包含」这一说；
 * - 响应头、JSON 字段：全能，但「包含」是文本包含；
 * - 响应文本：整段比大小没意义。
 */
var OPS_BY_SOURCE = {
    status: ['eq', 'ne', 'gt', 'lt'],
    time: ['eq', 'ne', 'gt', 'lt'],
    header: ['eq', 'ne', 'contains', 'notContains', 'exists', 'notExists', 'empty', 'notEmpty', 'regex'],
    json: OPS.slice(),
    text: ['eq', 'ne', 'contains', 'notContains', 'empty', 'notEmpty', 'regex']
};

/** 中文名字：断言结果显示给人看的就是它，界面上的下拉共用 */
var SOURCE_LABELS = {
    status: '状态码',
    time: '响应时间',
    header: '响应头',
    json: 'JSON 字段',
    text: '响应文本'
};

var OP_LABELS = {
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

/** 不用填期望值的比较方式（界面上把输入框灰掉） */
var NO_VALUE_OPS = { exists: true, notExists: true, empty: true, notEmpty: true };

/** 「类型是」允许的期望值 */
var TYPES = ['string', 'number', 'boolean', 'object', 'array', 'null'];

/** 提取变量的来源与去处 */
var EXTRACT_SOURCES = ['json', 'header', 'regex'];
var SCOPES = ['environment', 'project'];

var EXTRACT_SOURCE_LABELS = { json: 'JSON 字段', header: '响应头', regex: '响应文本里的正则第 1 组' };
var SCOPE_LABELS = { environment: '环境', project: '项目' };

/**
 * 超过这个大小的响应不做 JSON 解析。一次请求几 MB 的 JSON 解析起来要几百毫秒，
 * 而用户要的只是「这个字段对不对」—— 与其卡一下，不如给一条说得清的「没通过」。
 */
var MAX_JSON_BYTES = 5 * 1024 * 1024;

/** 提取出来的值在控制台里最多显示多少个字 */
var CONSOLE_VALUE_LIMIT = 20;

function str(value) {
    return value === null || value === undefined ? '' : String(value);
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/* ------------------------------------------------------------------ 清洗 */

/**
 * 断言行：`{ id, enabled, source, path, op, value }`。
 *
 * 读的时候宽容（库里可能存着写坏的 / 老版本的行），认不出来的直接丢掉 ——
 * 一条坏断言不该让整个接口 500。`header` / `json` 没有字段名的行也丢：
 * 那种行跑起来只会得到一句「没有这个字段」，留着是噪音。
 */
function toAssertions(list) {
    if (!Array.isArray(list)) return [];

    var out = [];
    list.forEach(function (item) {
        if (!item || typeof item !== 'object') return;

        var source = str(item.source);
        var op = str(item.op);
        if (SOURCES.indexOf(source) === -1) return;
        if (OPS_BY_SOURCE[source].indexOf(op) === -1) return;

        var path = str(item.path).trim();
        if ((source === 'header' || source === 'json') && !path) return;

        out.push({
            id: str(item.id) || 'a' + out.length,
            enabled: item.enabled !== false,
            source: source,
            path: path,
            op: op,
            value: str(item.value)
        });
    });

    return out;
}

/**
 * 提取行：`{ id, enabled, source, path, scope, name }`。
 * `path` 一列三用：JSON 路径 / 响应头名 / 正则原文（和界面上那一列的标题一致）。
 */
function toExtracts(list) {
    if (!Array.isArray(list)) return [];

    var out = [];
    list.forEach(function (item) {
        if (!item || typeof item !== 'object') return;

        var source = str(item.source);
        if (EXTRACT_SOURCES.indexOf(source) === -1) return;

        var scope = str(item.scope) || 'environment';
        if (SCOPES.indexOf(scope) === -1) return;

        var path = str(item.path).trim();
        var name = str(item.name).trim();
        if (!path || !name) return;

        out.push({
            id: str(item.id) || 'e' + out.length,
            enabled: item.enabled !== false,
            source: source,
            path: path,
            scope: scope,
            name: name
        });
    });

    return out;
}

/* ------------------------------------------------------------------ JSON */

/**
 * 超出安全整数范围的整数保留原文（变成字符串）。见文件头的第 3 条。
 * 用的是 `JSON.parse` 的第三个参数 `context.source`（Node 22 起有）。
 */
function keepHugeIntegers(key, value, context) {
    if (typeof value === 'number' && !Number.isSafeInteger(value) &&
        context && typeof context.source === 'string' && /^-?\d+$/.test(context.source)) {
        return context.source;
    }
    return value;
}

/** @returns {{ok: true, value: any} | {ok: false, reason: string}} */
function parseJson(text) {
    var source = typeof text === 'string' ? text : '';
    if (!source.trim()) return { ok: false, reason: '响应体是空的' };

    try {
        return { ok: true, value: JSON.parse(source, keepHugeIntegers) };
    } catch (err) {
        return { ok: false, reason: '响应不是合法的 JSON' };
    }
}

/**
 * JSON 路径 → 一段一段的键。
 *
 * 收 `data.list[0].id`、`$.data.id`、`['a b'].c` 这几种写法；`$.` 和开头的 `$` 去掉即可。
 * 路径写得不成对（`a[0`）时返回 null，由调用方判成「取不到值」——
 * 路径写错了和字段不存在，在用户看来是同一件事（都是「没有这个字段」）。
 */
function parsePath(path) {
    var text = str(path).trim();
    if (text === '$') return [];
    if (text.indexOf('$.') === 0) text = text.slice(2);

    var tokens = [];
    var i = 0;

    while (i < text.length) {
        var ch = text.charAt(i);

        if (ch === '.') { i += 1; continue; }

        if (ch === '[') {
            var end = text.indexOf(']', i);
            if (end === -1) return null;

            var inner = text.slice(i + 1, end).trim();
            var quote = inner.charAt(0);
            if (inner.length >= 2 && (quote === "'" || quote === '"') && inner.charAt(inner.length - 1) === quote) {
                tokens.push(inner.slice(1, -1));
            } else if (/^\d+$/.test(inner)) {
                tokens.push(Number(inner));
            } else if (inner) {
                tokens.push(inner);
            } else {
                return null;
            }

            i = end + 1;
            continue;
        }

        var next = text.length;
        for (var k = i; k < text.length; k++) {
            if (text.charAt(k) === '.' || text.charAt(k) === '[') { next = k; break; }
        }
        tokens.push(text.slice(i, next));
        i = next;
    }

    return tokens;
}

/**
 * 按路径取值。**取不到就是 `undefined`**（不是 null）—— 调用方据此判「不存在」。
 */
function valueAt(value, path) {
    var tokens = parsePath(path);
    if (!tokens) return undefined;

    var current = value;
    for (var i = 0; i < tokens.length; i++) {
        if (current === null || current === undefined) return undefined;
        if (typeof current !== 'object') return undefined;

        var key = tokens[i];
        if (Array.isArray(current)) {
            if (typeof key !== 'number' || key >= current.length) return undefined;
            current = current[key];
            continue;
        }
        if (!Object.prototype.hasOwnProperty.call(current, key)) return undefined;
        current = current[key];
    }

    return current;
}

/* ------------------------------------------------------------------ 取值 */

/** 值转文本（比较和提取都按文本走；对象就 JSON 化，至少能看） */
function textOf(value) {
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

/** 能当数字用的值（不是数字返回 null）。**不用 Number()**：它会把 '' 和 '0x10' 也算成数字 */
function numericLike(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value !== 'string') return null;

    var text = value.trim();
    if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)) return null;

    var number = Number(text);
    return Number.isFinite(number) ? number : null;
}

/** 空：空串、null、空数组、空对象。**没取到的值不在这里判**（那是「不存在」） */
function isEmpty(value) {
    if (value === null || value === undefined) return true;
    if (typeof value === 'string') return value === '';
    if (Array.isArray(value)) return value.length === 0;
    if (typeof value === 'object') return Object.keys(value).length === 0;
    return false;
}

function typeOf(value) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    return typeof value;
}

/** 11 位的 3 组那种状态码文本（`200 OK`）在这里没用，只认数字 */
function statusOf(response) {
    if (!response) return null;
    var status = Number(response.status);
    return Number.isFinite(status) ? status : null;
}

/** 响应头里最后一个同名的值（和界面上的取法一致） */
function headerOf(headers, name) {
    var target = String(name || '').toLowerCase();
    var found;
    (headers || []).forEach(function (pair) {
        if (String(pair[0]).toLowerCase() === target) found = String(pair[1]);
    });
    return found;
}

/**
 * 一次响应的取值环境。**JSON 是懒解析的**：只有真的用到 JSON 字段才 parse，
 * 一个「状态码是 200」的断言不该付出解析几 MB JSON 的代价。
 *
 * @param {object} result 执行器的结果（`{ response, timings }`）
 */
function createContext(result) {
    var response = (result && result.response) || null;
    var headers = (response && response.headers) || [];
    var body = response && typeof response.body === 'string' ? response.body : '';
    var bytes = response && Number.isFinite(response.size) ? response.size : body.length;
    var tooBig = bytes > MAX_JSON_BYTES;
    // 文本响应：契约里 `bodyEncoding` 不给就是 utf8（前端的 BodyViewer 也是这么兜的），
    // 只有显式的 base64（二进制）才没有文本可看
    var text = !response || response.bodyEncoding !== 'base64' ? body : null;
    var parsed = null;

    function json() {
        if (parsed) return parsed;
        if (tooBig) parsed = { ok: false, reason: '响应太大，没有解析' };
        else if (text === null) parsed = { ok: false, reason: '响应不是文本，没有解析' };
        else parsed = parseJson(text);
        return parsed;
    }

    return {
        response: response,
        status: statusOf(response),
        timeMs: result && result.timings && Number.isFinite(result.timings.total)
            ? result.timings.total
            : null,
        headers: headers,
        size: bytes,
        tooBig: tooBig,
        text: text,
        json: json
    };
}

/**
 * 取一处「实际值」。
 * @param {object} row 断言行
 * @param {object} ctx `createContext` 的结果
 * @returns {{found: boolean, value: any, reason?: string}} found 为 false 时 reason 说明为什么
 */
function actualOf(row, ctx) {
    if (row.source === 'status') {
        return ctx.status === null
            ? { found: false, reason: '没有收到响应' }
            : { found: true, value: ctx.status };
    }

    if (row.source === 'time') {
        return ctx.timeMs === null
            ? { found: false, reason: '没有耗时' }
            : { found: true, value: ctx.timeMs };
    }

    if (row.source === 'header') {
        var header = headerOf(ctx.headers, row.path);
        return header === undefined
            ? { found: false, reason: '没有这个响应头' }
            : { found: true, value: header };
    }

    if (row.source === 'json') {
        var parsed = ctx.json();
        if (!parsed.ok) return { found: false, reason: parsed.reason };

        var value = valueAt(parsed.value, row.path);
        return value === undefined
            ? { found: false, reason: '没有这个字段' }
            : { found: true, value: value };
    }

    // 响应文本
    if (ctx.text === null) return { found: false, reason: '响应不是文本，没有解析' };
    if (!ctx.text) return { found: false, reason: '响应体是空的' };
    return { found: true, value: ctx.text };
}

/* ------------------------------------------------------------------ 断言 */

/**
 * 「状态码 等于 200」「data.token 不为空」——自动生成的名字。
 *
 * `expected` 传进来时用它（**变量已经替换过的那个值**）：名字里写 `{{tk}}` 的话，
 * 用户看到结果也不知道这条到底比的是什么。不传就当没有变量替换。
 */
function assertName(row, expected) {
    var target;
    if (row.source === 'status') target = SOURCE_LABELS.status;
    else if (row.source === 'time') target = SOURCE_LABELS.time;
    else if (row.source === 'header') target = SOURCE_LABELS.header + ' ' + row.path;
    else if (row.source === 'text') target = SOURCE_LABELS.text;
    else target = row.path;

    var op = OP_LABELS[row.op] || row.op;
    if (NO_VALUE_OPS[row.op]) return target + ' ' + op;
    return target + ' ' + op + ' ' + str(expected === undefined ? row.value : expected);
}

function buildPattern(source) {
    try {
        return { ok: true, regex: new RegExp(source) };
    } catch (err) {
        return { ok: false, reason: '正则写得不对：' + ((err && err.message) || '无法解析') };
    }
}

/**
 * 判一条断言。
 * @returns {{passed: boolean, error?: string}} error 是给用户看的不通过原因
 */
function check(row, ctx, expected) {
    var actual = actualOf(row, ctx);

    if (!actual.found) {
        // 「不存在」是唯一一个「取不到值也算通过」的方式，别的一律不通过并说明为什么
        if (row.op === 'notExists') return { passed: true };
        return { passed: false, error: actual.reason };
    }

    var value = actual.value;

    if (row.op === 'exists') return { passed: true };
    if (row.op === 'notExists') return { passed: false, error: '有这个字段' };
    if (row.op === 'empty') {
        return isEmpty(value) ? { passed: true } : { passed: false, error: '不是空的' };
    }
    if (row.op === 'notEmpty') {
        return isEmpty(value) ? { passed: false, error: '是空的' } : { passed: true };
    }

    if (row.op === 'eq' || row.op === 'ne') {
        /*
         * 只有**实际值是数字**时才按数字比：响应里的 `code` 是数字 0，用户填的是字符串
         * "0"，不转就永远不通过。
         *
         * 反过来（实际值是字符串）一律按文本比 —— 保大整数的那条路会把 19 位 ID 变成
         * 字符串，这时按数字比会把 `12345678901234567890` 和用户打错的
         * `12345678901234567000` 判成相等（双精度一样），断言就形同虚设了。
         */
        var left = numericLike(value);
        var right = numericLike(expected);
        var same = typeof value === 'number' && left !== null && right !== null
            ? left === right
            : textOf(value) === str(expected);
        if (row.op === 'eq') return same ? { passed: true } : { passed: false, error: '实际是 ' + textOf(value) };
        return same ? { passed: false, error: '两边一样' } : { passed: true };
    }

    if (row.op === 'gt' || row.op === 'lt') {
        // 先看期望值：那是用户自己填的，写错了最该先告诉他
        var b = numericLike(expected);
        if (b === null) return { passed: false, error: '期望值不是数字：' + str(expected) };
        var a = numericLike(value);
        if (a === null) return { passed: false, error: '实际值不是数字：' + textOf(value) };

        var pass = row.op === 'gt' ? a > b : a < b;
        return pass ? { passed: true } : { passed: false, error: '实际是 ' + a };
    }

    if (row.op === 'contains' || row.op === 'notContains') {
        var hit = textOf(value).indexOf(str(expected)) !== -1;
        var wanted = row.op === 'contains';
        if (hit === wanted) return { passed: true };
        return { passed: false, error: hit ? '包含「' + str(expected) + '」' : '不包含「' + str(expected) + '」' };
    }

    if (row.op === 'regex') {
        var built = buildPattern(str(expected));
        if (!built.ok) return { passed: false, error: built.reason };
        return built.regex.test(textOf(value))
            ? { passed: true }
            : { passed: false, error: '不匹配：' + textOf(value) };
    }

    if (row.op === 'type') {
        var want = str(expected).trim();
        if (TYPES.indexOf(want) === -1) {
            return { passed: false, error: '期望值不是 ' + TYPES.join(' / ') + ' 之一' };
        }
        var got = typeOf(value);
        return got === want ? { passed: true } : { passed: false, error: '实际类型是 ' + got };
    }

    return { passed: false, error: '不认识的比较方式：' + row.op };
}

/**
 * 跑一遍断言。
 *
 * @param {Array} rows `toAssertions` 的结果
 * @param {object} ctx `createContext` 的结果
 * @param {object} [vars] 变量表：**期望值里的 `{{变量}}` 用它替换**（这次请求最终的变量表）
 * @returns {Array<{name, passed, error?, source}>} 形状和脚本的测试结果一致，`source` 标「断言」
 */
function runAssertions(rows, ctx, vars) {
    if (!ctx || !ctx.response) return [];

    var tests = [];

    (rows || []).forEach(function (row) {
        if (!row || row.enabled === false) return;

        var expected = row.value;
        if (!NO_VALUE_OPS[row.op]) {
            var resolved = variables.resolve(str(expected), vars || {});
            expected = resolved.text;
        }

        var outcome;
        try {
            outcome = check(row, ctx, expected);
        } catch (err) {
            // 一条断言自己有 bug 不能把整个请求带崩：记成不通过，原因写出来
            outcome = { passed: false, error: '断言执行出错：' + ((err && err.message) || '未知错误') };
        }

        var entry = { name: assertName(row, expected), passed: outcome.passed, source: '断言' };
        if (!outcome.passed && outcome.error) entry.error = outcome.error;
        tests.push(entry);
    });

    return tests;
}

/* ------------------------------------------------------------------ 提取 */

/** 控制台里那行：值只显示前 20 个字 */
function consoleLine(name, value) {
    var text = str(value);
    var head = text.length > CONSOLE_VALUE_LIMIT
        ? text.slice(0, CONSOLE_VALUE_LIMIT) + '…（只显示前 ' + CONSOLE_VALUE_LIMIT + ' 个字）'
        : text;
    return '已提取 ' + name + ' = ' + head;
}

/** 取一个要提取的值 */
function extractValue(row, ctx) {
    if (row.source === 'header') {
        var header = headerOf(ctx.headers, row.path);
        return header === undefined
            ? { ok: false, reason: '没有这个响应头' }
            : { ok: true, value: header };
    }

    if (row.source === 'json') {
        var parsed = ctx.json();
        if (!parsed.ok) return { ok: false, reason: parsed.reason };

        var value = valueAt(parsed.value, row.path);
        if (value === undefined) return { ok: false, reason: '没有这个字段' };
        return { ok: true, value: typeof value === 'string' ? value : textOf(value) };
    }

    // 正则：取第 1 组；没有分组就取整个匹配
    if (ctx.text === null) return { ok: false, reason: '响应不是文本，没有解析' };

    var built = buildPattern(row.path);
    if (!built.ok) return { ok: false, reason: built.reason };

    var matched = built.regex.exec(ctx.text);
    if (!matched) return { ok: false, reason: '正则没有匹配到内容' };

    return { ok: true, value: matched[1] === undefined ? matched[0] : matched[1] };
}

/**
 * 跑一遍提取。
 *
 * 三种「没提取到」的情况都**只记警告、不算失败**（提取不到不该让这次请求变红）：
 * 取不到值、没选环境、正则不匹配。
 *
 * @param {Array} rows `toExtracts` 的结果
 * @param {object} ctx `createContext` 的结果
 * @param {object} options `{ hasEnvironment }` —— 没选环境（或选的是内置 Mock 环境）时
 *   「存到环境」的提取不生效，只提示一句
 * @returns {{environment: object, project: object, console: Array, warnings: Array, names: object}}
 */
function runExtracts(rows, ctx, options) {
    var opts = options || {};
    var result = { environment: {}, project: {}, console: [], warnings: [], names: {} };
    if (!ctx || !ctx.response) return result;

    (rows || []).forEach(function (row) {
        if (!row || row.enabled === false) return;

        if (row.scope === 'environment' && !opts.hasEnvironment) {
            result.warnings.push('提取「' + row.name + '」：没有选环境，这个变量没有保存');
            return;
        }

        var got = extractValue(row, ctx);
        if (!got.ok) {
            result.warnings.push('提取「' + row.name + '」：' + got.reason);
            return;
        }

        var bucket = row.scope === 'project' ? result.project : result.environment;
        bucket[row.name] = str(got.value);
        result.names[row.name] = row.scope;
        result.console.push({ level: 'log', text: consoleLine(row.name, got.value), source: '提取变量' });
    });

    return result;
}

module.exports = {
    SOURCES: SOURCES,
    OPS: OPS,
    OPS_BY_SOURCE: OPS_BY_SOURCE,
    SOURCE_LABELS: SOURCE_LABELS,
    OP_LABELS: OP_LABELS,
    NO_VALUE_OPS: NO_VALUE_OPS,
    TYPES: TYPES,
    EXTRACT_SOURCES: EXTRACT_SOURCES,
    SCOPES: SCOPES,
    EXTRACT_SOURCE_LABELS: EXTRACT_SOURCE_LABELS,
    SCOPE_LABELS: SCOPE_LABELS,
    MAX_JSON_BYTES: MAX_JSON_BYTES,
    CONSOLE_VALUE_LIMIT: CONSOLE_VALUE_LIMIT,
    toAssertions: toAssertions,
    toExtracts: toExtracts,
    parsePath: parsePath,
    valueAt: valueAt,
    parseJson: parseJson,
    textOf: textOf,
    isEmpty: isEmpty,
    typeOf: typeOf,
    createContext: createContext,
    actualOf: actualOf,
    assertName: assertName,
    consoleLine: consoleLine,
    check: check,
    runAssertions: runAssertions,
    runExtracts: runExtracts
};
