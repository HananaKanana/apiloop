/**
 * 智能模板化：把一段 JSON 文本里「可以随机化的值」换成 mock 占位符。
 *
 * 场景是「录制的真实响应一键变成 mock 模板」——录制下来的是死数据，模板化之后
 * 每次请求都会重新生成，但**结构和类型保持不变**。
 *
 * 三条原则，按优先级：
 *   1. **宁可少换，不要换错。** 状态码、`code`、`msg`、分页参数、布尔值这些带业务
 *      含义的值一个都不换（见 PROTECTED_KEYS）。
 *   2. **类型不变。** 规则里挑出来的占位符如果产出字符串，就只替换字符串值；
 *      产出数字的占位符（`{{@id}}`、`{{@price}}`、`{{@timestamp}}`…）只替换数字值。
 *      占位符一律带引号写出去，引擎渲染整串占位符时会自己去掉引号，数字还是数字。
 *   3. **换完必须还能解析。** 模板里用 `{{@repeat(n)}}` 表示数组，重复出来的元素之间
 *      没有逗号，靠引擎的 repairJson 补。所以最后一定要渲染一次真的解析一遍，
 *      解析不过就退回原文。
 */

var engine = require('./mock-engine');

/* ------------------------------------------------------------------ key 名 */

/**
 * key 名归一化：不区分大小写，忽略下划线和连字符。
 * 于是 `created_at`、`createdAt`、`CreatedAt` 是同一个 key。
 */
function normalizeKey(key) {
    return String(key === undefined || key === null ? '' : key)
        .toLowerCase()
        .replace(/[_-]/g, '');
}

/**
 * 保护名单：命中就一个都不换。
 * 这些 key 上的值通常是状态码、枚举、分页参数这类带业务含义的东西，
 * 换成随机值会让联调的前端彻底没法用。
 */
var PROTECTED_KEYS = ('code msg message success errno errcode errmsg status state type kind level ' +
    'page pagesize pagenum size limit offset total count version currency lang locale gender sex')
    .split(' ');

var PROTECTED_MAP = {};
PROTECTED_KEYS.forEach(function (key) { PROTECTED_MAP[key] = true; });

/** 保护名单包括「所有以 is / has 开头的 key」（isVip、hasMore…） */
function isProtected(key) {
    if (PROTECTED_MAP[key]) return true;
    return key.indexOf('is') === 0 || key.indexOf('has') === 0;
}

/* ------------------------------------------------------------------ 值形态 */

var CHINESE_RE = /[\u4e00-\u9fa5]/;
var UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
var PHONE_RE = /^1[3-9]\d{9}$/;
var EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
var DATETIME_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/;
var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
var TIMESTAMP_RE = /^\d{13}$/;
var IMAGE_URL_RE = /^https?:\/\/\S+\.(?:png|jpe?g|gif|webp)(?:\?\S*)?$/i;

