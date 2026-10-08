/**
 * TCP / UDP 调试会话的注册表（第十五轮）。
 *
 * 和 `lib/mqtt-sessions.js` 是**同一套会话模型**（事件缓冲、seq、subscribeEvents、
 * 两个 60 秒倒计时、每人会话数上限），差别只在「用什么连上去、字节怎么切成一条消息」：
 * 那边是 MQTT.js 的 broker 会话，这里是 Node 自带的 `net` / `tls` / `dgram` 裸套接字。
 *
 * 四个和 MQTT 不一样、容易想歪的地方：
 *
 * 1. **裸 TCP 没有「消息」的概念**，收到的是字节流。所以「一条消息」要靠 `framing` 分出来：
 *    `none`（收到一块算一条）、`delimiter`（按分隔符切）、`length`（长度前缀）。
 *    UDP 相反 —— 一个数据报就是一条，`framing` 对它完全不生效。
 * 2. **发送也要过一遍分帧**：开了 `length` 分帧时，发出去的每一段前面要自动加上长度前缀，
 *    否则对端按「长度前缀」解析时会把 payload 的头几个字节当成长度。
 * 3. **`sent` 要等真正写出去才发**。`socket.write` 有回调，UDP 的 `send` 也有 —— 
 *    不加这一行的话，界面上的「发出」会比实际早，出错时还看不到。
 * 4. **不做自动重连**。裸套接字断了对端不会告诉你为什么，悄悄连回去只会让用户困惑；
 *    MQTT 那边有 `connected` / `reconnecting` 两档状态，这里只有「连上 / 断开」。
 *
 * 只用了 Node 自带的模块，没有第三方依赖。
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

/** 两种接口方法 */
var METHODS = ['TCP', 'UDP'];

/** 分帧方式 */
var FRAMING_TYPES = ['none', 'delimiter', 'length'];

/** 长度前缀占几个字节、什么字节序 */
var LENGTH_BYTES = [1, 2, 4];
var ENDIANS = ['be', 'le'];

/** 发送内容的编码方式 */
var ENCODINGS = ['text', 'hex', 'base64'];

/** 文本发送时自动补的行尾 */
var LINE_ENDINGS = ['none', 'lf', 'crlf'];

/** 认不出来的分帧配置回到这一份 */
var DEFAULT_FRAMING = { type: 'none', delimiter: '\n', lengthBytes: 2, endian: 'be' };

/** UDP 的默认设置 */
var DEFAULT_UDP = { bindPort: null, broadcast: false };

/** UDP 端口的上界（0 表示随机，不算合法值） */
var MAX_PORT = 65535;

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
 * 方法名：只认 TCP / UDP，别的（大小写不同、认不出来的）回到 TCP。
 *
 * **这里是全项目唯一的一份** —— 保存接口时（`lib/api/dto.js` 的 `toApiSocket`）和真建会话时
 * 都从这里取，两处不能各写一套。
 */
function toMethod(value) {
    var text = str(value).trim().toUpperCase();
    return METHODS.indexOf(text) > -1 ? text : 'TCP';
}

/**
 * 转义写法还原：`\n`、`\r`、`\t`、`\0`、`\\`、`\x00`。
 *
 * 分隔符住在接口配置里（会同步、会进备份文件），必须是**能写成一行文本**的东西 ——
 * 所以库里存的是转义写法（界面上那个输入框里也是），连之前要还原成真正的字节。
 */
function decodeEscapes(text) {
    return str(text).replace(/\\(x[0-9a-fA-F]{2}|n|r|t|0|\\)/g, function (whole, code) {
        if (code === 'n') return '\n';
        if (code === 'r') return '\r';
        if (code === 't') return '\t';
        if (code === '0') return '\0';
        if (code === '\\') return '\\';
        return String.fromCharCode(parseInt(code.slice(1), 16));
    });
}

/** 分隔符做 byte 还原（`\x00` 这类也得变成真正的字节） */
function delimiterBytes(text) {
    return Buffer.from(decodeEscapes(text), 'utf8');
}

