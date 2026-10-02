/**
 * Postman 导入导出。
 *
 * 解析器把 Postman 的 Collection v2.0 / v2.1、Environment、Globals 转成本项目的
 * 「接口树」中间结构（字段和 P1 的 folders / apis / examples 表一一对应），
 * 导出器做反向转换，保证「导入 → 导出 → 再导入」尽量无损。
 *
 * 无损靠两处：
 * - `extra`：每一层没被映射到的字段原样兜在这里，导出时先摊开再让已映射字段覆盖；
 * - `unsupported.raw`：不支持的鉴权类型整块原样带回。
 *
 * Postman 导出的 JSON 什么样都有（url 可能是字符串也可能是对象、header 可能是字符串、
 * description 可能是 {content} 对象、disabled 可能根本没有），解析时一律按「能读就读，
 * 读不到给默认值」处理，绝不因为一个字段脏就整体抛错。
 */

var http = require('http');

var urlUtils = require('./url-utils');

/** 各层「已经映射过、不该再进 extra」的字段名 */
var COLLECTION_MAPPED_KEYS = ['info', 'item', 'variable', 'auth', 'event'];
var INFO_MAPPED_KEYS = ['name', 'description', 'schema'];
var FOLDER_MAPPED_KEYS = ['name', 'description', 'auth', 'variable', 'event', 'item'];
var API_ITEM_MAPPED_KEYS = ['name', 'description', 'auth', 'event', 'request', 'response'];
var REQUEST_MAPPED_KEYS = ['method', 'header', 'body', 'url', 'auth', 'description'];

/**
 * `extra` 按来源分层保存，不再把不同层的字段混成一个包。
 *
 * 混在一起的问题：`info._exporter_id` 这类字段导出时会被放到顶层、接口里未知的 request
 * 字段会被放到条目上，文件结构就变了。而且「解析 → 导出 → 再解析」看不出来 ——
 * 再解析时它们又合回同一个包，比较结果仍然相等。
 */
var EXAMPLE_MAPPED_KEYS = ['name', 'code', 'status', 'header', 'body'];

var COLLECTION_SCHEMA = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

/* ------------------------------------------------------------------ 小工具 */

function str(value) {
    if (value === null || value === undefined) return '';
    return String(value);
}

/** Postman 的 description 可能是字符串，也可能是 { content, type } */
function toDescription(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'object' && typeof value.content === 'string') return value.content;
    return '';
}

function isBlank(value) {
    return value === null || value === undefined;
}

/** 把一层里没映射到的字段原样兜起来 */
function pickExtra(source, mappedKeys) {
    var extra = {};
    if (!source || typeof source !== 'object') return extra;

    Object.keys(source).forEach(function (key) {
        if (mappedKeys.indexOf(key) !== -1) return;
        extra[key] = source[key];
    });
    return extra;
}

function mergeExtra(target, source) {
    Object.keys(source || {}).forEach(function (key) {
        target[key] = source[key];
    });
    return target;
}

/** 统一的键值行 */
function toRow(key, value, options) {
    var opts = options || {};
    return {
        key: str(key),
        value: isBlank(value) ? '' : String(value),
        type: 'string',
        required: false,
        desc: opts.desc || '',
        enabled: opts.enabled !== false
    };
}

/**
 * 解析 Postman 的 header / query / variable 数组。
 * 数组里每项可能是对象（正常情况），也可能是纯字符串（脏数据），字符串按第一个冒号切。
 */
function toRows(list) {
    if (typeof list === 'string') return toRowsFromText(list);
    if (!Array.isArray(list)) return [];

    return list.map(function (entry) {
        if (typeof entry === 'string') return toRowFromText(entry);
        if (!entry || typeof entry !== 'object') return null;

        var row = toRow(entry.key, entry.value, {
            desc: toDescription(entry.description),
            enabled: entry.disabled !== true
        });
        return row;
    }).filter(Boolean);
}

function toRowFromText(text) {
    var index = String(text).indexOf(':');
    if (index === -1) return toRow(String(text).trim(), '');
    return toRow(String(text).slice(0, index).trim(), String(text).slice(index + 1).trim());
}

