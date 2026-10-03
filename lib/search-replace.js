/**
 * 全局查找替换（第五轮第 2 节）。
 *
 * 后端改了版本前缀（`/api/v1` → `/api/v2`）、换了一个请求头名、某个参数改了名 ——
 * 以前只能一个个接口打开改。这里做两件事，**都是纯函数**（不读库、不写库）：
 *
 *   - `findMatches(api, conditions)`：一个接口里所有命中；
 *   - `applyToApi(api, conditions, targets)`：只动 targets 里列出的那些位置，算出要写的 patch。
 *
 * 两个容易想歪的地方，先说清楚：
 *
 * 1. **`location` 是「哪一处」的唯一标识**，不是给人看的（虽然它读起来很清楚）：
 *    `url`、`name`、`description`、`headers[2].value`、`params.query[1].key`、
 *    `body.raw`、`body.form[0].value`、`body.graphql.query`、`scripts.test`。
 *    查找和替换都用 `placesOf` 这一份清单生成，两边不可能对不上。
 * 2. **一处可能有多个命中**（一个请求头值里出现两次 `/api/v1`）。`targets` 的粒度是
 *    「位置」，所以只要这个位置在 targets 里，它里面的命中**全部**替换掉 —— 用户勾的是
 *    这一行，不是某一处字符。
 *
 * 不搜的地方（计划里点名的）：示例、Mock 期望、环境变量。保密变量不涉及（值在
 * `secret_values` 里，共享数据里本来就是空）。
 */

var respond = require('./api/respond');

/** 能搜的字段（顺序也是结果里的顺序） */
var FIELDS = ['url', 'headers', 'params', 'body', 'scripts', 'name', 'description'];

/** 界面默认勾上的那几项（计划里给的默认值） */
var DEFAULT_FIELDS = ['url', 'headers', 'params', 'body'];

/** 一次最多返回多少处命中 */
var MAX_MATCHES = 500;

/** 命中前后各留多少字（压紧的 JSON 请求体是一整行，不截能到几十 KB） */
var CONTEXT_LIMIT = 200;

function str(value) {
    return value === undefined || value === null ? '' : String(value);
}

/** 把正则里的特殊字符转义掉（不按正则搜时用） */
function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 造正则。`conditions.regex` 为假时把查找词当纯文本（转义掉特殊字符）。
 * 写错了抛 400（文案带上 JS 自己给的原因，用户知道是哪个字符的问题）。
 */
function buildPattern(conditions) {
    var query = str(conditions && conditions.query);
    if (!query) return null;

    var source = conditions.regex ? query : escapeRegExp(query);
    if (conditions.wholeWord) source = '\\b(?:' + source + ')\\b';

    var flags = 'g' + (conditions.caseSensitive ? '' : 'i');
    try {
        return new RegExp(source, flags);
    } catch (err) {
        throw respond.apiError(400, '正则写得不对：' + ((err && err.message) || '无法解析'));
    }
}

/** 请求里要搜哪几个字段；一个都不给就用默认那四项 */
function normalizeFields(list) {
    if (!Array.isArray(list)) return DEFAULT_FIELDS.slice();

    var fields = [];
    list.forEach(function (item) {
        var name = str(item);
        if (FIELDS.indexOf(name) === -1) return;
        if (fields.indexOf(name) === -1) fields.push(name);
    });
    return fields.length ? fields : DEFAULT_FIELDS.slice();
}

/* ------------------------------------------------------------------ 位置 */

function getPath(object, path) {
    var current = object;
    for (var i = 0; i < path.length; i++) {
        if (current === null || current === undefined) return undefined;
        current = current[path[i]];
    }
    return current;
}

function setPath(object, path, value) {
    var current = object;
    for (var i = 0; i < path.length - 1; i++) {
        if (current[path[i]] === null || typeof current[path[i]] !== 'object') return;
        current = current[path[i]];
    }
    current[path[path.length - 1]] = value;
}

