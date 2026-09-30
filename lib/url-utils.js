/**
 * URL 拼装与 mock 路径推导。
 *
 * 两件事分开看：
 * - buildUrl：把「url 模板 + 路径参数 + query 行」拼成一个能直接发出去的 URL；
 * - deriveMockPath：反过来，从一个请求 URL 推出它该挂在 /mock 下的哪个路径。
 *
 * 两处都要小心「已经编码过的 %xx」—— 再编码一次会把 %20 变成 %2520，
 * 所以统一走 encodeQueryPart，它只编码不是合法转义序列的百分号。
 */

var SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

/** 路径里的 :name 段。要求 : 前面是 / 或开头，免得把 http://host:8080 的端口号当成参数 */
var PATH_PARAM = /(^|\/):([\w.\-]+)/g;

/** 和 variables.js 同一套占位符写法 */
var PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;

/** 开头的 {{变量}}，可能连着好几个，比如 {{baseUrl}}{{version}}/api */
var LEADING_PLACEHOLDER = /^(?:\s*\{\{\s*[^{}]*?\s*\}\})+/;

/** 协议后面的主机名（含端口） */
var PROTOCOL_RELATIVE_HOST = /^\/\/[^/?#]*/;

/**
 * 按 URL 规则编码，但不碰已经是 %xx 的部分。
 * 'a b' → 'a%20b'；'a%20b' → 'a%20b'；'100%' → '100%25'。
 */
function encodeQueryPart(text) {
    return String(text).split(/(%[0-9a-fA-F]{2})/).map(function (part, index) {
        // split 带捕获组时，奇数位就是捕获到的 %xx，已经编码过，原样保留
        return index % 2 === 1 ? part : encodeURIComponent(part);
    }).join('');
}

/** 取出启用且 key 非空的行，key 和 value 都转成字符串 */
function enabledRows(rows) {
    if (!Array.isArray(rows)) return [];

    return rows.filter(function (row) {
        if (!row || row.enabled === false) return false;
        return row.key !== null && row.key !== undefined && String(row.key) !== '';
    }).map(function (row) {
        return {
            key: String(row.key),
            value: row.value === null || row.value === undefined ? '' : String(row.value)
        };
    });
}

/**
 * 拼出最终要请求的 URL。
 *
 * @param {object} spec RequestSpec
 * @returns {string}
 */
function buildUrl(spec) {
    var source = spec || {};
    var params = source.params || {};
    var raw = typeof source.url === 'string' ? source.url : '';

    // 1. 没有协议就补 http://，用户只写 example.com/api 也能发
    var url = SCHEME.test(raw) ? raw : 'http://' + raw;

    // 2. 路径参数：把 /:id 换成实际值
    var pathValues = {};
    enabledRows(params.path).forEach(function (row) {
        pathValues[row.key] = row.value;
    });

    url = url.replace(PATH_PARAM, function (whole, slash, name) {
        if (!Object.prototype.hasOwnProperty.call(pathValues, name)) return whole;
        return slash + encodeQueryPart(pathValues[name]);
    });

    // 3. 追加 query 行；url 自己带的查询串排在前面，两边都发
    var extra = enabledRows(params.query).map(function (row) {
        return encodeQueryPart(row.key) + '=' + encodeQueryPart(row.value);
    });

    if (extra.length) {
        url += (url.indexOf('?') === -1 ? '?' : '&') + extra.join('&');
    }

    return url;
}

/**
 * 从请求 URL 推出 mock 路径。
 *
 * {{baseUrl}}/api/users/{{id}}?x=1  →  /api/users/:id
 * https://a.com:8080/v1/x           →  /v1/x
 *
 * @param {string} url
 * @returns {string}
 */
function deriveMockPath(url) {
    var text = typeof url === 'string' ? url : '';

    // 1. 去掉开头的 {{baseUrl}} 这类变量
    text = text.replace(LEADING_PLACEHOLDER, '');

    // 2. 去掉协议和主机名。协议相对地址（//host/path）没有协议，单独处理；
    //    剩下的「host/path」这种写法，第一段就是主机，一起切掉
    text = text.replace(SCHEME, '').replace(PROTOCOL_RELATIVE_HOST, '');
    if (text.charAt(0) !== '/') {
        var slash = text.search(/[/?#]/);
        text = slash === -1 ? '' : text.slice(slash);
    }

    // 3. 去掉查询串和 # 之后的部分
    text = text.split('?')[0].split('#')[0];

    // 4. 路径里的 {{name}} 段转成 :name；{{@...}} 是 mock 占位符，原样保留
    text = text.replace(PLACEHOLDER, function (whole, rawName) {
        var name = String(rawName).trim();
        if (!name || name.charAt(0) === '@') return whole;
        return ':' + name;
    });

    // 5. 保证以 / 开头
    if (text.charAt(0) !== '/') text = '/' + text;
    return text;
}

module.exports = {
    buildUrl: buildUrl,
    deriveMockPath: deriveMockPath,
    encodeQueryPart: encodeQueryPart
};