/** 已经写过占位符的值不再动它：模板化过一遍的响应体再模板化一次，不该越换越歪 */
var ALREADY_TEMPLATE_RE = /\{\{@/;

/* ------------------------------------------------------------------ 规则表 */

function isNumber(value) {
    return typeof value === 'number' && isFinite(value);
}

function stringOnly(placeholder) {
    return function (value) { return typeof value === 'string' ? placeholder : null; };
}

function numberOnly(placeholder) {
    return function (value) { return isNumber(value) ? placeholder : null; };
}

function containsAny(words) {
    return function (key) {
        for (var i = 0; i < words.length; i++) {
            if (key.indexOf(words[i]) > -1) return true;
        }
        return false;
    };
}

function equalsAny(words) {
    return function (key) { return words.indexOf(key) > -1; };
}

/**
 * 按 key 名替换。数组顺序就是判断顺序，**命中第一条就停**；
 * 某一条的名字匹配上了但值的条件不满足（比如 `id` 的值既不是整数也不是 uuid），
 * 就继续往下试别的规则。
 */
var KEY_RULES = [
    {
        match: function (key) { return key === 'id' || key.slice(-2) === 'id'; },
        pick: function (value) {
            if (isNumber(value) && Number.isInteger(value)) return '{{@id}}';
            if (typeof value === 'string' && UUID_RE.test(value)) return '{{@uuid}}';
            return null;
        }
    },
    {
        match: function (key) {
            return key.indexOf('phone') > -1 || key.indexOf('mobile') > -1 || key === 'tel';
        },
        pick: stringOnly('{{@phone}}')
    },
    {
        match: function (key) { return key.indexOf('email') > -1 || key === 'mail'; },
        pick: stringOnly('{{@email}}')
    },
    {
        match: equalsAny(['name', 'username', 'nickname', 'realname', 'cname', 'fullname']),
        pick: function (value) {
            if (typeof value !== 'string') return null;
            return CHINESE_RE.test(value) ? '{{@cname}}' : '{{@ename}}';
        }
    },
    {
        match: containsAny(['avatar', 'image', 'img', 'pic', 'photo', 'cover', 'thumb']),
        pick: stringOnly('{{@image(200x200)}}')
    },
    {
        match: containsAny(['url', 'link', 'href', 'website']),
        pick: stringOnly('{{@url}}')
    },
    { match: equalsAny(['city']), pick: stringOnly('{{@city}}') },
    { match: equalsAny(['province']), pick: stringOnly('{{@province}}') },
    {
        match: function (key) { return key.indexOf('address') > -1 || key === 'addr'; },
        pick: stringOnly('{{@address}}')
    },
    { match: containsAny(['company']), pick: stringOnly('{{@company}}') },
    { match: equalsAny(['job', 'position']), pick: stringOnly('{{@job}}') },
    { match: equalsAny(['title']), pick: stringOnly('{{@title}}') },
    {
        match: containsAny(['desc', 'content', 'remark', 'summary', 'intro']),
        pick: function (value) {
            if (typeof value !== 'string') return null;
            return value.length > 30 ? '{{@paragraph}}' : '{{@sentence}}';
        }
    },
    {
        match: containsAny(['price', 'amount', 'money', 'fee', 'cost']),
        pick: numberOnly('{{@price(1,999)}}')
    },
    { match: containsAny(['token']), pick: stringOnly('{{@token}}') },
    { match: equalsAny(['ip']), pick: stringOnly('{{@ip}}') },
    {
        match: containsAny(['color']),
        pick: function (value) {
            return (typeof value === 'string' && value.charAt(0) === '#') ? '{{@color}}' : null;
        }
    }
];

/** key 名没命中时，退一步看值的形态 */
function matchByShape(key, value) {
    if (typeof value === 'string') {
        if (DATETIME_RE.test(value)) return '{{@datetime}}';
        if (DATE_RE.test(value)) return '{{@date}}';
        if (PHONE_RE.test(value)) return '{{@phone}}';
        if (EMAIL_RE.test(value)) return '{{@email}}';
        if (UUID_RE.test(value)) return '{{@uuid}}';
        if (IMAGE_URL_RE.test(value)) return '{{@image(200x200)}}';
        return null;
    }

    // 13 位整数只有在 key 名暗示它是时间的时候才当时间戳，否则它就是个大数字
    if (isNumber(value) && TIMESTAMP_RE.test(String(value))) {
        if (key.indexOf('time') > -1 || key.indexOf('at') > -1) return '{{@timestamp}}';
    }
    return null;
}

/** 产出数字的占位符。其余一律当字符串看待 —— 类型不变这条规则靠它守 */
var NUMBER_PLACEHOLDERS = { id: true, int: true, float: true, price: true, timestamp: true };

function outputsString(placeholder) {
    var match = /^\{\{@([A-Za-z]+)/.exec(placeholder);
    var name = match ? match[1].toLowerCase() : '';
    return !NUMBER_PLACEHOLDERS[name];
}

/**
 * 决定一个叶子节点换不换。顺序：保护名单 → key 名 → 值的形态。
 * @returns {string|null} 占位符，或者 null（保持原样）
 */
function pickPlaceholder(key, value) {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    if (typeof value === 'string' && ALREADY_TEMPLATE_RE.test(value)) return null;

    if (key !== null && key !== undefined) {
        var normalized = normalizeKey(key);
        if (isProtected(normalized)) return null;

        for (var i = 0; i < KEY_RULES.length; i++) {
            if (!KEY_RULES[i].match(normalized)) continue;
            var placeholder = KEY_RULES[i].pick(value);
            if (placeholder) return placeholder;
        }
    }

    return matchByShape(normalizeKey(key), value);
}

/* ------------------------------------------------------------------ 构建模板树 */

/**
 * 把解析好的 JSON 变成一个「模板树」。
 *
 * 节点形状：
 *   { kind: 'value', value }                   原样保留的叶子
 *   { kind: 'placeholder', text }              换掉的叶子
 *   { kind: 'array', items: [] }               普通数组
 *   { kind: 'object', entries: [[key, node]] } 对象
 *   { kind: 'repeat', count, item }            元素全是对象的数组：只留第一个当样板
 */
function buildNode(value, key, path, replacements) {
    if (value === null || typeof value === 'boolean') {
        return { kind: 'value', value: value };
    }

    if (typeof value === 'string' || typeof value === 'number') {
        var placeholder = pickPlaceholder(key, value);

        if (placeholder) {
            var keepsType = outputsString(placeholder)
                ? typeof value === 'string'
                : isNumber(value);

            if (keepsType) {
                replacements.push({ path: path, from: value, placeholder: placeholder });
                return { kind: 'placeholder', text: placeholder };
            }
        }
        return { kind: 'value', value: value };
    }

    if (Array.isArray(value)) {
        if (isObjectList(value) && value.length >= 2) {
            return {
                kind: 'repeat',
                // 最多 20 份：一个录下来的 500 条列表全展开会把模板撑爆
                count: Math.min(value.length, 20),
                item: buildNode(value[0], null, path + '[0]', replacements)
            };
        }
        return {
            kind: 'array',
            items: value.map(function (item, index) {
                return buildNode(item, null, path + '[' + index + ']', replacements);
            })
        };
    }

    var entries = [];
    Object.keys(value).forEach(function (childKey) {
        entries.push([
            childKey,
            buildNode(value[childKey], childKey, joinPath(path, childKey), replacements)
        ]);
    });
    return { kind: 'object', entries: entries };
}

function isObjectList(list) {
    if (!list.length) return false;
    return list.every(function (item) {
        return item !== null && typeof item === 'object' && !Array.isArray(item);
    });
}

function joinPath(path, key) {
    return path ? (path + '.' + key) : key;
}

/* ------------------------------------------------------------------ 序列化 */

function indentOf(depth) {
    var out = '';
    for (var i = 0; i < depth; i++) out += '  ';
    return out;
}

/**
 * 自己写序列化，因为 `{{@repeat}}` 的排版不是 JSON 能表达的：
 *
 *   [
 *   {{@repeat(3)}}    { … }
 *   {{/repeat}}  ]
 *
 * 与 routes-store.createSampleRoutes 里给的示例保持一致。
 * 占位符一律带引号输出：数值类占位符渲染时引擎会去掉引号，类型才对得上。
 */
function serialize(node, depth) {
    if (node.kind === 'placeholder') return '"' + node.text + '"';
    if (node.kind === 'value') return JSON.stringify(node.value);

    if (node.kind === 'repeat') {
        return '[\n{{@repeat(' + node.count + ')}}' + indentOf(depth + 1) +
            serialize(node.item, depth + 1) + '\n{{/repeat}}' + indentOf(depth) + ']';
    }

    if (node.kind === 'array') {
        if (!node.items.length) return '[]';
        return '[\n' + node.items.map(function (item) {
            return indentOf(depth + 1) + serialize(item, depth + 1);
        }).join(',\n') + '\n' + indentOf(depth) + ']';
    }

    if (!node.entries.length) return '{}';
    return '{\n' + node.entries.map(function (entry) {
        return indentOf(depth + 1) + JSON.stringify(entry[0]) + ': ' + serialize(entry[1], depth + 1);
    }).join(',\n') + '\n' + indentOf(depth) + '}';
}

/* ------------------------------------------------------------------ 出口 */

/**
 * @param {string} text JSON 文本
 * @returns {{body: string, replacements: Array, skipped: string|null}}
 *   body 是模板化之后的文本（跳过时是原文）；
 *   replacements 列出每一处替换，前端拿它展示给用户确认；
 *   skipped 是跳过原因，没有跳过就是 null。
 */
function templatize(text) {
    var source = String(text === undefined || text === null ? '' : text);

    var parsed;
    try {
        parsed = JSON.parse(source);
    } catch (err) {
        return { body: source, replacements: [], skipped: '不是合法 JSON，已保持原样' };
    }

    var replacements = [];
    var output = serialize(buildNode(parsed, null, '', replacements), 0);

    // 自检：真的渲染一次、修复一次、解析一次。
    // 这里能过，mock 运行时那边就一定能过。
    try {
        JSON.parse(engine.repairJson(engine.render(output, {}).text));
    } catch (err) {
        return { body: source, replacements: [], skipped: '模板化后不是合法 JSON，已保持原样' };
    }

    return { body: output, replacements: replacements, skipped: null };
}

module.exports = {
    templatize: templatize
};