/** 分帧配置：只认三档 + 长度前缀 1/2/4 + be/le，别的回到默认 */
function toFraming(value) {
    var source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    var type = FRAMING_TYPES.indexOf(str(source.type)) > -1 ? str(source.type) : DEFAULT_FRAMING.type;

    var lengthBytes = Number(source.lengthBytes);
    if (LENGTH_BYTES.indexOf(lengthBytes) === -1) lengthBytes = DEFAULT_FRAMING.lengthBytes;

    var endian = ENDIANS.indexOf(str(source.endian)) > -1 ? str(source.endian) : DEFAULT_FRAMING.endian;

    // 分隔符允许为空（空分隔符切不出东西来，退化成 none）——但不允许把用户写的值丢掉
    var delimiter = source.delimiter === undefined || source.delimiter === null
        ? DEFAULT_FRAMING.delimiter
        : str(source.delimiter);
    if (type === 'delimiter' && delimiterBytes(delimiter).length === 0) {
        delimiter = DEFAULT_FRAMING.delimiter;
    }

    return { type: type, delimiter: delimiter, lengthBytes: lengthBytes, endian: endian };
}

/** 发送编码 / 行尾：认不出来的回到默认 */
function toSendEncoding(value) {
    var text = str(value);
    return ENCODINGS.indexOf(text) > -1 ? text : 'text';
}

function toLineEnding(value) {
    var text = str(value);
    return LINE_ENDINGS.indexOf(text) > -1 ? text : 'none';
}

/** UDP 那两格：`bindPort` 不填就是随机（null），`broadcast` 默认关 */
function toUdp(value) {
    var source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    var port = Number(source.bindPort);

    return {
        bindPort: Number.isFinite(port) && port > 0 && port <= MAX_PORT ? Math.round(port) : null,
        broadcast: source.broadcast === true
    };
}

/**
 * `tcp://host:9000` / `tls://host:9000` / `udp://host:9000` → `{ host, port, tls }`。
 *
 * **方法说了算**：方法选了 UDP 却写了 `tcp://` 时，只拿它的 host:port（`tls` 也就没意义了）。
 * 端口不给就直接报错 —— 少了端口的地址没法用，硬套一个默认端口只会连到莫名其妙的地方。
 */
function parseEndpoint(url, method) {
    var text = str(url).trim();
    if (!text) throw httpError(400, i18n.m('缺少地址'));

    var parsed;
    try {
        parsed = new URL(text);
    } catch (err) {
        throw httpError(400, i18n.m('地址不是合法的地址，要写成 tcp://主机:端口'));
    }

    if (!parsed.hostname) throw httpError(400, i18n.m('地址里没有主机名，要写成 tcp://主机:端口'));

    var port = Number(parsed.port);
    if (!Number.isFinite(port) || port <= 0 || port > MAX_PORT) {
        throw httpError(400, i18n.m('地址里要写端口，例如 tcp://127.0.0.1:9000'));
    }

    return {
        host: parsed.hostname,
        port: port,
        // TLS 只对 TCP 有意义；方法选了 UDP 时忽略协议头里的 tls
        tls: toMethod(method) === 'TCP' && parsed.protocol === 'tls:'
    };
}

/* ------------------------------------------------------------ 错误文案 */

/** `err.code` 是 Node 的字符串错误码；认不出来的把它自己的话带上，别吞掉 */
function describeError(err, extra, locale) {
    var code = err && err.code ? String(err.code) : '';
    var context = extra || {};

    switch (code) {
        case 'ECONNREFUSED': return i18n.mIn(locale, '连不上，检查地址和端口');
        case 'ETIMEDOUT': return i18n.mIn(locale, '连接超时');
        case 'ENOTFOUND': case 'EAI_AGAIN': return i18n.mIn(locale, '域名解析不了');
        case 'ECONNRESET': return i18n.mIn(locale, '对方重置了连接');
        case 'EHOSTUNREACH': case 'ENETUNREACH': return i18n.mIn(locale, '网络不通，检查地址');
        case 'EPIPE': return i18n.mIn(locale, '连接已经被对方关闭');
        case 'EADDRINUSE':
            return i18n.mIn(locale, '本机端口 {port} 被占用', { port: context.bindPort ? context.bindPort : '' });
        case 'EACCES': return i18n.mIn(locale, '没有权限绑定这个端口（1024 以下要管理员）');
        default: break;
    }

    var raw = str(err && err.message ? err.message : err);
    // TLS 的证书错不一定带 code：Node 的码（DEPTH_ZERO_SELF_SIGNED_CERT 之类）和
    // OpenSSL 的人话（unable to verify the first certificate）两种写法都要认
    if (/CERT_|UNABLE_TO_VERIFY|unable to verify|unable to get local issuer|self.signed|self-signed|altnames|expired|hostname\/IP does not match/i.test(raw)) {
        return i18n.mIn(locale, '证书不受信任，可以勾选「忽略证书错误」');
    }
    if (/handshake|ECONNRESET|socket hang up/i.test(code || raw)) {
        return i18n.mIn(locale, 'TLS 握手失败，检查对方是不是 TLS 服务');
    }

    return raw || i18n.mIn(locale, '连接出错');
}

