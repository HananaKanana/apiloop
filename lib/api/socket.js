/**
 * TCP / UDP 调试会话接口（第十五轮）。
 *
 * 结构和 `lib/api/mqtt.js` 一一对应（那份是 MQTT 的）：这一层只做
 * **鉴权、解析请求体、按 /send 同一套层级替换变量、把事件写成 NDJSON**，
 * 会话本身在 `lib/socket-sessions.js` 里。
 *
 * **只在本机网关上挂**（`ctx.localSend` 为真）：云端连路由都没有。裸 TCP / UDP 连的大多是
 * 内网设备，只有用户自己那台机器发得出去。
 *
 * 复用点（一个都不要另写一份）：
 * - 变量层级与保密值：`sendApi.createShared(ctx).resolveVariables`，替换用
 *   `lib/variables.js` 的 `resolve`（`{{$guid}}` 这类动态变量也在里面）；
 * - 「云端不发送」这件事的判定与文案：`sendApi.serverSendEnabled` / `serverSendDisabled`；
 * - 配置的清洗（方法、分帧、编码、UDP 那两格）：`dto.toApiSocket` —— 和保存接口时是同一份；
 * - 地址解析与内容编解码：`lib/socket-sessions.js`（`parseEndpoint` / `decodePayload`）；
 * - NDJSON 的响应头：`lib/api/ndjson.js`。
 *
 * **`/socket/:id/*` 刻意不挂 guard**：和 WebSocket / Socket.IO / gRPC / MQTT 一样，
 * 会话只有创建者能访问（admin 也不例外），任何一步不满足都返回**同一个** 404。
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
var socketSessions = require('../socket-sessions');
var i18n = require('../i18n');

/** 按系统设置本来该走代理时的说明（和 WebSocket / Socket.IO / gRPC / MQTT 那条同一个意思） */
var PROXY_NOTE = '系统代理不作用于 TCP / UDP，本次为直连';

/**
 * 代理提示：裸 TCP / UDP 不是 HTTP，系统代理（http_proxy）管不到它。
 * 命中代理设置时说明一句「本次是直连」，免得用户以为是代理没配对。
 */
function proxyNoteFor(handle, host, port, tls) {
    var url = (tls ? 'https://' : 'http://') + host + ':' + port;
    var target = proxySettings.forTarget(proxySettings.get(handle), url);
    if (!target) return null;
    if (executor.shouldBypassProxy(host, port, target.noProxy)) return null;

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

    // 会话模型照 MQTT 那一份（缓冲、seq、60 秒回收）
    var registry = socketSessions.createRegistry(ctx.socketSessionOptions);

    /* ---------------------------------------------------------- 会话定位 */

    function sessionMissing() {
        return respond.apiError(404, i18n.m('TCP / UDP 会话不存在'));
    }

    function locateSession(req) {
        var session = registry.get(req.params.id, req.user && req.user.id);
        if (!session) return null;
        if (!access.roleOf(handle, req.user, session.projectId)) return null;

        return session;
    }

    /**
     * 这条会话的变量表：每次发送都重新算一遍。
     *
     * 建会话时已经把地址里的变量替换好了，这里是给**运行中**的动作用的（发送的 payload）
     * —— 按建会话时选的环境算，用户中途改了环境变量也能用上。
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
     * 建会话之前的全部准备：地址、方法、分帧、发送默认值、变量表。
     *
     * 配置的清洗（方法 / 分帧 / 编码 / UDP）交给 `dto.toApiSocket` —— 它是保存接口时用的
     * 同一份；地址的解析交给 `socket-sessions.parseEndpoint`（协议头和方法对不上时按方法为准）。
     *
     * @returns {object} 可以直接交给 `lib/socket-sessions.js` 的一份参数
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
            // 内置 Mock 环境只对 HTTP / WebSocket 有意义，TCP / UDP 要连真实设备
            throw respond.apiError(400, i18n.m('TCP / UDP 不支持内置的 Mock 环境，请选一个真实环境或不选'));
        } else if (environmentId) {
            environment = environmentsRepo.get(handle, environmentId);
            if (!environment || environment.projectId !== project.id) {
                throw respond.apiError(400, i18n.m('环境不存在或不属于这个项目'));
            }
        }

        var vars = shared.resolveVariables(project, apiId, environment, userId);
        var config = dto.toApiSocket(body) || dto.toApiSocket({});
        var resolve = makeResolver(vars);

        /**
         * 方法从**请求体**取（界面上就是那个 TCP / UDP 切换）。
         *
         * `extra.socket` 里刻意不存方法 —— 方法在 `api.method` 上，存两份迟早有一份是旧的。
         * 请求体没给就用接口自己的方法，再没有当 TCP。
         */
        var method = socketSessions.toMethod(body.method || (api ? api.method : ''));

        /* 地址：变量先替换掉再解析（端口的变量也要能替换） */
        var endpoint = socketSessions.parseEndpoint(resolve(body.url), method);

        return {
            projectId: project.id,
            userId: userId,
            apiId: apiId,
            environmentId: environment ? environment.id : null,
            method: method,
            host: endpoint.host,
            port: endpoint.port,
            tls: endpoint.tls,
            tlsInsecure: config.tlsInsecure,
            connectTimeoutMs: config.connectTimeoutMs,
            framing: config.framing,
            sendEncoding: config.sendEncoding,
            udp: config.udp,
            note: proxyNoteFor(handle, endpoint.host, endpoint.port, endpoint.tls),
            missing: resolve.missing()
        };
    }

    router.post('/projects/:pid/socket', guard('viewer', byPid), respond.wrap(function (req, res) {
        if (!sendApi.serverSendEnabled()) throw sendApi.serverSendDisabled();

        var prepared = prepareSession(req, req.project, req.body || {});

        var session = registry.create(prepared);

        respond.ok(res, { id: session.id, missing: prepared.missing });
    }));

    /* ---------------------------------------------------------- 事件流 */

    router.get('/socket/:id/events', function (req, res) {
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

    /* ---------------------------------------------------------- 发送 */

    /**
     * 发一段内容。
     *
     * - `text` 的 payload **可以带 `{{变量}}`**，按建会话时的环境替换；替换后按请求体里给的
     *   `lineEnding` 补行尾（行尾每次都从请求体读 —— 界面上可以临时改，读会话上存的值会打架）。
     * - `hex` / `base64` 是字节，不做变量替换（那两种写法里出现 `{{}}` 本来就是用户写错了）。
     * - `to` 只对 UDP 有用；TCP 传了也忽略。
     */
    router.post('/socket/:id/send', respond.wrap(function (req, res) {
        var session = locateSession(req);
        if (!session) throw sessionMissing();

        var body = req.body || {};
        var resolve = makeResolver(varsOf(session));

        var encoding = body.encoding === undefined || body.encoding === null || body.encoding === ''
            ? session.sendEncoding
            : socketSessions.toSendEncoding(body.encoding);

        var payload = encoding === 'text' ? resolve(body.payload) : dto.str(body.payload);

        var to = null;
        if (body.to && typeof body.to === 'object' && !Array.isArray(body.to)) {
            to = { host: dto.str(body.to.host), port: Number(body.to.port) };
        }

        var outcome = registry.send(session.id, {
            payload: payload,
            encoding: encoding,
            lineEnding: body.lineEnding,
            to: session.method === 'UDP' ? to : null
        });

        respond.ok(res, { size: outcome.size, missing: resolve.missing() });
    }));

    /* ---------------------------------------------------------- 断开 */

    router.delete('/socket/:id', respond.wrap(function (req, res) {
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
