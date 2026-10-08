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
        // 常见的坑：填的是 Swagger UI 页面地址，拿回来的是 HTML
        if (/^\s*<(!doctype|html)/i.test(text)) {
            throw new Error(i18n.m('这个地址返回的是网页，不是接口定义。请填 JSON / YAML 的地址，比如 /v3/api-docs 或 /swagger.json'));
        }
        return text;
    }, function (err) {
        if (err && err.name === 'AbortError') throw new Error(i18n.m('超时（15 秒）'));
        throw new Error((err && err.cause && err.cause.message) || (err && err.message) || String(err));
    }).finally(function () {
        clearTimeout(timer);
    });
}

module.exports = {
    fetchSpecText: fetchSpecText,
    SPEC_FETCH_TIMEOUT_MS: SPEC_FETCH_TIMEOUT_MS,
    SPEC_MAX_BYTES: SPEC_MAX_BYTES
};
