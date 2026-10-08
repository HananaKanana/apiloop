/**
 * 请求执行器：由本地后端代发任意 HTTP 请求。
 *
 * 为什么不在浏览器里直接发：跨域会被拦，拿不到完整响应头和分阶段耗时，
 * 也没法读本地文件当请求体。所以请求一律经这里转发，前端只负责展示。
 *
 * 三条硬约定：
 * - **永远 resolve，不 reject。** 连不上、超时、被取消都是正常结果，
 *   放在结果的 error 里返回，绝不让调用方去 catch。
 * - **不引入新依赖**，只用 Node 自带的 http / https / tls / zlib。
 * - 结果里的 request 描述的是**用户最初发出的那一跳**，重定向链在 redirects 里；
 *   重定向链每一条的 url 是**跳转的目标地址**（跳转前的地址见前一条，第一条见 request.url），
 *   所以最终地址 = redirects 最后一条的 url，没有重定向时就是 request.url。
 */

var http = require('http');
var https = require('https');
var tls = require('tls');
var net = require('net');
var zlib = require('zlib');
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var appInfo = require('./app-info');
var variables = require('./variables');
var urlUtils = require('./url-utils');
var jsonComments = require('./json-comments');
var responseFiles = require('./response-files');
var pkg = require('../package.json');
var i18n = require('./i18n');

/**
 * 请求头里没写 User-Agent 时用的默认值：按浏览器的格式写，末尾带上 apiloop/<版本>。
 * 不少网站会按 User-Agent 区别对待 —— 只写「apiloop」时百度只回一个 227 字节的
 * 跳转页，用户以为请求没发成功（2026-10-01 用户反馈）。末尾的 apiloop 标识保留，
 * 对方日志里仍然认得出来。请求头里自己写了 User-Agent 就以用户的为准。
 */
var DEFAULT_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 ' + appInfo.APP_NAME + '/' + pkg.version;

/** 会自动跟随的状态码 */
var REDIRECT_CODES = [301, 302, 303, 307, 308];

/**
 * 跨主机跳转时必须摘掉的请求头。
 * 不然 A 主机收下的凭据会被原样转交给 B 主机（curl 和 fetch 都是这么处理的）。
 */
var CREDENTIAL_HEADERS = ['authorization', 'cookie', 'proxy-authorization'];

/** raw 模式下 language 到 Content-Type 的对应 */
var RAW_CONTENT_TYPES = {
    json: 'application/json',
    text: 'text/plain',
    xml: 'application/xml',
    html: 'text/html',
    javascript: 'application/javascript'
};

/** request.bodyPreview 最多留多少个字符 */
var PREVIEW_LIMIT = 2000;

var DEFAULT_TIMEOUT_MS = 30000;
var DEFAULT_MAX_REDIRECTS = 10;
var DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024;

/* ------------------------------------------------------------------ 小工具 */

function now() {
    return process.hrtime.bigint();
}

/** 从某个时间点到现在过了多少毫秒，保留三位小数 */
function msSince(start) {
    return Math.round(Number(process.hrtime.bigint() - start) / 1e3) / 1e3;
}

function numberOr(value, fallback) {
    return typeof value === 'number' && isFinite(value) ? value : fallback;
}

function emptyTimings() {
    return { dns: null, connect: null, tls: null, ttfb: null, download: null, total: null };
}

/** 启用且 key 非空的行 */
function enabledRows(rows) {
    if (!Array.isArray(rows)) return [];

    return rows.filter(function (row) {
        if (!row || row.enabled === false) return false;
        return row.key !== null && row.key !== undefined && String(row.key) !== '';
    });
}

/** 把 Node 的 err.code 归到有限的几类，前端好按类型给提示 */
function mapErrorCode(code) {
    var value = String(code || '');

    if (value === 'ENOTFOUND' || value === 'EAI_AGAIN') return 'DNS';
    if (value === 'ECONNREFUSED' || value === 'ECONNRESET' || value === 'EHOSTUNREACH' ||
        value === 'ECONNABORTED' || value === 'EPIPE' || value === 'ENETUNREACH') return 'CONNECT';
    if (/^(CERT_|ERR_TLS_|UNABLE_TO_|SELF_SIGNED_CERT|DEPTH_ZERO_SELF_SIGNED_CERT|HOSTNAME_MISMATCH)/.test(value)) return 'TLS';

    return 'OTHER';
}

/**
 * 逐条校验请求头。Node 自己的校验器最准，直接拿来用。
 *
 * 不校验的话 `transport.request` 会在 Promise 的执行函数里同步抛错，整个 Promise 变成
 * reject —— 违反「永远 resolve」的约定。国内用户在请求头里写中文值很常见，必须挡住。
 *
 * @returns {{name: string, message: string}|null}
 */
function findInvalidHeader(headers) {
    for (var i = 0; i < headers.length; i++) {
        var name = headers[i][0];
        var value = headers[i][1];

        try {
            http.validateHeaderName(name);
        } catch (err) {
            return { name: String(name), message: i18n.m('请求头名称不合法：{name}', { name: name }) };
        }
        try {
            http.validateHeaderValue(name, value);
        } catch (err) {
            return {
                name: String(name),
                message: i18n.m('请求头 {name} 的值含有 HTTP 不允许的字符（非 ASCII 字符需要先编码）', { name: name })
            };
        }
    }
    return null;
}

/** 协议 + 主机名 + 端口，任一项不同就算跨站（URL 会把默认端口归一成空串，直接比就行） */
function sameOrigin(first, second) {
    var a;
    var b;
    try {
        a = new URL(first);
        b = new URL(second);
    } catch (err) {
        return false;
    }

    return a.protocol === b.protocol && a.hostname === b.hostname && a.port === b.port;
}

function stripCredentialHeaders(headers) {
    return headers.filter(function (pair) {
        return CREDENTIAL_HEADERS.indexOf(String(pair[0]).toLowerCase()) === -1;
    });
}

function withoutContentType(headers) {
    return headers.filter(function (pair) {
        return String(pair[0]).toLowerCase() !== 'content-type';
    });
}

/* ------------------------------------------------------------------ 代理 */

/**
 * 代理地址里的密码不能出现在任何地方 —— 结果、错误信息、历史里都只能看到 `***`。
 * 用户名保留：排查「用的哪个账号」时需要它，而且它本身不是密钥。
 */
function maskProxyAddress(value) {
    var url;
    try {
        url = new URL(String(value));
    } catch (err) {
        // 解析都不出来的地址，宁可不显示也不要原样吐出去
        return '***';
    }

    var auth = url.username ? decodeURIComponent(url.username) + ':***@' : '';
    return url.protocol + '//' + auth + url.host;
}

