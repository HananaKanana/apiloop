/**
 * Mock 录制：本机代理 + 记录 + 找对应接口（第十一轮第 2 节）。
 *
 * 用户在客户端里开一个本机代理，把前端 / App 的接口地址改成代理地址，请求原样转发到真实后端，
 * **同时把请求和响应记下来**；之后挑几条一键存成接口的示例（当 Mock 返回）。
 *
 * 三件事分开看：
 *   - **代理**：单独起一个 `http.createServer`，不走网关的安全闸门（前端页面、手机 App 都要能连），
 *     只把请求转发到 target，再把响应原样回给客户端；
 *   - **记录**：请求 / 响应各留最近 500 条，body 各最多 1 MB（超出截断并标记）；只在内存里，
 *     不落库、不同步，网关重启就没了；
 *   - **匹配**：录到的请求按 `lib/mock-runtime.js` 的 `sortBySpecificity` 顺序找项目里对应的接口
 *     （固定路径段优先于 `:参数`），给「存为示例」用。
 *
 * **整个网关同时只有一个录制**（模块级的单例）—— 端口只有一个，两个项目同时录也没法区分。
 * 记录在 stop 之后**保留**，方便停了再挑着保存，直到显式清空。
 */

var http = require('http');
var https = require('https');
var net = require('net');
var os = require('os');
var zlib = require('zlib');
var crypto = require('crypto');

var apisRepo = require('./db/repos/apis');
var runtimeModule = require('./mock-runtime');

/** 记录最多留多少条 */
var MAX_ENTRIES = 500;
/** 请求体 / 响应体各最多记多少字节（超出截断并标记 bodyTruncated） */
var MAX_BODY_BYTES = 1024 * 1024;
/** 为了解压，最多先攒多少原始字节 —— 压缩后的 1 MB 可能解出好几 MB */
var MAX_RAW_BYTES = 8 * 1024 * 1024;
/** port 为 0 时从这个端口开始往上找 */
var PORT_START = 47400;
var PORT_TRIES = 100;

/** hop-by-hop 头：代理不转发（RFC 7230 第 6.1 节） */
var HOP_BY_HOP = [
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer', 'transfer-encoding', 'upgrade'
];

/** 这些扩展名的请求不记（照样转发）—— 静态资源记下来只会淹掉真正有用的请求 */
var STATIC_EXT = [
    '.js', '.css', '.map', '.png', '.jpg', '.jpeg', '.gif', '.svg',
    '.ico', '.woff', '.woff2', '.ttf', '.html'
];

/** 存示例时丢掉这些响应头（都是逐次变化或和传输方式有关的） */
var DROP_RESPONSE_HEADERS = [
    'set-cookie', 'content-length', 'content-encoding',
    'transfer-encoding', 'date', 'connection'
];

/** 这些 content-type 当文本记；其余当二进制（body 留空、binary: true） */
var TEXT_TYPES = [
    'application/json', 'application/javascript', 'application/x-javascript',
    'application/xml', 'application/xhtml+xml', 'application/x-www-form-urlencoded',
    'application/graphql', 'application/ld+json', 'application/x-ndjson',
    'application/sql', 'application/x-sh', 'application/yaml', 'application/x-yaml'
];

/** 不参与匹配的接口方法（都不是 HTTP 请求 / 响应那一套） */
var NON_HTTP_METHODS = ['WS', 'SIO', 'GRPC', 'MQTT', 'TCP', 'UDP'];

/* ------------------------------------------------------------------ 状态 */

/** 正在录的那一份；没在录是 null */
var recording = null;
/** 录到的记录：stop 之后也留着，直到显式清空 */
var entries = [];
/** 序号只增不减（清空也不回退）—— 前端按 after=lastSeq 拉增量，回退会让它漏掉新记录 */
var seq = 0;
/**
 * 最近一次开始录制时用的数据库句柄。
 *
 * 列表返回时要**重新匹配**一遍接口（见 freshMatch），而这件事在 stop 之后还要做
 * （记录是留着的），所以句柄不能挂在 recording 上 —— 它跟着网关进程活着。
 */
var activeHandle = null;

