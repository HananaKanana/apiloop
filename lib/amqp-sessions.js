/**
 * RabbitMQ（AMQP 0-9-1）调试会话的注册表（第十六轮 T40）。
 *
 * 和 `lib/mqtt-sessions.js`、`lib/socket-sessions.js` 是**同一套会话模型**：
 * 事件缓冲 + `seq`、`subscribe` 补发、两个 60 秒倒计时（没有订阅者 / 上游已关闭）、
 * 每人会话数上限、单条消息 64KB 预览。差别只在「用什么连上去」和「能做什么」：
 *
 * - 驱动是 `amqplib`（**用到时才 require**）；
 * - 一个会话 = **一条连接 + 一个（或换过的）channel**。AMQP 的 channel 级错误
 *   （队列不存在 404、参数不匹配 406）会把整个 channel 关掉，但**连接还在** ——
 *   所以出错之后要自动重建 channel，并把之前还在消费的 consumer 重新开起来
 *   （见 `recoverChannel`）。这是这一块最容易做漏的地方。
 * - 收消息是**服务端推**（`channel.consume`），不是订阅主题；发消息走
 *   **confirm channel**，broker 确认之后才发 `published` 事件。
 *
 * 两个刻意的地方：
 * - **只在 consume 的 manual ack 下才带 `pendingAck`**：界面上要能一眼看出哪几条还没回。
 * - **`ack` / `nack` / `reject` 都从会话上找 deliveryTag 归属的那个 consumer**：
 *   AMQP 的 deliveryTag 是 **channel 级**的，两个 consumer 的 tag 会重叠，
 *   不能只看 tag 数字。
 */

var crypto = require('crypto');

var i18n = require('./i18n');

/** 每个会话最多缓冲多少个事件 */
var MAX_EVENTS = 500;

/** 单条消息最多放进事件里多少字节，超出部分截断（`size` 仍是原始大小） */
var MAX_MESSAGE_BYTES = 64 * 1024;

/** 每个用户同时最多保持多少个会话 */
var MAX_SESSIONS_PER_USER = 10;

/** 没有订阅者、或者连接已经关掉，满这个时间就销毁会话 */
var DEFAULT_TTL_MS = 60 * 1000;

/** 连接超时（毫秒） */
var CONNECT_TIMEOUT_MS = 10000;

/** 默认心跳（秒）；0 表示不要心跳 */
var DEFAULT_HEARTBEAT = 60;

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

/** 非负整数（心跳 0 是合法的「不要心跳」，所以不能用 positive） */
function wholeNumber(value, fallback, min, max) {
    var number = Number(value);
    if (!isFinite(number) || Math.floor(number) !== number) return fallback;
    if (number < min || number > max) return fallback;
    return number;
}

/** 地址里的密码遮掉：界面上要能看到连的是哪台机器，但不能看到凭据 */
function maskUrl(url) {
    var text = str(url);
    return text.replace(/^(\w+:\/\/)([^@/]*):([^@/]*)@/, function (whole, scheme, user) {
        return scheme + user + ':******@';
    });
}

/** 一次最大 64KB 的预览（和 MQTT 那边同一套：按字节切，文本按 UTF-8 边界切） */
function previewText(text, maxBytes) {
    var buffer = Buffer.from(text === undefined || text === null ? '' : String(text), 'utf8');
    if (buffer.length <= maxBytes) return { text: buffer.toString('utf8'), truncated: false };

    var cut = buffer.subarray(0, maxBytes);
    var StringDecoder = require('string_decoder').StringDecoder;
    return { text: new StringDecoder('utf8').write(cut), truncated: true };
}

/** Buffer → 事件里那两格：能原样转回 UTF-8 就给文本，否则只给 base64 */
function payloadFields(body, maxBytes) {
    var buffer = Buffer.isBuffer(body) ? body : Buffer.from(body === undefined || body === null ? '' : String(body), 'utf8');
    var size = buffer.length;

    var sliced = buffer.length > maxBytes ? buffer.subarray(0, maxBytes) : buffer;
    var truncated = buffer.length > maxBytes;

    // 绕一圈看是不是合法 UTF-8：能还原成同样的字节就是文本
    var text = sliced.toString('utf8');
    var roundTrip = Buffer.from(text, 'utf8');
    var isText = truncated ? false : roundTrip.length === sliced.length && roundTrip.equals(sliced);

    if (isText) {
        return { payload: text, payloadBase64: null, size: size, truncated: false };
    }

    return {
        payload: null,
        payloadBase64: sliced.toString('base64'),
        size: size,
        truncated: truncated
    };
}