/* ------------------------------------------------------------ 分帧 */

/**
 * 把一个字节流按分帧规则切成一条条消息。
 *
 * 状态住在会话上（`session.buffer`），因为一块 TCP 数据里可能装着两条半消息。
 *
 * @returns {Array<Buffer>} 这次能切出来的完整消息（可能一条都没有）
 */
function takeFrames(session, chunk) {
    var framing = session.framing || DEFAULT_FRAMING;

    if (framing.type === 'none') {
        // 收到一块就是一条：连残留缓冲一起给出去（上一次不会留，写着保险）
        var whole = session.buffer && session.buffer.length
            ? Buffer.concat([session.buffer, chunk])
            : chunk;
        session.buffer = Buffer.alloc(0);
        return whole.length ? [whole] : [];
    }

    session.buffer = session.buffer && session.buffer.length
        ? Buffer.concat([session.buffer, chunk])
        : Buffer.from(chunk);

    var out = [];

    if (framing.type === 'delimiter') {
        var delim = session.delimiterBytes;
        if (!delim.length) {
            // 分隔符是空的（理论上 toFraming 已经挡过）：退化成「一块一条」
            var rest = session.buffer;
            session.buffer = Buffer.alloc(0);
            return rest.length ? [rest] : [];
        }

        for (;;) {
            var at = session.buffer.indexOf(delim);
            if (at === -1) break;

            var piece = session.buffer.subarray(0, at);
            session.buffer = session.buffer.subarray(at + delim.length);
            // 分隔符本身不算内容（界面上一条一行，分隔符是它自己的事）
            if (piece.length) out.push(Buffer.from(piece));
        }
        return out;
    }

    /* length：前缀 + 内容。长度值**不含**前缀本身 */
    var size = framing.lengthBytes;
    for (;;) {
        if (session.buffer.length < size) break;

        var declared = readLength(session.buffer.subarray(0, size), framing.endian, size);
        if (declared === null) {
            // 前缀本身不合理（比如 4 字节读出来是个天文数字）：丢一个字节继续找，别把会话卡死
            session.buffer = session.buffer.subarray(1);
            continue;
        }

        var total = size + declared;
        if (session.buffer.length < total) break;

        out.push(Buffer.from(session.buffer.subarray(size, total)));
        session.buffer = session.buffer.subarray(total);
    }
    return out;
}

/** 读长度前缀。读出来明显不合理（超过 64 MB）时返回 null，让调用方丢字节重找 */
function readLength(prefix, endian, size) {
    var value = endian === 'le' ? prefix.readUIntLE(0, size) : prefix.readUIntBE(0, size);
    if (value > 64 * 1024 * 1024) return null;
    return value;
}

/** 写长度前缀 */
function writeLength(value, endian, size) {
    var buffer = Buffer.alloc(size);
    if (endian === 'le') buffer.writeUIntLE(value, 0, size);
    else buffer.writeUIntBE(value, 0, size);
    return buffer;
}

/**
 * 发送时的分帧：开了 `length` 分帧就把长度前缀补上。
 *
 * 不补的话，对端按「先读长度再读内容」解析时会把 payload 的头几个字节当成长度，
 * 收到的东西全是错的 —— 而且这种错很难从现象上看出来。
 */
function frameForSend(session, payload) {
    var framing = session.framing || DEFAULT_FRAMING;
    if (session.method !== 'TCP' || framing.type !== 'length') return payload;

    // 前缀装不下就直接报错：静默截断会发出去一段长度对不上的东西，比报错难查得多
    var max = framing.lengthBytes === 1 ? 0xff : (framing.lengthBytes === 2 ? 0xffff : 0xffffffff);
    if (payload.length > max) {
        throw httpError(400, i18n.m('这一段太长，{n} 字节的长度前缀装不下', { n: framing.lengthBytes }));
    }

    return Buffer.concat([writeLength(payload.length, framing.endian, framing.lengthBytes), payload]);
}