function httpError(status, message) {
    var err = new Error(message);
    err.status = status;
    return err;
}

/** 给客户端看的 recording 形状（内部字段不出去） */
function publicRecording() {
    if (!recording) return null;
    var info = recording.info;
    return {
        projectId: info.projectId,
        target: info.target,
        port: info.port,
        lan: info.lan,
        localUrl: info.localUrl,
        lanUrls: info.lanUrls,
        pathPrefix: info.pathPrefix,
        skipStatic: info.skipStatic,
        startedAt: info.startedAt,
        count: info.count
    };
}

function publicEntry(entry, match) {
    return {
        seq: entry.seq,
        id: entry.id,
        at: entry.at,
        method: entry.method,
        path: entry.path,
        query: entry.query,
        status: entry.status,
        durationMs: entry.durationMs,
        error: entry.error,
        request: entry.request,
        response: entry.response,
        match: match === undefined ? entry.match : match
    };
}

/**
 * `match` 在**返回时**重新算一遍。
 *
 * 记录的 match 是录的那一刻算的：用户先把 /orders/1001 存成新接口之后，列表里 /orders/1002
 * 还写着「新接口」，一保存又建一个重复的接口。返回时重算，保存过之后列表马上就显示接口名。
 * 走的是同一个 matchApi（1 秒路由缓存，开销可接受）；算不出来就退回记录时那一份。
 */
function freshMatch(projectId, entry) {
    if (!activeHandle || !projectId) return undefined;
    var target = entry._target || {};
    return matchApi(activeHandle, projectId, entry.method, entry.path, target.prefix || '');
}

/* ------------------------------------------------------------------ 小工具 */

function newEntryId() {
    return 'e_' + crypto.randomBytes(6).toString('hex');
}

function normalizePrefix(pathname) {
    var text = String(pathname || '');
    if (!text || text === '/') return '';
    while (text.length > 1 && text.charAt(text.length - 1) === '/') text = text.slice(0, -1);
    return text;
}

function contentTypeOf(headers) {
    return String((headers && headers['content-type']) || '').split(';')[0].trim().toLowerCase();
}

function isTextType(contentType) {
    if (!contentType) return true;
    if (contentType.indexOf('text/') === 0) return true;
    if (/(\+json|\+xml)$/.test(contentType)) return true;
    return TEXT_TYPES.indexOf(contentType) > -1;
}

/** 按字节截断文本，末尾切到半个汉字时退一格，别留替换符 */
function capText(text, limit) {
    var buf = Buffer.from(String(text), 'utf8');
    if (buf.length <= limit) return { text: String(text), truncated: false };

    var out = buf.slice(0, limit).toString('utf8');
    if (out.charCodeAt(out.length - 1) === 0xFFFD) out = out.slice(0, -1);
    return { text: out, truncated: true };
}

/** 按 content-encoding 解压；解不了返回 null（记录时当「没录到内容」） */
function decompress(buf, encoding) {
    if (!buf || !buf.length) return '';
    try {
        if (encoding === 'gzip' || encoding === 'x-gzip') return zlib.gunzipSync(buf).toString('utf8');
        if (encoding === 'br') return zlib.brotliDecompressSync(buf).toString('utf8');
        if (encoding === 'deflate') {
            try {
                return zlib.inflateSync(buf).toString('utf8');
            } catch (err) {
                // 有些服务端发的是裸 deflate（没有 zlib 头）
                return zlib.inflateRawSync(buf).toString('utf8');
            }
        }
    } catch (err) {
        return null;
    }
    return buf.toString('utf8');
}

/** Set-Cookie 去掉 Domain=，让 cookie 落在代理地址上（前端登录态才用得上） */
function stripCookieDomain(cookie) {
    return String(cookie).replace(/;\s*Domain=[^;]*/gi, '');
}

function hasStaticExtension(pathname) {
    var lower = String(pathname || '').toLowerCase().split('?')[0];
    return STATIC_EXT.some(function (ext) { return lower.slice(-ext.length) === ext; });
}

