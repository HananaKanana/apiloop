/**
 * Socket.IO 调试会话的注册表（第九轮第 4 节）。
 *
 * 和 `lib/ws-sessions.js` 是**同一套会话模型**（缓冲、seq、subscribe、两个 60 秒倒计时），
 * 差别只在「用什么连上去」：那边是 Node 自带的 WebSocket，这里是 `socket.io-client`。
 *
 * 为什么不直接复用 ws-sessions：Socket.IO 在 WebSocket 之上还有自己的协议
 * （握手、事件名、ack、命名空间、path），连上以后要发的是「事件 + 参数」而不是一段
 * 文本帧。硬塞进 WS 那个会话里会让两边都变难懂 —— 所以单独一份，把能共用的思路照着写。
 *
 * 三个和 WS 不一样、容易想歪的地方：
 * - **连接参数是 `auth` 而不是请求头**。Socket.IO 的握手可以用 `auth` 带凭据（服务端
 *   `socket.handshake.auth`），这比塞 `Authorization` 头更常用，所以单独给一项。
 * - **`transports` 只给两档**（先长轮询再升级 / 只用 WebSocket）。中间那些组合没有实际意义，
 *   给多了只会让人纠结。
 * - **默认监听全部事件**（`onAny`）。用户还没配监听名单时，看不到任何事件会以为没连上。
 *
 * 老服务端连不上时说人话：socket.io v4 的客户端连 v3 / v4 的服务端没问题，
 * **v2 及更早**的握手格式不一样，报出来的是 `xhr poll error` 之类，用户看不懂 ——
 * 这种情况在 `describeConnectError` 里换成一句「对方可能是 Socket.IO 2.x 或更早」。
 */

var crypto = require('crypto');

/** 每个会话最多缓冲多少个事件 */
var MAX_EVENTS = 500;

/** 单条消息最多放进事件里多少字节，超出部分截断（`size` 仍是原始大小） */
var MAX_MESSAGE_BYTES = 64 * 1024;

/** 每个用户同时最多保持多少个会话 */
var MAX_SESSIONS_PER_USER = 10;

/** 上游关闭、或者没有任何 events 连接，满这个时间就销毁会话 */
var DEFAULT_TTL_MS = 60 * 1000;

/** 连接超时（毫秒） */
var CONNECT_TIMEOUT_MS = 10000;

/**
 * 这几个事件名是 Socket.IO 自己用的，不该被当成「用户要监听的事件」再注册一遍 ——
 * 重复注册会让 connect / disconnect 各记两条。
 */
var RESERVED_EVENTS = ['connect', 'disconnect', 'connect_error', 'connect_timeout', 'error', 'reconnect'];

var liveRegistries = new Set();
var exitHooked = false;

function hookExit() {
    if (exitHooked) return;
    exitHooked = true;
    process.once('exit', function () {
        liveRegistries.forEach(function (registry) { registry.closeAll(); });
    });
}

function httpError(status, message) {
    var err = new Error(message);
    err.status = status;
    err.exposed = true;
    return err;
}

function positive(value, fallback) {
    return typeof value === 'number' && isFinite(value) && value > 0 ? value : fallback;
}

function str(value) {
    return value === null || value === undefined ? '' : String(value);
}

/**
 * `[[k, v]]` 或 `{ key, value }` 行 → 普通对象。
 *
 * 请求头对外是 `[[k, v]]`（和 executor 一个口径），查询参数和 auth 直接收对象。
 */
function toHeaderObject(pairs) {
    var headers = {};
    if (!Array.isArray(pairs)) return headers;

    pairs.forEach(function (pair) {
        if (!Array.isArray(pair) || pair.length < 2) return;

        var name = String(pair[0]);
        if (!name) return;

        headers[name] = pair[1] === undefined || pair[1] === null ? '' : String(pair[1]);
    });

    return headers;
}

/** 查询参数行 → 对象；值统一成字符串 */
function toQueryObject(rows) {
    var query = {};
    if (!Array.isArray(rows)) return query;

    rows.forEach(function (row) {
        if (!row || row.enabled === false) return;
        if (row.key === null || row.key === undefined || String(row.key) === '') return;

        query[String(row.key)] = row.value === undefined || row.value === null ? '' : String(row.value);
    });

    return query;
}

