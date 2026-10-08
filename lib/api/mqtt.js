/**
 * MQTT 调试会话接口（第十三轮）。
 *
 * 结构和 `lib/api/sio.js` 一一对应（那份是 Socket.IO 的）：这一层只做
 * **鉴权、解析请求体、按 /send 同一套层级替换变量、把事件写成 NDJSON**，
 * 会话本身在 `lib/mqtt-sessions.js` 里。
 *
 * **只在本机网关上挂**（`ctx.localSend` 为真）：云端连路由都没有。MQTT 连的常是内网
 * broker，只有用户自己那台机器发得出去。
 *
 * 复用点（一个都不要另写一份）：
 * - 变量层级与保密值：`sendApi.createShared(ctx).resolveVariables`，替换用
 *   `lib/variables.js` 的 `resolve`（`{{$guid}}` 这类动态变量也在里面）；
 * - 「云端不发送」这件事的判定与文案：`sendApi.serverSendEnabled` / `serverSendDisabled`；
 * - 配置的清洗（协议版本、QoS、遗嘱、订阅列表）：`dto.toApiMqtt` —— 和保存接口时是同一份；
 * - NDJSON 的响应头：`lib/api/ndjson.js`。
 *
 * **`/mqtt/:id/*` 刻意不挂 guard**：和 WebSocket / Socket.IO / gRPC 一样，会话只有创建者
 * 能访问（admin 也不例外），任何一步不满足都返回**同一个** 404。
 */

var express = require('express');

var respond = require('./respond');
var dto = require('./dto');
var ndjson = require('./ndjson');
var guardModule = require('./guard');
var sendApi = require('./send');
var mockEnv = require('./mock-env');
var variables = require('../variables');
var access = require('../access');
var executor = require('../executor');
var proxySettings = require('../proxy-settings');
var environmentsRepo = require('../db/repos/environments');
var projectsRepo = require('../db/repos/projects');
var apisRepo = require('../db/repos/apis');
var mqttSessions = require('../mqtt-sessions');
var i18n = require('../i18n');

/** broker 地址的协议头：mqtt / mqtts 是原生，ws / wss 是 WebSocket 承载的 MQTT */
var BROKER_SCHEMES = /^(mqtt|mqtts|ws|wss):\/\//i;

/** 按系统设置本来该走代理时的说明（和 WebSocket / Socket.IO / gRPC 那条同一个意思） */
var PROXY_NOTE = '系统代理不作用于 MQTT，本次为直连';

/**
 * 代理提示：MQTT 走自己的 TCP / WebSocket 连接，系统代理（http_proxy）管不到它，
 * 命中代理设置时说明一句「本次是直连」。
 */
function proxyNoteFor(handle, brokerUrl) {
    var target = proxySettings.forTarget(proxySettings.get(handle), brokerUrl);
    if (!target) return null;

    var parsed;
    try {
        parsed = new URL(brokerUrl);
    } catch (err) {
        return i18n.m(PROXY_NOTE);
    }

    var port = Number(parsed.port) || (parsed.protocol === 'mqtts:' || parsed.protocol === 'wss:' ? 8883 : 1883);
    if (executor.shouldBypassProxy(parsed.hostname, port, target.noProxy)) return null;

    return i18n.m(PROXY_NOTE);
}

