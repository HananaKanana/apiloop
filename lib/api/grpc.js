/**
 * gRPC 调试接口（第十一轮第 1 节）。
 *
 * 两条路由，和 Socket.IO 那份（`lib/api/sio.js`）是一个思路：
 * - `POST /projects/:pid/grpc/parse`：proto 文本 → 服务清单 + 示例（viewer 就能用，
 *   它只读请求体，不碰库）；
 * - `POST /projects/:pid/grpc/call`：真发一次调用，事件写成 NDJSON。
 *
 * **只在本机网关上挂**：云端连路由都没有（`ctx.localSend` 为假时直接返回空 router）。
 * gRPC 要连内网、还是长连接，只有用户自己那台机器发得出去。
 *
 * 复用点（和 `/send`、`/sio` 一份都不要另写）：
 * - 变量层级与保密值：`sendApi.createShared(ctx).resolveVariables`，
 *   替换用 `lib/variables.js` 的 `resolve`（`{{$guid}}` 这类动态变量也在里面）；
 * - 「云端不发送」这件事的判定与文案：`sendApi.serverSendEnabled` / `serverSendDisabled`；
 * - NDJSON 的响应头：`lib/api/ndjson.js`。
 *
 * 权限和 `/send` 一样是 **viewer**：调用不改库，读得到项目就能发。
 */

var express = require('express');

var respond = require('./respond');
var dto = require('./dto');
var ndjson = require('./ndjson');
var guardModule = require('./guard');
var sendApi = require('./send');
var mockEnv = require('./mock-env');
var grpcLib = require('../grpc');
var variables = require('../variables');
var executor = require('../executor');
var proxySettings = require('../proxy-settings');
var environmentsRepo = require('../db/repos/environments');
var apisRepo = require('../db/repos/apis');

/** 按系统设置本来该走代理时的说明（和 WebSocket / Socket.IO 那条同一个意思） */
var PROXY_NOTE = '系统代理不作用于 gRPC，本次为直连';

/** 启用且 key 非空的行 */
function enabledRows(rows) {
    if (!Array.isArray(rows)) return [];

    return rows.filter(function (row) {
        if (!row || row.enabled === false) return false;
        return row.key !== null && row.key !== undefined && String(row.key) !== '';
    });
}

/** 代理提示：gRPC 走自己的 HTTP/2 连接，系统代理（http_proxy）管不到它 */
function proxyNoteFor(handle, hostport, tls) {
    var url = (tls ? 'https://' : 'http://') + hostport;
    var target = proxySettings.forTarget(proxySettings.get(handle), url);
    if (!target) return null;

    var pieces = String(hostport).split(':');
    var host = pieces[0];
    var port = Number(pieces[1]) || (tls ? 443 : 80);
    if (executor.shouldBypassProxy(host, port, target.noProxy)) return null;

    return PROXY_NOTE;
}

