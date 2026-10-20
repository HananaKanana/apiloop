/**
 * 拉 OpenAPI / Swagger 定义的原文。
 *
 * 两个地方要用（`/import/openapi` 和 `/projects/:pid/openapi/diff`、`/apply`），
 * 所以从 `lib/admin.js` 里提出来单独放 —— 复制两份的话，超时和大小上限迟早会不一致。
 *
 * 由**这个进程**去取：客户端里就是本机网关，公司内网的 swagger 也拉得到。
 */

var i18n = require('./i18n');

var SPEC_FETCH_TIMEOUT_MS = 15000;
var SPEC_MAX_BYTES = 20 * 1024 * 1024;

/**
 * @param {string} url 只认 http(s)
 * @returns {Promise<string>} 定义原文（JSON 或 YAML）
 */
function fetchSpecText(url) {
    return fetchText(url).then(function (text) {
        // 常见的坑：填的是 Swagger UI 页面地址，拿回来的是 HTML
        if (looksLikeHtml(text)) {
            throw new Error(i18n.m('这个地址返回的是网页，不是接口定义。请填 JSON / YAML 的地址，比如 /v3/api-docs 或 /swagger.json'));
        }
        return text;
    });
}

/**
 * 是不是网页。springdoc 的 Swagger UI 首页开头是一段 `<!-- HTML for static distribution… -->`
 * 注释，原来只认 `<!doctype` / `<html` 开头，被它骗过去了（用户 2026-10-20）。
 */
function looksLikeHtml(text) {
    return /^\s*(?:<!--[\s\S]*?-->\s*)*<(?:!doctype|html|head|body)/i.test(String(text || ''));
}

/** 取原文，不管是不是网页（超时、大小上限照旧） */
function fetchText(url) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, SPEC_FETCH_TIMEOUT_MS);

    return fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json, application/yaml, text/yaml, */*' }
    }).then(function (response) {
        if (!response.ok) throw new Error(i18n.m('对方返回 HTTP {status}', { status: response.status }));
        var length = Number(response.headers.get('content-length'));
        if (length > SPEC_MAX_BYTES) throw new Error(i18n.m('文件太大（超过 20MB）'));
        return response.text();
    }).then(function (text) {
        if (text.length > SPEC_MAX_BYTES) throw new Error(i18n.m('文件太大（超过 20MB）'));
        return text;
    }, function (err) {
        if (err && err.name === 'AbortError') throw new Error(i18n.m('超时（15 秒）'));
        throw new Error((err && err.cause && err.cause.message) || (err && err.message) || String(err));
    }).finally(function () {
        clearTimeout(timer);
    });
}

/* ------------------------------------------------------------------ Swagger UI 页面 */

function parseJsonOrNull(text) {
    try {
        var value = JSON.parse(text);
        return value && typeof value === 'object' ? value : null;
    } catch (err) {
        return null;
    }
}

/** 是 Swagger UI 的配置（swagger-config）吗：有 `urls` 列表或 `url`，但自己没有 paths */
function isSwaggerConfig(value) {
    return Boolean(value) && !value.paths && (Array.isArray(value.urls) || typeof value.url === 'string');
}

/** 配置里列出来的文档：`[{ name, url }]`，地址按配置所在的地址解析成绝对地址 */
function documentsFromConfig(config, baseUrl) {
    var list = Array.isArray(config.urls) && config.urls.length
        ? config.urls
        : [{ url: config.url, name: '' }];
    return list.filter(function (item) { return item && typeof item.url === 'string' && item.url; })
        .map(function (item) {
            return { name: String(item.name || ''), url: new URL(item.url, baseUrl).toString() };
        });
}

/**
 * Swagger UI 页面背后的配置在哪：按顺序试，第一个拿得到的就用。
 *
 * 1. 页面同目录的 `swagger-initializer.js`（新版 Swagger UI；springdoc 在里面写 `configUrl`）；
 *    页面里直接写了 `configUrl` / `url` 的（老版本、自己改过的页面）也认；
 * 2. springdoc 的默认位置：`<swagger-ui 前面那段>/v3/api-docs/swagger-config`。
 *
 * 页面里那个默认的 petstore 示例地址不算数。
 */