function createRouter(ctx) {
    var handle = ctx.handle;
    var router = express.Router();

    // 云端（不是本机网关）：这个 router 什么都不挂
    if (!ctx.localSend) return router;

    var g = guardModule.createGuard(ctx);
    var guard = g.guard;
    var byPid = g.byPid;

    // 变量层级、保密值都要和 /send 是同一套规则
    var shared = sendApi.createShared(ctx);

    // 会话模型照 Socket.IO 那一份（缓冲、seq、60 秒回收）
    var registry = mqttSessions.createRegistry(ctx.mqttSessionOptions);

    /* ---------------------------------------------------------- 会话定位 */

    function sessionMissing() {
        return respond.apiError(404, i18n.m('MQTT 会话不存在'));
    }

    function locateSession(req) {
        var session = registry.get(req.params.id, req.user && req.user.id);
        if (!session) return null;
        if (!access.roleOf(handle, req.user, session.projectId)) return null;

        return session;
    }

    /**
     * 这条会话的变量表：每次发消息 / 订阅都重新算一遍。
     *
     * 建会话时已经把要用的值替换好了，这里是给**运行中**的动作用的（发布 payload、
     * 运行中订阅）—— 按建会话时选的环境算，用户中途改了环境变量也能用上。
     */
    function varsOf(session) {
        var project = projectsRepo.getById(handle, session.projectId);
        if (!project) return {};

        var environment = session.environmentId ? environmentsRepo.get(handle, session.environmentId) : null;
        return shared.resolveVariables(project, session.apiId, environment, session.userId);
    }

    /** 替换一个字符串里的 `{{变量}}`，没替换掉的记进 missing */
    function makeResolver(vars) {
        var missing = [];

        function resolve(value) {
            var got = variables.resolve(dto.str(value), vars);
            missing = missing.concat(got.missing);
            return got.text;
        }

        resolve.missing = function () { return missing; };
        return resolve;
    }

    /* ---------------------------------------------------------- 建会话 */

    /**
     * 建会话之前的全部准备：地址、凭据、遗嘱、订阅列表、变量表。
     *
     * 变量的清洗（协议版本 / QoS / 遗嘱 / 订阅行的形状）交给 `dto.toApiMqtt` ——
     * 它是保存接口时用的同一份，两处不能各写一套。
     *
     * @returns {object} 可以直接交给 `lib/mqtt-sessions.js` 的一份参数
     */
    function prepareSession(req, project, body) {
        var userId = req.user ? req.user.id : null;

        var apiId = body.apiId ? dto.str(body.apiId) : null;
        if (apiId) {
            var api = apisRepo.get(handle, apiId);
            if (!api || api.projectId !== project.id) {
                throw respond.apiError(400, i18n.m('接口不存在或不属于这个项目'));
            }
        }

        /* 环境：和 /send 一样只认本项目的 */
        var environment = null;
        var environmentId = body.environmentId ? dto.str(body.environmentId) : null;
        if (mockEnv.isMockEnvironment(environmentId)) {
            // 内置 Mock 环境只对 HTTP / WebSocket 有意义，MQTT 要连真实 broker
            throw respond.apiError(400, i18n.m('MQTT 不支持内置的 Mock 环境，请选一个真实环境或不选'));
        } else if (environmentId) {
            environment = environmentsRepo.get(handle, environmentId);
            if (!environment || environment.projectId !== project.id) {
                throw respond.apiError(400, i18n.m('环境不存在或不属于这个项目'));
            }
        }

        var vars = shared.resolveVariables(project, apiId, environment, userId);
        var config = dto.toApiMqtt(body) || dto.toApiMqtt({});

        var resolve = makeResolver(vars);

        /* 地址：broker 的协议头是地址的一部分（mqtts:// / wss:// 决定要不要 TLS） */
        var url = resolve(body.url).trim();
        if (!BROKER_SCHEMES.test(url)) {
            throw respond.apiError(400, i18n.m('MQTT 的地址要以 mqtt://、mqtts://、ws:// 或 wss:// 开头'));
        }

        /* 遗嘱：主题为空就是没有遗嘱（和界面上的约定一致） */
        var will = config.will;
        if (will) {
            will = {
                topic: resolve(will.topic),
                payload: resolve(will.payload),
                qos: will.qos,
                retain: will.retain
            };
        }

        /* 订阅列表：主题里的变量在这里就替换掉 —— 自动订阅发生在注册表内部，
         * 那里拿不到变量表。替换后为空的行直接丢掉（变量没值时订不出东西来） */
        var subscriptions = (config.subscriptions || []).map(function (row) {
            return { topic: resolve(row.topic).trim(), qos: row.qos, enabled: row.enabled };
        }).filter(function (row) { return row.topic !== ''; });

        return {
            projectId: project.id,
            userId: userId,
            apiId: apiId,
            environmentId: environment ? environment.id : null,
            url: url,
            clientId: resolve(config.clientId),
            username: resolve(config.username),
            password: resolve(config.password),
            protocolVersion: config.protocolVersion,
            clean: config.clean,
            keepalive: config.keepalive,
            connectTimeoutMs: config.connectTimeoutMs,
            will: will,
            subscriptions: subscriptions,
            note: proxyNoteFor(handle, url),
            missing: resolve.missing()
        };
    }

    router.post('/projects/:pid/mqtt', guard('viewer', byPid), respond.wrap(function (req, res) {
        if (!sendApi.serverSendEnabled()) throw sendApi.serverSendDisabled();

        var prepared = prepareSession(req, req.project, req.body || {});

        // 会话事件的语言按「建会话这一刻」定（事件是请求结束之后由 socket 回调产生的）
        var session = registry.create(Object.assign({ locale: i18n.locale() }, prepared));

        respond.ok(res, { id: session.id, missing: prepared.missing });
    }));

    /* ---------------------------------------------------------- 事件流 */

    router.get('/mqtt/:id/events', function (req, res) {
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

        var unsubscribe = registry.subscribeEvents(session.id, after, function (event) {
            if (!event) {
                if (!res.writableEnded) res.end();
                return;
            }
            ndjson.write(res, event);
        });

        res.on('close', function () { unsubscribe(); });
    });

    /* ---------------------------------------------------------- 订阅 / 取消订阅 */

    router.post('/mqtt/:id/subscribe', respond.wrap(function (req, res) {
        var session = locateSession(req);
        if (!session) throw sessionMissing();

        var body = req.body || {};
        var resolve = makeResolver(varsOf(session));
        var topic = resolve(body.topic).trim();

        registry.subscribe(session.id, topic, body.qos);

        respond.ok(res, { topic: topic, missing: resolve.missing() });
    }));

    router.post('/mqtt/:id/unsubscribe', respond.wrap(function (req, res) {
        var session = locateSession(req);
        if (!session) throw sessionMissing();

        var body = req.body || {};
        var resolve = makeResolver(varsOf(session));
        var topic = resolve(body.topic).trim();

        registry.unsubscribe(session.id, topic);

        respond.ok(res, { topic: topic, missing: resolve.missing() });
    }));

    /* ---------------------------------------------------------- 发布 */

    router.post('/mqtt/:id/publish', respond.wrap(function (req, res) {
        var session = locateSession(req);
        if (!session) throw sessionMissing();

        var body = req.body || {};
        var resolve = makeResolver(varsOf(session));

        registry.publish(session.id, {
            topic: resolve(body.topic).trim(),
            payload: resolve(body.payload),
            qos: body.qos,
            retain: body.retain === true
        });

        respond.ok(res, { missing: resolve.missing() });
    }));

    /* ---------------------------------------------------------- 断开 */

    router.delete('/mqtt/:id', respond.wrap(function (req, res) {
        var session = locateSession(req);
        if (!session) throw sessionMissing();

        registry.destroy(session.id);

        respond.ok(res, {});
    }));

    return router;
}

module.exports = {
    createRouter: createRouter
};