function toRowsFromText(text) {
    return String(text).split(/\r?\n/).filter(function (line) {
        return line.trim() !== '';
    }).map(toRowFromText);
}

/**
 * 环境变量 / 集合变量：Row.type 仍是 string，type 为 secret 时额外标一个 secret 字段
 * 供界面打码。
 *
 * 注意 Postman 这两处用的字段名不一样：Environment / Globals 的 values 用 `enabled`，
 * 集合条目里的 header / query 用 `disabled`。这里两个都认，缺失一律按启用处理。
 */
function toVariableRows(values) {
    if (!Array.isArray(values)) return [];

    return values.map(function (entry) {
        if (!entry || typeof entry !== 'object') return null;

        var row = toRow(entry.key, entry.value, {
            desc: toDescription(entry.description),
            enabled: entry.enabled !== false && entry.disabled !== true
        });
        if (entry.type === 'secret') row.secret = true;
        return row;
    }).filter(Boolean);
}

/** 从 rawHeaders 那种 [[k, v]] 里取某个头的值 */
function findHeaderValue(headers, name) {
    var target = String(name).toLowerCase();
    var found = '';
    (headers || []).forEach(function (row) {
        if (row.enabled === false) return;
        if (String(row.key).toLowerCase() === target) found = String(row.value || '');
    });
    return found;
}

/* ------------------------------------------------------------------ 鉴权 */

/** v2.1 是 [{key, value}] 数组，v2.0 是 {k: v} 对象，统一摊成普通对象 */
function authValues(auth, type) {
    var source = auth[type];
    var values = {};

    if (Array.isArray(source)) {
        source.forEach(function (row) {
            if (!row || typeof row !== 'object' || isBlank(row.key)) return;
            values[str(row.key)] = row.value;
        });
    } else if (source && typeof source === 'object') {
        Object.keys(source).forEach(function (key) {
            values[key] = source[key];
        });
    }
    return values;
}

function pickValue(values, key) {
    return isBlank(values[key]) ? '' : String(values[key]);
}

function toAuth(auth, stats) {
    if (!auth || typeof auth !== 'object') return null;

    var type = str(auth.type);
    if (!type) return null;
    if (type === 'noauth') return { type: 'noauth' };
    if (type === 'inherit') return { type: 'inherit' };

    var values = authValues(auth, type);

    if (type === 'bearer') {
        return { type: 'bearer', token: pickValue(values, 'token') };
    }
    if (type === 'basic') {
        return {
            type: 'basic',
            username: pickValue(values, 'username'),
            password: pickValue(values, 'password')
        };
    }
    if (type === 'apikey') {
        return {
            type: 'apikey',
            key: pickValue(values, 'key'),
            value: pickValue(values, 'value'),
            in: values.in === 'query' ? 'query' : 'header'
        };
    }

    // 其他类型（oauth2 / digest / awsv4 / hawk / ntlm …）整块原样带回
    if (stats.unsupportedAuth.indexOf(type) === -1) stats.unsupportedAuth.push(type);
    return { type: type, unsupported: true, raw: auth };
}

/* ------------------------------------------------------------------ 脚本 */

function toScripts(event, stats) {
    if (!Array.isArray(event)) return [];

    var scripts = [];
    event.forEach(function (entry) {
        if (!entry || typeof entry !== 'object') return;

        var listen = str(entry.listen);
        if (listen !== 'prerequest' && listen !== 'test') return;

        var exec = entry.script && entry.script.exec;
        if (Array.isArray(exec)) exec = exec.join('\n');

        scripts.push({ listen: listen, exec: typeof exec === 'string' ? exec : '' });
        stats.scripts++;
    });
    return scripts;
}

/* ------------------------------------------------------------------ url */

