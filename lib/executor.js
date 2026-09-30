/**
 * 请求执行器：由本地后端代发任意 HTTP 请求。
 *
 * 为什么不在浏览器里直接发：跨域会被拦，拿不到完整响应头和分阶段耗时，
 * 也没法读本地文件当请求体。所以请求一律经这里转发，前端只负责展示。
 *
 * 三条硬约定：
 * - **永远 resolve，不 reject。** 连不上、超时、被取消都是正常结果，
 *   放在结果的 error 里返回，绝不让调用方去 catch。
 * - **不引入新依赖**，只用 Node 自带的 http / https / zlib。
 * - 结果里的 request 描述的是**用户最初发出的那一跳**，重定向链在 redirects 里；
 *   重定向链每一条的 url 是**跳转的目标地址**（跳转前的地址见前一条，第一条见 request.url），
 *   所以最终地址 = redirects 最后一条的 url，没有重定向时就是 request.url。
 */

var http = require('http');
var https = require('https');
var zlib = require('zlib');
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var appInfo = require('./app-info');
var variables = require('./variables');
var urlUtils = require('./url-utils');

/** 会自动跟随的状态码 */
var REDIRECT_CODES = [301, 302, 303, 307, 308];

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

/** 按 content-type 判断该按文本还是二进制处理 */
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

/* ------------------------------------------------------------------ 请求体 */

/** 读本地文件当请求体；读不到抛 FILE 类错误 */
function readLocalFile(filePath) {
    var target = String(filePath || '');
    if (!target) {
        var empty = new Error('没有指定文件路径');
        empty.code = 'FILE';
        throw empty;
    }

    try {
        return fs.readFileSync(target);
    } catch (err) {
        var wrapped = new Error('读取文件失败：' + target + '（' + err.message + '）');
        wrapped.code = 'FILE';
        throw wrapped;
    }
}