/* ------------------------------------------------------------ 内容编码 */

/**
 * 一段字节 → 事件里的字段（`data` 和 `sent` 共用一个形状）。
 *
 * 和 MQTT 那边不一样：**`base64` 总是给**（界面上一律能看原始字节），`text` 只有
 * 「能原样转回 UTF-8」时才有值，否则是 null（不会出现半个汉字被解成乱码的情况）。
 */
function contentFields(raw, maxBytes) {
    var buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw === undefined || raw === null ? '' : String(raw), 'utf8');
    var limit = positive(maxBytes, MAX_MESSAGE_BYTES);
    var truncated = buffer.length > limit;
    var cut = truncated ? buffer.subarray(0, limit) : buffer;

    var whole = buffer.toString('utf8');
    var isText = Buffer.from(whole, 'utf8').equals(buffer);

    var text = null;
    if (isText) {
        if (!truncated) text = whole;
        else {
            // 截断处落在汉字中间时丢掉那半个字符，而不是塞一个 U+FFFD 进去
            var StringDecoder = require('string_decoder').StringDecoder;
            text = new StringDecoder('utf8').write(cut);
        }
    }

    var fields = { size: buffer.length, text: text, base64: cut.toString('base64') };
    if (truncated) fields.truncated = true;
    return fields;
}

/**
 * 发送内容 → 字节。
 *
 * `hex` 允许空格、换行和 `0x` 前缀（用户从抓包工具里复制出来的常常是那种样子）；
 * 奇数位或者有非法字符都报 400，并且说清是哪个字符不对。
 */
function decodePayload(payload, encoding) {
    var text = str(payload);

    if (encoding === 'base64') {
        var cleaned = text.replace(/\s+/g, '');
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned) || cleaned.length % 4 !== 0) {
            throw httpError(400, i18n.m('Base64 格式不对：只能有 A-Z a-z 0-9 + / =，长度要是 4 的倍数'));
        }
        return Buffer.from(cleaned, 'base64');
    }

    if (encoding === 'hex') {
        return parseHex(text);
    }

    return Buffer.from(text, 'utf8');
}

/** 十六进制文本 → 字节 */
function parseHex(text) {
    var cleaned = text
        .replace(/0[xX]/g, '')      // 允许 0x 前缀
        .replace(/[\s,;:]+/g, '')   // 允许空格、换行、逗号、冒号、分号
        .replace(/[^0-9a-fA-F]/g, function (bad) {
            throw httpError(400, i18n.m('十六进制格式不对：出现了「{bad}」', { bad: bad }));
        });

    if (cleaned.length % 2 !== 0) {
        throw httpError(400, i18n.m('十六进制格式不对：位数是奇数（{n} 位）', { n: cleaned.length }));
    }

    return Buffer.from(cleaned, 'hex');
}

/** 文本发送时按 `lineEnding` 补行尾 */
function withLineEnding(text, lineEnding) {
    if (lineEnding === 'lf') return text + '\n';
    if (lineEnding === 'crlf') return text + '\r\n';
    return text;
}

/** 看起来像广播地址吗（用来提示「要发广播请勾选允许广播」） */
function isBroadcastHost(host) {
    var text = str(host).trim();
    if (text === '255.255.255.255') return true;
    return /\.255$/.test(text);
}

/* ------------------------------------------------------------ 注册表 */