/** url 可能是字符串，也可能是对象；对象优先取 raw，没有 raw 就用各段拼 */
function toUrlText(url) {
    if (typeof url === 'string') return url;
    if (!url || typeof url !== 'object') return '';

    if (typeof url.raw === 'string') return url.raw;

    var protocol = url.protocol ? str(url.protocol).replace(/:$/, '') + '://' : '';
    var host = Array.isArray(url.host) ? url.host.join('.') : str(url.host);
    var port = url.port ? ':' + str(url.port) : '';
    var pathText = Array.isArray(url.path) ? url.path.join('/') : str(url.path).replace(/^\//, '');
    var path = pathText ? '/' + pathText : '';

    return protocol + host + port + path;
}

/** 查询串只留 ? 之前的部分 */
function stripQuery(urlText) {
    var index = String(urlText).indexOf('?');
    return index === -1 ? String(urlText) : String(urlText).slice(0, index);
}

function toPathRows(url) {
    if (!url || typeof url !== 'object' || !Array.isArray(url.variable)) return [];

    return url.variable.map(function (entry) {
        if (!entry || typeof entry !== 'object') return null;
        return toRow(entry.key, entry.value, {
            desc: toDescription(entry.description),
            enabled: true
        });
    }).filter(Boolean);
}

function toQueryRows(url) {
    if (!url || typeof url !== 'object' || !Array.isArray(url.query)) return [];

    return url.query.map(function (entry) {
        if (!entry || typeof entry !== 'object') return null;
        return toRow(entry.key, entry.value, {
            desc: toDescription(entry.description),
            enabled: entry.disabled !== true
        });
    }).filter(Boolean);
}

/* ------------------------------------------------------------------ 请求体 */

function toFormRows(list) {
    if (!Array.isArray(list)) return [];

    return list.map(function (entry) {
        if (!entry || typeof entry !== 'object') return null;

        var row = toRow(entry.key, entry.value, {
            desc: toDescription(entry.description),
            enabled: entry.disabled !== true
        });

        if (entry.type === 'file') {
            row.kind = 'file';
            // src 可能是字符串，也可能是数组（多文件），取第一个
            var src = Array.isArray(entry.src) ? entry.src[0] : entry.src;
            row.src = isBlank(src) ? null : String(src);
        } else {
            row.kind = 'text';
            row.src = null;
        }
        return row;
    }).filter(Boolean);
}

function toBody(body) {
    if (!body || typeof body !== 'object') return { mode: 'none' };

    var mode = str(body.mode);

    if (mode === 'raw') {
        var language = 'text';
        if (body.options && body.options.raw && body.options.raw.language) {
            language = str(body.options.raw.language);
        }
        return { mode: 'raw', raw: typeof body.raw === 'string' ? body.raw : '', language: language };
    }

    if (mode === 'urlencoded') {
        return { mode: 'urlencoded', form: toFormRows(body.urlencoded) };
    }

    if (mode === 'formdata') {
        return { mode: 'formdata', form: toFormRows(body.formdata) };
    }

    if (mode === 'file') {
        var src = body.file && body.file.src;
        if (Array.isArray(src)) src = src[0];
        return { mode: 'binary', file: { src: isBlank(src) ? null : String(src) } };
    }

    if (mode === 'graphql') {
        var graphql = body.graphql || {};
        var variables = graphql.variables;
        if (variables && typeof variables === 'object') variables = JSON.stringify(variables);
        return {
            mode: 'graphql',
            graphql: {
                query: typeof graphql.query === 'string' ? graphql.query : '',
                variables: typeof variables === 'string' ? variables : ''
            }
        };
    }

    return { mode: 'none' };
}

/* ------------------------------------------------------------------ 示例 */

/** 按响应头的 content-type 判断，没有就看 _postman_previewlanguage，都不行用 text */
function guessResponseType(headers, previewLanguage) {
    var contentType = findHeaderValue(headers, 'content-type').toLowerCase();

    if (contentType) {
        if (contentType.indexOf('json') !== -1) return 'json';
        if (contentType.indexOf('html') !== -1) return 'html';
        return 'text';
    }

    var preview = str(previewLanguage).toLowerCase();
    if (preview === 'json') return 'json';
    if (preview === 'html') return 'html';
    return 'text';
}

function toExamples(response, stats) {
    if (!Array.isArray(response)) return [];

    return response.map(function (entry, index) {
        var item = entry && typeof entry === 'object' ? entry : {};
        var headers = toRows(item.header);
        stats.examples++;

        return {
            name: str(item.name) || ('示例 ' + (index + 1)),
            status: typeof item.code === 'number' ? item.code : 200,
            headers: headers,
            body: typeof item.body === 'string' ? item.body : '',
            responseType: guessResponseType(headers, item._postman_previewlanguage),
            source: 'imported',
            // originalRequest / cookie / responseTime / id / _postman_previewlanguage 都兜在这里
            extra: pickExtra(item, EXAMPLE_MAPPED_KEYS)
        };
    });
}

/* ------------------------------------------------------------------ 接口树 */

function toApi(item, stats) {
    var request = item.request;
    if (typeof request === 'string') request = { method: 'GET', url: request };
    if (!request || typeof request !== 'object') request = {};

    var urlText = toUrlText(request.url);
    var queryRows = toQueryRows(request.url);

    // 查询串已经拆成 params.query 了，就从 url 里去掉，免得发两次。
    // 但如果这个 url 根本没有 query 数组，那 url 自带的查询串得留着，否则就丢了。
    if (queryRows.length) urlText = stripQuery(urlText);

    // item.auth 是某些导出里放在条目上的鉴权，request.auth 优先
    var auth = request.auth !== undefined ? request.auth : item.auth;

    return {
        type: 'api',
        name: str(item.name) || '未命名接口',
        description: toDescription(item.description) || toDescription(request.description),
        method: str(request.method || 'GET').toUpperCase(),
        url: urlText,
        params: {
            path: toPathRows(request.url),
            query: queryRows,
            headers: toRows(request.header)
        },
        body: toBody(request.body),
        auth: toAuth(auth, stats),
        scripts: toScripts(item.event, stats),
        mockPath: urlUtils.deriveMockPath(urlText),
        examples: toExamples(item.response, stats),
        // 分层保存，导出时各回各层
        extra: {
            item: pickExtra(item, API_ITEM_MAPPED_KEYS),
            request: pickExtra(request, REQUEST_MAPPED_KEYS)
        }
    };
}

function toFolder(item, stats) {
    var folder = {
        type: 'folder',
        name: str(item.name) || '未命名分组',
        description: toDescription(item.description),
        auth: toAuth(item.auth, stats),
        variables: toVariableRows(item.variable),
        scripts: toScripts(item.event, stats),
        extra: pickExtra(item, FOLDER_MAPPED_KEYS),
        children: []
    };

    item.item.forEach(function (child) {
        var node = toNode(child, stats);
        if (node) folder.children.push(node);
    });

    return folder;
}

/** 有 item 字段就是分组，有 request 就是接口，都不是就忽略 */
function toNode(item, stats) {
    if (!item || typeof item !== 'object') return null;

    if (Array.isArray(item.item)) {
        stats.folders++;
        return toFolder(item, stats);
    }
    if (item.request) {
        stats.apis++;
        return toApi(item, stats);
    }
    return null;
}

/* ------------------------------------------------------------------ 入口 */

function emptyStats() {
    return { folders: 0, apis: 0, examples: 0, scripts: 0, unsupportedAuth: [] };
}

function buildWarnings(stats) {
    var warnings = [];
    if (stats.scripts > 0) {
        warnings.push(stats.scripts + ' 个脚本已导入，发送请求时会执行（沙箱内运行，见 README 的「脚本」一节）');
    }
    if (stats.unsupportedAuth.length) {
        warnings.push('以下鉴权类型暂不支持：' + stats.unsupportedAuth.join('、'));
    }
    return warnings;
}

function parseCollection(data) {
    var info = data.info && typeof data.info === 'object' ? data.info : {};
    var stats = emptyStats();

    var collection = {
        name: str(info.name) || '未命名集合',
        description: toDescription(info.description),
        variables: toVariableRows(data.variable),
        auth: toAuth(data.auth, stats),
        scripts: toScripts(data.event, stats),
        // 分层保存，导出时各回各层
        extra: {
            root: pickExtra(data, COLLECTION_MAPPED_KEYS),
            info: pickExtra(info, INFO_MAPPED_KEYS)
        },
        children: []
    };

    (Array.isArray(data.item) ? data.item : []).forEach(function (item) {
        var node = toNode(item, stats);
        if (node) collection.children.push(node);
    });

    return { kind: 'collection', collection: collection, stats: stats, warnings: buildWarnings(stats) };
}

function parseEnvironment(data, kind) {
    var stats = emptyStats();
    var name = kind === 'globals' ? 'Globals' : (str(data.name) || '未命名环境');

    return {
        kind: kind,
        environment: { name: name, variables: toVariableRows(data.values) },
        stats: stats,
        warnings: []
    };
}

function parseJson(text) {
    try {
        return JSON.parse(text);
    } catch (err) {
        throw new Error('不是合法的 JSON：' + err.message);
    }
}

/**
 * 解析一份 Postman 文件。
 *
 * @param {string|object} input 文件内容（字符串）或已经 JSON.parse 过的对象
 * @returns {{kind: string, collection?: object, environment?: object, stats: object, warnings: string[]}}
 * @throws {Error} 认不出格式时抛出，message 是能直接给用户看的中文
 */
function parse(input) {
    var data = typeof input === 'string' ? parseJson(input) : input;

    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('无法识别的 JSON 文件：顶层不是一个对象');
    }

    var schema = data.info && typeof data.info === 'object' ? str(data.info.schema) : '';

    if (schema.indexOf('v2.1.0') !== -1 || schema.indexOf('v2.0.0') !== -1) {
        return parseCollection(data);
    }
    if (data.requests && data.order) {
        throw new Error('这是旧的 Collection v1 格式，请重新导出为 Collection v2.1 之后再导入');
    }
    if (data._postman_variable_scope === 'globals') {
        return parseEnvironment(data, 'globals');
    }
    if (Array.isArray(data.values)) {
        return parseEnvironment(data, 'environment');
    }
    // 有些导出会漏掉 info.schema，只要有 info 和 item 就按 v2.1 集合处理
    if (data.info && Array.isArray(data.item)) {
        return parseCollection(data);
    }

    throw new Error('无法识别的 JSON 文件：既不是集合，也不是环境或全局变量');
}

