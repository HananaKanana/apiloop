/**
 * Socket.IO 调试会话接口（第九轮第 4 节）。
 *
 * 结构和 `lib/api/ws.js` 一一对应（那份是 WebSocket 的）：这一层只做
 * **鉴权、解析请求体、拼出要连的地址与参数、把事件写成 NDJSON**，
 * 会话本身在 `lib/sio-sessions.js` 里。
 *
 * 复用点（一个都不要另写一份）：
 * - 鉴权继承与 Cookie 读写走 `/send` 的 `createShared`；
 * - bearer / basic / apikey 的翻译走 `executor.buildAuth`；
 * - NDJSON 的响应头走 `lib/api/ndjson.js`。
 *
 * **`/sio/:id/*` 刻意不挂 guard**：和 WebSocket 一样，会话只有创建者能访问（admin 也不例外），
 * 任何一步不满足都返回**同一个** 404。
 */

var express = require('express');

var respond = require('./respond');
var dto = require('./dto');
var ndjson = require('./ndjson');
var guardModule = require('./guard');
var sendApi = require('./send');
var executor = require('../executor');
var variables = require('../variables');
var access = require('../access');
var commonHeaders = require('../common-headers');
var urlUtils = require('../url-utils');
var proxySettings = require('../proxy-settings');
var environmentsRepo = require('../db/repos/environments');
var sioSessions = require('../sio-sessions');
var mockEnv = require('./mock-env');
var i18n = require('../i18n');

/** Socket.IO 的地址是 http(s)：它的握手本来就是一次 HTTP 请求（长轮询） */
var HTTP_SCHEME = /^https?:\/\//i;

/** 传输方式只有这两档（见 sio-sessions.js 的说明） */
var TRANSPORTS = ['polling', 'websocket'];

/** 按系统设置本来该走代理时的说明（和 WebSocket 那条同一句） */
var PROXY_NOTE = '系统代理不作用于 Socket.IO，本次为直连';

/** 启用且 key 非空的行 */
function enabledRows(rows) {
    if (!Array.isArray(rows)) return [];

    return rows.filter(function (row) {
        if (!row || row.enabled === false) return false;
        return row.key !== null && row.key !== undefined && String(row.key) !== '';
    });
}

/** 监听的事件名单：字符串数组，去掉空项和 Socket.IO 自己那几个 */
function toListenEvents(value) {
    if (!Array.isArray(value)) return [];

    return value.map(function (item) {
        return String(item).trim();
    }).filter(Boolean);
}

/** 代理提示：和 ws.js 同一套判断（命中 noProxy 的目标本来也是直连，不提示） */
function proxyNoteFor(handle, httpUrl) {
    var parsed;
    try {
        parsed = new URL(httpUrl);
    } catch (err) {
        return null;
    }

    var target = proxySettings.forTarget(proxySettings.get(handle), httpUrl);
    if (!target) return null;

    var port = parsed.port || (parsed.protocol === 'https:' ? 443 : 80);
    if (executor.shouldBypassProxy(parsed.hostname, port, target.noProxy)) return null;

    return i18n.m(PROXY_NOTE);
}