/** 响应 content-type 是页面 / 脚本 / 样式 / 图片 / 字体，也算静态资源 */
function isStaticContentType(contentType) {
    var type = String(contentType || '').toLowerCase();
    if (!type) return false;
    if (type.indexOf('text/html') === 0) return true;
    if (type.indexOf('javascript') > -1) return true;
    if (type.indexOf('text/css') === 0) return true;
    if (type.indexOf('image/') === 0) return true;
    if (type.indexOf('font') > -1) return true;
    return false;
}

/* ------------------------------------------------------------------ 匹配接口 */

/** 项目里的接口，只要匹配用得上的几个字段；带 1 秒缓存，密集请求时不必每条都查库 */
var routeCache = { projectId: null, at: 0, list: [] };

function routesFor(handle, projectId) {
    var now = Date.now();
    if (routeCache.projectId === projectId && now - routeCache.at < 1000) return routeCache.list;

    var list;
    try {
        list = apisRepo.list(handle, projectId).map(function (api) {
            return {
                id: api.id,
                name: api.name,
                method: String(api.method || 'GET').toUpperCase(),
                // 和 lib/routes-store.js 的 readRoutes 同一个口径
                path: api.mockPath || api.url || '/'
            };
        }).filter(function (route) {
            return NON_HTTP_METHODS.indexOf(route.method) === -1;
        });
    } catch (err) {
        /*
         * 读库失败**绝不能抛出去**：切换账号 / 退出登录时网关会把 handle.close()，
         * 之后代理还在收请求，这条异常如果冒到 proxyRes 的 end 回调里就是
         * uncaughtException，整个网关进程会退出。读不到就当没有接口可匹配（match: null），
         * 转发和记录都照常。
         */
        return [];
    }

    routeCache = { projectId: projectId, at: now, list: list };
    return list;
}

function invalidateRoutes() {
    routeCache = { projectId: null, at: 0, list: [] };
}

/** 接口路径（`/api/users/:id`）能不能匹配上实际路径（`/api/users/42`） */
function pathMatches(routePath, actualPath) {
    var route = String(routePath || '').split('?')[0].split('/').filter(Boolean);
    var actual = String(actualPath || '').split('?')[0].split('/').filter(Boolean);

    // 路径里带 {{变量}} 的段没法字面比，整段跳过（导入进来的接口偶尔是这种）
    while (route.length && route[0].indexOf('{{') > -1) route.shift();

    for (var i = 0; i < route.length; i++) {
        var segment = route[i];
        if (segment === '*' || segment.charAt(0) === '(' || segment.indexOf('*') > -1) return true;
        if (i >= actual.length) return false;
        if (segment.charAt(0) === ':') continue;
        if (segment !== actual[i]) return false;
    }
    return route.length === actual.length;
}

/**
 * 给一条录到的请求找对应接口。找不到返回 null。
 *
 * 请求路径先按客户端发来的路径比，比不上再试「去掉 / 加上 target 的路径前缀」——
 * 用户可能把前端的基础地址设成代理根，也可能直接把 target 的前缀一起写在前面。
 */
function matchApi(handle, projectId, method, clientPath, targetPrefix) {
    // 这里整段兜底：调用方在代理的响应回调里，抛出去就是 uncaughtException
    try {
        var candidates = [clientPath];

        try {
            var decoded = decodeURIComponent(clientPath);
            if (decoded !== clientPath) candidates.push(decoded);
        } catch (err) {
            // 路径不是合法编码，忽略
        }

        if (targetPrefix) {
            var inside = clientPath === targetPrefix || clientPath.indexOf(targetPrefix + '/') === 0;
            if (inside) {
                candidates.push(clientPath.slice(targetPrefix.length) || '/');
            } else {
                candidates.push(targetPrefix + clientPath);
            }
        }

        var sorted = runtimeModule.sortBySpecificity(routesFor(handle, projectId));

        for (var i = 0; i < sorted.length; i++) {
            var route = sorted[i];
            if (route.method !== method && route.method !== 'ALL') continue;
            for (var j = 0; j < candidates.length; j++) {
                if (pathMatches(route.path, candidates[j])) {
                    return { apiId: route.id, apiName: route.name, method: route.method, path: route.path };
                }
            }
        }
    } catch (err) {
        return null;
    }

    return null;
}