/** 一次最大 64KB 的预览（和 WS 那边同一套：按字节切，文本按 UTF-8 边界切） */
function previewText(text, maxBytes) {
    var buffer = Buffer.from(text === undefined || text === null ? '' : String(text), 'utf8');
    if (buffer.length <= maxBytes) return { text: buffer.toString('utf8'), truncated: false };

    var cut = buffer.subarray(0, maxBytes);
    // 用一个只 write 不 end 的解码器：截断处正好落在汉字中间时，半个字符被丢掉而不是变成 U+FFFD
    var StringDecoder = require('string_decoder').StringDecoder;
    return { text: new StringDecoder('utf8').write(cut), truncated: true };
}

/** 参数数组 → 一行 JSON；循环引用这类情况退化成 String() */
function argsText(args) {
    try {
        var text = JSON.stringify(args);
        return text === undefined ? String(args) : text;
    } catch (err) {
        return String(args);
    }
}

/**
 * 连接失败时把驱动的原话换成人能看懂的。
 *
 * socket.io-client 连一个「不是 Socket.IO」的服务端，或者一个 2.x 的老服务端时，
 * 给的是 `xhr poll error` / `websocket error` 这种，光看它没法判断问题在哪。
 */
function describeConnectError(err) {
    var message = err && err.message ? String(err.message) : String(err || '连接出错');

    /**
     * engine.io 在「对方不是 Socket.IO 服务端」时给的是一句很含糊的 `server error` /
     * `xhr poll error`（它收到一个不是握手格式的响应就报这个），2.x 的老服务端同理。
     * 光看这几个词，用户完全不知道问题在哪，所以在这里补一句能自救的说明。
     */
    if (/server error|xhr poll error|websocket error|transport error|parser error/i.test(message)) {
        return message + '（对方可能不是 Socket.IO 服务端，或者是 Socket.IO 2.x 及更早的版本 —— ' +
            '本客户端能连的是 3.x / 4.x）';
    }
    return message;
}

function describeSocketError(err) {
    if (!err) return '连接出错';
    return String(err.message || err);
}

