/**
 * HAR 导入（契约第 13 节）。
 *
 * 浏览器开发者工具导出的 HAR 1.2 里混着 xhr、图片、CSS、JS…… 这里把它过滤、按主机
 * 分组、按「方法 + origin + pathname」合并成接口，产出和 `lib/postman.js` 的
 * `parse().collection` **完全相同的结构**，然后交给同一个 `tree.writeTree` 落库。
 * 换句话说：这个模块只负责「HAR → collection」，写库、事务、mock 设置、权限
 * 一行都不重复实现。
 *
 * 三条容易写错的地方：
 *   - **凭据默认不保留**。HAR 是从真实浏览器会话录下来的，带着登录态，而导入的项目
 *     是全体成员都能看到的。默认去掉 Cookie / Authorization / Proxy-Authorization
 *     和 Set-Cookie，每去掉一处记一次数。
 *   - **请求头名一律按小写比**。HTTP/2 的 HAR 里请求头名就是小写的 `cookie`，
 *     少比一次就等于把凭据原样存进了库。
 *   - **残缺的条目不能把整次导入带崩**。headers 为 null、postData 没有 text、
 *     content 缺失、startedDateTime 写错、url 解析不了 —— 能导的照常导，
 *     导不了的计入 `stats.skipped`，只有顶层结构不对才抛错（由路由转成 400）。
 */

var urlUtils = require('./url-utils');
var postman = require('./postman');

/** 传输层自己会重算，留着反而会把请求发错 */
var DROPPED_REQUEST_HEADERS = ['host', 'content-length', 'connection', 'keep-alive',
    'transfer-encoding', 'te', 'upgrade'];

/** 凭据头：不保留凭据时去掉它们 */
var CREDENTIAL_REQUEST_HEADERS = ['cookie', 'authorization', 'proxy-authorization'];
var CREDENTIAL_RESPONSE_HEADERS = ['set-cookie'];

/** 示例响应头里去掉的：响应体已经是解码后的内容，长度和编码都不再成立 */
var DROPPED_RESPONSE_HEADERS = ['content-length', 'content-encoding', 'transfer-encoding', 'connection'];

/** 没有 `_resourceType` 时，按 mimeType 判定为静态资源 */
var STATIC_MIME_PREFIXES = ['image/', 'font/', 'audio/', 'video/'];
var STATIC_MIME_EXACT = ['text/css', 'text/html', 'application/wasm'];

/** 每个接口最多留几条示例 */
var MAX_EXAMPLES_PER_API = 5;

function str(value) {
    if (value === null || value === undefined) return '';
    return String(value);
}

function pad2(value) {
    return String(value).padStart(2, '0');
}

function parseJson(text) {
    try {
        return JSON.parse(text);
    } catch (err) {
        throw new Error('不是合法的 JSON：' + err.message);
    }
}

/** 解析不了的（相对地址、空串、脏数据）一律返回 null，由调用方计入 skipped */
function parseUrl(text) {
    if (typeof text !== 'string' || !text) return null;
    try {
        return new URL(text);
    } catch (err) {
        return null;
    }
}

/** mimeType 去掉参数并转小写：`text/HTML; charset=utf-8` → `text/html` */
function mimeOf(entry) {
    var content = entry && entry.response && entry.response.content;
    var mime = content && typeof content.mimeType === 'string' ? content.mimeType : '';
    return mime.toLowerCase().split(';')[0].trim();
}

function isStaticMime(mime) {
    if (!mime) return false;

    for (var i = 0; i < STATIC_MIME_PREFIXES.length; i++) {
        if (mime.indexOf(STATIC_MIME_PREFIXES[i]) === 0) return true;
    }
    if (STATIC_MIME_EXACT.indexOf(mime) !== -1) return true;
    // application/javascript、text/javascript、application/x-javascript 都算
    return mime.indexOf('javascript') !== -1;
}

/** 文本类型的响应体才值得存成示例 */
function isTextMime(mime) {
    if (!mime) return false;
    if (mime.indexOf('text/') === 0) return true;
    return mime.indexOf('json') !== -1 || mime.indexOf('xml') !== -1 || mime.indexOf('javascript') !== -1;
}

