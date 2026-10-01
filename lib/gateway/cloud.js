/**
 * 网关调云端的 JSON 接口（G1）。
 *
 * 网关自己不认识用户，云端才认识 —— 所以每一次调用都把**浏览器那份 Cookie 原样带过去**，
 * 云端按它认人、判权限。网关这边不做任何鉴权判断，也拿不到别的项目的数据。
 *
 * 两件事在这个文件里定死，别处不要再写一份：
 * - **哪些请求头能转给云端**（Host 要换成云端的、逐跳头不能转）；
 * - **什么算「连不上云端」**（网络层失败，和云端返回 4xx/5xx 要分开处理）。
 */

var fs = require('fs');
var path = require('path');
var http = require('http');
var https = require('https');

var appInfo = require('../app-info');

/**
 * 逐跳头（RFC 7230 6.1）。转发时两头都要去掉 —— 它们是「这一段连接」的属性，
 * 照搬给下一段会让下一段按上一段的约定说话（最典型的是 transfer-encoding）。
 */
var HOP_BY_HOP = [
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer', 'transfer-encoding', 'upgrade'
];

/**
 * 安装包里写死的云端地址。
 *
 * 打包时用 `APILOOP_CLOUD_URL=<地址> bash agent-installer/mac/build.sh` 把它写进
 * `<安装目录>/cloud.json`（内容就是 `{ "cloudUrl": "…" }`）。装完之后用户界面上
 * **没有任何填写或修改它的地方** —— 换地址就是发一个新版本的安装包。
 *
 * 这是三个来源里的最后一个（前两个是 `--cloud` 和 `gateway.json`，只给开发用）。
 *
 * `__dirname` 是 `<安装目录>/app/lib/gateway`，所以往上两层就是 `<安装目录>/app/cloud.json`。
 *
 * @returns {string} 归一化后的地址；没有这个文件、内容坏了、或者地址不合法都返回 ''
 */
function readBundledCloudUrl() {
    try {
        var parsed = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'cloud.json'), 'utf8'));
        var url = parsed && typeof parsed.cloudUrl === 'string'
            ? normalizeCloudUrl(parsed.cloudUrl)
            : '';
        // 解析不出来的地址当成没配：宁可什么都不连，也不要让页面卡在一个连不上的地址上
        return parseCloudUrl(url) ? url : '';
    } catch (err) {
        return '';
    }
}