/* ================================================================== 导出 */

/**
 * 反向映射的总原则：**先把 extra 摊到这一层，再让已映射的字段覆盖它**。
 * 这样没被识别的字段原样带回，被识别的字段以解析结果为准，两边都不会互相污染。
 *
 * extra 是按来源分了层的（集合是 root / info，接口是 item / request，文件夹平铺），
 * 导出时各取各的那一层，不要再靠「已知键名单」去猜。
 */

/** 取某一层的 extra；没有或不是对象时给个空包，本项目新建的节点也能直接导出 */
function layerExtra(extra, key) {
    if (!extra || typeof extra !== 'object') return {};
    if (key === undefined) return extra;

    var layer = extra[key];
    return layer && typeof layer === 'object' ? layer : {};
}

function withDescription(entry, row) {
    var desc = str(row && row.desc);
    if (desc) entry.description = desc;
    return entry;
}

/** header / query / path 参数共用的键值条目 */
function toKeyValueEntry(row) {
    var entry = withDescription({
        key: str(row && row.key),
        value: isBlank(row && row.value) ? '' : String(row.value)
    }, row);

    if (row && row.enabled === false) entry.disabled = true;
    return entry;
}

/** 变量条目：secret 用 type 表达，停用用 enabled（和环境文件一致） */
function toVariableEntry(row) {
    var entry = withDescription({
        key: str(row && row.key),
        value: isBlank(row && row.value) ? '' : String(row.value),
        type: row && row.secret ? 'secret' : 'default'
    }, row);

    if (row && row.enabled === false) entry.enabled = false;
    return entry;
}

