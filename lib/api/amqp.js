/**
 * RabbitMQ 调试会话接口（第十六轮 T40）。
 *
 * 结构和 `lib/api/mqtt.js` 一一对应：这一层只做**鉴权、解析请求体、拼出要连的地址与参数、
 * 把事件写成 NDJSON**，会话本身在 `lib/amqp-sessions.js` 里。
 *
 * 复用点（一个都不要另写一份）：
 * - 变量层级与保密值走 `/send` 的 `createShared().resolveVariables`；
 * - 「云端不发送」的判定与文案走 `sendApi.serverSendEnabled` / `serverSendDisabled`；
 * - NDJSON 的响应头走 `lib/api/ndjson.js`。
 *
 * **`/amqp/:id/*` 刻意不挂 guard**：和 MQTT / TCP 一样，会话只有创建者能访问（admin 也不例外），
 * 任何一步不满足都返回**同一个** 404。
 *
 * **只在本机网关上挂**：云端连路由都没有（`ctx.localSend` 为假时直接返回空 router）。
 */

var express = require('express');

var respond = require('./respond');
var dto = require('./dto');
var ndjson = require('./ndjson');
var guardModule = require('./guard');
var sendApi = require('./send');
var variables = require('../variables');
var access = require('../access');
var environmentsRepo = require('../db/repos/environments');
var apisRepo = require('../db/repos/apis');
var amqpSessions = require('../amqp-sessions');
var mockEnv = require('./mock-env');
var i18n = require('../i18n');

/** 连接地址的协议头：amqp 明文、amqps 走 TLS */
var SCHEMES = /^(amqp|amqps):\/\//i;

/** 属性里允许透传的那几个标量（其余的是 amqplib 的默认值，不用带） */
var PROPERTY_KEYS = ['contentType', 'contentEncoding', 'correlationId', 'replyTo',
    'expiration', 'messageId', 'type', 'userId', 'appId'];

