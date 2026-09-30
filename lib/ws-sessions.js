/**
 * WebSocket 调试会话的注册表（契约第 15 节）。
 *
 * 浏览器不能给 WebSocket 设置自定义请求头，也不能绕开跨域限制，所以由服务端作为客户端
 * 去连目标，前端通过管理台接口操作这个会话。这里就是「会话」本身：
 *
 *   create → 连上游、把上游的事件按 seq 编号缓冲起来
 *   subscribe → 前端拉一条 events 长连接，先补发漏掉的、再实时推新的
 *
 * **这个模块不碰 HTTP，也不碰数据库。** 鉴权、解析请求体、把事件写成 NDJSON，
 * 全是 `lib/api/ws.js` 的事。这样它可以在没有 express、没有库的情况下被单独验证。
 *
 * 三个容易做错的地方：
 * - **事件必须缓冲**：前端刷新页面时会重连 events，`after=<最后一条 seq>` 靠缓冲补齐。
 *   只推不存的话，刷新一下之前的事件就永久丢了。
 * - **两个 60 秒的倒计时**：上游关了要收（不然会话永远挂着），前端全跑了也要收
 *   （不然用户关掉标签页，上游连接会一直留在服务端）。
 * - **所有计时器都要 `.unref()`**：长连接的计时器不能挡住进程退出。
 */

var crypto = require('crypto');
var StringDecoder = require('string_decoder').StringDecoder;

/** 每个会话最多缓冲多少个事件 */
var MAX_EVENTS = 500;

/** 单条消息最多放进事件里多少字节，超出部分截断（`size` 仍是原始大小） */
var MAX_MESSAGE_BYTES = 64 * 1024;

/** 每个用户同时最多保持多少个会话 */
var MAX_SESSIONS_PER_USER = 10;

/** 上游关闭、或者没有任何 events 连接，满这个时间就销毁会话 */
var DEFAULT_TTL_MS = 60 * 1000;

/** 契约第 15 节：DELETE 用 1000 关闭 */
var NORMAL_CLOSURE = 1000;

/** 握手失败时浏览器 / undici 给的关闭码 */
var ABNORMAL_CLOSURE = 1006;

/** WebSocket.readyState 的 CLOSED */
var SOCKET_CLOSED = 3;

/**
 * 进程里所有活着的 registry。
 *
 * 进程退出时统一收一次 —— 主要是为了测试和程序化使用（`apiloop web` 是 Ctrl-C 直接退，
 * 有没有这一步对用户没区别，但把上游 socket 悬在那里总归不对）。
 */
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

/** 启用且 key 非空的行 */
function enabledRows(rows) {
    if (!Array.isArray(rows)) return [];

    return rows.filter(function (row) {
        if (!row || row.enabled === false) return false;
        return row.key !== null && row.key !== undefined && String(row.key) !== '';
    });
}

/**
 * 把一段字节做成「能放进事件里的预览」。
 *
 * 截断按**字节**切，但文本必须按 UTF-8 边界切：64KB 处正好落在一个汉字的中间是常事，
 * 直接 `toString('utf8')` 会在末尾吐出一个 U+FFFD。StringDecoder 会把不完整的尾巴
 * 留在内部 —— 我们不 flush，正好把它丢掉。
 */
function preview(buffer, isBinary, maxBytes) {
    var truncated = buffer.length > maxBytes;
    var cut = truncated ? buffer.subarray(0, maxBytes) : buffer;

    if (isBinary) return { base64: cut.toString('base64'), truncated: truncated };
    return { text: new StringDecoder('utf8').write(cut), truncated: truncated };
}

/** 上游给的数据统一转成 Buffer；binaryType 设成了 arraybuffer，正常只会是字符串或 ArrayBuffer */
function toBuffer(data) {
    if (typeof data === 'string') return Buffer.from(data, 'utf8');
    if (Buffer.isBuffer(data)) return data;
    if (data instanceof ArrayBuffer) return Buffer.from(data);
    if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);

    return Buffer.from(String(data === undefined || data === null ? '' : data), 'utf8');
}