/**
 * 这条记录要不要保留。
 *
 * `_resourceType` 有值（Chrome 导出的一定有）就只看它；没有（其他工具）才回退到
 * 按 mimeType 判静态资源。空串当成没有 —— 有些工具会留一个空字段，
 * 那不该把所有请求都判死。
 */
function shouldKeep(entry) {
    var parsed = parseUrl(entry.request && entry.request.url);
    if (!parsed) return false;
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

    var resourceType = str(entry._resourceType).trim().toLowerCase();
    if (resourceType) return resourceType === 'xhr' || resourceType === 'fetch';

    return !isStaticMime(mimeOf(entry));
}

function timeOf(entry) {
    var ms = Date.parse(str(entry && entry.startedDateTime));
    return Number.isNaN(ms) ? null : ms;
}

/**
 * 按 `startedDateTime` 升序。时间无效的排在最后，**并且保持它们原来的相对顺序**。
 *
 * 先按「有效 / 无效」分两组、再各自排序，而不是写一个比较函数交给 sort ——
 * 比较函数返回 0 时是否稳定要看引擎，不能指望。
 */
function sortEntries(list) {
    var valid = [];
    var invalid = [];

    list.forEach(function (entry, index) {
        var ms = timeOf(entry);
        if (ms === null) invalid.push({ entry: entry, index: index });
        else valid.push({ entry: entry, index: index, ms: ms });
    });

    valid.sort(function (a, b) { return a.ms - b.ms || a.index - b.index; });
    invalid.sort(function (a, b) { return a.index - b.index; });

    return valid.concat(invalid).map(function (item) { return item.entry; });
}

/* ------------------------------------------------------------------ 请求 */

function toHeaderRows(headers, stats, keepCredentials) {
    var rows = [];

    (Array.isArray(headers) ? headers : []).forEach(function (item) {
        if (!item || typeof item !== 'object') return;

        var name = str(item.name);
        // HTTP/2 的伪头（`:method`、`:authority`…）不是真请求头
        if (!name || name.charAt(0) === ':') return;

        var lower = name.toLowerCase();
        if (DROPPED_REQUEST_HEADERS.indexOf(lower) !== -1) return;

        if (!keepCredentials && CREDENTIAL_REQUEST_HEADERS.indexOf(lower) !== -1) {
            stats.credentialsStripped++;
            return;
        }

        rows.push(postman.toRow(name, item.value));
    });

    return rows;
}

function toQueryRows(parsed) {
    var rows = [];

    parsed.searchParams.forEach(function (value, key) {
        rows.push(postman.toRow(key, value));
    });

    return rows;
}

/** 和 postman.js 的 `toFormRows` 同一形状：多两个字段 kind / src */
function toFormRow(item, kind) {
    var row = postman.toRow(item.name, item.value);
    row.kind = kind;
    row.src = null;
    return row;
}

function rawLanguage(mime) {
    if (mime.indexOf('json') !== -1) return 'json';
    if (mime.indexOf('xml') !== -1) return 'xml';
    return 'text';
}

function toBody(entry, stats) {
    var postData = entry.request && entry.request.postData;
    if (!postData || typeof postData !== 'object') return { mode: 'none' };

    var mime = str(postData.mimeType).toLowerCase().split(';')[0].trim();
    var params = Array.isArray(postData.params) ? postData.params : [];

    if (mime.indexOf('x-www-form-urlencoded') !== -1 && params.length) {
        return {
            mode: 'urlencoded',
            form: params.map(function (item) { return toFormRow(item, 'text'); })
        };
    }

    if (mime.indexOf('multipart/form-data') !== -1 && params.length) {
        return {
            mode: 'formdata',
            form: params.map(function (item) {
                // HAR 的文件部分靠 fileName 认。文件内容不在 HAR 里，所以值置空、
                // 标成文件行 —— 保留这一行是为了让字段名还在，用户自己补文件。
                var isFile = str(item.fileName) !== '';
                if (isFile) stats.filesDropped++;
                return toFormRow(item, isFile ? 'file' : 'text');
            })
        };
    }

    if (typeof postData.text === 'string') {
        return { mode: 'raw', raw: postData.text, language: rawLanguage(mime) };
    }

    return { mode: 'none' };
}

/* ------------------------------------------------------------------ 示例 */