function createRegistry(options) {
    var opts = options || {};
    var now = typeof opts.now === 'function' ? opts.now : function () { return Date.now(); };
    var ttlMs = positive(opts.ttlMs, DEFAULT_TTL_MS);
    var maxSessions = positive(opts.maxSessions, MAX_SESSIONS_PER_USER);
    var maxBuffer = positive(opts.maxBuffer, MAX_EVENTS);
    var maxMessageBytes = positive(opts.maxMessageBytes, MAX_MESSAGE_BYTES);
    var connectTimeoutDefault = positive(opts.connectTimeoutMs, CONNECT_TIMEOUT_MS);

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

    function detach(session) {
        var socket = session.socket;
        session.socket = null;
        if (!socket) return null;

        try { socket.removeAllListeners(); } catch (err) { /* 已经关了 */ }
        return socket;
    }

    /** 拆掉会话（内部用）：不再往事件流里写东西，只把订阅者叫醒 */
    function destroySession(session) {
        if (!sessions.has(session.id)) return;

        sessions.delete(session.id);
        clearTimer(session, 'closeTimer');
        clearTimer(session, 'idleTimer');
        clearTimer(session, 'connectTimer');
        session.status = 'closed';

        var socket = detach(session);
        if (socket) {
            try {
                if (session.method === 'UDP') socket.close();
                else socket.destroy();
            } catch (err) {
                // 已经关了
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

    /* ------------------------------------------------------------ 收数据 */

    function emitData(session, chunk, from) {
        var fields = contentFields(chunk, maxMessageBytes);
        var event = { type: 'data', at: now() };
        Object.keys(fields).forEach(function (key) { event[key] = fields[key]; });
        if (from) event.from = { address: str(from.address), port: Number(from.port) || 0 };

        push(session, event);
    }

    function onTcpChunk(session, chunk) {
        if (!sessions.has(session.id)) return;

        var frames;
        try {
            frames = takeFrames(session, chunk);
        } catch (err) {
            push(session, {
                type: 'error',
                error: i18n.mIn(session.locale, '分帧出错：{reason}', { reason: (err && err.message) || err })
            });
            return;
        }

        frames.forEach(function (frame) { emitData(session, frame, null); });
    }

    /* ------------------------------------------------------------ 连接 */

    function connectOptions(session) {
        return {
            host: session.host,
            port: session.port,
            // 我们自己数超时：连接超时那句中文提示要在自己的计时器里给
            timeout: 0
        };
    }

    function failConnect(session, message) {
        push(session, { type: 'error', error: message });
        recordClose(session, 'error');
    }

    function armConnectTimer(session) {
        var ms = session.connectTimeoutMs || connectTimeoutDefault;

        clearTimer(session, 'connectTimer');
        session.connectTimer = setTimeout(function () {
            session.connectTimer = null;
            if (!sessions.has(session.id) || session.status !== 'connecting') return;

            failConnect(session, i18n.mIn(session.locale, '连接超时'));
            var socket = detach(session);
            if (socket) { try { socket.destroy(); } catch (err) { /* 已经关了 */ } }
        }, ms);

        if (session.connectTimer.unref) session.connectTimer.unref();
    }

    function pushConnected(session, local, remote) {
        clearTimer(session, 'connectTimer');
        session.status = 'open';

        var event = { type: 'connected' };
        if (local) event.local = { address: str(local.address), port: Number(local.port) || 0 };
        if (remote) event.remote = { address: str(remote.address), port: Number(remote.port) || 0 };

        push(session, event);
    }

    /** TCP（明文或 TLS） */
    function connectTcp(session) {
        var socket;
        try {
            if (session.tls) {
                var tls = require('tls');
                socket = tls.connect(Object.assign(connectOptions(session), {
                    servername: require('net').isIP(session.host) ? undefined : session.host,
                    rejectUnauthorized: session.tlsInsecure !== true
                }));
            } else {
                socket = require('net').connect(connectOptions(session));
            }
        } catch (err) {
            failConnect(session, describeError(err, null, session.locale));
            return;
        }

        session.socket = socket;
        session.buffer = Buffer.alloc(0);
        session.delimiterBytes = delimiterBytes((session.framing || DEFAULT_FRAMING).delimiter);
        armConnectTimer(session);

        /** TLS 是 `secureConnect`，明文是 `connect` */
        socket.on(session.tls ? 'secureConnect' : 'connect', function () {
            if (!sessions.has(session.id)) return;
            pushConnected(session, { address: socket.localAddress, port: socket.localPort },
                { address: socket.remoteAddress, port: socket.remotePort });
        });

        socket.on('data', function (chunk) { onTcpChunk(session, chunk); });

        socket.on('error', function (err) {
            if (!sessions.has(session.id)) return;

            push(session, { type: 'error', error: describeError(err, null, session.locale) });
            // 还没连上就是「连不上」，连上了才算「连接出错」—— 两种都是 error + closed
            if (session.status !== 'closed') recordClose(session, 'error');
        });

        socket.on('close', function () {
            if (!sessions.has(session.id)) return;
            // 自己 destroy 的（取消 / 超时 / DELETE）不该再记一条「对端关了」
            recordClose(session, 'remote');
        });
    }

    /** UDP */
    function connectUdp(session) {
        var dgram = require('dgram');
        var socket = dgram.createSocket({ type: 'udp4', reuseAddr: false });

        session.socket = socket;
        armConnectTimer(session);

        socket.on('listening', function () {
            if (!sessions.has(session.id)) return;

            try {
                // 允许发广播要在 bind 之后设；关着也设一遍 setBroadcast(false) 没意义，跳过
                if (session.udp.broadcast) socket.setBroadcast(true);
            } catch (err) {
                push(session, { type: 'error', error: describeError(err, null, session.locale) });
            }

            var address = socket.address();
            pushConnected(session, { address: address.address, port: address.port }, null);
        });

        socket.on('message', function (message, remote) {
            if (!sessions.has(session.id)) return;
            emitData(session, message, remote ? { address: remote.address, port: remote.port } : null);
        });

        socket.on('error', function (err) {
            if (!sessions.has(session.id)) return;

            var message = describeError(err, { bindPort: session.udp.bindPort }, session.locale);
            push(session, { type: 'error', error: message });
            if (session.status !== 'closed') recordClose(session, 'error');
        });

        socket.on('close', function () {
            if (!sessions.has(session.id)) return;
            recordClose(session, 'remote');
        });

        try {
            // 绑到本机（端口 0 = 系统随机给一个）：UDP 的「本机绑定」和远端地址无关
            socket.bind(session.udp.bindPort === null ? 0 : session.udp.bindPort);
        } catch (err) {
            push(session, { type: 'error', error: describeError(err, { bindPort: session.udp.bindPort }, session.locale) });
            recordClose(session, 'error');
        }
    }

    function connect(session) {
        if (session.method === 'UDP') connectUdp(session);
        else connectTcp(session);
    }

    /* ------------------------------------------------------------ 对外接口 */

    /**
     * @param {{userId: string, projectId: string, apiId?: string, environmentId?: string,
     *          method?: string, host: string, port: number, tls?: boolean, tlsInsecure?: boolean,
     *          connectTimeoutMs?: number, framing?: object, sendEncoding?: string, udp?: object,
     *          note?: string|null, locale?: string}} input
     *   `locale` 是**建会话时**界面的语言：事件由 socket 回调产生，那时候
     *   `AsyncLocalStorage` 里已经没有这个请求的语言了，所以记在会话上
     */
    function create(input) {
        var options = input || {};
        if (!options.host) throw httpError(400, i18n.m('缺少地址'));
        if (!Number.isFinite(Number(options.port))) throw httpError(400, i18n.m('地址里要写端口'));

        var mine = 0;
        sessions.forEach(function (session) {
            if (session.userId === options.userId) mine += 1;
        });
        if (mine >= maxSessions) {
            throw httpError(400, i18n.m('同时最多保持 {n} 个 TCP / UDP 会话', { n: maxSessions }));
        }

        var session = {
            id: 'sk_' + crypto.randomBytes(12).toString('hex'),
            userId: options.userId,
            projectId: options.projectId,
            apiId: options.apiId || null,
            environmentId: options.environmentId || null,
            method: toMethod(options.method),
            host: options.host,
            port: Number(options.port),
            tls: options.tls === true,
            tlsInsecure: options.tlsInsecure === true,
            connectTimeoutMs: positive(Number(options.connectTimeoutMs), connectTimeoutDefault),
            framing: toFraming(options.framing),
            // 接口上配的默认发送格式：请求体里不带 encoding 时用它
            sendEncoding: toSendEncoding(options.sendEncoding),
            udp: toUdp(options.udp),
            note: options.note || null,
            // 事件文案按建会话时的语言（见上方 create 的说明）
            locale: options.locale || null,
            status: 'connecting',
            seq: 0,
            events: [],
            listeners: new Set(),
            socket: null,
            buffer: Buffer.alloc(0),
            delimiterBytes: Buffer.alloc(0),
            closeTimer: null,
            idleTimer: null,
            connectTimer: null,
            createdAt: now()
        };

        sessions.set(session.id, session);
        armTimer(session, 'idleTimer');

        // 「连接中」是第一行：页面晚连上来时靠缓冲把这行走出来
        push(session, {
            type: 'connecting',
            method: session.method,
            host: session.host,
            port: session.port,
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

    /**
     * 发送一段内容。
     *
     * @param {{payload: string, encoding?: string, lineEnding?: string, to?: {host, port}}} input
     * @returns {{size: number}} 真正写出去的字节数（含自动补的长度前缀和行尾）
     */
    function send(id, input) {
        var session = sessions.get(id);
        if (!session) throw httpError(404, i18n.m('会话不存在'));
        if (session.status !== 'open' || !session.socket) {
            throw httpError(409, i18n.m('连接还没有打开，或者已经关闭'));
        }

        var data = input || {};
        // 请求体里没给编码就用接口上配的默认值（界面上可以一次一次改）
        var encoding = data.encoding === undefined || data.encoding === null || data.encoding === ''
            ? session.sendEncoding
            : toSendEncoding(data.encoding);

        var payload;
        if (encoding === 'text') {
            payload = Buffer.from(withLineEnding(str(data.payload), toLineEnding(data.lineEnding)), 'utf8');
        } else {
            payload = decodePayload(data.payload, encoding);
        }

        if (session.method === 'UDP') return sendUdp(session, payload, data.to);
        return sendTcp(session, payload);
    }

    function sendTcp(session, payload) {
        var out = frameForSend(session, payload);
        var socket = session.socket;

        socket.write(out, function (err) {
            if (!sessions.has(session.id)) return;

            if (err) {
                push(session, { type: 'error', error: describeError(err, null, session.locale) });
                return;
            }

            var fields = contentFields(payload, maxMessageBytes);
            var event = { type: 'sent', at: now() };
            Object.keys(fields).forEach(function (key) { event[key] = fields[key]; });
            event.size = out.length;
            event.to = {
                address: str(socket.remoteAddress || session.host),
                port: Number(socket.remotePort || session.port) || session.port
            };

            push(session, event);
        });

        return { size: out.length };
    }

    function sendUdp(session, payload, to) {
        var target = to && typeof to === 'object' ? to : null;
        var host = target && target.host ? str(target.host) : session.host;
        var port = target && target.port !== undefined && target.port !== null
            ? Number(target.port)
            : session.port;

        if (!Number.isFinite(port) || port <= 0 || port > MAX_PORT) {
            throw httpError(400, i18n.m('目标端口不对'));
        }
        if (isBroadcastHost(host) && !session.udp.broadcast) {
            throw httpError(400, i18n.m('要发广播请勾选「允许广播」'));
        }

        session.socket.send(payload, port, host, function (err) {
            if (!sessions.has(session.id)) return;

            if (err) {
                push(session, { type: 'error', error: describeError(err, null, session.locale) });
                return;
            }

            var fields = contentFields(payload, maxMessageBytes);
            var event = { type: 'sent', at: now() };
            Object.keys(fields).forEach(function (key) { event[key] = fields[key]; });
            event.to = { address: host, port: port };

            push(session, event);
        });

        return { size: payload.length };
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

    /**
     * 主动断开并删掉会话。
     *
     * 先把 `closed`（reason = local）记进缓冲再拆 —— 订阅者还能收到这一行，
     * 界面上就是「自己断开」而不是「事件流无声无息地没了」。
     */
    function destroy(id) {
        var session = sessions.get(id);
        if (!session) return false;

        if (session.status !== 'closed') {
            session.status = 'closed';
            push(session, { type: 'closed', reason: 'local' });
        }
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
    // 配置清洗：dto 和真建会话共用这一份
    toMethod: toMethod,
    toFraming: toFraming,
    toSendEncoding: toSendEncoding,
    toLineEnding: toLineEnding,
    toUdp: toUdp,
    parseEndpoint: parseEndpoint,
    decodeEscapes: decodeEscapes,
    describeError: describeError,
    decodePayload: decodePayload,
    withLineEnding: withLineEnding,
    isBroadcastHost: isBroadcastHost,
    takeFrames: takeFrames,
    frameForSend: frameForSend,
    contentFields: contentFields,
    METHODS: METHODS,
    FRAMING_TYPES: FRAMING_TYPES,
    LENGTH_BYTES: LENGTH_BYTES,
    ENDIANS: ENDIANS,
    ENCODINGS: ENCODINGS,
    LINE_ENDINGS: LINE_ENDINGS,
    DEFAULT_FRAMING: DEFAULT_FRAMING,
    DEFAULT_UDP: DEFAULT_UDP,
    MAX_EVENTS: MAX_EVENTS,
    MAX_MESSAGE_BYTES: MAX_MESSAGE_BYTES,
    MAX_SESSIONS_PER_USER: MAX_SESSIONS_PER_USER,
    DEFAULT_TTL_MS: DEFAULT_TTL_MS,
    CONNECT_TIMEOUT_MS: CONNECT_TIMEOUT_MS
};