function safeDecode(value) {
    try {
        return decodeURIComponent(String(value === undefined || value === null ? '' : value));
    } catch (err) {
        return String(value || '');
    }
}

/** 代理需要认证时的 Proxy-Authorization 值；不需要认证返回 null */
function proxyAuthHeader(url) {
    if (!url.username && !url.password) return null;
    var plain = safeDecode(url.username) + ':' + safeDecode(url.password);
    return 'Basic ' + Buffer.from(plain, 'utf8').toString('base64');
}

/** 去掉 IPv6 的方括号，统一小写，方便比较 */
function normalizeHostName(value) {
    var host = String(value || '').toLowerCase();
    if (host.charAt(0) === '[' && host.charAt(host.length - 1) === ']') {
        return host.slice(1, -1);
    }
    return host;
}

/**
 * noProxy 命中判定（契约第 12 节）。
 *
 * 每一项可以是：`*`（全部直连）、精确主机名、以 `.` 开头的后缀、或者 `host:port`。
 * 写成 `host:port` 时只有端口也对得上才命中。
 *
 * @param {string} host
 * @param {number|string} port
 * @param {string} noProxy 逗号分隔
 * @returns {boolean}
 */
function shouldBypassProxy(host, port, noProxy) {
    var target = normalizeHostName(host);
    var targetPort = port === undefined || port === null || port === '' ? '' : String(port);

    var entries = String(noProxy || '').split(',')
        .map(function (item) { return item.trim(); })
        .filter(Boolean);

    for (var i = 0; i < entries.length; i++) {
        var entry = entries[i];
        if (entry === '*') return true;

        var entryHost = entry;
        var entryPort = '';

        // `host:port`：从右边找那个冒号，IPv6 字面量里的冒号不会被误判
        var match = /^(.*):(\d+)$/.exec(entry);
        if (match && match[1].charAt(match[1].length - 1) !== ':') {
            entryHost = match[1];
            entryPort = match[2];
        }

        if (entryPort && entryPort !== targetPort) continue;

        var name = normalizeHostName(entryHost);
        if (!name) continue;

        if (name === target) return true;
        // 以 . 开头的后缀：.internal 命中 api.internal，但不命中 internal 本身
        if (name.charAt(0) === '.' && target.length > name.length &&
            target.slice(-name.length) === name) {
            return true;
        }
    }

    return false;
}

/**
 * 把 auth 翻译成「要加的请求头」和「要拼到 URL 上的 query 参数」。
 *
 * 抽出来是因为 WebSocket 会话（`lib/api/ws.js`）必须用**完全相同**的规则：
 * 两处各写一份，迟早会有一处漏掉「`key` 为空就什么都不加」这类判断。
 *
 * 两个刻意的行为，别顺手改掉：
 * - `key` 为空时什么都不加 —— 空的名字是非法请求头，加了反而让整个请求失败；
 * - 只有 apikey 会进 query，bearer / basic 一律走请求头。
 *
 * @param {object|null} auth
 * @returns {{headers: Array<Array<string>>, query: Array<Array<string>>}}
 */
function buildAuth(auth) {
    var result = { headers: [], query: [] };
    if (!auth || !auth.type) return result;

    if (auth.type === 'bearer') {
        result.headers.push(['Authorization', 'Bearer ' + (auth.token || '')]);
        return result;
    }

    if (auth.type === 'basic') {
        var plain = (auth.username || '') + ':' + (auth.password || '');
        result.headers.push(['Authorization', 'Basic ' + Buffer.from(plain, 'utf8').toString('base64')]);
        return result;
    }

    if (auth.type === 'apikey' && auth.key) {
        var pair = [auth.key, auth.value || ''];
        if (auth.in === 'query') result.query.push(pair);
        else result.headers.push(pair);
    }

    // noauth / inherit / 不支持的鉴权类型：什么也不加
    return result;
}

/**
 * 按 content-type 判断该按文本还是二进制处理。
 *
 * 除了自己用，流式发送也要用它 —— `chunk` 事件按文本还是 base64 发、以及
 * `result.response.bodyEncoding` 是什么，必须是同一个判断。
 */
function isTextContentType(contentType) {
    var value = String(contentType || '').toLowerCase();

    // 服务端没给 content-type 时按文本处理，至少能看见内容
    if (!value) return true;

    return /^text\//.test(value) ||
        value.indexOf('json') !== -1 ||
        value.indexOf('xml') !== -1 ||
        value.indexOf('javascript') !== -1 ||
        value.indexOf('html') !== -1 ||
        value.indexOf('x-www-form-urlencoded') !== -1;
}

/**
 * 这次响应要不要落临时文件（第十七轮 T38）。
 *
 * **非文本**的响应一律要：页面上的预览和保存都得靠完整的那一份（内存里那份是 base64 的，
 * 超过 5 MB 还会被截断）。调用方另外还会把 HEAD / 204 / 304 这种**本来就没有响应体**的
 * 排除掉（见 `readResponse` 里的 `hasNoBody`）—— 空文件既没法预览也没法保存，
 * 白白占一个「每人 20 个」的名额。
 *
 * **文本**的响应只在**被截断**时才要 —— 而截断只可能发生在「解压之后的字节数超过内存上限」
 * 的时候。所以：没压缩、声明了长度、长度又没超上限的文本响应**一定不会被截断**，直接跳过。
 * 少了这一条，每个 JSON 响应都要白写一遍临时文件再删掉（Express 的 `res.json()` 都会带
 * `Content-Length`，省掉的是绝大多数请求）。
 *
 * 长度认不出来（chunked、头缺失）时保守地落 —— 判错的代价是白写一个文件，
 * 比「被截断了却没有文件可下载」小得多。
 */
function needsResponseFile(contentType, headers, encoding, maxBodyBytes) {
    if (!isTextContentType(contentType)) return true;
    if (encoding) return true;

    var declared = Number(headers['content-length']);
    if (!Number.isFinite(declared)) return true;
    return declared > maxBodyBytes;
}

/* ------------------------------------------------------------------ 请求体 */

/**
 * 解析成真实路径，用来做目录范围判断。
 * 文件还不存在时 realpath 会失败，那就退一步解析它所在的目录，再拼回文件名 ——
 * 这样「路径越界」这件事对不存在的文件也能判出来。
 */
