/**
 * MQTT 调试会话的注册表（第十三轮）。
 *
 * 和 `lib/sio-sessions.js` 是**同一套会话模型**（缓冲、seq、subscribe、两个 60 秒倒计时，
 * 连事件名都尽量对齐），差别只在「用什么连上去」：那边是 `socket.io-client`，这里是 `mqtt`
 * （MQTT.js v5，纯 JS）。
 *
 * 为什么不复用 sio-sessions：那边是「事件名 + 参数数组」，这里是「主题 + 字节流」，
 * 收发单位完全不是一回事（订阅要等 SUBACK、QoS 1/2 要等 PUBACK/PUBCOMP 才算发出去）。
 * 硬塞进一个会话里两边都会变难懂，所以单独一份，把能共用的思路照着写。
 *
 * 四个和 Socket.IO 不一样、容易想歪的地方：
 * - **协议版本要连 `protocolId` 一起换**。3.1（版本 3）的协议名是 `MQIsdp`，不显式写给
 *   默认的 `MQTT`，不少 broker 会直接拒掉这次连接（MQTT.js 只在 4 / 5 上用 `MQTT`）。
 * - **`subscribe` 回调的第二个参数是「订阅项数组」，不是「granted 数组」**。
 *   MQTT.js v5 给的是 `[{ topic, qos }]`，而且 `qos` 被换成了 SUBACK 里的授权码
 *   （0/1/2 成功，>= 128 是原因码）—— 要读 `granted[0].qos`，不是 `granted[0]`。
 * - **重连是自己的事**。MQTT.js 默认 `reconnectPeriod` 1 秒自动重连，这里保留这个行为
 *   （界面上有「重连中」这一档），但 `resubscribe` 关掉、改成**每次连上都自动重订阅一遍**
 *   —— 这样重连之后能再发一轮 `subscribed`，界面上的订阅状态不会是假的。
 * - **二进制和文本要分清**。payload 是字节流，能原样转回 UTF-8 才算文本；转不回去就给
 *   base64（界面上显示「二进制 N 字节」）。
 *
 * `mqtt` 在函数里 `require`：它是重依赖，只在真的要连 broker 时才加载。
 */

var crypto = require('crypto');
var i18n = require('./i18n');

/** 每个会话最多缓冲多少个事件 */
var MAX_EVENTS = 500;

/** 单条消息最多放进事件里多少字节，超出部分截断（`size` 仍是原始大小） */
var MAX_MESSAGE_BYTES = 64 * 1024;

/** 每个用户同时最多保持多少个会话 */
var MAX_SESSIONS_PER_USER = 10;

/** 上游断开、或者没有任何 events 连接，满这个时间就销毁会话 */
var DEFAULT_TTL_MS = 60 * 1000;

/** 连接超时（毫秒） */
var CONNECT_TIMEOUT_MS = 10000;

/** 断开之后多久重连一次（和界面上的「重连中」对应） */
var RECONNECT_PERIOD_MS = 2000;

/** MQTT 的协议版本：3 = 3.1、4 = 3.1.1、5 = 5（请求体里写的就是这几个数） */
var PROTOCOL_VERSIONS = [3, 4, 5];

/**
 * 认不出来的协议版本用这个。
 *
 * 选 4（3.1.1）不是随便挑的：它是 MQTT 用得最广的一版，绝大多数 broker 都认；
 * MQTT.js 自己的默认值也是它。用户真要用 5 的 properties / 原因码，界面上会显式选。
 */
var DEFAULT_PROTOCOL_VERSION = 4;

/** QoS 只有三档 */
var QOS_VALUES = [0, 1, 2];

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

/* ------------------------------------------------------------ 配置清洗 */

/**
 * 协议版本：只认 3 / 4 / 5，别的（undefined、9、"abc"）给默认值。
 *
 * **这里是全项目唯一的一份** —— 保存接口时（`lib/api/dto.js` 的 `toApiMqtt`）和
 * 真建会话时（`lib/api/mqtt.js`）都从这里取，两处不能各写一套。
 */
function toProtocolVersion(value) {
    var num = Number(value);
    return PROTOCOL_VERSIONS.indexOf(num) > -1 ? num : DEFAULT_PROTOCOL_VERSION;
}