/**
 * 一个接口里所有「能搜的地方」。**查找和替换共用这一份**，两边不可能对不上。
 *
 * @returns {Array<{field: string, location: string, path: Array}>}
 */
function placesOf(api) {
    var source = api || {};
    var params = source.params || {};
    var body = source.body || {};
    var places = [];

    function push(field, location, path) {
        places.push({ field: field, location: location, path: path });
    }

    push('url', 'url', ['url']);

    ['path', 'query'].forEach(function (kind) {
        (params[kind] || []).forEach(function (row, index) {
            if (!row) return;
            push('params', 'params.' + kind + '[' + index + '].key', ['params', kind, index, 'key']);
            push('params', 'params.' + kind + '[' + index + '].value', ['params', kind, index, 'value']);
        });
    });

    (params.headers || []).forEach(function (row, index) {
        if (!row) return;
        push('headers', 'headers[' + index + '].key', ['params', 'headers', index, 'key']);
        push('headers', 'headers[' + index + '].value', ['params', 'headers', index, 'value']);
    });

    if (body.mode === 'raw') push('body', 'body.raw', ['body', 'raw']);
    if (body.mode === 'urlencoded' || body.mode === 'formdata') {
        (body.form || []).forEach(function (row, index) {
            if (!row) return;
            push('body', 'body.form[' + index + '].key', ['body', 'form', index, 'key']);
            push('body', 'body.form[' + index + '].value', ['body', 'form', index, 'value']);
        });
    }
    if (body.mode === 'graphql' && body.graphql) {
        push('body', 'body.graphql.query', ['body', 'graphql', 'query']);
        push('body', 'body.graphql.variables', ['body', 'graphql', 'variables']);
    }
    if (body.mode === 'binary' && body.file) push('body', 'body.file.src', ['body', 'file', 'src']);

    /* 脚本：同一个 listen 有多段时后面那几段带 #序号（否则两段的 location 会撞在一起） */
    var seen = {};
    (source.scripts || []).forEach(function (script, index) {
        if (!script) return;
        var listen = str(script.listen);
        if (listen !== 'prerequest' && listen !== 'test') return;

        seen[listen] = (seen[listen] || 0) + 1;
        push('scripts', 'scripts.' + listen + (seen[listen] > 1 ? '#' + seen[listen] : ''),
            ['scripts', index, 'exec']);
    });

    push('name', 'name', ['name']);
    push('description', 'description', ['description']);

    return places;
}

/* ------------------------------------------------------------------ 查 */

/** 一段文本里所有命中（**跳过空匹配**：`a*` 这种正则会匹配出零长度，替换时会死循环） */
function scan(text, pattern) {
    var regex = new RegExp(pattern.source, pattern.flags);
    var hits = [];
    var matched = regex.exec(text);

    while (matched) {
        if (matched[0] === '') {
            regex.lastIndex += 1;
        } else {
            hits.push({ start: matched.index, end: matched.index + matched[0].length });
        }
        matched = regex.exec(text);
    }
    return hits;
}

/** 整段替换（和 `String.replace` 的正则替换同一套规则，`$1` 这类分组引用照 JS 的来） */
function replaceAll(text, pattern, replacement) {
    var regex = new RegExp(pattern.source, pattern.flags);
    return text.replace(regex, replacement);
}

/**
 * 命中所在的那一行（含前后文），太长时**按命中处截一段**。
 *
 * 为什么必须截：请求体经常是压紧的一整行 JSON，不截的话每一条命中都会把几十 KB
 * 原样回给前端（500 条就是几十 MB）。
 */
function contextLine(text, hit) {
    var start = text.lastIndexOf('\n', hit.start - 1) + 1;
    var end = text.indexOf('\n', hit.end);
    if (end === -1) end = text.length;

    var from = Math.max(start, hit.start - CONTEXT_LIMIT);
    var to = Math.min(end, hit.end + CONTEXT_LIMIT);

    return {
        text: text.slice(from, to),
        start: hit.start - from,
        end: hit.end - from
    };
}