/* ------------------------------------------------------------------ 记录 */

/**
 * 记一条。**每个项目各留最近 500 条** —— 记录是按项目看的，一个项目录得多
 * 不该把另一个项目的记录挤掉。
 */
function pushEntry(entry) {
    entries.push(entry);

    var mine = 0;
    for (var i = entries.length - 1; i >= 0; i -= 1) {
        if (entries[i].projectId === entry.projectId) mine += 1;
    }

    var excess = mine - MAX_ENTRIES;
    for (var j = 0; j < entries.length && excess > 0; j += 1) {
        if (entries[j].projectId !== entry.projectId) continue;
        entries.splice(j, 1);
        j -= 1;
        excess -= 1;
    }

    if (recording && recording.info.projectId === entry.projectId) recording.info.count += 1;
}

/* ------------------------------------------------------------------ 代理 */

function lanUrls(port) {
    var out = [];
    var interfaces = os.networkInterfaces();

    Object.keys(interfaces).forEach(function (name) {
        (interfaces[name] || []).forEach(function (item) {
            if (item && item.family === 'IPv4' && !item.internal) {
                out.push('http://' + item.address + ':' + port);
            }
        });
    });

    return out;
}

function listenOn(server, host, port) {
    return new Promise(function (resolve, reject) {
        function onError(err) {
            server.removeListener('listening', onListening);
            reject(err);
        }
        function onListening() {
            server.removeListener('error', onError);
            resolve();
        }

        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
    });
}

/** 指定端口就用指定的（被占用报 400）；为 0 从 PORT_START 往上找第一个空闲的 */
async function bindPort(server, host, preferred) {
    if (preferred > 0) {
        try {
            await listenOn(server, host, preferred);
            return preferred;
        } catch (err) {
            if (err && err.code === 'EADDRINUSE') throw httpError(400, '端口 ' + preferred + ' 被占用');
            throw err;
        }
    }

    for (var port = PORT_START; port < PORT_START + PORT_TRIES; port += 1) {
        try {
            await listenOn(server, host, port);
            return port;
        } catch (err) {
            if (!err || err.code !== 'EADDRINUSE') throw err;
        }
    }

    throw httpError(400, '从 ' + PORT_START + ' 起连着 ' + PORT_TRIES + ' 个端口都被占用了，请手动指定一个');
}

/**
 * 开始录制。
 *
 * @param {object} handle 数据库句柄
 * @param {object} project 项目（guard 已经查过）
 * @param {object} options `{ target, port, lan, pathPrefix, skipStatic }`（target 已替换过变量）
 * @returns {Promise<object>} recording 的公开形状
 */
async function start(handle, project, options) {
    if (recording) {
        throw httpError(409, '正在录制项目「' + recording.info.projectName + '」，先停掉再开始');
    }

    var opts = options || {};
    var targetText = String(opts.target || '').trim();
    var target = null;
    try {
        target = new URL(targetText);
    } catch (err) {
        target = null;
    }
    if (!target || (target.protocol !== 'http:' && target.protocol !== 'https:')) {
        throw httpError(400, '目标地址要以 http:// 或 https:// 开头');
    }

    var lan = opts.lan === true;
    var preferred = Number(opts.port);
    if (!Number.isFinite(preferred) || preferred < 0 || preferred > 65535) {
        throw httpError(400, '端口要填 0~65535 的整数（0 表示自动）');
    }

    var host = lan ? '0.0.0.0' : '127.0.0.1';
    var sockets = new Set();
    var server = http.createServer(function (req, res) {
        handleRequest(req, res);
    });

    server.on('connection', function (socket) {
        sockets.add(socket);
        socket.on('close', function () { sockets.delete(socket); });
    });

    // WebSocket 升级：用 net 管道原样转发，不记录（协议不是一问一答，记下来也没法当示例）
    server.on('upgrade', function (req, socket, head) {
        handleUpgrade(req, socket, head);
    });

    // HTTPS 中间人不做：客户端发 CONNECT 就直接断掉
    server.on('connect', function (req, socket) {
        socket.destroy();
    });

    var port = await bindPort(server, host, preferred);

    var localUrl = 'http://127.0.0.1:' + port;

    activeHandle = handle;

    recording = {
        server: server,
        sockets: sockets,
        handle: handle,
        target: target,
        targetPrefix: normalizePrefix(target.pathname),
        info: {
            projectId: project.id,
            projectName: project.name,
            target: target.origin + normalizePrefix(target.pathname),
            port: port,
            lan: lan,
            localUrl: localUrl,
            lanUrls: lan ? lanUrls(port) : [],
            pathPrefix: String(opts.pathPrefix || '').trim(),
            skipStatic: opts.skipStatic !== false,
            startedAt: Date.now(),
            count: 0
        }
    };

    invalidateRoutes();
    return publicRecording();
}