function createRouter(ctx) {
    var handle = ctx.handle;
    var router = express.Router();

    var g = guardModule.createGuard(ctx);
    var guard = g.guard;
    var byPid = g.byPid;

    var registry = sioSessions.createRegistry(ctx.sioSessionOptions);

    // 鉴权继承与 Cookie 读写必须和 /send 是同一套规则
    var shared = sendApi.createShared(ctx);

    /* ---------------------------------------------------------- 会话定位 */

    function sessionMissing() {
        return respond.apiError(404, i18n.m('Socket.IO 会话不存在'));
    }

    function locateSession(req) {
        var session = registry.get(req.params.id, req.user && req.user.id);
        if (!session) return null;
        if (!access.roleOf(handle, req.user, session.projectId)) return null;

        return session;
    }

    /* ---------------------------------------------------------- 建会话 */

    /**
     * 建会话之前的全部准备：地址、请求头、查询参数、auth、监听名单。
     *
     * 拆出来是因为有第二个用户：本机网关要在自己的进程里建这个会话，
     * 云端 `POST /projects/:pid/sio/prepare` 把同一份东西发给它。
     *
     * @returns {object} 可 JSON 的会话参数
     */
    /** auth 对象里的字符串（任意深度）做变量替换；不是对象就是没有 auth */
    function resolveAuth(auth, vars) {
        if (!auth) return null;

        function walk(value) {
            if (typeof value === 'string') return variables.resolve(value, vars || {}).text;
            if (Array.isArray(value)) return value.map(walk);
            if (value && typeof value === 'object') {
                var out = {};
                Object.keys(value).forEach(function (key) { out[key] = walk(value[key]); });
                return out;
            }
            return value;
        }

        return walk(auth);
    }

    function prepareSession(req, project, body) {
        var input = dto.plainObject(body.spec);
        if (!input) throw respond.apiError(400, i18n.m('缺少 spec'));

        var options = dto.plainObject(body.options) || {};
        var userId = req.user ? req.user.id : null;

        /* 环境：和 /send 一样只认本项目的 */
        var environment = null;
        var environmentId = body.environmentId ? dto.str(body.environmentId) : null;
        if (mockEnv.isMockEnvironment(environmentId)) {
            // 内置 Mock 环境只对 HTTP / WebSocket 有意义，Socket.IO 的 Mock 这一轮不做
            throw respond.apiError(400, i18n.m('Socket.IO 不支持内置的 Mock 环境，请选一个真实环境或不选'));
        } else if (environmentId) {
            environment = environmentsRepo.get(handle, environmentId);
            if (!environment || environment.projectId !== project.id) {
                throw respond.apiError(400, i18n.m('环境不存在或不属于这个项目'));
            }
        }

        var vars = shared.resolveVariables(project, null, environment, userId);

        var sio = dto.plainObject(input.sio) || {};

        var spec = {
            url: dto.str(input.url),
            params: dto.toParams(input.params),
            auth: shared.inheritAuth(project, null, dto.toAuth(input.auth))
        };

        // 公共请求头（第五轮第 1 节）：只有「项目」这一层能继承（SIO 标签页不进目录树）
        spec.params.headers = commonHeaders.resolve(
            spec.params.headers, shared.commonHeaderLayers(project, null)).rows;

        var resolvedSpec = variables.resolveSpec(spec, vars).spec;

        // Socket.IO 的地址是握手用的 http(s) 地址：这里只取 origin，path / namespace 单独给
        var url = urlUtils.buildUrl(resolvedSpec);

        if (!HTTP_SCHEME.test(url)) {
            throw respond.apiError(400, i18n.m('Socket.IO 地址必须以 http:// 或 https:// 开头'));
        }

        var parsedUrl;
        try {
            parsedUrl = new URL(url);
        } catch (err) {
            throw respond.apiError(400, i18n.m('Socket.IO 地址不是合法的地址'));
        }

        var path = dto.str(sio.path).trim() || '/socket.io';
        if (path.charAt(0) !== '/') path = '/' + path;

        var namespace = dto.str(sio.namespace).trim() || '/';
        if (namespace.charAt(0) !== '/') namespace = '/' + namespace;

        var transports = TRANSPORTS.indexOf(dto.str(sio.transports)) > -1 ? dto.str(sio.transports) : 'polling';

        /* -------- 请求头：用户写的优先，鉴权和 Cookie 只补空缺 -------- */

        var headers = [];

        function indexOfHeader(name) {
            var lower = String(name).toLowerCase();
            for (var i = 0; i < headers.length; i++) {
                if (String(headers[i][0]).toLowerCase() === lower) return i;
            }
            return -1;
        }

        function addHeaderIfAbsent(name, value) {
            if (indexOfHeader(name) !== -1) return;
            headers.push([name, value]);
        }

        enabledRows(resolvedSpec.params.headers).forEach(function (row) {
            headers.push([
                String(row.key),
                row.value === undefined || row.value === null ? '' : String(row.value)
            ]);
        });

        /* 鉴权（bearer / basic / apikey）：复用执行器的规则 */
        var authParts = executor.buildAuth(resolvedSpec.auth);
        authParts.headers.forEach(function (pair) { addHeaderIfAbsent(pair[0], pair[1]); });
        authParts.query.forEach(function (pair) {
            parsedUrl.searchParams.append(pair[0], pair[1]);
        });

        /* Cookie：按这个 http 地址从库里取匹配的 cookie */
        if (options.cookies !== false && userId) {
            var jar = shared.createCookieJar(project.id, userId);
            var cookieHeader = jar.cookieHeaderFor(parsedUrl.origin + parsedUrl.pathname + parsedUrl.search);
            if (cookieHeader) addHeaderIfAbsent('Cookie', cookieHeader);
        }

        /**
         * 查询参数：**只从拼好的 URL 上取一次**。
         *
         * `buildUrl` 已经把「表格里的行」和「地址里带的查询串」合并好了（有行时以行为准），
         * 再遍历一遍 `params.query` 会把每个参数发两遍（自测就是这么撞到的）。
         */
        var query = [];
        parsedUrl.searchParams.forEach(function (value, key) {
            query.push({ key: key, value: value, enabled: true });
        });

        return {
            projectId: project.id,
            userId: userId,
            url: parsedUrl.origin,
            path: path,
            namespace: namespace,
            headers: headers,
            query: query,
            // auth 是 Socket.IO 最常用来带凭据的地方（`{ "token": "{{token}}" }`），
            // 里面的字符串和地址、请求头一样按当前环境替换
            auth: resolveAuth(dto.plainObject(sio.auth), vars),
            transports: transports,
            listenEvents: toListenEvents(sio.listenEvents),
            note: proxyNoteFor(handle, parsedUrl.origin)
        };
    }

    /** 给本机网关的「准备」接口（设计稿第 3.3 节第 1 步） */
    router.post('/projects/:pid/sio/prepare', guard('viewer', byPid), respond.wrap(function (req, res) {
        var prepared = prepareSession(req, req.project, req.body || {});
        respond.ok(res, { session: prepared });
    }));

    router.post('/projects/:pid/sio', guard('viewer', byPid), respond.wrap(function (req, res) {
        if (!sendApi.serverSendEnabled()) throw sendApi.serverSendDisabled();

        var prepared = prepareSession(req, req.project, req.body || {});

        var session = registry.create(Object.assign({ locale: i18n.locale() }, prepared));

        respond.ok(res, {
            session: {
                id: session.id,
                url: session.url + (session.namespace === '/' ? '' : session.namespace)
            }
        });
    }));

    /* ---------------------------------------------------------- 事件流 */

    router.get('/sio/:id/events', function (req, res) {
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

    /* ---------------------------------------------------------- 发事件 */

    router.post('/sio/:id/send', respond.wrap(function (req, res) {
        var session = locateSession(req);
        if (!session) throw sessionMissing();

        var body = req.body || {};
        registry.send(session.id, {
            event: body.event,
            args: body.args,
            ack: body.ack === true
        });

        respond.ok(res, {});
    }));

    /* ---------------------------------------------------------- 断开 */

    router.delete('/sio/:id', respond.wrap(function (req, res) {
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