/**
 * amqplib 的报错 → 中文。
 *
 * RabbitMQ 的错误**大量走 `replyCode`**（404 / 403 / 406），`code` 反而是
 * `ECONNREFUSED` 这种 Node 的。两个都要认。
 */
function describeError(err, locale) {
    var message = err && err.message ? String(err.message) : String(err || '');
    var code = err && err.code ? String(err.code) : '';
    var replyCode = err && err.replyCode !== undefined ? Number(err.replyCode) : null;
    var t = function (text, params) { return i18n.mIn(locale, text, params); };

    if (code === 'ECONNREFUSED') return t('连不上 RabbitMQ，检查地址和端口');
    if (code === 'ETIMEDOUT' || code === 'ECONNRESET') return t('连不上 RabbitMQ，检查地址和端口（连接超时）');
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return t('找不到这个地址，检查主机名');
    if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return t('网络不通，检查地址');

    if (replyCode === 403 || /ACCESS_REFUSED/.test(message)) {
        return t('用户名或密码不对，或者这个账号没有权限');
    }
    if (replyCode === 530 || /NOT_ALLOWED/.test(message)) {
        // 530 = not-allowed（vhost 级别）
        return t('vhost 不存在，或者这个账号没有权限');
    }

    /**
     * **vhost 不存在**是另一条路（T44 在真 broker 上撞到的）：
     * amqplib v2 对 RabbitMQ 4 报的是
     * `Expected ConnectionOpenOk; got <ConnectionClose channel:0>` —— 既没有 `replyCode`，
     * 也不含 `NOT_ALLOWED`（broker 直接把连接关在 ConnectionOpen 那一步，原因没传回来）。
     * 只能认这句话本身。
     */
    if (/ConnectionOpenOk/i.test(message) || /ConnectionClose channel:\s*0/i.test(message)) {
        return t('vhost 不存在，或者这个账号没有权限');
    }
    if (replyCode === 404 || /NOT_FOUND/.test(message)) {
        return t('队列或交换机不存在：{reason}', { reason: message });
    }
    if (replyCode === 406 || /PRECONDITION_FAILED/.test(message)) {
        return t('参数和已存在的队列 / 交换机不一致：{reason}', { reason: message });
    }
    if (replyCode === 320 || /CONNECTION_FORCED/.test(message)) {
        return t('连接被 broker 强制断开（心跳超时或管理端关闭）');
    }

    if (/CERT_|UNABLE_TO_VERIFY|unable to verify|self.signed|self-signed|altnames|expired|hostname\/IP does not match/i.test(message)) {
        return t('证书不受信任，可以勾选「忽略证书错误」');
    }
    if (/handshake|socket hang up/i.test(code || message)) {
        return t('TLS 握手失败，检查对方是不是 TLS 服务');
    }

    return message || t('RabbitMQ 出错');
}

/**
 * 消费配置的清洗：mode / ack 认不出来的回默认，空 queue / exchange 的行丢掉。
 * **两份清洗只有这一处**：`lib/api/dto.js` 的 `toApiAmqp` 保存时也调它。
 */
