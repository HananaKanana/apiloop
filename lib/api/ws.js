/**
 * WebSocket 调试会话接口（契约第 15 节）。
 *
 * 这一层只做四件事：**鉴权、解析请求体、拼出要连的地址与请求头、把事件写成 NDJSON**。
 * 会话本身（连接、缓冲、生命周期）全在 `lib/ws-sessions.js` 里。
 *
 * 三个复用点，一个都不要另写一份：
 * - 鉴权继承与 Cookie 读写走 `/send` 的 `createShared`；
 * - bearer / basic / apikey 的翻译走 `executor.buildAuth`；
 * - NDJSON 的响应头走 `lib/api/ndjson.js`。
 *
 * **`/ws/:id/*` 刻意不挂 guard**：guard 的定位是「资源属于哪个项目」，而这里要先按
 * 「会话 + 创建者」定位（会话只有本人能访问，admin 也不例外），再确认创建者现在还
 * 是不是这个项目的成员。任何一步不满足都返回**同一个** 404。
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
var wsSessions = require('../ws-sessions');
var mockEnv = require('./mock-env');

/** 契约第 15 节：目标地址只接受这两种协议 */
var WS_SCHEME = /^wss?:\/\//i;

/** 按系统设置本来该走代理时的说明文案（契约第 15 节给了原文） */
var PROXY_NOTE = '系统代理不作用于 WebSocket，本次为直连';

/** 启用且 key 非空的行 */
function enabledRows(rows) {
    if (!Array.isArray(rows)) return [];

    return rows.filter(function (row) {
        if (!row || row.enabled === false) return false;
        return row.key !== null && row.key !== undefined && String(row.key) !== '';
    });
}

/** ws(s):// → http(s)://，用来查 Cookie 和判断代理（两者都只认 http 地址） */
function toHttpUrl(url) {
    return String(url).replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:');
}

/**
 * 只有「按系统设置这个目标本来该走代理」时，才给用户一句说明（契约第 15 节）。
 *
 * **noProxy 必须一起判**：命中 noProxy 的目标，普通请求本来也是直连，再提示一句
 * 「代理不作用于 WebSocket」只会让人以为代理配置坏了。`forTarget` 只看协议和代理地址，
 * noProxy 的命中判定在 `shouldBypassProxy` 里（执行器也是这么拆的，这里复用同一个）。
 *
 * @returns {string|null} 要放进 open 事件 note 的文案
 */
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

    return PROXY_NOTE;
}