function toVariableEntries(rows) {
    if (!Array.isArray(rows)) return [];
    return rows.map(toVariableEntry);
}

function toKeyValueEntries(rows) {
    if (!Array.isArray(rows)) return [];
    return rows.map(toKeyValueEntry);
}

function toFormEntries(rows) {
    if (!Array.isArray(rows)) return [];

    return rows.map(function (row) {
        var isFile = Boolean(row) && row.kind === 'file';

        var entry = withDescription({
            key: str(row && row.key),
            value: isBlank(row && row.value) ? '' : String(row.value),
            type: isFile ? 'file' : 'text'
        }, row);

        if (isFile) entry.src = isBlank(row.src) ? null : String(row.src);
        if (row && row.enabled === false) entry.disabled = true;
        return entry;
    });
}

function toBodyPayload(body) {
    var source = body || {};
    var mode = str(source.mode) || 'none';

    if (mode === 'raw') {
        return {
            mode: 'raw',
            raw: typeof source.raw === 'string' ? source.raw : '',
            options: { raw: { language: str(source.language) || 'text' } }
        };
    }
    if (mode === 'urlencoded') {
        return { mode: 'urlencoded', urlencoded: toFormEntries(source.form) };
    }
    if (mode === 'formdata') {
        return { mode: 'formdata', formdata: toFormEntries(source.form) };
    }
    if (mode === 'binary') {
        var file = source.file || {};
        return { mode: 'file', file: { src: isBlank(file.src) ? null : String(file.src) } };
    }
    if (mode === 'graphql') {
        var graphql = source.graphql || {};
        return {
            mode: 'graphql',
            graphql: { query: str(graphql.query), variables: str(graphql.variables) }
        };
    }

    return { mode: 'none' };
}