/** QoS：只认 0 / 1 / 2，别的给 `fallback`（fallback 自己不合法时按 0） */
function toQos(value, fallback) {
    var base = QOS_VALUES.indexOf(Number(fallback)) > -1 ? Number(fallback) : 0;
    var num = Number(value);
    return QOS_VALUES.indexOf(num) > -1 ? num : base;
}

/* ------------------------------------------------------------ 错误文案 */

/**
 * CONNACK / DISCONNECT 的原因码 → 中文。
 *
 * 3.1 和 3.1.1 用的是低编号（1~5），5 换成高编号（128 起），两套编号在这里合并；
 * 认不出来的返回 null，交给调用方自己兜底。
 */
function reasonMessage(code, locale) {
    switch (Number(code)) {
        case 1: return i18n.mIn(locale, 'broker 不支持这个协议版本，请换一个协议版本（3.1 / 3.1.1 / 5）');
        case 2: return i18n.mIn(locale, '客户端 ID 不合规，broker 拒绝了这次连接');
        case 3: return i18n.mIn(locale, 'broker 不可用，请稍后再试');
        case 4: return i18n.mIn(locale, '用户名或密码不对');
        // 5 / 135（Not authorized）：**不能写「用户名密码对上了」** —— 很多 broker
        // （aedes、部分 mosquitto 插件）密码错了也回 5，那样说会把用户带偏。
        // 4 / 134（Bad user name or password）才是能确定「凭据不对」的那一档。
        case 5: return i18n.mIn(locale, '用户名或密码不对，或者这个用户没有连接权限');
        case 128: return i18n.mIn(locale, 'broker 返回了未指明的错误');
        case 129: return i18n.mIn(locale, '报文格式不对，broker 拒收');
        case 132: return i18n.mIn(locale, 'broker 不支持这个协议版本，请换一个协议版本（3.1 / 3.1.1 / 5）');
        case 133: return i18n.mIn(locale, '客户端 ID 不合规，broker 拒绝了这次连接');
        case 134: return i18n.mIn(locale, '用户名或密码不对');
        case 135: return i18n.mIn(locale, '用户名或密码不对，或者这个用户没有连接权限');
        case 136: return i18n.mIn(locale, 'broker 不可用，请稍后再试');
        case 137: return i18n.mIn(locale, 'broker 正忙，请稍后再试');
        case 138: return i18n.mIn(locale, 'broker 正在关闭');
        case 139: return i18n.mIn(locale, 'broker 正在关闭');
        case 140: return i18n.mIn(locale, 'broker 不支持这个功能');
        case 142: return i18n.mIn(locale, '同一个 clientId 在别处登录，被 broker 断开');
        case 143: return i18n.mIn(locale, '主题过滤器不合法');
        case 144: return i18n.mIn(locale, '主题名不合法');
        case 145: return i18n.mIn(locale, '报文里的属性不合法');
        case 151: return i18n.mIn(locale, '没有权限订阅这个主题');
        case 154: return i18n.mIn(locale, '没有权限发布这个主题');
        default: return null;
    }
}

/**
 * 连接层面的错误 → 给人看懂的一句中文。
 *
 * `err.code` 有两种完全不同的东西：CONNACK 被拒时是**数字**原因码（MQTT.js 的
 * `ErrorWithReasonCode`），网络层的错则是 `ECONNREFUSED` 这种字符串。所以先按数字查表，
 * 再按字符串里的错误码 / 关键字判断。
 */
function describeConnectError(err, locale) {
    if (!err) return i18n.mIn(locale, '连接出错');

    var known = reasonMessage(err.code, locale);
    if (known) return known;

    var raw = str(err.message || err);
    if (/ECONNREFUSED/i.test(raw)) return i18n.mIn(locale, '连不上 broker，检查地址和端口');
    if (/ETIMEDOUT|ECONNRESET|timed?\s?out|timeout/i.test(raw)) return i18n.mIn(locale, '连不上 broker，检查地址和端口（连接超时）');
    if (/ENOTFOUND|EAI_AGAIN/i.test(raw)) return i18n.mIn(locale, '找不到这个地址，检查 broker 的主机名');
    if (/EHOSTUNREACH|ENETUNREACH/i.test(raw)) return i18n.mIn(locale, '网络不通，检查 broker 的地址');
    if (/CERT_|certificate|self.signed|SSL|TLS/i.test(raw)) {
        return i18n.mIn(locale, 'TLS 握手失败，检查证书和协议（mqtts:// 或 wss://）');
    }
    if (/invalid protocol|protocol version|protocol id/i.test(raw)) {
        return i18n.mIn(locale, 'broker 不支持这个协议版本，请换一个协议版本（3.1 / 3.1.1 / 5）');
    }
    return raw;
}