/**
 * 停止录制。**记录保留**，方便停了再挑着保存。
 *
 * 只有正在录的那个项目能停它：别的项目来停会拿到 409（不然 A 的录制会被 B 顺手停掉）。
 */
function stop(projectId) {
    if (!recording) return null;

    var pid = String(projectId || '');
    if (recording.info.projectId !== pid) {
        throw httpError(409, '正在录制的是项目「' + recording.info.projectName + '」，请到那个项目里停止');
    }

    var current = recording;
    recording = null;

    try {
        current.server.close();
    } catch (err) {
        // 已经关了
    }
    current.sockets.forEach(function (socket) {
        try { socket.destroy(); } catch (err) { /* 已经断了 */ }
    });
    current.sockets.clear();

    return null;
}

/**
 * 某个项目的记录。
 *
 * `recording` 只在这个项目正录着时才有值；别的项目在录时给 `busy`，
 * 前端拿它提示「正在录制项目 X」（不然只看到 recording: null 会以为没人在录）。
 *
 * 每条记录的 `match` **在这里重新算**（见 freshMatch）：用户存过一条之后，
 * 列表里同类请求要立刻显示对应接口名。
 */
function list(projectId, after) {
    var pid = String(projectId || '');
    var from = Number(after);
    if (!Number.isFinite(from)) from = 0;

    var mine = recording && recording.info.projectId === pid;

    return {
        recording: mine ? publicRecording() : null,
        busy: (!mine && recording)
            ? { projectId: recording.info.projectId, projectName: recording.info.projectName }
            : null,
        lastSeq: seq,
        entries: entries.filter(function (entry) {
            return entry.projectId === pid && entry.seq > from;
        }).map(function (entry) {
            return publicEntry(entry, freshMatch(pid, entry));
        })
    };
}

/** 只清这个项目的记录 */
function clear(projectId) {
    var pid = String(projectId || '');
    entries = entries.filter(function (entry) { return entry.projectId !== pid; });
    if (recording && recording.info.projectId === pid) recording.info.count = 0;
}

/** 取一条记录；**项目对不上就当没有**（不能拿别的项目的 entryId 存到自己的项目里） */
function getEntry(id, projectId) {
    var want = String(id || '');
    var pid = String(projectId || '');
    return entries.filter(function (entry) {
        return entry.id === want && entry.projectId === pid;
    })[0] || null;
}

/** 保存时要用的 target 信息（录完停了也要能算地址） */
function targetOf(entry) {
    return entry._target || null;
}

/* ------------------------------------------------------------------ 请求处理 */