function createRouter(ctx) {
    var handle = ctx.handle;
    var router = express.Router();

    // 云端（不是本机网关）：这个 router 什么都不挂
    if (!ctx.localSend) return router;

    var g = guardModule.createGuard(ctx);
    var guard = g.guard;
    var byPid = g.byPid;

    // 变量层级、保密值、Cookie 都要和 /send 是同一套规则
    var shared = sendApi.createShared(ctx);

    /* ---------------------------------------------------------- 解析 proto */

    router.post('/projects/:pid/grpc/parse', guard('viewer', byPid), respond.wrap(function (req, res) {
        var body = req.body || {};

        // grpcLib 校验不过时抛的是 GrpcInputError（带 status 400），wrap 会原样转成 JSON
        respond.ok(res, grpcLib.parse(body.protoFiles));
    }));

    /* ---------------------------------------------------------- 调用 */

    /**
     * 把这次要发的调用准备好。
     *
     * **这一步出的错按普通 JSON 返回**（契约第 14 节：开始流式输出之前出的错不写成
     * NDJSON）—— 只有 proto 解析、方法查找、消息 JSON 这三类进流（它们要发 `error` 行，
     * 见 `lib/grpc.js`）。
     *
     * @returns {{target, tls, note, missing, protoFiles, service, method, metadata, messageText, deadlineMs}}
     */
    function prepareCall(req, project, body) {
        var userId = req.user ? req.user.id : null;

        var apiId = body.apiId ? dto.str(body.apiId) : null;
        if (apiId) {
            var api = apisRepo.get(handle, apiId);
            if (!api || api.projectId !== project.id) {
                throw respond.apiError(400, '接口不存在或不属于这个项目');
            }
        }

        /* 环境：和 /send 一样只认本项目的 */
        var environment = null;
        var environmentId = body.environmentId ? dto.str(body.environmentId) : null;
        if (mockEnv.isMockEnvironment(environmentId)) {
            // 内置 Mock 环境只对 HTTP 有意义：gRPC 的地址是 host:port，Mock 也管不到
            throw respond.apiError(400, 'gRPC 不支持内置的 Mock 环境，请选一个真实环境或不选');
        } else if (environmentId) {
            environment = environmentsRepo.get(handle, environmentId);
            if (!environment || environment.projectId !== project.id) {
                throw respond.apiError(400, '环境不存在或不属于这个项目');
            }
        }

        var vars = shared.resolveVariables(project, apiId, environment, userId);

        /* -------- 地址：`grpcs://` 等于开 TLS，`grpc://` 等于不开 -------- */

        var urlResolved = variables.resolve(dto.str(body.url), vars);
        var missing = urlResolved.missing.slice();
        var split = grpcLib.splitTarget(urlResolved.text);

        // 地址里写了协议头就以它为准，没写才看请求体里的开关
        var tls = split.tls === null ? body.tls === true : split.tls;

        /* -------- metadata：键和值都能写变量 -------- */

        var metadata = [];
        enabledRows(body.metadata).forEach(function (row) {
            var key = variables.resolve(dto.str(row.key), vars);
            var value = variables.resolve(dto.str(row.value), vars);
            missing = missing.concat(key.missing, value.missing);

            metadata.push({ key: key.text.trim(), value: value.text, enabled: true });
        });

        /* -------- 消息文本：整段替换，没替换掉的原样留着（和地址一个规则） -------- */

        var message = variables.resolve(dto.str(body.message), vars);
        missing = missing.concat(message.missing);

        var deadline = Number(body.deadlineMs);

        return {
            target: split.target,
            tls: tls,
            note: proxyNoteFor(handle, split.target, tls),
            missing: missing,
            protoFiles: grpcLib.normalizeFiles(body.protoFiles),
            service: dto.str(body.service).trim(),
            method: dto.str(body.method).trim(),
            metadata: metadata,
            messageText: message.text,
            deadlineMs: Number.isFinite(deadline) && deadline > 0 ? deadline : grpcLib.DEFAULT_DEADLINE_MS
        };
    }

    router.post('/projects/:pid/grpc/call', guard('viewer', byPid), function (req, res) {
        var prepared;

        try {
            if (!sendApi.serverSendEnabled()) throw sendApi.serverSendDisabled();

            prepared = prepareCall(req, req.project, req.body || {});

            if (!prepared.service) throw respond.apiError(400, '请选择服务');
            if (!prepared.method) throw respond.apiError(400, '请选择方法');
        } catch (err) {
            var status = Number(err && err.status);
            return respond.fail(res, Number.isFinite(status) ? status : 500,
                (err && err.message) || '调用准备失败', err && err.code);
        }

        ndjson.start(res);

        var call = grpcLib.startCall(prepared, {
            onEvent: function (event) {
                ndjson.write(res, event);
            },
            onDone: function () {
                if (!res.writableEnded) res.end();
            }
        });

        /**
         * 浏览器断开（用户点了「取消」、或者关掉了页签）时把调用取消掉。
         *
         * 不取消的话这个调用会一直挂到超时，服务端那边也一直占着一条流 ——
         * 界面上看起来是「已经取消了」，实际还在跑。
         */
        res.on('close', function () { call.cancel(); });
    });

    return router;
}

module.exports = {
    createRouter: createRouter
};