function toExampleHeaderRows(headers, stats, keepCredentials) {
    var rows = [];

    (Array.isArray(headers) ? headers : []).forEach(function (item) {
        if (!item || typeof item !== 'object') return;

        var name = str(item.name);
        if (!name) return;

        var lower = name.toLowerCase();
        if (DROPPED_RESPONSE_HEADERS.indexOf(lower) !== -1) return;

        if (!keepCredentials && CREDENTIAL_RESPONSE_HEADERS.indexOf(lower) !== -1) {
            stats.credentialsStripped++;
            return;
        }

        rows.push(postman.toRow(name, item.value));
    });

    return rows;
}

/** 响应体文本；拿不到就返回 null（调用方计入 bodiesMissing） */
function responseBody(entry) {
    var content = entry.response && entry.response.content;
    if (!content || typeof content !== 'object') return null;
    if (typeof content.text !== 'string') return null;

    if (str(content.encoding).toLowerCase() === 'base64') {
        return Buffer.from(content.text, 'base64').toString('utf8');
    }
    return content.text;
}

function exampleName(status, startedDateTime, now) {
    var date = new Date(str(startedDateTime));
    if (Number.isNaN(date.getTime())) date = now;

    return status + ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes()) + ':' + pad2(date.getSeconds());
}

/**
 * 给一个接口生成示例。entries 已经按时间排好序。
 *
 * 不生成示例的三种情况：状态码是 0（请求被拦截/失败）、响应不是文本类型、
 * 拿不到 `content.text`。后两种计入 `bodiesMissing`，状态码 0 不计（它本来就没响应）。
 */
function toExamples(entries, stats, options) {
    var kept = [];
    var seen = {};

    entries.forEach(function (entry) {
        var status = Number(entry.response && entry.response.status);
        if (!Number.isFinite(status) || status <= 0) return;

        var mime = mimeOf(entry);
        if (!isTextMime(mime)) {
            stats.bodiesMissing++;
            return;
        }

        var body = responseBody(entry);
        if (body === null) {
            stats.bodiesMissing++;
            return;
        }

        // 上限先判：到顶之后每条都是 examplesDropped，没必要再算指纹
        // （指纹里带着整段响应体，留着很占内存）
        if (kept.length >= MAX_EXAMPLES_PER_API) {
            stats.examplesDropped++;
            return;
        }

        var fingerprint = status + '\u0000' + body;
        if (seen[fingerprint]) {
            stats.examplesDropped++;
            return;
        }
        seen[fingerprint] = true;

        var headers = toExampleHeaderRows(entry.response.headers, stats, options.keepCredentials);

        kept.push({
            name: exampleName(status, entry.startedDateTime, options.now),
            status: status,
            headers: headers,
            body: body,
            responseType: postman.guessResponseType(headers),
            source: 'imported',
            extra: {}
        });
    });

    stats.examples += kept.length;
    return kept;
}

/* ------------------------------------------------------------------ 组装 */

function toApiNode(entries, stats, options) {
    var first = entries[0];
    var parsed = parseUrl(first.request.url);
    var method = str(first.request.method || 'GET').toUpperCase();

    // url 不带查询串（查询串进 params.query），origin 里也没有 userinfo
    var url = parsed.origin + parsed.pathname;

    stats.apis++;

    return {
        type: 'api',
        name: method + ' ' + parsed.pathname,
        description: '',
        method: method,
        url: url,
        params: {
            // HAR 里没有路径参数的写法，留空
            path: [],
            query: toQueryRows(parsed),
            headers: toHeaderRows(first.request.headers, stats, options.keepCredentials)
        },
        body: toBody(first, stats),
        auth: null,
        scripts: null,
        mockPath: urlUtils.deriveMockPath(url),
        examples: toExamples(entries, stats, options),
        extra: {}
    };
}

function projectName(log, now) {
    var pages = Array.isArray(log.pages) ? log.pages : [];
    var first = pages.length ? pages[0] : null;
    var title = first && typeof first === 'object' ? str(first.title).trim() : '';
    if (title) return title;

    return 'HAR 导入 ' + now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate()) +
        ' ' + pad2(now.getHours()) + ':' + pad2(now.getMinutes());
}