function realPathOf(target) {
    try {
        return fs.realpathSync(target);
    } catch (err) {
        // 继续往下退
    }
    try {
        return path.join(fs.realpathSync(path.dirname(target)), path.basename(target));
    } catch (err) {
        return null;
    }
}

/**
 * 限制只能读允许目录里的文件。
 *
 * 导入进来的 Postman 集合里 src 可以是任意本地路径，一份恶意集合就能在用户点「发送」时
 * 把 ~/.ssh/id_rsa 发到攻击者服务器上。所以接入管理台时必须传 fileRoots；
 * 不传就不限制，保持这个模块本身的纯粹。
 */
function assertReadable(filePath, fileRoots) {
    if (!Array.isArray(fileRoots) || !fileRoots.length) return;

    var resolved = realPathOf(filePath);
    if (!resolved) return; // 路径都解析不出来，交给后面 readFileSync 报更具体的错

    var allowed = fileRoots.some(function (root) {
        var rootPath = realPathOf(root) || path.resolve(root);
        if (resolved === rootPath) return true;
        return resolved.indexOf(rootPath + path.sep) === 0;
    });

    if (!allowed) {
        var denied = new Error(i18n.m('文件不在允许读取的目录内：{path}', { path: filePath }));
        denied.code = 'FILE';
        throw denied;
    }
}

/** 读本地文件当请求体；读不到或越界抛 FILE 类错误 */
function readLocalFile(filePath, fileRoots) {
    var target = String(filePath || '');
    if (!target) {
        var empty = new Error(i18n.m('没有指定文件路径'));
        empty.code = 'FILE';
        throw empty;
    }

    assertReadable(target, fileRoots);

    try {
        return fs.readFileSync(target);
    } catch (err) {
        var wrapped = new Error(i18n.m('读取文件失败：{path}（{reason}）', { path: target, reason: err.message }));
        wrapped.code = 'FILE';
        throw wrapped;
    }
}