function createRegistry(options) {
    var opts = options || {};
    var now = typeof opts.now === 'function' ? opts.now : function () { return Date.now(); };
    var ttlMs = positive(opts.ttlMs, DEFAULT_TTL_MS);
    var maxSessions = positive(opts.maxSessions, MAX_SESSIONS_PER_USER);
    var maxBuffer = positive(opts.maxBuffer, MAX_EVENTS);
    var maxMessageBytes = positive(opts.maxMessageBytes, MAX_MESSAGE_BYTES);

    var sessions = new Map();

    /* ------------------------------------------------------------ 事件 */

    function deliver(listener, payload) {
        try {
            listener(payload);
        } catch (err) {
            // 订阅者自己的错（多半是它那边的连接已经断了），不能连累会话
        }
    }

    function push(session, event) {
        session.seq += 1;

        var payload = { seq: session.seq, time: now() };
        Object.keys(event || {}).forEach(function (key) {
            if (event[key] !== undefined) payload[key] = event[key];
        });

        session.events.push(payload);
        if (session.events.length > maxBuffer) {
            session.events.splice(0, session.events.length - maxBuffer);
        }

        session.listeners.forEach(function (listener) { deliver(listener, payload); });
        return payload;
    }

    /**
     * 记一条「事件 + 参数」。
     *
     * `direction` 是 out / in；`event` 是事件名，`args` 是参数数组。
     * 文本按 `args` 的 JSON 存进 `text` —— 界面上一行就是一条，展开能看到格式化后的 JSON。
     */
    function recordMessage(session, direction, event, args) {
        var text = argsText(args);
        var shown = previewText(text, maxMessageBytes);

        push(session, {
            type: 'message',
            direction: direction,
            event: str(event),
            size: Buffer.byteLength(text, 'utf8'),
            text: shown.text,
            truncated: shown.truncated
        });
    }

    /* ------------------------------------------------------------ 计时器 */

    function clearTimer(session, key) {
        if (!session[key]) return;
        clearTimeout(session[key]);
        session[key] = null;
    }

    function armTimer(session, key) {
        clearTimer(session, key);

        var timer = setTimeout(function () {
            session[key] = null;
            destroySession(session);
        }, ttlMs);

        if (timer.unref) timer.unref();
        session[key] = timer;
    }

    /* ------------------------------------------------------------ 生命周期 */

    function destroySession(session) {
        if (!sessions.has(session.id)) return;

        sessions.delete(session.id);
        clearTimer(session, 'closeTimer');
        clearTimer(session, 'idleTimer');

        var socket = session.socket;
        session.socket = null;
        session.status = 'closed';

        if (socket) {
            session.detachSocket(socket);
            try {
                socket.disconnect();
            } catch (err) {
                // 已经断了
            }
        }

        var listeners = session.listeners;
        session.listeners = new Set();
        listeners.forEach(function (listener) { deliver(listener, null); });
    }

    /* ------------------------------------------------------------ 连接上游 */

    function connectOptions(session) {
        var headers = toHeaderObject(session.headers);
        var query = toQueryObject(session.query);

        var result = {
            path: session.path || '/socket.io',
            // 只给两档：「先长轮询再升级」和「只用 WebSocket」
            transports: session.transports === 'websocket' ? ['websocket'] : ['polling', 'websocket'],
            // 不自动重连：用户点了「断开」就是断开，后台偷偷连回来更让人困惑（界面上有「重连」）
            reconnection: false,
            // 不让同名连接复用，否则换一套参数再连会拿到上一个 socket
            forceNew: true,
            timeout: CONNECT_TIMEOUT_MS,
            // 认证信息（Socket.IO 的 auth），和请求头是两回事
            auth: session.auth && typeof session.auth === 'object' ? session.auth : undefined
        };

        if (Object.keys(headers).length) result.extraHeaders = headers;
        if (Object.keys(query).length) result.query = query;

        return result;
    }

    function failConnect(session, message) {
        push(session, { type: 'error', message: message });
        recordClose(session, '连接失败', '');
    }

    function recordClose(session, reason, detail) {
        if (session.status === 'closed') return;

        session.status = 'closed';
        push(session, { type: 'close', code: 0, reason: detail ? reason + '：' + detail : reason });
        armTimer(session, 'closeTimer');
    }

    function connect(session, input) {
        var client = require('socket.io-client');
        var io = client.io || client;

        var url = session.url + (session.namespace === '/' ? '' : session.namespace);

        var socket;
        try {
            socket = io(url, connectOptions(session));
        } catch (err) {
            failConnect(session, '建立 Socket.IO 连接失败：' + ((err && err.message) || '未知错误'));
            return;
        }

        session.socket = socket;
        session.detachSocket = function (target) {
            try { target.removeAllListeners(); } catch (err) { /* 已经关了 */ }
        };

        socket.on('connect', function () {
            if (!sessions.has(session.id)) return;
            session.status = 'open';
            push(session, { type: 'open', protocol: '', sid: socket.id || '', note: session.note || undefined });
        });

        socket.on('connect_error', function (err) {
            if (!sessions.has(session.id)) return;
            push(session, { type: 'error', message: describeConnectError(err) });
            if (session.status === 'connecting') recordClose(session, '连接失败', describeConnectError(err));
        });

        socket.on('disconnect', function (reason) {
            if (!sessions.has(session.id)) return;
            recordClose(session, '连接已断开', reason ? String(reason) : '');
        });

        socket.on('error', function (err) {
            if (!sessions.has(session.id)) return;
            push(session, { type: 'error', message: describeSocketError(err) });
        });

        /**
         * 监听哪些事件：给名单就只监听那几个，没给就 `onAny` 全收。
         *
         * 名单里出现 Socket.IO 自己那几个（connect / disconnect …）时跳过 ——
         * 上面已经注册过，再注册一次会让每条连接 / 断开各记两条。
         */
        var wanted = (session.listenEvents || []).filter(function (name) {
            return RESERVED_EVENTS.indexOf(String(name)) === -1;
        });

        if (wanted.length) {
            wanted.forEach(function (name) {
                socket.on(String(name), function () {
                    if (!sessions.has(session.id)) return;
                    recordMessage(session, 'in', name, Array.prototype.slice.call(arguments));
                });
            });
        } else {
            socket.onAny(function (name) {
                if (!sessions.has(session.id)) return;
                recordMessage(session, 'in', name, Array.prototype.slice.call(arguments, 1));
            });
        }
    }

    /* ------------------------------------------------------------ 对外接口 */

    /**
     * @param {{userId: string, projectId: string, url: string, path?: string, namespace?: string,
     *          headers?: Array, query?: Array, auth?: object, transports?: string,
     *          listenEvents?: string[], note?: string|null}} input
     */
    function create(input) {
        var options = input || {};
        if (!options.url) throw httpError(400, '缺少 Socket.IO 地址');

        var mine = 0;
        sessions.forEach(function (session) {
            if (session.userId === options.userId) mine += 1;
        });
        if (mine >= maxSessions) {
            throw httpError(400, '同时最多保持 ' + maxSessions + ' 个 Socket.IO 会话');
        }

        var session = {
            id: crypto.randomBytes(12).toString('hex'),
            userId: options.userId,
            projectId: options.projectId,
            url: options.url,
            path: options.path || '/socket.io',
            namespace: options.namespace || '/',
            headers: options.headers || [],
            query: options.query || [],
            auth: options.auth || null,
            transports: options.transports || 'polling',
            listenEvents: Array.isArray(options.listenEvents) ? options.listenEvents : [],
            note: options.note || null,
            status: 'connecting',
            seq: 0,
            events: [],
            listeners: new Set(),
            socket: null,
            detachSocket: null,
            closeTimer: null,
            idleTimer: null,
            createdAt: now()
        };

        sessions.set(session.id, session);
        armTimer(session, 'idleTimer');
        connect(session, options);

        return session;
    }

    function get(id, userId) {
        var session = sessions.get(id);
        if (!session) return null;
        if (!userId || session.userId !== userId) return null;
        return session;
    }

    /**
     * 发一个事件。连接还没打开、或者已经关闭时抛 409。
     *
     * @param {string} id
     * @param {{event?: string, args?: Array, ack?: boolean}} payload
     */
    function send(id, payload) {
        var session = sessions.get(id);
        if (!session) throw notOpenError('Socket.IO 会话不存在');
        if (session.status !== 'open' || !session.socket) {
            throw notOpenError('Socket.IO 连接还没有打开，或者已经关闭');
        }

        var data = payload || {};
        var event = str(data.event).trim();
        if (!event) throw httpError(400, '缺少事件名');

        var args = Array.isArray(data.args) ? data.args : [];

        try {
            if (data.ack === true) {
                // 确认（ack）：把服务端的回值当成一条消息记进日志。
                // 「等待确认」只是个勾选 —— 服务端不回也不会卡住，界面上就是少一行确认。
                session.socket.emit.apply(session.socket, [event].concat(args).concat([function (response) {
                    if (!sessions.has(session.id)) return;
                    recordMessage(session, 'ack', event, [response]);
                }]));
            } else {
                session.socket.emit.apply(session.socket, [event].concat(args));
            }
        } catch (err) {
            throw notOpenError('发送失败：' + ((err && err.message) || '未知错误'));
        }

        // 发出去的也要进日志（确认的回值由上面的回调另记一条）
        recordMessage(session, 'out', event, args);
    }

    function notOpenError(message) {
        return httpError(409, message);
    }

    function subscribe(id, after, listener) {
        var session = sessions.get(id);
        if (!session || typeof listener !== 'function') return function () {};

        var from = Number(after);
        if (!Number.isFinite(from)) from = 0;

        session.events.forEach(function (event) {
            if (event.seq > from) deliver(listener, event);
        });

        session.listeners.add(listener);
        clearTimer(session, 'idleTimer');

        return function unsubscribe() {
            if (!session.listeners.has(listener)) return;

            session.listeners.delete(listener);
            if (!session.listeners.size) armTimer(session, 'idleTimer');
        };
    }

    function destroy(id) {
        var session = sessions.get(id);
        if (!session) return false;

        destroySession(session);
        return true;
    }

    function closeAll() {
        Array.from(sessions.keys()).forEach(function (id) {
            var session = sessions.get(id);
            if (session) destroySession(session);
        });
    }

    var registry = {
        create: create,
        get: get,
        send: send,
        subscribe: subscribe,
        destroy: destroy,
        closeAll: closeAll
    };

    liveRegistries.add(registry);
    hookExit();

    return registry;
}

module.exports = {
    createRegistry: createRegistry,
    MAX_EVENTS: MAX_EVENTS,
    MAX_MESSAGE_BYTES: MAX_MESSAGE_BYTES,
    MAX_SESSIONS_PER_USER: MAX_SESSIONS_PER_USER,
    DEFAULT_TTL_MS: DEFAULT_TTL_MS,
    CONNECT_TIMEOUT_MS: CONNECT_TIMEOUT_MS
};