function createRouter(ctx) {
    var handle = ctx.handle;
    var router = express.Router();

    // 云端（不是本机网关）：这个 router 什么都不挂
    if (!ctx.localSend) return router;

    var g = guardModule.createGuard(ctx);
    var guard = g.guard;
    var byPid = g.byPid;

    var registry = amqpSessions.createRegistry(ctx.amqpSessionOptions);

    // 变量层级、保密值都要和 /send 是同一套规则
    var shared = sendApi.createShared(ctx);

    /* ---------------------------------------------------------- 会话定位 */

    function sessionMissing() {
        return respond.apiError(404, 'RabbitMQ 会话不存在');
    }

    function locateSession(req) {
        var session = registry.get(req.params.id, req.user && req.user.id);
        if (!session) return null;
        if (!access.roleOf(handle, req.user, session.projectId)) return null;

        return session;
    }

    /* ---------------------------------------------------------- 建会话 */

    /**
     * 建会话之前的全部准备：地址、账号密码、心跳、消费配置。
     *
     * @returns {object} 可以直接交给 `lib/amqp-sessions.js` 的一份参数
     */
    function prepareSession(req, project, body) {
        var userId = req.user ? req.user.id : null;

        var api = null;
        var apiId = body.apiId ? dto.str(body.apiId) : null;
        if (apiId) {
            api = apisRepo.get(handle, apiId);
            if (!api || api.projectId !== project.id) {
                throw respond.apiError(400, i18n.m('接口不存在或不属于这个项目'));
            }
        }

        /* 环境：和 /send 一样只认本项目的 */
        var environment = null;
        var environmentId = body.environmentId ? dto.str(body.environmentId) : null;
        if (mockEnv.isMockEnvironment(environmentId)) {
            // 内置 Mock 环境只对 HTTP / WebSocket 有意义，RabbitMQ 要连真实 broker
            throw respond.apiError(400, i18n.m('RabbitMQ 不支持内置的 Mock 环境，请选一个真实环境或不选'));
        } else if (environmentId) {
            environment = environmentsRepo.get(handle, environmentId);
            if (!environment || environment.projectId !== project.id) {
                throw respond.apiError(400, i18n.m('环境不存在或不属于这个项目'));
            }
        }

        var vars = shared.resolveVariables(project, apiId, environment, userId);

        // 地址、账号、密码都能写 {{变量}}
        var urlResolved = resolveField(body.url, vars, []);
        var missing = urlResolved.missing;

        var url = urlResolved.text.trim();
        if (!url) throw respond.apiError(400, i18n.m('缺少 RabbitMQ 地址'));
        if (!SCHEMES.test(url)) {
            throw respond.apiError(400, i18n.m('RabbitMQ 地址要以 amqp:// 或 amqps:// 开头'));
        }

        var username = resolveField(body.username, vars, []);
        missing = missing.concat(username.missing);

        var password = resolveField(body.password, vars, []);
        missing = missing.concat(password.missing);

        return {
            projectId: project.id,
            userId: userId,
            apiId: apiId,
            environmentId: environment ? environment.id : null,
            url: url,
            username: username.text,
            password: password.text,
            heartbeat: body.heartbeat,
            connectTimeoutMs: body.connectTimeoutMs,
            tlsInsecure: body.tlsInsecure === true,
            consumers: Array.isArray(body.consumers) ? body.consumers : [],
            missing: missing,
            // 发布时的 `{{变量}}` 按**建会话时的环境**替换
            vars: vars
        };
    }

    /** 一处字段的变量替换：`{{变量}}` 没配上的名字都要报回去 */
    function resolveField(raw, vars, into) {
        var result = variables.resolve(dto.str(raw), vars || {});
        return { text: result.text, missing: result.missing };
    }

    router.post('/projects/:pid/amqp', guard('viewer', byPid), respond.wrap(function (req, res) {
        if (!sendApi.serverSendEnabled()) throw sendApi.serverSendDisabled();

        var prepared = prepareSession(req, req.project, req.body || {});

        // 事件的语言按「建会话这一刻」定（事件是请求结束之后由 amqplib 回调产生的）
        var session = registry.create(Object.assign({ locale: i18n.locale() }, prepared));

        respond.ok(res, { id: session.id, missing: prepared.missing });
    }));

    /* ---------------------------------------------------------- 事件流 */

    router.get('/amqp/:id/events', function (req, res) {
        var session;
        try {
            session = locateSession(req);
            if (!session) throw sessionMissing();
        } catch (err) {
            var status = Number(err && err.status);
            return respond.fail(res, Number.isFinite(status) ? status : 404, err.message);
        }

        var after = Number((req.query || {}).after);

        ndjson.start(res);

        var unsubscribe = registry.subscribe(session.id, after, function (event) {
            if (!event) {
                if (!res.writableEnded) res.end();
                return;
            }
            ndjson.write(res, event);
        });

        res.on('close', function () { unsubscribe(); });
    });

    /* ---------------------------------------------------------- 消费 / 取消 */

    router.post('/amqp/:id/consume', respond.wrap(function (req, res) {
        var session = locateSession(req);
        if (!session) throw sessionMissing();

        var body = req.body || {};
        var spec = Object.assign({}, body, {
            queue: resolveField(body.queue, session.vars).text,
            exchange: resolveField(body.exchange, session.vars).text,
            routingKey: resolveField(body.routingKey, session.vars).text
        });

        return registry.consume(session.id, spec).then(function (result) {
            respond.ok(res, result);
        });
    }));

    router.post('/amqp/:id/cancel', respond.wrap(function (req, res) {
        var session = locateSession(req);
        if (!session) throw sessionMissing();

        return registry.cancel(session.id, (req.body || {}).consumerTag).then(function (result) {
            respond.ok(res, result);
        });
    }));

    /* ---------------------------------------------------------- 回确认 */

    router.post('/amqp/:id/ack', respond.wrap(function (req, res) {
        var session = locateSession(req);
        if (!session) throw sessionMissing();

        respond.ok(res, registry.ack(session.id, req.body || {}));
    }));

    /* ---------------------------------------------------------- 发布 */

    router.post('/amqp/:id/publish', respond.wrap(function (req, res) {
        var session = locateSession(req);
        if (!session) throw sessionMissing();

        var body = req.body || {};

        var exchange = resolveField(body.exchange, session.vars).text.trim();
        var routingKey = resolveField(body.routingKey, session.vars).text;
        var payload = resolveField(body.payload, session.vars).text;

        var options = toPublishOptions(body, session);

        return registry.publish(session.id, {
            exchange: exchange,
            routingKey: routingKey,
            body: payload,
            options: options
        }).then(function (result) {
            respond.ok(res, result);
        });
    }));

    /* ---------------------------------------------------------- 队列信息 */

    router.post('/amqp/:id/queue-info', respond.wrap(function (req, res) {
        var session = locateSession(req);
        if (!session) throw sessionMissing();

        return registry.queueInfo(session.id, (req.body || {}).queue).then(function (info) {
            respond.ok(res, info);
        });
    }));

    /* ---------------------------------------------------------- 断开 */

    router.delete('/amqp/:id', respond.wrap(function (req, res) {
        var session = locateSession(req);
        if (!session) throw sessionMissing();

        registry.destroy(session.id);

        respond.ok(res, {});
    }));

    /* ---------------------------------------------------------- 发布的可选项 */

    /**
     * 界面上那几格 → amqplib 的 `options`。
     *
     * `headers` 在界面上是 `[{ key, value, enabled }]` 表格（和请求头一个形状），
     * 到了 amqplib 那里要变成普通对象 —— 只收启用的行。
     */
    function toPublishOptions(body, session) {
        var source = dto.plainObject(body.properties) || {};
        var options = {};

        PROPERTY_KEYS.forEach(function (key) {
            var value = dto.str(source[key]);
            if (value) options[key] = value;
        });

        if (source.persistent === true) options.persistent = true;
        if (source.priority !== undefined && source.priority !== null && source.priority !== '') {
            var priority = Number(source.priority);
            if (Number.isFinite(priority)) options.priority = priority;
        }

        var headers = {};
        (Array.isArray(source.headers) ? source.headers : []).forEach(function (row) {
            if (!row || row.enabled === false) return;
            var key = dto.str(row.key).trim();
            if (!key) return;
            headers[key] = resolveField(row.value, session.vars).text;
        });
        if (Object.keys(headers).length) options.headers = headers;

        if (body.mandatory === true) options.mandatory = true;

        return options;
    }

    return router;
}

module.exports = {
    createRouter: createRouter
};