/** 云端地址归一化：补协议、去结尾斜杠。空串原样返回（表示还没配置） */
function normalizeCloudUrl(value) {
    var text = String(value === undefined || value === null ? '' : value).trim();
    if (!text) return '';
    if (!/^https?:\/\//i.test(text)) text = 'http://' + text;
    return text.replace(/\/+$/, '');
}

/** 解析云端地址；不合法时返回 null */
function parseCloudUrl(cloudUrl) {
    try {
        return new URL(cloudUrl);
    } catch (err) {
        return null;
    }
}

/**
 * 把浏览器请求里的头挑一遍，转给云端。
 *
 * `host` 要换成云端的（见调用方），逐跳头一律去掉。其余**原样保留** ——
 * 包括 `Cookie`（云端靠它认人）和 `Content-Type`。
 */
function headersForCloud(headers) {
    var out = {};

    Object.keys(headers || {}).forEach(function (name) {
        var lower = name.toLowerCase();
        if (lower === 'host') return;
        if (HOP_BY_HOP.indexOf(lower) !== -1) return;
        out[lower] = headers[name];
    });

    return out;
}

/**
 * 调一次云端的 JSON 接口。
 *
 * @param {object} options `{ cloudUrl, path, method, headers, body, timeoutMs, onRequest }`
 *   - `path`：`/__admin/api/...` 那种路径（含查询串）；
 *   - `body`：给了就按 JSON 发出去；
 *   - `onRequest`：拿到在途的请求对象，调用方可以拿它做取消。
 * @returns {Promise<{status: number, json: object|null, text: string, setCookie: string[]}>}
 *   云端**回了响应**就 resolve（4xx / 5xx 也算），只有连不上 / 超时才 reject。
 */
function requestJson(options) {
    var opts = options || {};

    return new Promise(function (resolve, reject) {
        var base = parseCloudUrl(opts.cloudUrl);
        if (!base) {
            var bad = new Error('云端地址不合法：' + opts.cloudUrl);
            bad.cloudError = true;
            bad.code = 'CLOUD_URL';
            reject(bad);
            return;
        }

        var secure = base.protocol === 'https:';
        var transport = secure ? https : http;

        var headers = headersForCloud(opts.headers);
        headers.host = base.host;
        headers.accept = 'application/json';

        var payload = null;
        if (opts.body !== undefined && opts.body !== null) {
            payload = Buffer.from(JSON.stringify(opts.body), 'utf8');
            headers['content-type'] = 'application/json';
            headers['content-length'] = String(payload.length);
        }

        var target = new URL(opts.path, base.origin);
        var request = transport.request({
            protocol: base.protocol,
            hostname: target.hostname,
            port: target.port || (secure ? 443 : 80),
            method: opts.method || 'POST',
            path: target.pathname + target.search,
            headers: headers
        }, function (response) {
            var chunks = [];
            response.on('data', function (chunk) { chunks.push(chunk); });
            response.on('end', function () {
                var text = Buffer.concat(chunks).toString('utf8');
                var json = null;
                try {
                    json = JSON.parse(text);
                } catch (err) {
                    // 云端回的也可能不是 JSON（比如被反向代理换成了 HTML 错误页），
                    // 交给调用方按状态码处理
                }
                resolve({
                    status: response.statusCode,
                    json: json,
                    text: text,
                    // 云端发的会话就在这里，调用方（登录、改密码）要拿它写进 session.json。
                    // **它只存在网关和云端之间，永远不交给浏览器**（设计稿第 8 节）。
                    setCookie: response.headers['set-cookie'] || []
                });
            });
        });

        if (typeof opts.onRequest === 'function') opts.onRequest(request);

        if (typeof opts.timeoutMs === 'number') {
            request.setTimeout(opts.timeoutMs, function () {
                request.destroy(new Error('云端响应超时'));
            });
        }

        request.on('error', function (err) {
            if (opts.signal && opts.signal.aborted) {
                var aborted = new Error('已取消');
                aborted.cloudError = true;
                aborted.code = 'ABORTED';
                reject(aborted);
                return;
            }
            err.cloudError = true;
            reject(err);
        });

        if (payload) request.write(payload);
        request.end();
    });
}

/** 「连不上云端（地址）：原因」这句文案只写一次 */
function cloudDownMessage(cloudUrl, err) {
    return '连不上云端（' + cloudUrl + '）：' + ((err && err.message) || '未知错误');
}

/**
 * 从云端的 `Set-Cookie` 里取出会话 Cookie，拼成可以直接塞进请求头的 `apiloop_sid=…`。
 *
 * 网关只在**登录**和**改完密码**这两处需要它：前者写进 `session.json`，后者换掉里面那份。
 * 取不到返回 null —— 调用方要当成「云端没给会话」处理，不能默默当成空串。
 */
function sessionCookieFrom(setCookie) {
    var list = Array.isArray(setCookie) ? setCookie : [];
    var prefix = appInfo.SESSION_COOKIE + '=';

    for (var i = 0; i < list.length; i++) {
        var pair = String(list[i]).split(';')[0].trim();
        if (pair.indexOf(prefix) !== 0) continue;

        var value = pair.slice(prefix.length);
        if (!value) return null;      // 云端在清 Cookie（值为空），当没有
        return prefix + value;
    }
    return null;
}

module.exports = {
    HOP_BY_HOP: HOP_BY_HOP,
    normalizeCloudUrl: normalizeCloudUrl,
    parseCloudUrl: parseCloudUrl,
    readBundledCloudUrl: readBundledCloudUrl,
    headersForCloud: headersForCloud,
    requestJson: requestJson,
    cloudDownMessage: cloudDownMessage,
    sessionCookieFrom: sessionCookieFrom
};