/**
 * 找出一个接口里所有命中。
 *
 * @param {object} api 接口 DTO（`params` / `body` / `scripts` 都是库里的形状）
 * @param {object} conditions `{ pattern, fields, query... }`
 * @returns {Array<{apiId, apiName, method, field, location, line, start, end, preview}>}
 *   `line` 是命中所在那一行（截过），`start` / `end` 是命中在 `line` 里的偏移，
 *   `preview` 是这一行**按同一个条件替换之后**的样子（同一行里别的命中也会一起替换）。
 */
function findMatches(api, conditions) {
    var pattern = conditions.pattern;
    if (!pattern || !api) return [];

    var fields = conditions.fields || DEFAULT_FIELDS;
    var out = [];

    placesOf(api).forEach(function (place) {
        if (fields.indexOf(place.field) === -1) return;

        var text = getPath(api, place.path);
        if (typeof text !== 'string' || !text) return;

        scan(text, pattern).forEach(function (hit) {
            var line = contextLine(text, hit);
            out.push({
                apiId: api.id,
                apiName: api.name || '',
                method: api.method || 'GET',
                field: place.field,
                location: place.location,
                line: line.text,
                start: line.start,
                end: line.end,
                preview: replaceAll(line.text, pattern, str(conditions.replacement))
            });
        });
    });

    return out;
}

/* ------------------------------------------------------------------ 替换 */

/**
 * 算一个接口的 patch。
 *
 * @param {object} api 接口 DTO（库里的形状，**不要**先过 DTO 清洗 —— 清洗会改掉
 *   没被替换的字段，patch 会变成「顺手把整行重写一遍」）
 * @param {object} conditions `{ pattern, fields, replacement }`
 * @param {object} targets `{ 'headers[2].value': true, ... }` —— 这一个接口里要动的位置
 * @returns {{patch: object, changed: number}|null} 没有变化时返回 null
 */
function applyToApi(api, conditions, targets) {
    var pattern = conditions.pattern;
    if (!pattern || !api || !targets) return null;

    var fields = conditions.fields || DEFAULT_FIELDS;
    var replacement = str(conditions.replacement);

    var clone = {
        name: api.name,
        description: api.description,
        url: api.url,
        params: JSON.parse(JSON.stringify(api.params || {})),
        body: JSON.parse(JSON.stringify(api.body || {})),
        scripts: JSON.parse(JSON.stringify(api.scripts || []))
    };

    var changed = 0;

    placesOf(api).forEach(function (place) {
        if (fields.indexOf(place.field) === -1) return;
        if (targets[place.location] !== true) return;

        var text = getPath(api, place.path);
        if (typeof text !== 'string' || !text) return;

        var next = replaceAll(text, pattern, replacement);
        if (next === text) return;

        changed += scan(text, pattern).length;
        setPath(clone, place.path, next);
    });

    if (!changed) return null;

    var patch = {};
    if (clone.name !== api.name) patch.name = clone.name;
    if (clone.description !== api.description) patch.description = clone.description;
    if (clone.url !== api.url) patch.url = clone.url;
    // 用 JSON 比：入参和副本都是同一份形状（都来自库里那一行），没动过就逐字相同
    if (JSON.stringify(clone.params) !== JSON.stringify(api.params || {})) patch.params = clone.params;
    if (JSON.stringify(clone.body) !== JSON.stringify(api.body || {})) patch.body = clone.body;
    if (JSON.stringify(clone.scripts) !== JSON.stringify(api.scripts || [])) patch.scripts = clone.scripts;

    return Object.keys(patch).length ? { patch: patch, changed: changed } : null;
}

module.exports = {
    FIELDS: FIELDS,
    DEFAULT_FIELDS: DEFAULT_FIELDS,
    MAX_MATCHES: MAX_MATCHES,
    CONTEXT_LIMIT: CONTEXT_LIMIT,
    buildPattern: buildPattern,
    normalizeFields: normalizeFields,
    placesOf: placesOf,
    scan: scan,
    findMatches: findMatches,
    applyToApi: applyToApi
};