/**
 * 请求头从 `[[k, v]]` 转成普通对象 —— 和 executor 的 `headersToObject` 一个口径
 * （同名后者覆盖前者，代价是重复的同名头会丢，握手场景下可以接受）。
 *
 * 入参是**二元数组**，不是 `{ key, value }` 行：管理台那边 `params.headers` 是行对象，
 * 但出了 `lib/api/ws.js` 就往这里塞成 `[[k, v]]` 了（和执行器一致）。
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

/** 子协议：字符串或数组都收，去掉空项 */
function toProtocolList(value) {
    if (typeof value === 'string') return value ? [value] : [];
    if (!Array.isArray(value)) return [];

    return value.map(function (item) {
        return String(item).trim();
    }).filter(Boolean);
}

/** 从 WebSocket 的 error 事件里挖出一句能给人看的话 */
function describeSocketError(event) {
    if (!event) return '连接出错';

    var text = event.message || (event.error && event.error.message) || '';
    if (!text && event.error) text = String(event.error);

    return text ? String(text) : '连接出错';
}

function notOpenError(message) {
    return httpError(409, message);
}

/**
 * @param {object} [options]
 * @param {Function} [options.now] 取时间，默认 Date.now —— 注入它是给测试用的
 * @param {number} [options.ttlMs] 两个倒计时的时长，默认 60 秒
 * @param {number} [options.maxSessions] 每个用户的会话上限
 * @param {number} [options.maxBuffer] 每个会话的事件缓冲上限
 * @param {number} [options.maxMessageBytes] 单条消息的展示上限
 */
