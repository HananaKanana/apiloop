/**
 * gRPC 流式会话的注册表（第十二轮第 2 节）。
 *
 * 客户端流和双向流要**边连着边发**，一次 POST 表达不了，所以和 Socket.IO 一样做成会话：
 * 建会话（建完就开始连）、`/events` 收 NDJSON、`/send` 一条条发、`/end` 半关、`DELETE` 取消。
 *
 * 会话模型照 `lib/sio-sessions.js` 抄（缓冲 + seq + subscribe 补发 + 空闲回收 + 每人会话数上限），
 * 差别在「连上去以后干什么」：那边是 Socket.IO 的事件，这里是
 * `call.write(一条消息)` / `call.end()` / `call.cancel()`。
 *
 * 三个刻意的地方：
 *
 * - **不设 deadline**。一元调用那种「10 秒不回就算了」的规矩放在会话上会把一个正常的
 *   长连接掐死 —— 会话的寿命由**空闲回收**（没人看事件流、或者上游已经结束）来管。
 * - **`end` 之后不马上销毁**：晚一步连上来的页面还能把整个会话的事件补看一遍（照 sio 的做法，
 *   等到空闲 TTL 才收）。
 * - **`sent` 事件要记**：客户端流的关键就是「我发出去的那几条到底是什么」，变量替换后的样子
 *   必须能在界面上看到，不然「发了 3 条但服务端说收到 2 条」这种问题没法查。
 */

var crypto = require('crypto');

/** 每个会话最多缓冲多少个事件 */
var MAX_EVENTS = 500;

/** 每个用户同时最多保持多少个会话 */
var MAX_SESSIONS_PER_USER = 10;

/** 上游结束、或者没有任何 events 连接，满这个时间就销毁会话 */
var DEFAULT_TTL_MS = 60 * 1000;

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