/** multipart 的字段名/文件名里不能出现裸的引号和换行 */
function escapeMultipartText(text) {
    return String(text).replace(/[\r\n]/g, ' ').replace(/"/g, '%22');
}

function buildMultipart(formRows, fileRoots) {
    var boundary = '----apiloop' + crypto.randomBytes(12).toString('hex');
    var chunks = [];

    formRows.forEach(function (row) {
        var name = escapeMultipartText(row.key);
        chunks.push(Buffer.from('--' + boundary + '\r\n'));

        if (row.kind === 'file') {
            var content = readLocalFile(row.src, fileRoots);
            var filename = escapeMultipartText(path.basename(String(row.src || '')));
            chunks.push(Buffer.from('Content-Disposition: form-data; name="' + name +
                '"; filename="' + filename + '"\r\n'));
            chunks.push(Buffer.from('Content-Type: application/octet-stream\r\n\r\n'));
            chunks.push(content);
            chunks.push(Buffer.from('\r\n'));
        } else {
            chunks.push(Buffer.from('Content-Disposition: form-data; name="' + name + '"\r\n\r\n'));
            chunks.push(Buffer.from(row.value === null || row.value === undefined ? '' : String(row.value), 'utf8'));
            chunks.push(Buffer.from('\r\n'));
        }
    });

    chunks.push(Buffer.from('--' + boundary + '--\r\n'));

    return {
        buffer: Buffer.concat(chunks),
        contentType: 'multipart/form-data; boundary=' + boundary
    };
}

/**
 * 按 body.mode 生成请求体。
 * @param {object} spec
 * @param {string[]} [fileRoots] 允许读取文件的根目录，不传则不限制
 * @returns {{buffer: Buffer|null, contentType: string|null}}
 */
function buildBody(spec, fileRoots) {
    var body = spec.body || {};
    var mode = body.mode || 'none';

    if (mode === 'raw') {
        var raw = typeof body.raw === 'string' ? body.raw : '';
        // JSON 请求体允许写注释（和 Postman 一样），发送前去掉，见 lib/json-comments.js
        if (body.language === 'json') raw = jsonComments.stripJsonComments(raw);
        return {
            buffer: Buffer.from(raw, 'utf8'),
            contentType: RAW_CONTENT_TYPES[body.language] || RAW_CONTENT_TYPES.text
        };
    }

    if (mode === 'urlencoded') {
        var params = new URLSearchParams();
        enabledRows(body.form).forEach(function (row) {
            var value = row.value === null || row.value === undefined ? '' : String(row.value);
            params.append(String(row.key), value);
        });
        return {
            buffer: Buffer.from(params.toString(), 'utf8'),
            contentType: 'application/x-www-form-urlencoded'
        };
    }

    if (mode === 'formdata') {
        var multipart = buildMultipart(enabledRows(body.form), fileRoots);
        return { buffer: multipart.buffer, contentType: multipart.contentType };
    }

    if (mode === 'binary') {
        var file = body.file || {};
        return { buffer: readLocalFile(file.src, fileRoots), contentType: 'application/octet-stream' };
    }

    if (mode === 'graphql') {
        var graphql = body.graphql || {};
        var graphqlVariables = {};
        if (graphql.variables) {
            try {
                graphqlVariables = JSON.parse(graphql.variables);
            } catch (err) {
                // 变量不是合法 JSON 就当成没有变量，别让整个请求发不出去
                graphqlVariables = {};
            }
        }
        return {
            buffer: Buffer.from(JSON.stringify({ query: graphql.query || '', variables: graphqlVariables }), 'utf8'),
            contentType: 'application/json'
        };
    }

    return { buffer: null, contentType: null };
}

/* ------------------------------------------------------------------ 执行 */

/**
 * 代发一个请求。
 *
 * @param {object} spec RequestSpec
 * @param {object} [options] { variables, timeoutMs, followRedirects, maxRedirects, rejectUnauthorized,
 *   maxBodyBytes, signal, fileRoots, cookieJar, proxy, stream, onHead, onChunk, agent, discardBody,
 *   responseFiles }
 *   - `cookieJar`：`{ cookieHeaderFor(url), storeFrom(url, setCookies) }`。传了它，每一跳都会
 *     自动带上匹配的 cookie、并把响应里的 Set-Cookie 收进来（用户手写了 Cookie 头则一次都不补）。
 *   - `proxy`：`{ url, noProxy }`，只支持 `http://` 形式的代理；https 目标走 CONNECT 隧道。
 *   - `agent`：**直连时**用哪个 Agent（压测靠它复用连接，见第八轮第 2 节）。不传时和以前
 *     完全一样（`agent: false`，一个请求一条连接）。走代理时不生效 —— 代理那条路要按跳
 *     改写请求头、https 还要自己打隧道，复用连接的收益和风险都不划算。
 *   - `discardBody`：只要响应大小、**不把响应体攒在内存里**（压测用）。不传时行为不变。
 *   - `responseFiles`：`{ userId }`，把**完整**响应体（解压之后的）落一份临时文件，
 *     结果里给 `response.fileId`（第十七轮 T38，登记 / 下载 / 清理见 `lib/response-files.js`）。
 *     **默认不传 = 不落文件**：只有页面上的 `/send`、`/send/stream` 传它，测试集、批量、
 *     压测、脚本里的 `pm.sendRequest`、前置接口都不传。落文件失败（磁盘满）不影响这次请求。
 *   - `stream` / `onHead` / `onChunk`：流式输出用的钩子。
 *     - `onHead(head, controls)`：**最后一跳**的响应头到达时调用一次，`head` 是
 *       `{ response: { status, statusText, httpVersion, headers }, redirects }`；
 *       `controls` 是 `{ pause(), resume() }`，作用在解压之后的响应流上 —— 调用方
 *       写不动了就拿它把上游按停（背压），详见 `streamControls`；
 *     - `onChunk(buffer)`：**最后一跳**每一段**解压之后**的数据到达时调用一次；
 *     - `stream: true`：`head` 到达之后清掉总超时的计时器 —— 契约第 14 节规定
 *       `timeoutMs` 只管到 `head` 为止，之后 SSE 可以一直连着，由用户主动取消。
 *
 *     重定向的中间几跳**不会**触发这两个回调。回调里抛出的异常一律吞掉：
 *     调用方是外挂进来的，它出错不该影响执行器「永远 resolve」的约定。
 * @returns {Promise<object>} ExecResult，永远 resolve
 */
function execute(spec, options) {
    var opts = options || {};

    var timeoutMs = numberOr(opts.timeoutMs, DEFAULT_TIMEOUT_MS);
    var followRedirects = opts.followRedirects !== false;
    var maxRedirects = numberOr(opts.maxRedirects, DEFAULT_MAX_REDIRECTS);
    var rejectUnauthorized = opts.rejectUnauthorized === true;
    var maxBodyBytes = numberOr(opts.maxBodyBytes, DEFAULT_MAX_BODY_BYTES);
    var signal = opts.signal;
    var fileRoots = opts.fileRoots;
    /** 压测复用连接用的 Agent；不传就是老行为（`agent: false`） */
    var agent = opts.agent || false;

    var overallStart = now();
    var redirects = [];
    var missing = [];
    var requestInfo = { method: '', url: '', headers: [], bodyPreview: '', bodySize: 0 };
    var response = null;
    var timings = emptyTimings();
    var error = null;
    var finished = false;
    var timer = null;
    var currentReq = null;
    var onAbort = null;
    /** CONNECT 隧道建立后拿到的 socket；取消时要一起销毁，否则它会吊着 */
    var tunnelSocket = null;
    /** 这次请求实际用到的代理（第一跳决定的），地址里的密码已打码 */
    var proxyUsed = null;
    /** { host, port, auth, noProxy, display } —— 解析失败或没配就是 null */
    var proxySetting = null;
    /**
     * 这次响应落的临时文件（T38）。取消 / 超时 / 读响应出错时，`settle` 要把还没收尾的
     * 半截文件删掉（`abort`），不能留在磁盘上等人下载到一个坏文件。
     */
    var responseFileSink = null;

    return new Promise(function (resolve) {

        function settle() {
            if (finished) return;
            finished = true;

            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            if (signal && onAbort) signal.removeEventListener('abort', onAbort);

            // 落文件还没收尾（取消、超时、读响应出错）：半截文件删掉、不登记
            if (responseFileSink) responseFileSink.abort();

            timings.total = msSince(overallStart);
            resolve({
                ok: response !== null,
                request: requestInfo,
                response: response,
                redirects: redirects,
                timings: timings,
                missingVariables: missing,
                error: error,
                proxy: proxyUsed
            });
        }

        function fail(code, message) {
            error = { code: code, message: message };
            settle();
        }

        /**
         * 调一次流式钩子。
         *
         * 钩子（`onHead` / `onChunk`）是调用方传进来的，它自己抛错不能连累执行器 ——
         * 「永远 resolve」这条约定对钩子也成立。吞掉而不是打日志：钩子里抛错通常意味着
         * 客户端已经断开，日志会刷屏。
         */
        function callHook(fn, arg, extra) {
            if (typeof fn !== 'function') return;
            try {
                fn(arg, extra);
            } catch (err) {
                // 忽略
            }
        }

        /** 中止在途请求：先定结论再销毁，避免销毁触发的 error 事件覆盖结论 */
        function abortWith(code, message) {
            if (finished) return;
            error = { code: code, message: message };
            settle();
            if (currentReq) currentReq.destroy();
            // 隧道是独立的 socket，destroy 请求本身不会带上它
            if (tunnelSocket) {
                try { tunnelSocket.destroy(); } catch (err) { /* 已经断了 */ }
            }
        }

        /* -------- 请求头：用户设置的优先，auth 与默认值都不覆盖它 -------- */

        var headerList = [];

        function findHeader(name) {
            var lower = String(name).toLowerCase();
            for (var i = 0; i < headerList.length; i++) {
                if (headerList[i][0].toLowerCase() === lower) return headerList[i];
            }
            return null;
        }

        function addHeaderIfAbsent(name, value) {
            if (findHeader(name)) return;
            headerList.push([name, value]);
        }

        /* -------- 代理设置 -------- */

        /**
         * 代理地址在发第一个请求**之前**就校验掉。
         * 地址不合法时直接报 PROXY，而不是悄悄直连 —— 用户配了代理就说明内网出不去，
         * 直连的结果是「怎么都连不上」，比报错更难排查。
         */
        if (opts.proxy && opts.proxy.url) {
            var proxyUrl = null;
            try {
                proxyUrl = new URL(String(opts.proxy.url));
            } catch (err) {
                proxyUrl = null;
            }

            if (!proxyUrl || proxyUrl.protocol !== 'http:') {
                fail('PROXY', i18n.m('代理地址不可用（只支持 http:// 形式的代理）'));
                return;
            }

            proxySetting = {
                host: proxyUrl.hostname,
                port: proxyUrl.port || 80,
                auth: proxyAuthHeader(proxyUrl),
                noProxy: opts.proxy.noProxy || '',
                display: maskProxyAddress(proxyUrl)
            };
        }

        /**
         * 这一跳该不该走代理。没配代理、或者 noProxy 命中，都返回 null（直连）。
         */
        function proxyFor(parsed, isHttps) {
            if (!proxySetting) return null;
            var port = parsed.port || (isHttps ? 443 : 80);
            if (shouldBypassProxy(parsed.hostname, port, proxySetting.noProxy)) return null;
            return proxySetting;
        }

        /* -------- 组装 -------- */

        var resolved = variables.resolveSpec(spec, opts.variables || {});
        missing = resolved.missing;

        var requestSpec = resolved.spec;
        var method = String(requestSpec.method || 'GET').toUpperCase();
        var originalUrl = urlUtils.buildUrl(requestSpec);

        var body;
        try {
            body = buildBody(requestSpec, fileRoots);
        } catch (err) {
            fail('FILE', err.message);
            return;
        }

        enabledRows((requestSpec.params || {}).headers).forEach(function (row) {
            headerList.push([String(row.key), row.value === null || row.value === undefined ? '' : String(row.value)]);
        });

        /**
         * Cookie 钩子（契约第 12 节）。
         *
         * 用户在请求头里手写了 Cookie 就以他为准：**整个请求的所有跳**都不再从 jar 补，
         * 否则「我明明写死了 cookie」和「jar 里还有一份」会打架，排查起来极难。
         *
         * 但**写回是另一回事**：手写 Cookie 不影响把响应里的 Set-Cookie 收进库
         * （契约第 12 节明确要求照做）。所以这里有「读」「写」两个 jar：
         * 读的那个在手写时是空的，写的那个始终有效。
         *
         * 注意判定的时机：必须等用户头都进 headerList 之后再问。jar 的每个调用都包在
         * try/catch 里 —— 它是外挂进来的，出错只能跳过，不能让整次请求失败。
         */
        var userCookieHeader = !!findHeader('Cookie');
        var cookieJar = opts.cookieJar || null;
        var readJar = userCookieHeader ? null : cookieJar;

        /** 取这一跳该带的 cookie；jar 抛错就当没有 */
        function jarCookieFor(urlText) {
            if (!readJar) return '';
            try {
                return readJar.cookieHeaderFor(urlText) || '';
            } catch (err) {
                return '';
            }
        }

        /** 把这一跳响应里的 Set-Cookie 收进 jar；jar 抛错就跳过 */
        function storeJarCookies(urlText, setCookieHeaders) {
            if (!cookieJar || !setCookieHeaders) return;
            try {
                cookieJar.storeFrom(urlText, setCookieHeaders);
            } catch (err) {
                // 忽略
            }
        }

        var authParts = buildAuth(requestSpec.auth);
        authParts.headers.forEach(function (pair) {
            addHeaderIfAbsent(pair[0], pair[1]);
        });

        // apikey 放 query 的情况要拼到 URL 上
        authParts.query.forEach(function (pair) {
            originalUrl += (originalUrl.indexOf('?') === -1 ? '?' : '&') +
                urlUtils.encodeQueryPart(pair[0]) + '=' + urlUtils.encodeQueryPart(pair[1]);
        });

        if (body.contentType) addHeaderIfAbsent('Content-Type', body.contentType);
        addHeaderIfAbsent('User-Agent', DEFAULT_USER_AGENT);
        addHeaderIfAbsent('Accept', '*/*');
        // 和浏览器、Postman 一样声明能收压缩的响应（下面 readResponse 会按 Content-Encoding 解压）。
        // 有的服务只给压缩版本：llama.cpp 的页面不带这个头直接回 415「gzip is not supported by
        // this browser」（2026-10-01 用户遇到）。只写我们解得开的三种
        addHeaderIfAbsent('Accept-Encoding', 'gzip, deflate, br');

        // 请求头不合法就别发出去了，否则 transport.request 会同步抛错把 Promise 变成 reject
        var invalidHeader = findInvalidHeader(headerList);
        if (invalidHeader) {
            fail('INVALID_HEADER', invalidHeader.message);
            return;
        }

        // 请求体预览：文本直接看，二进制只报字节数
        var bodyText = '';
        if (body.buffer) {
            bodyText = isTextContentType(body.contentType)
                ? body.buffer.toString('utf8')
                : i18n.m('（二进制 {n} 字节）', { n: body.buffer.length });
        }
        /**
         * requestInfo 记的是**第一跳实际发出的请求头**，所以 jar 补上的 Cookie 也得算进去
         * —— 否则历史里看不到「这次请求到底带了哪个 cookie」，而排查登录态问题全靠它。
         */
        var firstHopCookie = jarCookieFor(originalUrl);
        var firstHopHeaders = headerList;
        if (firstHopCookie) {
            firstHopHeaders = headerList.filter(function (pair) {
                return String(pair[0]).toLowerCase() !== 'cookie';
            });
            firstHopHeaders.push(['Cookie', firstHopCookie]);
        }

        requestInfo = {
            method: method,
            url: originalUrl,
            headers: firstHopHeaders.slice(),
            bodyPreview: bodyText.length > PREVIEW_LIMIT ? bodyText.slice(0, PREVIEW_LIMIT) + '…' : bodyText,
            bodySize: body.buffer ? body.buffer.length : 0
        };

        /* -------- 计时器与取消 -------- */

        if (signal && signal.aborted) {
            abortWith('ABORTED', i18n.m('请求已被取消'));
            return;
        }

        if (timeoutMs > 0) {
            timer = setTimeout(function () {
                abortWith('TIMEOUT', i18n.m('请求超过 {ms} 毫秒未完成', { ms: timeoutMs }));
            }, timeoutMs);
            if (timer.unref) timer.unref();
        }

        if (signal) {
            onAbort = function () { abortWith('ABORTED', i18n.m('请求已被取消')); };
            signal.addEventListener('abort', onAbort, { once: true });
        }

        /* -------- 逐跳发送 -------- */

        function send(method, urlText, bodyBuffer, hopHeaderList) {
            if (finished) return;

            var parsed;
            try {
                parsed = new URL(urlText);
            } catch (err) {
                fail('INVALID_URL', i18n.m('URL 不合法：{url}', { url: urlText }));
                return;
            }

            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
                fail('INVALID_URL', i18n.m('只支持 http / https，收到 {protocol}', { protocol: parsed.protocol }));
                return;
            }

            var isHttps = parsed.protocol === 'https:';
            var transport = isHttps ? https : http;
            var hopStart = now();
            var hopTimings = emptyTimings();

            // 跳转时这一跳的请求头可能已经被改过（摘掉凭据、丢掉 Content-Type）
            var sourceHeaders = hopHeaderList || headerList;

            // 每一跳都自己算 Content-Length：跳转时可能从带体变成不带体
            var hopHeaders = sourceHeaders.filter(function (pair) {
                return pair[0].toLowerCase() !== 'content-length';
            });
            if (bodyBuffer) hopHeaders.push(['Content-Length', String(bodyBuffer.length)]);

            /**
             * jar 补 cookie 的位置很关键：必须在**跨域摘掉凭据头之后**。
             * 跳到新域名时上一跳的 Cookie 已经被 stripCredentialHeaders 摘了，
             * 这里补上的是新域名自己那份 —— 顺序反了就会把 A 站的 cookie 送给 B 站。
             */
            var jarCookie = jarCookieFor(urlText);
            if (jarCookie) {
                hopHeaders = hopHeaders.filter(function (pair) {
                    return String(pair[0]).toLowerCase() !== 'cookie';
                });
                hopHeaders.push(['Cookie', jarCookie]);
            }

            /** 直连请求的错误：按 err.code 归类 */
            function onError(err) {
                if (finished) return;
                if (err && err.code === 'ERR_INVALID_URL') {
                    fail('INVALID_URL', err.message);
                    return;
                }
                fail(mapErrorCode(err && err.code), (err && err.message) || i18n.m('请求失败'));
            }

            /** 代理本身出的错：不管底层 err.code 是什么，一律是 PROXY */
            function onProxyError(err, proxy) {
                if (finished) return;
                fail('PROXY', i18n.m('连接代理 {proxy} 失败：{reason}', { proxy: proxy.display,
                    reason: (err && err.message) || i18n.m('未知错误') }));
            }

            function onResponse(res) {
                if (finished) {
                    res.resume();
                    return;
                }

                // **在判断是否跟随重定向之前**收下这一跳的 Set-Cookie：
                // 登录接口就是 302 + Set-Cookie，等跳完了再写，下一跳的请求头里没有它。
                storeJarCookies(urlText, res.headers['set-cookie']);

                hopTimings.ttfb = msSince(hopStart);
                timings = hopTimings;

                var status = res.statusCode;
                var location = res.headers.location;

                if (followRedirects && location && REDIRECT_CODES.indexOf(status) !== -1) {
                    // 先把这一跳的响应体排空，socket 才能复用/释放
                    res.resume();

                    if (redirects.length >= maxRedirects) {
                        fail('OTHER', i18n.m('重定向次数超过 {n} 次，已停止跟随', { n: maxRedirects }));
                        if (currentReq) currentReq.destroy();
                        return;
                    }

                    var nextUrl;
                    try {
                        nextUrl = new URL(location, urlText).toString();
                    } catch (err) {
                        fail('OTHER', i18n.m('重定向地址不合法：{url}', { url: location }));
                        return;
                    }
                    redirects.push({ status: status, url: nextUrl });

                    // 303，以及 POST 遇到 301/302：按规范改成 GET 并丢掉请求体
                    var dropBody = status === 303 || ((status === 301 || status === 302) && method === 'POST');

                    var nextHeaders = sourceHeaders;

                    // 跨了协议 / 主机 / 端口就别把凭据带过去，免得转交给第三方
                    if (!sameOrigin(urlText, nextUrl)) {
                        nextHeaders = stripCredentialHeaders(nextHeaders);
                    }
                    // 请求体都丢了，Content-Type 也没意义了
                    if (dropBody) {
                        nextHeaders = withoutContentType(nextHeaders);
                    }

                    send(dropBody ? 'GET' : method, nextUrl, dropBody ? null : bodyBuffer, nextHeaders);
                    return;
                }

                readResponse(res, hopStart, hopTimings);
            }

            /** 连上去这一段的地址解析与建连耗时（tls 由各分支自己补） */
            function attachSocketTimings(req, secure) {
                req.on('socket', function (socket) {
                    if (!socket.connecting) return;
                    socket.once('lookup', function () {
                        if (hopTimings.dns === null) hopTimings.dns = msSince(hopStart);
                    });
                    socket.once('connect', function () {
                        hopTimings.connect = msSince(hopStart);
                    });
                    if (secure) {
                        socket.once('secureConnect', function () {
                            hopTimings.tls = msSince(hopStart);
                        });
                    }
                });
            }

            var proxy = proxyFor(parsed, isHttps);
            // 结果里显示的代理取第一跳的：重定向之后各跳可能因为 noProxy 走不同的路，
            // 而 requestInfo 描述的也是第一跳
            if (proxy && !proxyUsed) proxyUsed = { url: proxy.display };

            /* ---------- 直连 ---------- */

            if (!proxy) {
                var directOptions = {
                    protocol: parsed.protocol,
                    hostname: parsed.hostname,
                    port: parsed.port || (isHttps ? 443 : 80),
                    path: parsed.pathname + parsed.search,
                    method: method,
                    headers: headersToObject(hopHeaders),
                    // 直连才用得上调用方给的 Agent；默认（不传 agent）仍是 false ——
                    // 一个请求一条连接，和这个模块以前的行为一个字都不差
                    agent: agent
                };
                if (isHttps) directOptions.rejectUnauthorized = rejectUnauthorized;

                // 请求头已经在发送前校验过，这里是兜底：构造请求也可能因为别的原因抛错，
                // 抛在 Promise 的执行函数里会把整个 Promise 变成 reject，必须接住。
                var req;
                try {
                    req = transport.request(directOptions);
                } catch (err) {
                    fail(mapErrorCode(err && err.code), (err && err.message) || i18n.m('请求构造失败'));
                    return;
                }
                currentReq = req;

                attachSocketTimings(req, isHttps);
                req.on('error', onError);
                req.on('response', onResponse);
                req.end(bodyBuffer || undefined);
                return;
            }

            /* ---------- 走代理：目标是 http，把绝对地址交给代理 ---------- */

            if (!isHttps) {
                var proxyHeaders = headersToObject(hopHeaders);
                // 代理连的是目标主机，Host 必须是目标，不能是自己的地址
                Object.keys(proxyHeaders).forEach(function (key) {
                    if (key.toLowerCase() === 'host') delete proxyHeaders[key];
                });
                proxyHeaders.Host = parsed.host;
                if (proxy.auth) proxyHeaders['Proxy-Authorization'] = proxy.auth;

                var viaProxy;
                try {
                    viaProxy = http.request({
                        protocol: 'http:',
                        hostname: proxy.host,
                        port: proxy.port,
                        // 代理要的是完整绝对地址，路径部分不能只给 /path
                        path: parsed.toString(),
                        method: method,
                        headers: proxyHeaders,
                        agent: false
                    });
                } catch (err) {
                    onProxyError(err, proxy);
                    return;
                }
                currentReq = viaProxy;

                attachSocketTimings(viaProxy, false);
                viaProxy.on('error', function (err) { onProxyError(err, proxy); });
                viaProxy.on('response', onResponse);
                viaProxy.end(bodyBuffer || undefined);
                return;
            }

            /* ---------- 走代理：目标是 https，先 CONNECT 打隧道 ---------- */

            var connectTarget = parsed.hostname + ':' + (parsed.port || 443);
            var connectHeaders = { Host: connectTarget };
            if (proxy.auth) connectHeaders['Proxy-Authorization'] = proxy.auth;

            var tunnel;
            try {
                tunnel = http.request({
                    hostname: proxy.host,
                    port: proxy.port,
                    method: 'CONNECT',
                    path: connectTarget,
                    headers: connectHeaders,
                    agent: false
                });
            } catch (err) {
                onProxyError(err, proxy);
                return;
            }
            currentReq = tunnel;

            tunnel.on('socket', function (socket) {
                if (!socket.connecting) return;
                socket.once('lookup', function () {
                    if (hopTimings.dns === null) hopTimings.dns = msSince(hopStart);
                });
            });
            tunnel.on('error', function (err) { onProxyError(err, proxy); });

            tunnel.on('connect', function (res, socket) {
                if (finished) {
                    socket.destroy();
                    return;
                }

                if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
                    socket.destroy();
                    fail('PROXY', i18n.m('代理 {proxy} 拒绝了 CONNECT（HTTP {status}）', { proxy: proxy.display, status: res.statusCode }));
                    return;
                }

                // 隧道通了。建隧道这一整段算 connect 阶段
                hopTimings.connect = msSince(hopStart);
                tunnelSocket = socket;
                socket.on('error', function (err) { onProxyError(err, proxy); });

                // 隧道只解决「怎么连过去」，不解决「对面是不是真的它」——
                // 目标服务器的证书照样按 rejectUnauthorized 校验
                var tlsOptions = {
                    socket: socket,
                    rejectUnauthorized: rejectUnauthorized
                };
                // 目标是 IP 时不设 servername：RFC 6066 不允许，Node 会打弃用警告
                if (!net.isIP(parsed.hostname)) tlsOptions.servername = parsed.hostname;

                var secureSocket = tls.connect(tlsOptions);
                secureSocket.once('secureConnect', function () {
                    if (hopTimings.tls === null) hopTimings.tls = msSince(hopStart);
                });
                secureSocket.on('error', onError);

                var tunneled;
                try {
                    tunneled = https.request({
                        hostname: parsed.hostname,
                        port: parsed.port || 443,
                        path: parsed.pathname + parsed.search,
                        method: method,
                        headers: headersToObject(hopHeaders),
                        rejectUnauthorized: rejectUnauthorized,
                        // **故意不传 agent: false**：那样 Node 会另造一个一次性 Agent，
                        // 反而不会用我们给的 socket。不传 agent 时 createConnection 才生效。
                        createConnection: function () { return secureSocket; }
                    });
                } catch (err) {
                    onError(err);
                    return;
                }
                currentReq = tunneled;
                tunneled.on('error', onError);
                tunneled.on('response', onResponse);
                tunneled.end(bodyBuffer || undefined);
            });

            tunnel.end();
        }

        /* -------- 读取响应 -------- */

        function readResponse(res, hopStart, hopTimings) {
            /**
             * 这里是**最后一跳** —— readResponse 只会被最后一跳调到：要跟随的重定向在
             * onResponse 里就已经 res.resume() 走掉了。所以钩子在这里调就不会误报中间跳。
             */
            if (opts.stream && timer) {
                // 契约第 14 节：head 到了之后不再有总超时
                clearTimeout(timer);
                timer = null;
            }

            // 解压流要先建出来：head 钩子的第二个参数就是它的背压开关
            var encoding = String(res.headers['content-encoding'] || '').toLowerCase();
            var source = res;

            // 声明了能收压缩以后，HEAD / 204 / 304 也常带着 Content-Encoding: gzip，但根本没有响应体。
            // 对空内容做 gunzip 会报「unexpected end of file」，一个成功的请求就变成了失败 —— 这几种不解压
            var hasNoBody = method === 'HEAD' || res.statusCode === 204 || res.statusCode === 304 ||
                res.headers['content-length'] === '0';
            if (hasNoBody) encoding = '';

            if (encoding === 'gzip' || encoding === 'x-gzip') {
                source = res.pipe(zlib.createGunzip());
            } else if (encoding === 'deflate') {
                source = res.pipe(zlib.createInflate());
            } else if (encoding === 'br') {
                source = res.pipe(zlib.createBrotliDecompress());
            }

            /**
             * 响应文件名（第十七轮 T38）：从 `Content-Disposition` 里取，没有就是 null。
             * 文本响应也有 —— 页面上那一行「📎 报表.xlsx」不挑类型。
             */
            var fileName = responseFiles.fileNameFrom(res.headers['content-disposition']);

            /**
             * 落文件那一路（T38）。只在**调用方给了选项、而且这份响应确实需要完整内容**时
             * 才开 —— 见 `needsResponseFile`。
             */
            var sink = null;
            var fileWaiting = false;

            if (opts.responseFiles && !hasNoBody &&
                needsResponseFile(res.headers['content-type'], res.headers, encoding, maxBodyBytes)) {
                sink = responseFiles.createSink(opts.responseFiles);
                responseFileSink = sink;
            }

            /**
             * 上游的按停开关。**两条路共用它**：写临时文件写不动了（下面）、以及流式输出
             * 发不出去（`onHead` 的第二个参数）。所以只有真用得着的时候才建。
             */
            var controls = (sink || typeof opts.onHead === 'function') ? streamControls(source) : null;

            /**
             * 写文件这条路：**完整内容，不受 maxBodyBytes 限制**。
             *
             * 写不动了（`write` 返回 false）就把上游按停 —— 磁盘比网络慢的时候，不按停的话
             * 整个响应会先攒在内存里，而这正是这个任务要解决的问题。只在没停过的时候停一次，
             * 重复 pause / resume 会让计数的配对错位。
             */
            function writeToFile(chunk) {
                if (!sink) return;
                if (sink.write(chunk)) return;
                if (fileWaiting) return;

                fileWaiting = true;
                controls.pause();
                sink.onceDrain(function () {
                    fileWaiting = false;
                    if (!finished) controls.resume();
                });
            }

            // 流式输出（契约第 14 节）：head 到达时把响应头和背压开关交给调用方
            if (typeof opts.onHead === 'function') {
                callHook(opts.onHead, {
                    response: {
                        status: res.statusCode,
                        statusText: res.statusMessage || '',
                        httpVersion: res.httpVersion,
                        headers: toHeaderPairs(res.rawHeaders)
                    },
                    redirects: redirects
                }, controls);
            }

            var chunks = [];
            var stored = 0;
            var total = 0;
            var truncated = false;

            source.on('data', function (chunk) {
                /**
                 * 解压之后的每一段都原样交给调用方，**不受 maxBodyBytes 限制** ——
                 * 契约第 14 节：已经发出去的数据要完整，截断只作用于 `result.response.body`。
                 *
                 * 只在还没出结果时转发：取消之后还会有一两段在途数据，这时候再推给调用方，
                 * 前端就会在 `end` 事件之后又收到 `chunk`。
                 */
                if (!finished) callHook(opts.onChunk, chunk);

                total += chunk.length;

                // 落文件那一路：完整内容，和内存里那份截断无关
                writeToFile(chunk);

                /**
                 * 压测（第八轮第 2 节）：只要大小、不要内容。攒着的话每秒几百个响应
                 * 会把内存堆起来 —— 压测本来也不看响应体。
                 */
                if (opts.discardBody) return;

                // 超过上限的部分直接丢弃，但继续读完，这样 total 仍是真实大小
                if (stored >= maxBodyBytes) {
                    truncated = true;
                    return;
                }
                var room = maxBodyBytes - stored;
                if (chunk.length <= room) {
                    chunks.push(chunk);
                    stored += chunk.length;
                } else {
                    chunks.push(chunk.subarray(0, room));
                    stored += room;
                    truncated = true;
                }
            });

            source.on('error', function (err) {
                if (finished) return;
                fail('OTHER', i18n.m('读取响应失败：{reason}', { reason: (err && err.message) || i18n.m('未知错误') }));
            });

            source.on('end', function () {
                if (finished) return;

                hopTimings.download = Math.round((msSince(hopStart) - (hopTimings.ttfb || 0)) * 1000) / 1000;

                var buffer = Buffer.concat(chunks);
                var text = isTextContentType(res.headers['content-type']);

                response = {
                    status: res.statusCode,
                    statusText: res.statusMessage || '',
                    httpVersion: res.httpVersion,
                    headers: toHeaderPairs(res.rawHeaders),
                    body: text ? buffer.toString('utf8') : buffer.toString('base64'),
                    bodyEncoding: text ? 'utf8' : 'base64',
                    size: total,
                    truncated: truncated,
                    // 响应里的文件名（没有就是 null）；`fileId` 见下面
                    fileName: fileName,
                    fileId: null,
                    fileTruncated: false
                };

                if (!sink) return settle();

                /**
                 * 等文件真的落盘再出结果：页面拿到 fileId 之后立刻去下载，文件还没写完
                 * 就会下到一个半截的（下载那条路用的是登记表里的 size）。
                 * 写失败时 `info` 是 null，结果里就没有 fileId —— 这次发送本身照常成功。
                 */
                sink.close({
                    contentType: String(res.headers['content-type'] || ''),
                    fileName: fileName
                }, function (info) {
                    if (info) {
                        response.fileId = info.fileId;
                        response.fileTruncated = info.truncated === true;
                    }
                    settle();
                });
            });
        }

        send(method, originalUrl, body.buffer);
    });
}