function createRouter(ctx) {
    var handle = ctx.handle;
    var router = express.Router();

    var g = guardModule.createGuard(ctx);
    var guard = g.guard;
    var byPid = g.byPid;

    // 会话注册表：每个管理台实例一份（进程内不跨实例共享）。
    // `ctx.wsSessionOptions` 只是给测试留的注入点（把 60 秒的回收时间缩短），
    // 由 lib/admin.js 从 createAdmin 的入参透传过来，生产上不传。
    var registry = wsSessions.createRegistry(ctx.wsSessionOptions);

    // 鉴权继承与 Cookie 读写必须和 /send 是同一套规则
    var shared = sendApi.createShared(ctx);

    /* ---------------------------------------------------------- 会话定位 */

    /** 会话不存在 / 不是本人的 / 创建者已不是项目成员 —— 一律这一句 404 */
    function sessionMissing() {
        return respond.apiError(404, 'WebSocket 会话不存在');
    }

    /**
     * 按「会话 + 创建者 + 仍然是项目成员」定位。
     *
     * `registry.get` 已经把「不是本人的」挡掉了（admin 也不是本人），这里再补一次
     * 项目成员判定 —— 创建者被移出项目之后，会话里带着的凭据就不该再能用了。
     */
    function locateSession(req) {
        var session = registry.get(req.params.id, req.user && req.user.id);
        if (!session) return null;
        if (!access.roleOf(handle, req.user, session.projectId)) return null;

        return session;
    }

    /* ---------------------------------------------------------- 建会话 */

    /**
     * 建会话之前的全部准备：地址、请求头、子协议、说明。
     *
     * **拆出来是因为有第二个用户**：本机网关要在自己的进程里建这个会话
     * （G1 设计稿第 3.3 节：WebSocket 调试挪到本机），它需要的正是这一份东西。
     * 云端这边 `POST /projects/:pid/ws/prepare` 把同一份东西发给它，两边不会有两套规则。
     *
     * @returns {{projectId: string, userId: string|null, url: string, headers: Array, protocols: string[], note: string|null}}
     */
    function prepareSession(req, project, body) {
        var input = dto.plainObject(body.spec);
        if (!input) throw respond.apiError(400, '缺少 spec');

        var options = dto.plainObject(body.options) || {};
        var userId = req.user ? req.user.id : null;

        /* 环境：和 /send 一样只认本项目的，用错了会拿到别人的变量表 */
        var environment = null;
        var environmentId = body.environmentId ? dto.str(body.environmentId) : null;
        if (mockEnv.isMockEnvironment(environmentId)) {
            // 内置的 Mock 环境（见 mock-env.js）：连 mock 服务端上的 WebSocket 接口。
            // 页面给的是 http(s) 地址，WebSocket 要 ws(s)
            environment = mockEnv.createMockEnvironment(project, body.mockBase, { websocket: true });
        } else if (environmentId) {
            environment = environmentsRepo.get(handle, environmentId);
            if (!environment || environment.projectId !== project.id) {
                throw respond.apiError(400, '环境不存在或不属于这个项目');
            }
        }

        // 变量：和 /send 共用同一个函数（项目 → 目录链 → 环境）。
        // WebSocket 的 spec 里没有 apiId —— 它是临时调试标签页、不存目录树，所以目录链天然是空的
        var vars = shared.resolveVariables(project, null, environment, userId);

        /**
         * WebSocket 的 spec 只有 url / params / auth 三样（没有 body，也没有 apiId）——
         * 契约第 15 节：这是一次性调试标签页，不存目录树，所以没有目录可以往上找鉴权。
         */
        var spec = {
            url: dto.str(input.url),
            params: dto.toParams(input.params),
            auth: shared.inheritAuth(project, null, dto.toAuth(input.auth))
        };

        /**
         * 公共请求头（第五轮第 1 节）：WebSocket 标签页是临时调试页、不存目录树，
         * 所以只有「项目」这一层能继承。和 `/send` 用的是同一份合并规则。
         */
        spec.params.headers = commonHeaders.resolve(
            spec.params.headers, shared.commonHeaderLayers(project, null)).rows;

        var resolvedSpec = variables.resolveSpec(spec, vars).spec;
        var url = urlUtils.buildUrl(resolvedSpec);

        if (!WS_SCHEME.test(url)) {
            throw respond.apiError(400, 'WebSocket 地址必须以 ws:// 或 wss:// 开头');
        }

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

        /**
         * 子协议：`Sec-WebSocket-Protocol` 的值按逗号拆开，作为 `protocols` 传给构造函数，
         * 并从请求头里去掉 —— 这个头是握手协议自己要写的，当成普通请求头再发一遍
         * 会和库里生成的那份打架。
         */
        var protocols = [];
        var protocolIndex = indexOfHeader('Sec-WebSocket-Protocol');
        if (protocolIndex !== -1) {
            protocols = String(headers[protocolIndex][1])
                .split(',')
                .map(function (item) { return item.trim(); })
                .filter(Boolean);
            headers.splice(protocolIndex, 1);
        }

        /* 鉴权：复用执行器的规则（bearer / basic 走请求头，apikey 看 in） */
        var authParts = executor.buildAuth(resolvedSpec.auth);
        authParts.headers.forEach(function (pair) { addHeaderIfAbsent(pair[0], pair[1]); });
        authParts.query.forEach(function (pair) {
            url += (url.indexOf('?') === -1 ? '?' : '&') +
                urlUtils.encodeQueryPart(pair[0]) + '=' + urlUtils.encodeQueryPart(pair[1]);
        });

        /**
         * Cookie（契约第 15 节）：把目标地址换成对应的 http(s) 地址，按这个地址从库里
         * 取匹配的 cookie 附到 `Cookie` 头上。用户手写了就以他的为准。
         *
         * **握手响应里的 `Set-Cookie` 拿不到，不会写回** —— 这是已知限制，写进 README 了。
         */
        var httpUrl = toHttpUrl(url);

        if (options.cookies !== false && userId) {
            var jar = shared.createCookieJar(project.id, userId);
            var cookieHeader = jar.cookieHeaderFor(httpUrl);
            if (cookieHeader) addHeaderIfAbsent('Cookie', cookieHeader);
        }

        return {
            projectId: project.id,
            userId: userId,
            url: url,
            headers: headers,
            protocols: protocols,
            // 代理：WebSocket 不走系统代理，只在「本来该走」时提示一句
            note: proxyNoteFor(handle, httpUrl)
        };
    }

    /**
     * 给本机网关的「准备」接口：把它建会话需要的东西发过去（设计稿第 3.3 节第 1 步）。
     *
     * **不受 `APILOOP_SERVER_SEND` 影响**：关掉的是「云端自己连 WebSocket」，
     * 这个接口是为了让连接从用户自己的电脑建立。
     */
    router.post('/projects/:pid/ws/prepare', guard('viewer', byPid), respond.wrap(function (req, res) {
        var prepared = prepareSession(req, req.project, req.body || {});
        respond.ok(res, { session: prepared });
    }));

    router.post('/projects/:pid/ws', guard('viewer', byPid), respond.wrap(function (req, res) {
        if (!sendApi.serverSendEnabled()) throw sendApi.serverSendDisabled();

        var prepared = prepareSession(req, req.project, req.body || {});

        var session = registry.create({
            userId: prepared.userId,
            projectId: prepared.projectId,
            url: prepared.url,
            headers: prepared.headers,
            protocols: prepared.protocols,
            note: prepared.note
        });

        respond.ok(res, { session: { id: session.id, url: session.url } });
    }));

    /* ---------------------------------------------------------- 事件流 */

    router.get('/ws/:id/events', function (req, res) {
        var session;
        try {
            session = locateSession(req);
            if (!session) throw sessionMissing();
        } catch (err) {
            var status = Number(err && err.status);
            return respond.fail(res, Number.isFinite(status) ? status : 404, err.message);
        }

        var after = Number((req.query || {}).after);

        // 先 start 再订阅：到这里为止一个字节都还没写过，所以错误还能按 JSON 返回
        ndjson.start(res);

        var unsubscribe = registry.subscribe(session.id, after, function (event) {
            // null 表示会话已经销毁（被 DELETE，或者上游关闭满 60 秒）：把这条流收掉。
            // 不收的话前端会一直挂在那儿等一个永远不来的事件。
            if (!event) {
                if (!res.writableEnded) res.end();
                return;
            }
            ndjson.write(res, event);
        });

        // 浏览器关掉页面 / 刷新：立刻取消订阅，让「没人看」的倒计时开始走
        res.on('close', function () { unsubscribe(); });
    });

    /* ---------------------------------------------------------- 发消息 */

    router.post('/ws/:id/send', respond.wrap(function (req, res) {
        var session = locateSession(req);
        if (!session) throw sessionMissing();

        var body = req.body || {};
        var payload = {};

        // 二进制用 base64 传。先认 base64：同时给了两个时以二进制为准
        if (typeof body.base64 === 'string') payload.base64 = body.base64;
        else if (typeof body.text === 'string') payload.text = body.text;
        else throw respond.apiError(400, '缺少 text 或 base64');

        registry.send(session.id, payload);

        respond.ok(res, {});
    }));

    /* ---------------------------------------------------------- 断开 */

    router.delete('/ws/:id', respond.wrap(function (req, res) {
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