function handleRequest(req, res) {
    var current = recording;
    if (!current) {
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('录制已经停止');
        return;
    }

    var origin = String(req.headers.origin || '');
    var rawUrl = String(req.url || '/');
    var mark = rawUrl.indexOf('?');
    var clientPath = mark === -1 ? rawUrl : rawUrl.slice(0, mark);
    var query = mark === -1 ? '' : rawUrl.slice(mark + 1);

    // 跨域预检：代理直接回，不转发、不记录
    if (req.method === 'OPTIONS' && req.headers['access-control-request-method']) {
        var preflight = {
            'Access-Control-Allow-Origin': origin || '*',
            'Access-Control-Allow-Credentials': 'true',
            'Access-Control-Allow-Methods': String(req.headers['access-control-request-method']),
            'Access-Control-Allow-Headers': String(req.headers['access-control-request-headers'] || '*'),
            'Access-Control-Max-Age': '600'
        };
        res.writeHead(204, preflight);
        res.end();
        return;
    }

    var target = current.target;
    var forwardPath = current.targetPrefix + rawUrl;
    var startedAt = Date.now();

    var outHeaders = {};
    Object.keys(req.headers).forEach(function (name) {
        if (HOP_BY_HOP.indexOf(name) > -1) return;
        outHeaders[name] = req.headers[name];
    });
    outHeaders.host = target.host;

    var transport = target.protocol === 'https:' ? https : http;
    var proxyReq = transport.request({
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        method: req.method,
        path: forwardPath,
        headers: outHeaders
    });

    /* -------- 请求体：一边转发一边记（最多 1 MB） -------- */

    var reqChunks = [];
    var reqBytes = 0;
    var reqTruncated = false;

    function captureRequest(chunk) {
        if (reqBytes >= MAX_BODY_BYTES) { reqTruncated = true; return; }
        var room = MAX_BODY_BYTES - reqBytes;
        if (chunk.length <= room) {
            reqChunks.push(chunk);
            reqBytes += chunk.length;
        } else {
            reqChunks.push(chunk.slice(0, room));
            reqBytes = MAX_BODY_BYTES;
            reqTruncated = true;
        }
    }

    req.on('data', function (chunk) {
        captureRequest(chunk);
        proxyReq.write(chunk);
    });
    req.on('end', function () { proxyReq.end(); });
    req.on('error', function () { proxyReq.destroy(); });

    var finished = false;

    function finish(fields) {
        if (finished) return;
        finished = true;

        var shouldRecord = current.info.pathPrefix
            ? clientPath.indexOf(current.info.pathPrefix) === 0
            : true;

        if (current.info.skipStatic) {
            // 路径扩展名看着是静态资源，或者响应本身是页面 / 脚本 / 样式 / 图片 / 字体
            if (hasStaticExtension(clientPath)) shouldRecord = false;
            if (isStaticContentType((fields.response || {}).contentType)) shouldRecord = false;
        }

        if (!shouldRecord) return;

        seq += 1;
        pushEntry(Object.assign({
            seq: seq,
            id: newEntryId(),
            at: startedAt,
            // 录制开始时的项目：list / clear / stop / save 都按它分（网关同时只录一个项目）
            projectId: current.info.projectId,
            method: String(req.method || 'GET').toUpperCase(),
            path: clientPath,
            query: query,
            durationMs: Date.now() - startedAt,
            match: matchApi(current.handle, current.info.projectId,
                String(req.method || 'GET').toUpperCase(), clientPath, current.targetPrefix),
            _target: {
                origin: target.origin,
                prefix: current.targetPrefix,
                text: current.info.target
            }
        }, fields));
    }

    /* -------- 目标连不上 -------- */

    proxyReq.on('error', function (err) {
        var reason = (err && (err.code || err.message)) || '未知错误';
        var message = '连不上 ' + target.origin + '：' + reason;

        finish({
            status: 0,
            error: message,
            request: {
                headers: req.headers,
                body: capText(Buffer.concat(reqChunks).toString('utf8'), MAX_BODY_BYTES).text,
                bodyTruncated: reqTruncated,
                contentType: contentTypeOf(req.headers)
            },
            response: { headers: {}, body: '', bodyTruncated: false, contentType: '', binary: false }
        });

        if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        }
        res.end(message);
    });

    /* -------- 目标响应 -------- */

    proxyReq.on('response', function (proxyRes) {
        var resHeaders = {};
        Object.keys(proxyRes.headers).forEach(function (name) {
            if (HOP_BY_HOP.indexOf(name) > -1) return;
            resHeaders[name] = proxyRes.headers[name];
        });

        if (resHeaders['set-cookie']) {
            resHeaders['set-cookie'] = [].concat(resHeaders['set-cookie']).map(stripCookieDomain);
        }

        // 请求带了 Origin 就由代理回 CORS，覆盖目标自己的那份
        if (origin) {
            resHeaders['access-control-allow-origin'] = origin;
            resHeaders['access-control-allow-credentials'] = 'true';
            resHeaders['access-control-expose-headers'] = '*';
        }

        res.writeHead(proxyRes.statusCode || 502, resHeaders);

        var contentType = contentTypeOf(proxyRes.headers);
        var streaming = contentType === 'text/event-stream';
        var binary = !streaming && !isTextType(contentType);
        var encoding = String(proxyRes.headers['content-encoding'] || '').toLowerCase();

        var resChunks = [];
        var resBytes = 0;
        var resTruncated = false;

        proxyRes.on('data', function (chunk) {
            // 客户端拿到的永远是原始字节（压缩的就照原样透传）
            var drained = res.write(chunk);

            // 客户端读得慢就先把上游按停，否则整份响应会堆在内存里
            // （这个代理会把响应体在内存里留一份用于记录，不能再叠加一份发送缓冲）
            if (!drained) {
                proxyRes.pause();
                res.once('drain', function () { proxyRes.resume(); });
            }

            if (streaming || binary) return;
            if (resBytes >= MAX_RAW_BYTES) { resTruncated = true; return; }

            var room = MAX_RAW_BYTES - resBytes;
            if (chunk.length <= room) {
                resChunks.push(chunk);
                resBytes += chunk.length;
            } else {
                resChunks.push(chunk.slice(0, room));
                resBytes = MAX_RAW_BYTES;
                resTruncated = true;
            }
        });

        proxyRes.on('end', function () {
            res.end();

            var body = '';
            var bodyTruncated = false;

            if (streaming) {
                body = '流式响应，未录制内容';
            } else if (!binary) {
                var text = decompress(Buffer.concat(resChunks), encoding);
                if (text === null) {
                    bodyTruncated = true;
                } else {
                    var capped = capText(text, MAX_BODY_BYTES);
                    body = capped.text;
                    bodyTruncated = capped.truncated || resTruncated;
                }
            }

            finish({
                status: proxyRes.statusCode || 0,
                error: null,
                request: {
                    headers: req.headers,
                    body: capText(Buffer.concat(reqChunks).toString('utf8'), MAX_BODY_BYTES).text,
                    bodyTruncated: reqTruncated,
                    contentType: contentTypeOf(req.headers)
                },
                response: {
                    headers: proxyRes.headers,
                    body: body,
                    bodyTruncated: bodyTruncated,
                    contentType: contentType,
                    binary: binary
                }
            });
        });

        proxyRes.on('error', function () {
            res.destroy();
            finish({
                status: proxyRes.statusCode || 0,
                error: '读取目标响应时出错',
                request: {
                    headers: req.headers,
                    body: capText(Buffer.concat(reqChunks).toString('utf8'), MAX_BODY_BYTES).text,
                    bodyTruncated: reqTruncated,
                    contentType: contentTypeOf(req.headers)
                },
                response: { headers: proxyRes.headers, body: '', bodyTruncated: false, contentType: contentType, binary: false }
            });
        });
    });
}

/** WebSocket 升级：net 管道原样转发，不记录 */
function handleUpgrade(req, socket, head) {
    var current = recording;
    if (!current) {
        socket.destroy();
        return;
    }

    var target = current.target;
    var port = target.port || (target.protocol === 'https:' ? 443 : 80);
    var upstream = net.connect(port, target.hostname, function () {
        var lines = [req.method + ' ' + current.targetPrefix + req.url + ' HTTP/1.1'];
        Object.keys(req.headers).forEach(function (name) {
            lines.push(name + ': ' + (name === 'host' ? target.host : req.headers[name]));
        });

        upstream.write(lines.join('\r\n') + '\r\n\r\n');
        if (head && head.length) upstream.write(head);

        socket.pipe(upstream);
        upstream.pipe(socket);
    });

    upstream.on('error', function () { socket.destroy(); });
    socket.on('error', function () { upstream.destroy(); });
    socket.on('close', function () { upstream.destroy(); });
}

module.exports = {
    start: start,
    stop: stop,
    list: list,
    clear: clear,
    getEntry: getEntry,
    targetOf: targetOf,
    invalidateRoutes: invalidateRoutes,
    matchApi: matchApi,
    DROP_RESPONSE_HEADERS: DROP_RESPONSE_HEADERS
};