/**
 * 鉴权转回 v2.1 的数组写法。
 * 认不出来又没留 raw 的，返回 undefined —— 不写 auth 就等于沿用父级，比瞎写一个强。
 */
function toAuthPayload(auth) {
    if (!auth) return undefined;

    if (auth.unsupported && auth.raw) return auth.raw;

    var type = str(auth.type);
    if (type === 'noauth') return { type: 'noauth' };
    if (type === 'inherit') return { type: 'inherit' };
    if (type === 'bearer') {
        return { type: 'bearer', bearer: [{ key: 'token', value: str(auth.token) }] };
    }
    if (type === 'basic') {
        return {
            type: 'basic',
            basic: [
                { key: 'username', value: str(auth.username) },
                { key: 'password', value: str(auth.password) }
            ]
        };
    }
    if (type === 'apikey') {
        return {
            type: 'apikey',
            apikey: [
                { key: 'key', value: str(auth.key) },
                { key: 'value', value: str(auth.value) },
                { key: 'in', value: auth.in === 'query' ? 'query' : 'header' }
            ]
        };
    }

    return undefined;
}

function toEventPayload(scripts) {
    if (!Array.isArray(scripts) || !scripts.length) return undefined;

    return scripts.map(function (script) {
        var exec = typeof script.exec === 'string' ? script.exec : '';
        return {
            listen: script.listen,
            script: { exec: exec.split('\n'), type: 'text/javascript' }
        };
    });
}

function toResponsePayload(examples) {
    if (!Array.isArray(examples)) return [];

    return examples.map(function (example) {
        var status = typeof example.status === 'number' ? example.status : 200;

        var payload = mergeExtra({}, layerExtra(example.extra));
        payload.name = str(example.name);
        payload.status = http.STATUS_CODES[status] || '';
        payload.code = status;
        payload.header = toKeyValueEntries(example.headers);
        payload.body = typeof example.body === 'string' ? example.body : '';

        // 只有在「再解析时判断不出同一个 responseType」时才补这个字段：
        // - 有 content-type 头的话，响应类型由它说了算，这个字段用不上；
        // - 没有 content-type 时，'text' 本来就是默认值，不写也一样。
        // 其余情况不补，免得给原本没有这个字段的示例凭空加一个，破坏往返无损。
        var responseType = str(example.responseType) || 'text';
        if (!payload._postman_previewlanguage &&
            !findHeaderValue(example.headers, 'content-type') &&
            responseType !== 'text') {
            payload._postman_previewlanguage = responseType;
        }

        return payload;
    });
}