function toConsumerSpec(raw) {
    var item = raw && typeof raw === 'object' ? raw : {};
    var mode = str(item.mode) === 'exchange' ? 'exchange' : 'queue';
    var queue = str(item.queue).trim();
    var exchange = str(item.exchange).trim();

    if (mode === 'queue' && !queue) return null;
    if (mode === 'exchange' && !exchange) return null;

    return {
        mode: mode,
        queue: queue,
        exchange: exchange,
        routingKey: str(item.routingKey),
        ack: str(item.ack) === 'manual' ? 'manual' : 'auto',
        prefetch: wholeNumber(item.prefetch, 10, 0, 100000),
        enabled: item.enabled !== false
    };
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

        session.status = 'closed';
        session.consumers = [];

        var connection = session.connection;
        session.connection = null;
        session.channel = null;

        if (connection) {
            // 关连接会把上面所有 channel 一起带走；回调里再 push 也没意义了（会话已经从表里删掉）
            try {
                Promise.resolve(connection.close()).catch(function () {});
            } catch (err) {
                // 已经断了
            }
        }

        var listeners = session.listeners;
        session.listeners = new Set();
        listeners.forEach(function (listener) { deliver(listener, null); });
    }

    /* ------------------------------------------------------------ 连上去 */

    /** 开一个 consumer；`resume` 为真时是「channel 重建之后恢复」，不再重复记 consuming 事件 */
    function startConsumer(session, spec, resume) {
        var channel = session.channel;
        if (!channel) return Promise.resolve(null);

        var options = spec.ack === 'manual' ? { noAck: false } : { noAck: true };

        function begin(queueName, extra) {
            if (spec.ack === 'manual' && spec.prefetch > 0) {
                channel.prefetch(spec.prefetch);
            }

            return channel.consume(queueName, function (message) {
                if (!message) {
                    // broker 主动取消（队列被删）：consumerTag 还是我们的那个
                    var index = indexOfConsumer(session, null, message);
                    push(session, {
                        type: 'cancelled',
                        consumerTag: '',
                        byServer: true,
                        reason: i18n.mIn(session.locale, '队列被删掉了')
                    });
                    void index;
                    return;
                }
                return onMessage(session, spec, message);
            }, options).then(function (result) {
                var tag = result && result.consumerTag ? result.consumerTag : '';
                session.consumers.push({ tag: tag, spec: spec, queue: queueName });

                push(session, Object.assign({
                    type: 'consuming',
                    consumerTag: tag,
                    mode: spec.mode,
                    queue: queueName
                }, extra || {}, resume ? { resumed: true } : {}));

                return tag;
            });
        }

        if (spec.mode === 'exchange') {
            /**
             * exchange 模式：建一个**临时队列**（exclusive + auto-delete）绑上去「旁听」。
             * 队列名让 broker 自己起（`''` 就是「你帮我命名」），拿到名字才能告诉用户看哪条。
             */
            return channel.assertQueue('', { exclusive: true, autoDelete: true }).then(function (queue) {
                return channel.bindQueue(queue.queue, spec.exchange, spec.routingKey).then(function () {
                    return begin(queue.queue, { exchange: spec.exchange, routingKey: spec.routingKey });
                });
            });
        }

        return begin(spec.queue, {});
    }

    function indexOfConsumer(session, tag) {
        for (var i = 0; i < session.consumers.length; i++) {
            if (session.consumers[i].tag === tag) return i;
        }
        return -1;
    }

    function onMessage(session, spec, message) {
        var fields = payloadFields(message.content, maxMessageBytes);

        push(session, Object.assign({
            type: 'message',
            consumerTag: message.fields && message.fields.consumerTag ? message.fields.consumerTag : '',
            deliveryTag: message.fields ? message.fields.deliveryTag : null,
            exchange: message.fields ? message.fields.exchange : '',
            routingKey: message.fields ? message.fields.routingKey : '',
            redelivered: message.fields ? message.fields.redelivered === true : false,
            properties: message.properties || {},
            at: now()
        }, fields, spec.ack === 'manual' ? { pendingAck: true } : {}));
    }

    /** channel 级错误之后重建：新 channel + 把还活着的 consumer 重开一遍 */
    function recoverChannel(session) {
        if (!sessions.has(session.id) || !session.connection) return Promise.resolve();

        session.pendingRecover = true;

        // 重建用的也是 confirm channel：换过 channel 之后 publish 仍然要等 broker 确认
        return session.connection.createConfirmChannel().then(function (channel) {
            if (!sessions.has(session.id)) {
                try { channel.close(); } catch (err) { /* 已经关了 */ }
                return;
            }

            session.channel = channel;
            channel.on('error', function (err) {
                onChannelError(session, err);
            });
            channel.on('close', function () {
                if (!sessions.has(session.id) || session.pendingRecover) return;
                push(session, { type: 'closed', reason: i18n.mIn(session.locale, 'channel 已关闭') });
            });

            // 新 channel 要重新挂 return 监听：旧的跟着旧 channel 一起没了
            watchReturns(session);

            var alive = session.consumers.slice();
            session.consumers = [];

            return alive.reduce(function (chain, item) {
                return chain.then(function () {
                    return startConsumer(session, item.spec, true).catch(function (err) {
                        push(session, {
                            type: 'error',
                            error: i18n.mIn(session.locale, '恢复消费「{queue}」失败：{reason}',
                                { queue: item.queue, reason: describeError(err, session.locale) })
                        });
                    });
                });
            }, Promise.resolve());
        }).catch(function (err) {
            push(session, {
                type: 'error',
                error: i18n.mIn(session.locale, '重建 channel 失败：{reason}',
                    { reason: describeError(err, session.locale) })
            });
        }).then(function () {
            session.pendingRecover = false;
        });
    }

    function onChannelError(session, err) {
        if (!sessions.has(session.id)) return;

        push(session, { type: 'error', error: describeError(err, session.locale) });

        // 连接断了就没得恢复；channel 级错误才有「重建」这一说
        if (session.connection && !session.recovering) {
            session.recovering = true;
            recoverChannel(session).then(function () { session.recovering = false; });
        }
    }

    function connect(session) {
        var amqp = require('amqplib');

        push(session, { type: 'connecting', url: maskUrl(session.url) });

        var socketOptions = {
            // 心跳和 connectTimeoutMs 都是 amqplib 的一等参数
            heartbeat: session.heartbeat,
            timeout: session.connectTimeoutMs
        };
        if (session.tlsInsecure) socketOptions.rejectUnauthorized = false;

        return amqp.connect(session.url, socketOptions).then(function (connection) {
            if (!sessions.has(session.id)) {
                try { connection.close(); } catch (err) { /* 已经断了 */ }
                return null;
            }

            session.connection = connection;
            session.status = 'open';

            connection.on('error', function (err) {
                if (!sessions.has(session.id)) return;
                push(session, { type: 'error', error: describeError(err, session.locale) });
            });

            connection.on('close', function () {
                if (!sessions.has(session.id) || session.status === 'closed') return;
                session.status = 'closed';
                session.connection = null;
                push(session, { type: 'closed' });
                armTimer(session, 'closeTimer');
            });

            // confirm channel：publish 之后要等 broker 确认才发 published（nack 时给 409）
            return connection.createConfirmChannel().then(function (channel) {
                session.channel = channel;

                channel.on('error', function (err) { onChannelError(session, err); });
                channel.on('close', function () {
                    if (!sessions.has(session.id) || session.pendingRecover) return;
                    push(session, { type: 'closed', reason: i18n.mIn(session.locale, 'channel 已关闭') });
                });

                // mandatory 发出去、消息路由不到任何队列时，broker 会从这条监听上回一条 return
                watchReturns(session);

                var server = connection.connection && connection.connection.serverProperties;
                push(session, { type: 'connected', server: server || {} });

                var enabled = session.consumers.map(function (item) { return item.spec; })
                    .filter(function (spec) { return spec.enabled; });

                session.consumers = [];

                return enabled.reduce(function (chain, spec) {
                    return chain.then(function () {
                        return startConsumer(session, spec, false).catch(function (err) {
                            push(session, {
                                type: 'error',
                                error: describeError(err, session.locale)
                            });
                        });
                    });
                }, Promise.resolve());
            });
        }).catch(function (err) {
            session.status = 'failed';
            push(session, { type: 'error', error: describeError(err, session.locale) });
            push(session, { type: 'closed' });
            armTimer(session, 'closeTimer');
        });
    }

    /* ------------------------------------------------------------ 对外接口 */

    function create(input) {
        var options_ = input || {};
        if (!options_.url) throw httpError(400, i18n.m('缺少 RabbitMQ 地址'));

        var mine = 0;
        sessions.forEach(function (session) {
            if (session.userId === options_.userId) mine += 1;
        });
        if (mine >= maxSessions) {
            throw httpError(400, i18n.m('同时最多保持 {n} 个 RabbitMQ 会话', { n: maxSessions }));
        }

        var specs = (options_.consumers || []).map(toConsumerSpec).filter(Boolean);

        var session = {
            id: crypto.randomBytes(12).toString('hex'),
            userId: options_.userId,
            projectId: options_.projectId,
            apiId: options_.apiId || null,
            environmentId: options_.environmentId || null,
            // 事件的语言按**建会话那一刻**定（事件是请求结束之后由 amqplib 回调产生的）
            locale: options_.locale || null,
            url: options_.url,
            username: options_.username || '',
            password: options_.password || '',
            heartbeat: wholeNumber(options_.heartbeat, DEFAULT_HEARTBEAT, 0, 3600),
            connectTimeoutMs: positive(options_.connectTimeoutMs, CONNECT_TIMEOUT_MS),
            tlsInsecure: options_.tlsInsecure === true,
            // 发布 / 消费里的 {{变量}} 按**建会话时的环境**替换，所以把变量表带在会话上
            vars: options_.vars || {},
            // 还没开起来的 consumer 配置：`connect` 成功之后逐个 startConsumer
            consumers: specs.map(function (spec) { return { spec: spec, tag: null, queue: spec.queue }; }),
            note: options_.note || null,
            status: 'connecting',
            seq: 0,
            events: [],
            listeners: new Set(),
            connection: null,
            channel: null,
            pendingRecover: false,
            recovering: false,
            closeTimer: null,
            idleTimer: null,
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

    function requireOpen(session) {
        if (!session || !session.channel || session.status !== 'open') {
            throw httpError(409, i18n.m('RabbitMQ 连接还没有打开，或者已经关闭'));
        }
        return session.channel;
    }

    /** 开一个 consumer（界面上「+ 消费」） */
    function consume(id, raw) {
        var session = sessions.get(id);
        if (!session) throw httpError(404, i18n.m('RabbitMQ 会话不存在'));

        var spec = toConsumerSpec(raw);
        if (!spec) throw httpError(400, i18n.m('这个消费者没有填队列或交换机'));

        requireOpen(session);

        return startConsumer(session, spec, false).then(function (tag) {
            return { consumerTag: tag };
        });
    }

    /** 取消一个 consumer */
    function cancel(id, consumerTag) {
        var session = sessions.get(id);
        if (!session) throw httpError(404, i18n.m('RabbitMQ 会话不存在'));

        var tag = str(consumerTag).trim();
        if (!tag) throw httpError(400, i18n.m('缺少 consumerTag'));

        var index = indexOfConsumer(session, tag);
        if (index === -1) throw httpError(404, i18n.m('这个消费者不在了'));

        var channel = requireOpen(session);
        var item = session.consumers[index];

        return Promise.resolve(channel.cancel(tag)).then(function () {
            session.consumers.splice(index, 1);
            push(session, { type: 'cancelled', consumerTag: tag, byServer: false, queue: item.queue });
            return {};
        });
    }

    /** ack / nack / reject */
    function ack(id, payload) {
        var session = sessions.get(id);
        if (!session) throw httpError(404, i18n.m('RabbitMQ 会话不存在'));

        var data = payload || {};
        var channel = requireOpen(session);

        var action = str(data.action) === 'ack'
            ? 'ack'
            : (str(data.action) === 'nack' ? 'nack' : (str(data.action) === 'reject' ? 'reject' : ''));

        if (!action) throw httpError(400, i18n.m('action 只能是 ack / nack / reject'));

        var tag = Number(data.deliveryTag);
        if (!isFinite(tag) || tag <= 0) throw httpError(400, i18n.m('缺少 deliveryTag'));

        var requeue = data.requeue === true;

        try {
            if (action === 'ack') channel.ack({ fields: { deliveryTag: tag } });
            else if (action === 'nack') channel.nack({ fields: { deliveryTag: tag } }, false, requeue);
            else channel.reject({ fields: { deliveryTag: tag } }, requeue);
        } catch (err) {
            throw httpError(409, i18n.m('回确认失败：{reason}', { reason: describeError(err, session.locale) }));
        }

        push(session, {
            type: 'acked',
            deliveryTag: tag,
            action: action,
            requeue: action === 'ack' ? false : requeue
        });

        return {};
    }

    /** 发布：走 confirm channel，broker 确认之后才推 `published` */
    function publish(id, payload) {
        var session = sessions.get(id);
        if (!session) throw httpError(404, i18n.m('RabbitMQ 会话不存在'));

        var channel = requireOpen(session);
        var data = payload || {};

        var exchange = str(data.exchange);
        var routingKey = str(data.routingKey);
        var body = Buffer.isBuffer(data.body) ? data.body : Buffer.from(str(data.body), 'utf8');

        var options = data.options || {};

        /**
         * confirm channel 上 `publish` 的**第 5 个参数是回调**，broker 确认（ack）时回调收到
         * `null`，拒绝（nack）时收到一个 error —— 只有回调到了才算发成功。
         *
         * 不能拿返回值当结果：`channel.publish()` 返回的 `true/false` 只是「缓冲区还有没有地方」，
         * 跟 broker 收没收下没关系。所以这里**必须**走回调，回调之前一个 `published` 都不该发。
         */
        var outcome = new Promise(function (resolve) {
            try {
                channel.publish(exchange, routingKey, body, options, function (err) {
                    if (err) {
                        resolve({ error: err });
                        return;
                    }

                    push(session, {
                        type: 'published',
                        exchange: exchange,
                        routingKey: routingKey,
                        size: body.length,
                        at: now()
                    });
                    resolve({});
                });
            } catch (err) {
                // channel 已经关了这类同步错误
                resolve({ error: err });
            }
        });

        /**
         * 兜一层没人接的拒绝。
         *
         * `respond.wrap` 只兜**同步**抛出的异常，路由那一层写的是
         * `return registry.publish(…).then(…)`（没有 catch）—— 真要是 nack 了，
         * 没人接的 rejection 在 Node 22 上是**直接把进程带走**的。
         * 这里挂一个空 handler 保证「无论如何不会崩」，同时把原来那个 promise 还给调用方，
         * 让它照常能 catch 到 409。
         */
        outcome.catch(function () {});

        var final = outcome.then(function (result) {
            if (result.error) {
                throw httpError(409, i18n.m('broker 拒绝了这条消息：{reason}',
                    { reason: describeError(result.error, session.locale) }));
            }
            return result;
        });

        // 最后返回的那一个也要兜住，不然它才是没人接的那个
        final.catch(function () {});
        return final;
    }

    /** 查一个队列的堆积情况 */
    function queueInfo(id, queueName) {
        var session = sessions.get(id);
        if (!session) throw httpError(404, i18n.m('RabbitMQ 会话不存在'));

        var name = str(queueName).trim();
        if (!name) throw httpError(400, i18n.m('缺少队列名'));

        var channel = requireOpen(session);

        return Promise.resolve(channel.checkQueue(name)).then(function (info) {
            return { messageCount: info.messageCount, consumerCount: info.consumerCount };
        }).catch(function (err) {
            throw httpError(404, i18n.m('查不到这个队列：{reason}', { reason: describeError(err, session.locale) }));
        });
    }

    /** 「returned」回调：publish 时带 mandatory、消息路由不到任何队列 */
    function watchReturns(session) {
        if (!session.channel) return;

        // 每次换 channel 都要重新挂：旧的跟着旧 channel 一起没了（所以不能用一次性标记）
        session.channel.on('return', function (message) {
            if (!sessions.has(session.id)) return;
            push(session, {
                type: 'returned',
                exchange: message.fields ? message.fields.exchange : '',
                routingKey: message.fields ? message.fields.routingKey : '',
                replyText: message.fields ? str(message.fields.replyText) : ''
            });
        });
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
        consume: consume,
        cancel: cancel,
        ack: ack,
        publish: publish,
        queueInfo: queueInfo,
        watchReturns: watchReturns,
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
    toConsumerSpec: toConsumerSpec,
    maskUrl: maskUrl,
    describeError: describeError,
    MAX_EVENTS: MAX_EVENTS,
    MAX_MESSAGE_BYTES: MAX_MESSAGE_BYTES,
    MAX_SESSIONS_PER_USER: MAX_SESSIONS_PER_USER,
    DEFAULT_TTL_MS: DEFAULT_TTL_MS,
    CONNECT_TIMEOUT_MS: CONNECT_TIMEOUT_MS,
    DEFAULT_HEARTBEAT: DEFAULT_HEARTBEAT
};