/**
 * 流式钩子的背压开关（契约第 14 节的实现细节，供 `onHead` 的第二个参数使用）。
 *
 * 作用在**解压之后**的那条流上。调用方读不动了（浏览器的接收速度跟不上上游）时
 * `pause()`：Transform 不再往下游推，它自己的可写侧很快攒满，`res.pipe(...)` 于是
 * 反过来把 IncomingMessage 也停住 —— 一路压到 TCP。没有压缩时 `source` 就是 `res`，
 * 直接停在 socket 上。
 *
 * **按停是计数的**：同一个上游还有第二条路要按它 —— 往临时文件写那一路（T38，见
 * `readResponse` 的 `writeToFile`）。两边可能同时按停（浏览器慢 + 磁盘慢，正是几百 MB
 * 文件下载的常见情形），谁先放行都不能把另一边还按着的上游放开，否则那一边的缓冲
 * 会一直涨、把内存顶起来。只有计数回到 0 才真的 `resume()`。
 *
 * 只有在**调用方真的设了 `onHead`、或者这次要落文件**时才构造它。
 */
function streamControls(source) {
    var paused = 0;

    return {
        pause: function () {
            paused++;
            source.pause();
        },
        resume: function () {
            // 没有配对 pause 的 resume（调用方自己出 bug）不该把计数弄成负数，
            // 那样下一次 pause 就永远等不到 0 了
            paused = Math.max(0, paused - 1);
            if (paused === 0) source.resume();
        }
    };
}