/** 订阅被拒 / 失败的说法 */
function subscribeMessage(code, locale) {
    var num = Number(code);
    if (num === 135 || num === 151 || num === 158) return i18n.mIn(locale, '没有权限订阅这个主题');
    if (num === 143) return i18n.mIn(locale, '主题过滤器不合法');
    if (num === 145) return i18n.mIn(locale, '订阅的主题名不合法');
    // 128 是 3.1.1 的 0x80（Failure），也是 v5 的「未指明错误」：broker 就是不肯说
    if (num === 128) return i18n.mIn(locale, 'broker 拒绝了这次订阅');
    if (num >= 128) return i18n.mIn(locale, 'broker 拒绝了这次订阅（原因码 {code}）', { code: num });
    return i18n.mIn(locale, 'broker 拒绝了这次订阅');
}

/** 发布被拒的说法（原因码和连接的是同一套，但措辞要落到「发布」上） */
function publishMessage(err, locale) {
    var code = Number(err && err.code);
    if (code === 135 || code === 151) return i18n.mIn(locale, '没有权限发布这个主题');
    if (code === 144) return i18n.mIn(locale, '主题名不合法');
    if (Number.isFinite(code) && code >= 128) {
        return reasonMessage(code, locale) || i18n.mIn(locale, 'broker 拒绝了这次发布（原因码 {code}）', { code: code });
    }
    return describeConnectError(err, session.locale);
}

/* ------------------------------------------------------------ 消息正文 */

/**
 * 一段 payload → 事件里的字段。
 *
 * 「是不是文本」按**整段**判（能不丢字节地转回 UTF-8），截断只影响给了多少 ——
 * 否则一段大一点的中文会被当成二进制。截断处落在汉字中间时用 StringDecoder 丢掉半个字符，
 * 而不是塞一个 U+FFFD 进事件里。
 *
 * @returns {{payload: ?string, payloadBase64: ?string, size: number, truncated: boolean}}
 */
function payloadFields(raw) {
    var buffer = Buffer.isBuffer(raw)
        ? raw
        : Buffer.from(raw === undefined || raw === null ? '' : String(raw), 'utf8');

    var size = buffer.length;
    var truncated = size > MAX_MESSAGE_BYTES;
    var cut = truncated ? buffer.subarray(0, MAX_MESSAGE_BYTES) : buffer;

    var whole = buffer.toString('utf8');
    var isText = Buffer.from(whole, 'utf8').equals(buffer);

    if (isText) {
        var text = whole;
        if (truncated) {
            // 只 write 不 end：截断处正好在汉字中间时丢掉那半个字符
            var StringDecoder = require('string_decoder').StringDecoder;
            text = new StringDecoder('utf8').write(cut);
        }
        return { payload: text, payloadBase64: null, size: size, truncated: truncated };
    }

    return { payload: null, payloadBase64: cut.toString('base64'), size: size, truncated: truncated };
}

/* ------------------------------------------------------------ 注册表 */