function emptyStats() {
    return {
        hosts: 0,
        apis: 0,
        examples: 0,
        skipped: 0,
        examplesDropped: 0,
        bodiesMissing: 0,
        credentialsStripped: 0,
        filesDropped: 0
    };
}

/**
 * 每一句都对应一类「有东西没进来」的情况，让用户知道导进来的是不是完整的。
 * `hosts` / `apis` / `examples` 是正常计数，不出警告 —— 那些是结果，不是问题。
 */
function buildWarnings(stats) {
    var warnings = [];

    if (stats.skipped > 0) {
        warnings.push('跳过了 ' + stats.skipped + ' 条静态资源或非 http 请求');
    }
    if (stats.credentialsStripped > 0) {
        warnings.push('已去掉 ' + stats.credentialsStripped +
            ' 处 Cookie / Authorization 等凭据；如需保留，导入时勾选『保留凭据』');
    }
    if (stats.bodiesMissing > 0) {
        warnings.push(stats.bodiesMissing + ' 条记录没有可用的文本响应体，没有生成示例');
    }
    if (stats.examplesDropped > 0) {
        warnings.push('有 ' + stats.examplesDropped + ' 个示例因为重复或超出每个接口 ' +
            MAX_EXAMPLES_PER_API + ' 条的上限被丢弃');
    }
    if (stats.filesDropped > 0) {
        warnings.push('有 ' + stats.filesDropped + ' 个上传的文件字段被置空（HAR 里没有文件内容）');
    }

    return warnings;
}

/**
 * 解析一份 HAR 文件。
 *
 * @param {string|object} input 文件内容（字符串）或已经 JSON.parse 过的对象
 * @param {{keepCredentials?: boolean, now?: Date}} [options]
 * @returns {{kind: 'har', name: string, collection: object, stats: object, warnings: string[]}}
 * @throws {Error} 顶层结构不对时抛出，message 是能直接给用户看的中文
 */
function parse(input, options) {
    var data = typeof input === 'string' ? parseJson(input) : input;
    var opts = options || {};
    var now = opts.now instanceof Date && !Number.isNaN(opts.now.getTime()) ? opts.now : new Date();

    var resolved = {
        keepCredentials: opts.keepCredentials === true,
        now: now
    };

    if (!data || typeof data !== 'object' || Array.isArray(data) ||
        !data.log || typeof data.log !== 'object' || !Array.isArray(data.log.entries)) {
        throw new Error('不是 HAR 文件：缺少 log.entries');
    }

    var stats = emptyStats();

    /** 分组键 → { host, entries }；Map 保持插入顺序，所以主机和接口的顺序都是「第一次出现」 */
    var groups = new Map();

    data.log.entries.forEach(function (entry) {
        if (!entry || typeof entry !== 'object') {
            stats.skipped++;
            return;
        }
        if (!shouldKeep(entry)) {
            stats.skipped++;
            return;
        }

        var parsed = parseUrl(entry.request.url);
        var method = str(entry.request.method || 'GET').toUpperCase();
        var key = method + ' ' + parsed.origin + ' ' + parsed.pathname;

        if (!groups.has(key)) groups.set(key, { host: parsed.host, entries: [] });
        groups.get(key).entries.push(entry);
    });

    var hostOrder = [];
    var byHost = new Map();

    groups.forEach(function (group) {
        if (!byHost.has(group.host)) {
            byHost.set(group.host, []);
            hostOrder.push(group.host);
        }
        byHost.get(group.host).push(toApiNode(sortEntries(group.entries), stats, resolved));
    });

    var children = hostOrder.map(function (host) {
        return {
            type: 'folder',
            name: host,
            description: '',
            auth: null,
            variables: [],
            scripts: null,
            extra: {},
            children: byHost.get(host)
        };
    });

    stats.hosts = hostOrder.length;

    var name = projectName(data.log, now);

    return {
        kind: 'har',
        name: name,
        collection: {
            name: name,
            description: '',
            variables: [],
            auth: null,
            scripts: null,
            extra: {},
            children: children
        },
        stats: stats,
        warnings: buildWarnings(stats)
    };
}

module.exports = {
    parse: parse,
    // 给自测脚本用，路由不需要
    MAX_EXAMPLES_PER_API: MAX_EXAMPLES_PER_API
};