/** rawHeaders 是 [k, v, k, v, ...] 的扁平数组，转成 [[k, v]] 并保留顺序与重复项 */
function toHeaderPairs(rawHeaders) {
    var pairs = [];
    if (!Array.isArray(rawHeaders)) return pairs;

    for (var i = 0; i + 1 < rawHeaders.length; i += 2) {
        pairs.push([rawHeaders[i], rawHeaders[i + 1]]);
    }
    return pairs;
}

/**
 * http.request 的 headers 选项**只接受普通对象**。
 * 传数组（扁平 [k, v, k, v] 或嵌套 [[k, v]] 都一样）会被当成 header 名拼进去，
 * 服务端解析不了直接回 400 —— 这个坑踩过，别改回去。
 * 代价是同名 header 会被后来的覆盖，请求场景下可以接受。
 */
function headersToObject(pairs) {
    var headers = {};
    pairs.forEach(function (pair) {
        headers[pair[0]] = pair[1];
    });
    return headers;
}

module.exports = {
    execute: execute,
    buildAuth: buildAuth,
    isTextContentType: isTextContentType,
    shouldBypassProxy: shouldBypassProxy,
    maskProxyAddress: maskProxyAddress,
    // 云端 prepare 要给网关挑文件，用的必须是**同一套**「在不在允许目录里」的判断 ——
    // 各写一份的话，迟早有一边放宽了而另一边不知道。
    assertReadable: assertReadable
};