function createRegistry(options) {
    var opts = options || {};
    var now = typeof opts.now === 'function' ? opts.now : function () { return Date.now(); };
    var ttlMs = positive(opts.ttlMs, DEFAULT_TTL_MS);
    var maxSessions = positive(opts.maxSessions, MAX_SESSIONS_PER_USER);
    var maxBuffer = positive(opts.maxBuffer, MAX_EVENTS);
    var reconnectPeriod = typeof opts.reconnectPeriod === 'number' && opts.reconnectPeriod >= 0
        ? opts.reconnectPeriod
        : RECONNECT_PERIOD_MS;

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

        var client = session.client;
        session.client = null;
        session.status = 'closed';

        if (client) {
            // 先摘监听：`end()` 会触发 `close`，那时不该再往一个已经销毁的会话里写事件
            session.detachClient(client);

            try {
                /**
                 * `force = false`：先发一个 DISCONNECT 报文再关 socket —— broker 立刻就能看到
                 * 这个客户端下线了（测试里的「DELETE 后 broker 看到断开」看的就是这一步）。
                 */
                client.end(false, {}, function () {});
            } catch (err) {
                // 已经断了
            }
        }

        var listeners = session.listeners;
        session.listeners = new Set();
        listeners.forEach(function (listener) { deliver(listener, null); });
    }

    /** 上游断了：记一行、开始 60 秒倒计时（这一段时间里页面还能回看事件） */
    function recordClose(session, reason) {
        if (session.status === 'closed') return;

        session.status = 'closed';
        push(session, { type: 'closed', reason: reason || undefined });
        armTimer(session, 'closeTimer');
    }

    function failConnect(session, message) {
        push(session, { type: 'error', error: message });
        recordClose(session, message);
    }

    /* ------------------------------------------------------------ 订阅 / 发布 */

    function subscribeTo(session, topic, qos) {
        var client = session.client;
        if (!client || session.status !== 'open') {
            throw httpError(409, i18n.m('MQTT 连接还没有打开，或者已经关闭'));
        }

        client.subscribe(topic, { qos: qos }, function (err, granted, packet) {
            if (!sessions.has(session.id)) return;

            /**
             * 第二个参数是**订阅项数组** `[{ topic, qos }]`（成功时 MQTT.js 会把 SUBACK 的授权码
             * 写回 `qos` 这一格），第三个参数才是 SUBACK 报文。**被拒时（granted >= 128）走的是
             * `err` 那条路，而且 `err.code` 是 undefined** —— 它包了一层 `ErrorWithSubackPacket`，
             * 原因码只在 `packet.granted` 里。所以原因码统一从报文里取，取不到才退回 `err.code`。
             */
            var codes = packet && Array.isArray(packet.granted) ? packet.granted : null;
            var code = null;
            if (codes && codes.length) code = Number(codes[0]);
            else if (Array.isArray(granted) && granted.length && granted[0] && granted[0].qos !== undefined) {
                code = Number(granted[0].qos);
            } else if (err && err.code !== undefined) {
                code = Number(err.code);
            }
            if (!Number.isFinite(code)) code = null;

            if (err) {
                push(session, {
                    type: 'subscribed',
                    topic: topic,
                    qos: qos,
                    granted: code,
                    error: subscribeMessage(code, session.locale)
                });
                return;
            }

            var row = { type: 'subscribed', topic: topic, qos: qos, granted: code };
            if (code !== null && code >= 128) row.error = subscribeMessage(code, session.locale);
            push(session, row);
        });
    }

    /** 连上（含重连）之后把启用着的订阅都订一遍 */
    function autoSubscribe(session) {
        (session.subscriptions || []).forEach(function (row) {
            if (!row || row.enabled === false) return;
            if (!str(row.topic).trim()) return;

            try {
                subscribeTo(session, str(row.topic), toQos(row.qos, 0));
            } catch (err) {
                push(session, { type: 'error', error: (err && err.message) || i18n.mIn(session.locale, '订阅失败') });
            }
        });
    }

    function publishTo(session, input) {
        var client = session.client;
        if (!client || session.status !== 'open') {
            throw httpError(409, i18n.m('MQTT 连接还没有打开，或者已经关闭'));
        }

        var topic = str(input.topic).trim();
        if (!topic) throw httpError(400, i18n.m('缺少发布的主题'));
        if (topic.indexOf('+') > -1 || topic.indexOf('#') > -1) {
            throw httpError(400, i18n.m('发布的主题不能带通配符'));
        }

        var qos = toQos(input.qos, 0);
        var retain = input.retain === true;
        var text = str(input.payload);

        client.publish(topic, text, { qos: qos, retain: retain }, function (err) {
            if (!sessions.has(session.id)) return;

            if (err) {
                push(session, { type: 'error', error: publishMessage(err, session.locale) });
                return;
            }

            // QoS 1/2 的这一行是 broker 确认（PUBACK / PUBCOMP）之后才发的
            push(session, {
                type: 'published',
                topic: topic,
                payload: text,
                qos: qos,
                retain: retain,
                at: now()
            });
        });
    }

    /* ------------------------------------------------------------ 连接上游 */

    function connectOptions(session) {
        var result = {
            protocolVersion: session.protocolVersion,
            clean: session.clean !== false,
            keepalive: session.keepalive,
            connectTimeout: session.connectTimeoutMs,
            reconnectPeriod: reconnectPeriod,
            // 自动重连保留（界面上有「重连中」），但重订阅自己做 —— 这样每次连上都能再发一轮
            // `subscribed`，界面上的订阅状态不会停在上一轮
            resubscribe: false
        };

        if (session.clientId) result.clientId = session.clientId;
        if (session.username) result.username = session.username;
        if (session.password) result.password = session.password;

        /**
         * 3.1 的协议名是 `MQIsdp`（不是 `MQTT`）。不写它，MQTT.js 会按默认的 `MQTT` 发出去，
         * 一部分 broker 直接按「协议名不认识」拒掉这次连接。
         */
        if (session.protocolVersion === 3) result.protocolId = 'MQIsdp';

        // 遗嘱消息：主题为空表示没有遗嘱（和界面上「不填就是不设」一致）
        if (session.will && str(session.will.topic).trim()) {
            result.will = {
                topic: str(session.will.topic),
                payload: str(session.will.payload),
                qos: toQos(session.will.qos, 0),
                retain: session.will.retain === true
            };
        }

        return result;
    }

    function connect(session) {
        var mqtt = require('mqtt');

        var client;
        try {
            client = mqtt.connect(session.url, connectOptions(session));
        } catch (err) {
            failConnect(session, i18n.mIn(session.locale, '建立 MQTT 连接失败：{reason}', {
                reason: (err && err.message) || i18n.mIn(session.locale, '未知错误')
            }));
            return;
        }

        session.client = client;
        session.detachClient = function (target) {
            try { target.removeAllListeners(); } catch (err) { /* 已经关了 */ }
        };

        client.on('connect', function (connack) {
            if (!sessions.has(session.id)) return;

            session.status = 'open';
            // 重连成功：60 秒的倒计时不能再往下走了
            clearTimer(session, 'closeTimer');

            push(session, {
                type: 'connected',
                sessionPresent: Boolean(connack && connack.sessionPresent)
            });

            autoSubscribe(session);
        });

        client.on('message', function (topic, payload, packet) {
            if (!sessions.has(session.id)) return;

            var fields = payloadFields(payload);
            var event = {
                type: 'message',
                topic: str(topic),
                qos: toQos(packet && packet.qos, 0),
                retain: Boolean(packet && packet.retain),
                properties: (packet && packet.properties) || null,
                at: now()
            };
            Object.keys(fields).forEach(function (key) { event[key] = fields[key]; });

            push(session, event);
        });

        client.on('reconnect', function () {
            if (!sessions.has(session.id)) return;

            session.status = 'reconnecting';
            push(session, { type: 'reconnecting' });
        });

        client.on('close', function () {
            if (!sessions.has(session.id)) return;

            recordClose(session, session.status === 'reconnecting'
        ? i18n.mIn(session.locale, '连接已断开，正在重连')
        : i18n.mIn(session.locale, '连接已断开'));
        });

        client.on('error', function (err) {
            if (!sessions.has(session.id)) return;

            var message = describeConnectError(err, session.locale);
            push(session, { type: 'error', error: message });

            if (session.status === 'connecting') recordClose(session, message);
        });

        /**
         * MQTT 5 才有：broker 主动发 DISCONNECT。最常见的就是同一个 clientId 在别处登录
         * （原因码 142），或者 broker 要关机。3.1.1 没有这个报文，那种情况只会看到 `close`。
         */
        client.on('disconnect', function (packet) {
            if (!sessions.has(session.id)) return;

            var code = packet && packet.reasonCode;
            var message = reasonMessage(code, session.locale) || i18n.mIn(session.locale, 'broker 主动断开了连接');
            push(session, { type: 'error', error: message });
            recordClose(session, message);
        });
    }

    /* ------------------------------------------------------------ 对外接口 */

    /**
     * @param {{userId: string, projectId: string, url: string, clientId?: string,
     *          username?: string, password?: string, protocolVersion?: number, clean?: boolean,
     *          keepalive?: number, connectTimeoutMs?: number, will?: object,
     *          subscriptions?: Array<{topic: string, qos: number, enabled: boolean}>,
     *          note?: string|null, locale?: string}} input
     *   `locale` 是**建会话时**界面的语言：事件由 socket / timer 回调产生，
     *   那时候 `AsyncLocalStorage` 里已经没有这个请求的语言了，所以记在会话上
     */
    function create(input) {
        var options = input || {};
        if (!options.url) throw httpError(400, i18n.m('缺少 broker 地址'));

        var mine = 0;
        sessions.forEach(function (session) {
            if (session.userId === options.userId) mine += 1;
        });
        if (mine >= maxSessions) {
            throw httpError(400, i18n.m('同时最多保持 {n} 个 MQTT 会话', { n: maxSessions }));
        }

        var session = {
            id: 'mq_' + crypto.randomBytes(12).toString('hex'),
            userId: options.userId,
            projectId: options.projectId,
            apiId: options.apiId || null,
            environmentId: options.environmentId || null,
            url: options.url,
            clientId: str(options.clientId),
            username: str(options.username),
            password: str(options.password),
            protocolVersion: toProtocolVersion(options.protocolVersion),
            clean: options.clean !== false,
            keepalive: Number.isFinite(Number(options.keepalive)) ? Number(options.keepalive) : 60,
            connectTimeoutMs: positive(Number(options.connectTimeoutMs), CONNECT_TIMEOUT_MS),
            will: options.will || null,
            subscriptions: Array.isArray(options.subscriptions) ? options.subscriptions : [],
            note: options.note || null,
            // 事件文案按建会话时的语言（见上方 create 的说明）
            locale: options.locale || null,
            status: 'connecting',
            seq: 0,
            events: [],
            listeners: new Set(),
            client: null,
            detachClient: null,
            closeTimer: null,
            idleTimer: null,
            createdAt: now()
        };

        sessions.set(session.id, session);
        armTimer(session, 'idleTimer');

        // 「连接中」是第一行：页面晚连上来时靠缓冲把这行走出来
        push(session, {
            type: 'connecting',
            url: session.url,
            clientId: session.clientId,
            note: session.note || undefined
        });

        connect(session);

        return session;
    }

    function get(id, userId) {
        var session = sessions.get(id);
        if (!session) return null;
        if (!userId || session.userId !== userId) return null;
        return session;
    }

    function subscribe(id, topic, qos) {
        var session = sessions.get(id);
        if (!session) throw httpError(404, i18n.m('MQTT 会话不存在'));

        var text = str(topic).trim();
        if (!text) throw httpError(400, i18n.m('缺少主题'));

        subscribeTo(session, text, toQos(qos, 0));
    }

    function unsubscribe(id, topic) {
        var session = sessions.get(id);
        if (!session) throw httpError(404, i18n.m('MQTT 会话不存在'));

        var client = session.client;
        if (!client || session.status !== 'open') {
            throw httpError(409, i18n.m('MQTT 连接还没有打开，或者已经关闭'));
        }

        var text = str(topic).trim();
        if (!text) throw httpError(400, i18n.m('缺少主题'));

        client.unsubscribe(text, function (err) {
            if (!sessions.has(session.id)) return;

            if (err) {
                push(session, { type: 'error', error: describeConnectError(err, session.locale) });
                return;
            }
            push(session, { type: 'unsubscribed', topic: text });
        });
    }

    function publish(id, input) {
        var session = sessions.get(id);
        if (!session) throw httpError(404, i18n.m('MQTT 会话不存在'));

        publishTo(session, input || {});
    }

    function subscribeEvents(id, after, listener) {
        var session = sessions.get(id);
        if (!session || typeof listener !== 'function') return function () {};

        var from = Number(after);
        if (!Number.isFinite(from)) from = 0;

        session.events.forEach(function (event) {
            if (event.seq > from) deliver(listener, event);
        });

        session.listeners.add(listener);
        clearTimer(session, 'idleTimer');

        return function unsubscribeEvents() {
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
        subscribe: subscribe,
        unsubscribe: unsubscribe,
        publish: publish,
        subscribeEvents: subscribeEvents,
        destroy: destroy,
        closeAll: closeAll
    };

    liveRegistries.add(registry);
    hookExit();

    return registry;
}

module.exports = {
    createRegistry: createRegistry,
    toProtocolVersion: toProtocolVersion,
    toQos: toQos,
    PROTOCOL_VERSIONS: PROTOCOL_VERSIONS,
    DEFAULT_PROTOCOL_VERSION: DEFAULT_PROTOCOL_VERSION,
    MAX_EVENTS: MAX_EVENTS,
    MAX_MESSAGE_BYTES: MAX_MESSAGE_BYTES,
    MAX_SESSIONS_PER_USER: MAX_SESSIONS_PER_USER,
    DEFAULT_TTL_MS: DEFAULT_TTL_MS,
    CONNECT_TIMEOUT_MS: CONNECT_TIMEOUT_MS,
    RECONNECT_PERIOD_MS: RECONNECT_PERIOD_MS
};