function createRegistry(options) {
    var opts = options || {};
    var now = typeof opts.now === 'function' ? opts.now : function () { return Date.now(); };
    var ttlMs = positive(opts.ttlMs, DEFAULT_TTL_MS);
    var maxSessions = positive(opts.maxSessions, MAX_SESSIONS_PER_USER);
    var maxBuffer = positive(opts.maxBuffer, MAX_EVENTS);
    var maxMessageBytes = positive(opts.maxMessageBytes, MAX_MESSAGE_BYTES);

    /** id → session */
    var sessions = new Map();

    /* ------------------------------------------------------------ 事件 */

    function deliver(listener, payload) {
        try {
            listener(payload);
        } catch (err) {
            // 订阅者自己的错（多半是它那边的连接已经断了），不能连累会话
        }
    }

    /**
     * 记一条事件：编 seq、塞进缓冲、推给所有 events 连接。
     *
     * `time` 和 `seq` 由这里统一填，调用方只管 type 和内容 —— 少一处手写就少一处不一致。
     */
    function push(session, event) {
        session.seq += 1;

        var payload = { seq: session.seq, time: now() };
        Object.keys(event || {}).forEach(function (key) {
            if (event[key] !== undefined) payload[key] = event[key];
        });

        session.events.push(payload);
        // 只留最近 maxBuffer 条。丢最旧的：前端要的是「刚刚发生了什么」
        if (session.events.length > maxBuffer) {
            session.events.splice(0, session.events.length - maxBuffer);
        }

        session.listeners.forEach(function (listener) { deliver(listener, payload); });
        return payload;
    }

    function recordMessage(session, direction, buffer, isBinary) {
        var shown = preview(buffer, isBinary, maxMessageBytes);
        var event = {
            type: 'message',
            direction: direction,
            size: buffer.length,
            truncated: shown.truncated
        };
        if (isBinary) event.base64 = shown.base64;
        else event.text = shown.text;

        push(session, event);
    }

    /* ------------------------------------------------------------ 计时器 */

    function clearTimer(session, key) {
        if (!session[key]) return;
        clearTimeout(session[key]);
        session[key] = null;
    }

    /** 起一个「没人要了就销毁」的倒计时，到点销毁会话 */
    function armTimer(session, key) {
        clearTimer(session, key);

        var timer = setTimeout(function () {
            session[key] = null;
            destroySession(session);
        }, ttlMs);

        // 长连接的计时器不能挡住进程退出
        if (timer.unref) timer.unref();
        session[key] = timer;
    }

    /* ------------------------------------------------------------ 生命周期 */

    function closeSocket(socket, code) {
        try {
            if (!socket || socket.readyState === SOCKET_CLOSED) return;
            socket.close(code, '');
        } catch (err) {
            // 已经断了，或者正在断：没什么可做的
        }
    }

    function destroySession(session) {
        if (!sessions.has(session.id)) return;

        sessions.delete(session.id);
        clearTimer(session, 'closeTimer');
        clearTimer(session, 'idleTimer');

        var socket = session.socket;
        session.socket = null;
        session.status = 'closed';
        closeSocket(socket, NORMAL_CLOSURE);

        /**
         * 告诉所有 events 连接「会话没了」—— 约定是**传 null**。
         * 不通知的话，前端那条 NDJSON 会一直挂着，直到它自己超时。
         */
        var listeners = session.listeners;
        session.listeners = new Set();
        listeners.forEach(function (listener) { deliver(listener, null); });
    }

    /* ------------------------------------------------------------ 连接上游 */

    function connectOptions(input) {
        var result = {};

        var headers = toHeaderObject(input.headers);
        if (Object.keys(headers).length) result.headers = headers;

        var protocols = toProtocolList(input.protocols);
        if (protocols.length) result.protocols = protocols;

        return result;
    }

    /** 会话没连上就先把 close 事件也记下 —— 用户至少要看到「为什么没成」 */
    function failConnect(session, message) {
        push(session, { type: 'error', message: message });
        recordClose(session, ABNORMAL_CLOSURE, '');
    }

    /**
     * 记一条 close 事件并开始「上游关了」的倒计时。
     *
     * 幂等：同一个会话只会记一条。`status === 'closed'` 就是「已经记过」的标记 ——
     * 少了这个判断，握手失败那次会记两条（见下面 error 处理里的说明）。
     */
    function recordClose(session, code, reason) {
        if (session.status === 'closed') return;

        session.status = 'closed';
        push(session, { type: 'close', code: code, reason: reason || '' });
        // 上游关了，但 events 连接可能还在读缓冲：留 ttl 再销毁
        armTimer(session, 'closeTimer');
    }

    function connect(session, input) {
        var Ctor = typeof WebSocket === 'undefined' ? null : WebSocket;
        if (!Ctor) {
            failConnect(session, '当前 Node 没有全局 WebSocket（需要 Node 22.4 以上）');
            return;
        }

        var socket;
        try {
            // Node 自带的 WebSocket 第二个参数可以给 `{ headers, protocols }`，
            // 这样才带得动自定义请求头 —— 也正是服务端代连的全部意义
            socket = new Ctor(session.url, connectOptions(input));
        } catch (err) {
            failConnect(session, '建立 WebSocket 连接失败：' + ((err && err.message) || '未知错误'));
            return;
        }

        session.socket = socket;
        // 二进制帧统一按 ArrayBuffer 收，事件里再转 base64
        socket.binaryType = 'arraybuffer';

        socket.addEventListener('open', function () {
            if (!sessions.has(session.id)) return;
            session.status = 'open';
            push(session, {
                type: 'open',
                protocol: socket.protocol || '',
                note: session.note || undefined
            });
        });

        socket.addEventListener('message', function (event) {
            if (!sessions.has(session.id)) return;

            var data = event.data;

            // binaryType 设成了 arraybuffer，正常不会走到 Blob；兜一手，别把消息丢了
            if (data && typeof data.arrayBuffer === 'function' && !Buffer.isBuffer(data) &&
                !(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) {
                data.arrayBuffer().then(function (buffer) {
                    if (!sessions.has(session.id)) return;
                    recordMessage(session, 'in', Buffer.from(buffer), true);
                }, function () { /* 读不出来就丢掉 */ });
                return;
            }

            var isBinary = typeof data !== 'string';
            recordMessage(session, 'in', toBuffer(data), isBinary);
        });

        socket.addEventListener('error', function (event) {
            if (!sessions.has(session.id)) return;

            // 握手失败时 error 先于 close 到达，两条都要留档 ——
            // 只留 close 的话用户只看到一个 1006，等于没给任何线索
            push(session, { type: 'error', message: describeSocketError(event) });

            /**
             * **握手失败时 Node 自带的 WebSocket 不会再触发 `close`。**
             * 实测（Node 22.22）：连不上端口时只来一个 error，`readyState` 一直停在
             * CONNECTING，等 8 秒也没有 close。计划里写的「error 之后一定跟着 close」
             * 在这一版上不成立。
             *
             * 所以这里自己补一条 —— 不补的话前端收不到任何「结束了」的信号，
             * 而且会话会一直挂着，close 倒计时也永远不会开始走。
             *
             * 已经 open 过的连接不受影响：那种情况 close 会正常到来（实测拔线 → 1006）。
             */
            if (session.status === 'connecting') {
                recordClose(session, ABNORMAL_CLOSURE, '');
            }
        });

        socket.addEventListener('close', function (event) {
            if (!sessions.has(session.id)) return;
            recordClose(
                session,
                event && event.code !== undefined ? event.code : ABNORMAL_CLOSURE,
                event && event.reason
            );
        });
    }

    /* ------------------------------------------------------------ 对外接口 */

    /**
     * 建一个会话并立即开始连接。超过每个用户的会话上限时抛出 400。
     *
     * @param {{userId: string, projectId: string, url: string, headers?: Array,
     *          protocols?: string|string[], note?: string|null}} input
     */
    function create(input) {
        var options = input || {};

        if (!options.url) throw httpError(400, '缺少 WebSocket 地址');

        var mine = 0;
        sessions.forEach(function (session) {
            if (session.userId === options.userId) mine += 1;
        });
        if (mine >= maxSessions) {
            throw httpError(400, '同时最多保持 ' + maxSessions + ' 个 WebSocket 会话');
        }

        var session = {
            id: crypto.randomBytes(12).toString('hex'),
            userId: options.userId,
            projectId: options.projectId,
            url: options.url,
            note: options.note || null,
            status: 'connecting',
            seq: 0,
            events: [],
            listeners: new Set(),
            socket: null,
            closeTimer: null,
            idleTimer: null,
            createdAt: now()
        };

        sessions.set(session.id, session);

        // 这时还没有 events 连接（前端紧接着就会连过来），先起「没人看」的倒计时
        armTimer(session, 'idleTimer');
        connect(session, options);

        return session;
    }

    /**
     * 取会话。**不是本人的一律当不存在** —— 会话里带着创建者的凭据，
     * 所以连 admin 也拿不到别人的。
     */
    function get(id, userId) {
        var session = sessions.get(id);
        if (!session) return null;
        if (!userId || session.userId !== userId) return null;
        return session;
    }

    /**
     * 发一条消息。连接还没打开、或者已经关闭时抛 409（契约第 15 节）。
     *
     * @param {string} id
     * @param {{text?: string, base64?: string}} payload
     */
    function send(id, payload) {
        var session = sessions.get(id);
        if (!session) throw notOpenError('WebSocket 会话不存在');
        if (session.status !== 'open' || !session.socket) {
            throw notOpenError('WebSocket 连接还没有打开，或者已经关闭');
        }

        var data = payload || {};
        var isBinary = typeof data.base64 === 'string';
        var text = typeof data.text === 'string' ? data.text : '';
        var buffer = isBinary ? Buffer.from(data.base64, 'base64') : Buffer.from(text, 'utf8');

        try {
            // 二进制发 Buffer（Uint8Array），文本发字符串：Node 的 WebSocket 两种都收
            session.socket.send(isBinary ? buffer : text);
        } catch (err) {
            throw notOpenError('发送失败：' + ((err && err.message) || '未知错误'));
        }

        // 发出去的也要进日志，而且**截断只作用于事件里的预览**，线上发的是完整内容
        recordMessage(session, 'out', buffer, isBinary);
    }

    /**
     * 订阅会话事件：先同步补发 `seq > after` 的缓冲事件，再推新的。
     *
     * @param {string} id
     * @param {number} after 客户端已经拿到的最后一条 seq（0 表示从头）
     * @param {Function} listener 收到事件对象；**会话被销毁时收一次 `null`**
     * @returns {Function} 取消订阅
     */
    function subscribe(id, after, listener) {
        var session = sessions.get(id);
        if (!session || typeof listener !== 'function') return function () {};

        var from = Number(after);
        if (!Number.isFinite(from)) from = 0;

        /**
         * 补发和「加进监听表」必须在同一个同步块里：中间一旦让出事件循环，
         * 新事件就可能既没被补发、又没被推给这个 listener。
         */
        session.events.forEach(function (event) {
            if (event.seq > from) deliver(listener, event);
        });

        session.listeners.add(listener);
        // 有人看了，取消「没人看」的倒计时
        clearTimer(session, 'idleTimer');

        return function unsubscribe() {
            if (!session.listeners.has(listener)) return;

            session.listeners.delete(listener);
            // 最后一个连接也走了：起倒计时，到期销毁会话，别把上游连接一直留着
            if (!session.listeners.size) armTimer(session, 'idleTimer');
        };
    }

    /** 销毁会话：关上游、清计时器、通知 events 连接。不存在时什么也不做 */
    function destroy(id) {
        var session = sessions.get(id);
        if (!session) return false;

        destroySession(session);
        return true;
    }

    /** 服务关闭时调 */
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
    DEFAULT_TTL_MS: DEFAULT_TTL_MS
};