function createRegistry(options) {
    var opts = options || {};
    var grpcLib = require('./grpc');
    var now = typeof opts.now === 'function' ? opts.now : function () { return Date.now(); };
    var ttlMs = positive(opts.ttlMs, DEFAULT_TTL_MS);
    var maxSessions = positive(opts.maxSessions, MAX_SESSIONS_PER_USER);
    var maxBuffer = positive(opts.maxBuffer, MAX_EVENTS);

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
        if (!sessions.has(session.id)) return null;

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

        var call = session.call;
        session.call = null;
        session.status = 'closed';

        if (call) {
            try { call.cancel(); } catch (err) { /* 已经结束了 */ }
        }

        if (session.client) {
            try { session.client.close(); } catch (err) { /* 已经关了 */ }
            session.client = null;
        }

        var listeners = session.listeners;
        session.listeners = new Set();
        listeners.forEach(function (listener) { deliver(listener, null); });
    }

    /* ------------------------------------------------------------ 连上去 */

    /**
     * 收尾：写一行 `end`，然后等空闲 TTL 再销毁。
     *
     * 断言和提取**在这里跑**（`lib/grpc.js` 的 `endEventOf`，和 `/grpc/call` 共用）：
     * 收到全部消息之后才知道响应体长什么样。
     */
    function finish(session, status) {
        if (session.finished) return;
        session.finished = true;
        session.status = 'ended';

        push(session, grpcLib.endEventOf({
            grpc: require('@grpc/grpc-js'),
            status: status,
            messages: session.messages,
            handshakeMetadata: session.handshakeMetadata,
            startedAt: session.startedAt,
            // 流式会话收到的都是一串消息：断言里「响应体」按数组算
            streamed: true,
            assertions: session.assertions,
            extracts: session.extracts,
            vars: session.vars,
            hasEnvironment: session.hasEnvironment
        }));

        // 调用结束了，但事件留着给晚连上来的页面看
        if (session.client) {
            try { session.client.close(); } catch (err) { /* 已经关了 */ }
            session.client = null;
        }
        session.call = null;
        armTimer(session, 'closeTimer');
    }

    function connect(session) {
        var grpc = require('@grpc/grpc-js');

        push(session, {
            type: 'start',
            target: session.target,
            tls: session.tls,
            missing: session.missing || [],
            note: session.note || null
        });

        var ready;
        try {
            ready = grpcLib.loadMethod({
                protoFiles: session.protoFiles,
                descriptorSet: session.descriptorSet,
                service: session.service,
                method: session.method
            });
        } catch (err) {
            session.status = 'failed';
            push(session, { type: 'error', error: (err && err.message) || '会话准备失败' });
            armTimer(session, 'closeTimer');
            return;
        }

        var credentials = session.tls === true ? grpc.credentials.createSsl() : grpc.credentials.createInsecure();

        try {
            session.client = new ready.Ctor(session.target, credentials);
            var metadata = grpcLib.buildMetadata(session.metadata);

            /**
             * 两种方法调用的**签名不一样**（grpc-js 的规矩，传错了报
             * `Incorrect arguments passed`）：
             * - 双向流：`(metadata, options)`，回值全走 `data` 事件；
             * - **客户端流**：`(metadata, options, callback)` —— 它的回值是**一条**，
             *   只在回调里给。回调一定早于 `status` 事件，所以 `finish` 里拼响应体时
             *   已经收得到这条回值。
             *
             * 都不设 deadline：会话是长连接，寿命交给空闲回收（见文件头）。
             */
            if (ready.method.responseStream) {
                session.call = session.client[session.method](metadata, {});
                session.call.on('data', function (item) {
                    session.messages.push(item);
                    push(session, { type: 'message', data: item, at: now() });
                });
            } else {
                session.call = session.client[session.method](metadata, {}, function (err, response) {
                    if (err || response === undefined || response === null) return;
                    session.messages.push(response);
                    push(session, { type: 'message', data: response, at: now() });
                });
            }

            session.call.on('metadata', function (md) {
                session.handshakeMetadata = grpcLib.metadataToObject(md);
                push(session, { type: 'metadata', metadata: session.handshakeMetadata });
            });

            // 出错时 error 和 status 都会来；不挂这个监听器会抛出去
            session.call.on('error', function () {});
            session.call.on('status', function (status) { finish(session, status); });

            session.status = 'open';
        } catch (err) {
            session.status = 'failed';
            push(session, { type: 'error', error: (err && err.message) || '建立 gRPC 调用失败' });
            armTimer(session, 'closeTimer');
        }
    }

    /* ------------------------------------------------------------ 对外接口 */

    /**
     * @param {{userId: string, projectId: string, target: string, tls: boolean,
     *          metadata?: Array, service: string, method: string,
     *          protoFiles?: Array, descriptorSet?: string, note?: string|null,
     *          missing?: string[], assertions?: Array, extracts?: Array,
     *          vars?: Object, hasEnvironment?: boolean}} input
     */
    function create(input) {
        var options = input || {};
        if (!options.target) throw httpError(400, '缺少 gRPC 服务地址');

        var mine = 0;
        sessions.forEach(function (session) {
            if (session.userId === options.userId) mine += 1;
        });
        if (mine >= maxSessions) {
            throw httpError(400, '同时最多保持 ' + maxSessions + ' 个 gRPC 流式会话');
        }

        var session = {
            id: 'gs_' + crypto.randomBytes(10).toString('hex'),
            userId: options.userId,
            projectId: options.projectId,
            apiId: options.apiId || null,
            environmentId: options.environmentId || null,
            target: options.target,
            tls: options.tls === true,
            metadata: options.metadata || [],
            service: options.service,
            method: options.method,
            protoFiles: options.protoFiles || [],
            descriptorSet: options.descriptorSet || '',
            note: options.note || null,
            missing: options.missing || [],
            assertions: options.assertions || [],
            extracts: options.extracts || [],
            vars: options.vars || {},
            hasEnvironment: options.hasEnvironment === true,
            status: 'connecting',
            finished: false,
            seq: 0,
            events: [],
            listeners: new Set(),
            messages: [],
            handshakeMetadata: {},
            client: null,
            call: null,
            closeTimer: null,
            idleTimer: null,
            startedAt: now(),
            createdAt: now()
        };

        sessions.set(session.id, session);
        armTimer(session, 'idleTimer');
        connect(session);

        return session;
    }

    function get(id, userId) {
        var session = sessions.get(id);
        if (!session) return null;
        if (!userId || session.userId !== userId) return null;
        return session;
    }

    /**
     * 发一条消息（调用方已经把 `{{变量}}` 替换好、JSON.parse 好了）。
     *
     * 已经半关 / 已经结束的会话再发就是 409「会话已经结束」—— 用户点得太快、
     * 或者两个页面同时开着时都会撞到。
     */
    function send(id, message) {
        var session = sessions.get(id);
        if (!session) throw httpError(409, 'gRPC 流式会话不存在');

        if (session.finished || session.status === 'ended' || session.status === 'closed') {
            throw httpError(409, '会话已经结束');
        }
        if (!session.call) throw httpError(409, 'gRPC 调用还没有建立');

        try {
            session.call.write(message);
        } catch (err) {
            throw httpError(409, '发送失败：' + ((err && err.message) || '未知错误'));
        }

        push(session, { type: 'sent', data: message, at: now() });
    }

    /** 结束发送（half-close）：之后服务端还可以继续回消息，直到它自己 end */
    function halfClose(id) {
        var session = sessions.get(id);
        if (!session) throw httpError(409, 'gRPC 流式会话不存在');
        if (session.finished || session.status === 'ended' || session.status === 'closed') {
            throw httpError(409, '会话已经结束');
        }
        if (!session.call) throw httpError(409, 'gRPC 调用还没有建立');

        try {
            session.call.end();
        } catch (err) {
            throw httpError(409, '结束发送失败：' + ((err && err.message) || '未知错误'));
        }
        session.status = 'half-closed';
    }

    function subscribe(id, after, listener) {
        var session = sessions.get(id);
        if (!session || typeof listener !== 'function') return function () {};

        var from = Number(after);
        if (!Number.isFinite(from)) from = 0;

        // 从头补发：页面晚连上、或者断开重连时都靠它
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
        halfClose: halfClose,
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
    MAX_SESSIONS_PER_USER: MAX_SESSIONS_PER_USER,
    DEFAULT_TTL_MS: DEFAULT_TTL_MS
};