/** multipart 的字段名/文件名里不能出现裸的引号和换行 */
function escapeMultipartText(text) {
    return String(text).replace(/[\r\n]/g, ' ').replace(/"/g, '%22');
}

function buildMultipart(formRows) {
    var boundary = '----apiloop' + crypto.randomBytes(12).toString('hex');
    var chunks = [];

    formRows.forEach(function (row) {
        var name = escapeMultipartText(row.key);
        chunks.push(Buffer.from('--' + boundary + '\r\n'));

        if (row.kind === 'file') {
            var content = readLocalFile(row.src);
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
 * @returns {{buffer: Buffer|null, contentType: string|null}}
 */
function buildBody(spec) {
    var body = spec.body || {};
    var mode = body.mode || 'none';

    if (mode === 'raw') {
        var raw = typeof body.raw === 'string' ? body.raw : '';
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
        var multipart = buildMultipart(enabledRows(body.form));
        return { buffer: multipart.buffer, contentType: multipart.contentType };
    }

    if (mode === 'binary') {
        var file = body.file || {};
        return { buffer: readLocalFile(file.src), contentType: 'application/octet-stream' };
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
 * @param {object} [options] { variables, timeoutMs, followRedirects, maxRedirects, rejectUnauthorized, maxBodyBytes, signal }
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

    return new Promise(function (resolve) {

        function settle() {
            if (finished) return;
            finished = true;

            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            if (signal && onAbort) signal.removeEventListener('abort', onAbort);

            timings.total = msSince(overallStart);
            resolve({
                ok: response !== null,
                request: requestInfo,
                response: response,
                redirects: redirects,
                timings: timings,
                missingVariables: missing,
                error: error
            });
        }

        function fail(code, message) {
            error = { code: code, message: message };
            settle();
        }

        /** 中止在途请求：先定结论再销毁，避免销毁触发的 error 事件覆盖结论 */
        function abortWith(code, message) {
            if (finished) return;
            error = { code: code, message: message };
            settle();
            if (currentReq) currentReq.destroy();
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

        /* -------- 组装 -------- */

        var resolved = variables.resolveSpec(spec, opts.variables || {});
        missing = resolved.missing;

        var requestSpec = resolved.spec;
        var method = String(requestSpec.method || 'GET').toUpperCase();
        var originalUrl = urlUtils.buildUrl(requestSpec);

        var body;
        try {
            body = buildBody(requestSpec);
        } catch (err) {
            fail('FILE', err.message);
            return;
        }

        enabledRows((requestSpec.params || {}).headers).forEach(function (row) {
            headerList.push([String(row.key), row.value === null || row.value === undefined ? '' : String(row.value)]);
        });

        var auth = requestSpec.auth;
        if (auth && auth.type === 'bearer') {
            addHeaderIfAbsent('Authorization', 'Bearer ' + (auth.token || ''));
        } else if (auth && auth.type === 'basic') {
            var plain = (auth.username || '') + ':' + (auth.password || '');
            addHeaderIfAbsent('Authorization', 'Basic ' + Buffer.from(plain, 'utf8').toString('base64'));
        } else if (auth && auth.type === 'apikey' && auth.in !== 'query') {
            addHeaderIfAbsent(auth.key || '', auth.value || '');
        }
        // noauth / inherit / unsupported / null：什么也不加

        // apikey 放 query 的情况要拼到 URL 上
        if (auth && auth.type === 'apikey' && auth.in === 'query' && auth.key) {
            originalUrl += (originalUrl.indexOf('?') === -1 ? '?' : '&') +
                urlUtils.encodeQueryPart(auth.key) + '=' + urlUtils.encodeQueryPart(auth.value || '');
        }

        if (body.contentType) addHeaderIfAbsent('Content-Type', body.contentType);
        addHeaderIfAbsent('User-Agent', appInfo.APP_NAME);
        addHeaderIfAbsent('Accept', '*/*');

        // 请求体预览：文本直接看，二进制只报字节数
        var bodyText = '';
        if (body.buffer) {
            bodyText = isTextContentType(body.contentType)
                ? body.buffer.toString('utf8')
                : '（二进制 ' + body.buffer.length + ' 字节）';
        }
        requestInfo = {
            method: method,
            url: originalUrl,
            headers: headerList.slice(),
            bodyPreview: bodyText.length > PREVIEW_LIMIT ? bodyText.slice(0, PREVIEW_LIMIT) + '…' : bodyText,
            bodySize: body.buffer ? body.buffer.length : 0
        };

        /* -------- 计时器与取消 -------- */

        if (signal && signal.aborted) {
            abortWith('ABORTED', '请求已被取消');
            return;
        }

        if (timeoutMs > 0) {
            timer = setTimeout(function () {
                abortWith('TIMEOUT', '请求超过 ' + timeoutMs + ' 毫秒未完成');
            }, timeoutMs);
            if (timer.unref) timer.unref();
        }

        if (signal) {
            onAbort = function () { abortWith('ABORTED', '请求已被取消'); };
            signal.addEventListener('abort', onAbort, { once: true });
        }

        /* -------- 逐跳发送 -------- */

        function send(method, urlText, bodyBuffer) {
            if (finished) return;

            var parsed;
            try {
                parsed = new URL(urlText);
            } catch (err) {
                fail('INVALID_URL', 'URL 不合法：' + urlText);
                return;
            }

            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
                fail('INVALID_URL', '只支持 http / https，收到 ' + parsed.protocol);
                return;
            }

            var isHttps = parsed.protocol === 'https:';
            var transport = isHttps ? https : http;
            var hopStart = now();
            var hopTimings = emptyTimings();

            // 每一跳都自己算 Content-Length：跳转时可能从带体变成不带体
            var hopHeaders = headerList.filter(function (pair) {
                return pair[0].toLowerCase() !== 'content-length';
            });
            if (bodyBuffer) hopHeaders.push(['Content-Length', String(bodyBuffer.length)]);

            var requestOptions = {
                protocol: parsed.protocol,
                hostname: parsed.hostname,
                port: parsed.port || (isHttps ? 443 : 80),
                path: parsed.pathname + parsed.search,
                method: method,
                headers: headersToObject(hopHeaders),
                agent: false
            };
            if (isHttps) requestOptions.rejectUnauthorized = rejectUnauthorized;

            var req = transport.request(requestOptions);
            currentReq = req;

            req.on('socket', function (socket) {
                if (!socket.connecting) return;
                socket.once('lookup', function () {
                    if (hopTimings.dns === null) hopTimings.dns = msSince(hopStart);
                });
                socket.once('connect', function () {
                    hopTimings.connect = msSince(hopStart);
                });
                if (isHttps) {
                    socket.once('secureConnect', function () {
                        hopTimings.tls = msSince(hopStart);
                    });
                }
            });

            req.on('error', function (err) {
                if (finished) return;
                if (err && err.code === 'ERR_INVALID_URL') {
                    fail('INVALID_URL', err.message);
                    return;
                }
                fail(mapErrorCode(err && err.code), (err && err.message) || '请求失败');
            });

            req.on('response', function (res) {
                if (finished) {
                    res.resume();
                    return;
                }

                hopTimings.ttfb = msSince(hopStart);
                timings = hopTimings;

                var status = res.statusCode;
                var location = res.headers.location;

                if (followRedirects && location && REDIRECT_CODES.indexOf(status) !== -1) {
                    // 先把这一跳的响应体排空，socket 才能复用/释放
                    res.resume();

                    if (redirects.length >= maxRedirects) {
                        fail('OTHER', '重定向次数超过 ' + maxRedirects + ' 次，已停止跟随');
                        req.destroy();
                        return;
                    }

                    var nextUrl;
                    try {
                        nextUrl = new URL(location, urlText).toString();
                    } catch (err) {
                        fail('OTHER', '重定向地址不合法：' + location);
                        return;
                    }
                    redirects.push({ status: status, url: nextUrl });

                    // 303，以及 POST 遇到 301/302：按规范改成 GET 并丢掉请求体
                    var dropBody = status === 303 || ((status === 301 || status === 302) && method === 'POST');
                    send(dropBody ? 'GET' : method, nextUrl, dropBody ? null : bodyBuffer);
                    return;
                }

                readResponse(res, hopStart, hopTimings);
            });

            req.end(bodyBuffer || undefined);
        }

        /* -------- 读取响应 -------- */

        function readResponse(res, hopStart, hopTimings) {
            var encoding = String(res.headers['content-encoding'] || '').toLowerCase();
            var source = res;

            if (encoding === 'gzip' || encoding === 'x-gzip') {
                source = res.pipe(zlib.createGunzip());
            } else if (encoding === 'deflate') {
                source = res.pipe(zlib.createInflate());
            } else if (encoding === 'br') {
                source = res.pipe(zlib.createBrotliDecompress());
            }

            var chunks = [];
            var stored = 0;
            var total = 0;
            var truncated = false;

            source.on('data', function (chunk) {
                total += chunk.length;

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
                fail('OTHER', '读取响应失败：' + ((err && err.message) || '未知错误'));
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
                    truncated: truncated
                };
                settle();
            });
        }

        send(method, originalUrl, body.buffer);
    });
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
    execute: execute
};