/**
 * url 输出成对象形式：raw 是拼回查询串的完整地址，query / variable 数组也一并给出。
 * raw 里只放启用的查询参数，query 数组里停用的也留着（带 disabled），这样往返不丢。
 */
function toUrlPayload(urlText, params) {
    var pathRows = (params && params.path) || [];
    var queryRows = (params && params.query) || [];

    var queryString = queryRows.filter(function (row) {
        return row && row.enabled !== false;
    }).map(function (row) {
        return urlUtils.encodeQueryPart(str(row.key)) + '=' +
            urlUtils.encodeQueryPart(isBlank(row.value) ? '' : String(row.value));
    }).join('&');

    var raw = str(urlText);
    if (queryString) raw += (raw.indexOf('?') === -1 ? '?' : '&') + queryString;

    return {
        raw: raw,
        query: toKeyValueEntries(queryRows),
        variable: toKeyValueEntries(pathRows)
    };
}

function toApiItem(node) {
    var item = mergeExtra({}, layerExtra(node.extra, 'item'));
    item.name = str(node.name);

    var description = str(node.description);
    if (description) item.description = description;

    var request = mergeExtra({}, layerExtra(node.extra, 'request'));
    request.method = str(node.method) || 'GET';
    request.header = toKeyValueEntries((node.params || {}).headers);
    request.url = toUrlPayload(node.url, node.params);
    request.body = toBodyPayload(node.body);

    var auth = toAuthPayload(node.auth);
    if (auth !== undefined) request.auth = auth;

    item.request = request;

    var event = toEventPayload(node.scripts);
    if (event) item.event = event;

    item.response = toResponsePayload(node.examples);
    return item;
}

function toFolderItem(node) {
    // 文件夹只有一层，extra 是平铺的
    var item = mergeExtra({}, layerExtra(node.extra));
    item.name = str(node.name);

    var description = str(node.description);
    if (description) item.description = description;

    var variables = toVariableEntries(node.variables);
    if (variables.length) item.variable = variables;

    var auth = toAuthPayload(node.auth);
    if (auth !== undefined) item.auth = auth;

    var event = toEventPayload(node.scripts);
    if (event) item.event = event;

    item.item = (node.children || []).map(toNodePayload).filter(Boolean);
    return item;
}

function toNodePayload(node) {
    if (!node) return null;
    return node.type === 'folder' ? toFolderItem(node) : toApiItem(node);
}

/**
 * 生成 Postman Collection v2.1。
 *
 * @param {object} collection 解析结果里的 collection 结构
 * @returns {object} 可以直接 JSON.stringify 落盘的对象
 */
function toCollection(collection) {
    var source = collection || {};

    var info = mergeExtra({}, layerExtra(source.extra, 'info'));
    info.name = str(source.name);
    var description = str(source.description);
    if (description) info.description = description;
    info.schema = COLLECTION_SCHEMA;

    var payload = mergeExtra({}, layerExtra(source.extra, 'root'));
    payload.info = info;

    var variables = toVariableEntries(source.variables);
    if (variables.length) payload.variable = variables;

    var auth = toAuthPayload(source.auth);
    if (auth !== undefined) payload.auth = auth;

    var event = toEventPayload(source.scripts);
    if (event) payload.event = event;

    payload.item = (source.children || []).map(toNodePayload).filter(Boolean);
    return payload;
}

/**
 * 生成 Postman Environment。
 *
 * @param {object} environment 解析结果里的 environment 结构
 * @returns {object}
 */
function toEnvironment(environment) {
    var source = environment || {};

    return {
        name: str(source.name),
        values: toVariableEntries(source.variables),
        _postman_variable_scope: 'environment'
    };
}

module.exports = {
    parse: parse,
    toCollection: toCollection,
    toEnvironment: toEnvironment,
    // HAR 导入（lib/har.js）要产出和这里**完全一样**的节点形状，所以复用这两个：
    // guessResponseType 判响应类型，toRow 造键值行。只加导出，实现没动。
    guessResponseType: guessResponseType,
    toRow: toRow
};