function configCandidates(pageUrl, html) {
    var out = [];
    function fromScript(text, base) {
        var config = /["']?configUrl["']?\s*:\s*["']([^"']+)["']/.exec(text);
        if (config) out.push({ kind: 'config', url: new URL(config[1], base).toString() });
        var single = /["']?url["']?\s*:\s*["']([^"']+)["']/.exec(text);
        if (single && !/petstore\.swagger\.io/.test(single[1])) {
            out.push({ kind: 'doc', url: new URL(single[1], base).toString() });
        }
    }
    fromScript(html, pageUrl);
    out.push({ kind: 'script', url: new URL('swagger-initializer.js', pageUrl).toString() });

    var parsed = new URL(pageUrl);
    var cut = parsed.pathname.toLowerCase().indexOf('/swagger-ui');
    var prefix = cut === -1 ? '' : parsed.pathname.slice(0, cut);
    out.push({ kind: 'config', url: parsed.origin + prefix + '/v3/api-docs/swagger-config' });
    out.push({ kind: 'doc', url: parsed.origin + prefix + '/v3/api-docs' });
    return { list: out, fromScript: fromScript };
}

/**
 * 按地址取接口定义，**可能有好几份**（用户 2026-10-20：填 Swagger UI 页面地址导不进来；
 * springdoc 按分组出好几份文档，页面上是右上角那个下拉）。
 *
 * - 地址本身就是 JSON / YAML 定义：一份，name 为空；
 * - 是 Swagger UI 的配置（swagger-config）：配置里列的每一份；
 * - 是 Swagger UI 页面：找到它背后的配置（见 configCandidates），再按配置取。
 *
 * @returns {Promise<Array<{name: string, url: string, text: string}>>}
 */
function fetchSpecDocuments(url) {
    return fetchText(url).then(function (text) {
        var asJson = parseJsonOrNull(text);
        if (isSwaggerConfig(asJson)) return fetchListed(documentsFromConfig(asJson, url));
        if (!looksLikeHtml(text)) return [{ name: '', url: url, text: text }];
        return fromSwaggerUiPage(url, text);
    });
}

function fetchListed(documents) {
    if (!documents.length) throw new Error(i18n.m('Swagger UI 的配置里没有列出接口文档'));
    return Promise.all(documents.map(function (doc) {
        return fetchSpecText(doc.url).then(function (text) {
            return { name: doc.name, url: doc.url, text: text };
        }, function (err) {
            throw new Error((doc.name ? doc.name + '：' : '') + doc.url + ' ' + err.message);
        });
    }));
}

function fromSwaggerUiPage(pageUrl, html) {
    var found = configCandidates(pageUrl, html);
    var queue = found.list.slice();

    function next() {
        var item = queue.shift();
        if (!item) {
            return Promise.reject(new Error(i18n.m('这个地址返回的是网页，不是接口定义，也没找到它背后的文档地址。请填 JSON / YAML 的地址，比如 /v3/api-docs 或 /swagger.json')));
        }
        return fetchText(item.url).then(function (text) {
            if (item.kind === 'script') {
                if (looksLikeHtml(text)) return next();
                // 脚本里找到的地址插到队列最前面，比默认位置优先
                var before = found.list.length;
                found.fromScript(text, item.url);
                queue = found.list.splice(before).concat(queue);
                return next();
            }
            var value = parseJsonOrNull(text);
            if (item.kind === 'config') {
                return isSwaggerConfig(value) ? fetchListed(documentsFromConfig(value, item.url)) : next();
            }
            if (looksLikeHtml(text) || (value && !value.paths)) return next();
            return [{ name: '', url: item.url, text: text }];
        }, next);
    }

    return next();
}

module.exports = {
    fetchSpecText: fetchSpecText,
    fetchSpecDocuments: fetchSpecDocuments,
    looksLikeHtml: looksLikeHtml,
    SPEC_FETCH_TIMEOUT_MS: SPEC_FETCH_TIMEOUT_MS,
    SPEC_MAX_BYTES: SPEC_MAX_BYTES
};
