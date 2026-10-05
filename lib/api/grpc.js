/**
 * gRPC 调试接口（第十一轮第 1 节；反射、断言和提取是第十二轮第 1 节加的）。
 *
 * 三条路由，和 Socket.IO 那份（`lib/api/sio.js`）是一个思路：
 * - `POST /projects/:pid/grpc/parse`：proto 文本**或**反射描述 → 服务清单 + 示例
 *   （viewer 就能用，它只读请求体，不碰库）；
 * - `POST /projects/:pid/grpc/reflect`：问服务端要描述（不用导 proto）；
 * - `POST /projects/:pid/grpc/call`：真发一次调用，事件写成 NDJSON。
 *
 * **只在本机网关上挂**：云端连路由都没有（`ctx.localSend` 为假时直接返回空 router）。
 * gRPC 要连内网、还是长连接，只有用户自己那台机器发得出去。
 *
 * 复用点（和 `/send`、`/sio` 一份都不要另写）：
 * - 变量层级与保密值：`sendApi.createShared(ctx).resolveVariables`，
 *   替换用 `lib/variables.js` 的 `resolve`（`{{$guid}}` 这类动态变量也在里面）；
 * - 「云端不发送」这件事的判定与文案：`sendApi.serverSendEnabled` / `serverSendDisabled`；
 * - 断言与提取的清洗和判定：`lib/assertions.js`（和 HTTP 接口同一份）；
 * - 变量写回库：和 `/send` 的 `writeBackVariables` **同一套规则**（见下面那段注释）；
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
var grpcReflection = require('../grpc-reflection');
var grpcSessions = require('../grpc-sessions');
var variables = require('../variables');
var executor = require('../executor');
var proxySettings = require('../proxy-settings');
var access = require('../access');
var environmentsRepo = require('../db/repos/environments');
var projectsRepo = require('../db/repos/projects');
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

/** gRPC 状态错误 → 给人看的一句中文（复用 `lib/grpc.js` 的那张状态码提示表） */
function grpcErrorMessage(err) {
    if (err && err.noReflection) return '服务端没开反射，请导入 proto 文件';

    var grpc = require('@grpc/grpc-js');
    var info = grpcLib.statusOf(grpc, {
        code: err && err.grpcCode,
        details: err && err.message
    });
    return info.details || '反射失败';
}

/**
 * 把提取到的变量写回库（第十二轮第 1 节）。
 *
 * **规则一个字都不在这里**：交给 `sendApi.createShared(ctx).writeBackVariables` ——
 * 它是 `/send` 写回脚本变量用的同一份（editor 才写、只动涉及的 key、保密行走
 * `secret_values`、一个事务里做完）。这里只做「把 `end` 行的 `[{key,value,scope}]`
 * 摊成 send-core 那个 `state.variables.*.set` 的形状」这一件事。
 *
 * 写回的提示（只读角色、写库失败）直接进 `state.warnings`，调用方把它们并进 `end` 行。
 *
 * @param {object} input `{ shared, role, projectId, environmentId, userId, extracted }`
 * @returns {string[]} 写回过程中要告诉用户的话
 */
function applyExtracted(input) {
    var state = {
        variables: {
            environment: { set: {}, unset: [] },
            project: { set: {}, unset: [] },
            persisted: false
        },
        warnings: []
    };

    var touched = 0;
    (input.extracted || []).forEach(function (item) {
        if (!item || !item.key) return;
        var bucket = item.scope === 'project' ? state.variables.project : state.variables.environment;
        bucket.set[item.key] = item.value;
        touched += 1;
    });

    if (!touched) return [];

    input.shared.writeBackVariables({
        role: input.role,
        projectId: input.projectId,
        environmentId: input.environmentId,
        userId: input.userId,
        state: state
    });

    return state.warnings;
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

    // 流式会话（客户端流 / 双向流）：会话模型照 Socket.IO 那一份
    var registry = grpcSessions.createRegistry(ctx.grpcSessionOptions);

    /* ---------------------------------------------------------- 解析 proto */

    router.post('/projects/:pid/grpc/parse', guard('viewer', byPid), respond.wrap(function (req, res) {
        var body = req.body || {};

        // grpcLib 校验不过时抛的是 GrpcInputError（带 status 400），wrap 会原样转成 JSON。
        // 传描述时不再要求 protoFiles（第十二轮第 1 节）：反射拉下来的描述就够用了
        respond.ok(res, grpcLib.parse({
            protoFiles: body.protoFiles,
            descriptorSet: body.descriptorSet
        }));
    }));

    /* ---------------------------------------------------------- 反射 */

    /**
     * 问服务端要描述（第十二轮第 1 节）：不用导 proto，直接拿到服务清单。
     *
     * 和 `/grpc/call` 一样只在客户端里有用（云端没有这条路由），权限也是 viewer ——
     * 它不改库，只读对方服务端的元信息。
     *
     * 失败分两种，都要说清是**哪一步**不行：
     * - 两版反射都 UNIMPLEMENTED → 400「服务端没开反射，请导入 proto 文件」；
     * - 其余（连不上、超时、被拒绝）→ 走 `STATUS_HINTS` 那套中文提示。
     */
    router.post('/projects/:pid/grpc/reflect', guard('viewer', byPid), async function (req, res) {
        var body = req.body || {};
        var connection;

        try {
            if (!sendApi.serverSendEnabled()) throw sendApi.serverSendDisabled();
            connection = resolveConnection(req, req.project, body);
        } catch (err) {
            var status = Number(err && err.status);
            return respond.fail(res, Number.isFinite(status) ? status : 500,
                (err && err.message) || '反射准备失败', err && err.code);
        }

        try {
            var got = await grpcReflection.reflect({
                target: connection.target,
                tls: connection.tls,
                metadata: grpcLib.buildMetadata(connection.metadata),
                deadlineMs: grpcReflection.REFLECT_TIMEOUT_MS
            });

            var tooLarge = Buffer.byteLength(got.descriptorSet, 'utf8') > grpcLib.MAX_DESCRIPTOR_SET_BYTES;

            respond.ok(res, {
                // 服务清单和 /grpc/parse 一个形状：界面上的「服务 / 方法」下拉两边共用
                services: grpcLib.servicesOf({ descriptorSet: got.descriptorSet }),
                descriptorSet: got.descriptorSet,
                fetchedAt: Date.now(),
                tooLarge: tooLarge,
                // 用的是哪一版反射 + 收上来几个文件：排查「服务清单怎么少了一个」时有用
                version: got.version,
                fileCount: got.fileCount,
                missing: connection.missing,
                note: connection.note
            });
        } catch (err) {
            var code = Number(err && err.status);
            if (Number.isFinite(code) && code >= 400) {
                return respond.fail(res, code, err.message, err.code);
            }
            return respond.fail(res, 400, grpcErrorMessage(err));
        }
    });

    /* ---------------------------------------------------------- 调用 */

    /**
     * 连接层面的东西：地址、TLS、metadata、变量表。
     *
     * `/grpc/call` 和 `/grpc/reflect` 都要这一份 —— 反射也得先把 `host:port` 和
     * metadata 里的 `{{变量}}` 替换对，不然「反射能拉到、调用拉不到」这种怪事迟早出现。
     *
     * @returns {{target, tls, note, missing, metadata, apiId, environmentId, vars}}
     */
    function resolveConnection(req, project, body) {
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

        return {
            target: split.target,
            tls: tls,
            note: proxyNoteFor(handle, split.target, tls),
            missing: missing,
            metadata: metadata,
            apiId: apiId,
            // 选了真实环境（不是内置 Mock）时，「存到环境」的提取才有效
            environmentId: environment ? environment.id : null,
            vars: vars
        };
    }

    /**
     * 把这次要发的调用准备好。
     *
     * **这一步出的错按普通 JSON 返回**（契约第 14 节：开始流式输出之前出的错不写成
     * NDJSON）—— 只有描述解析、方法查找、消息 JSON 这几类进流（它们要发 `error` 行，
     * 见 `lib/grpc.js`）。
     *
     * @returns {{target, tls, note, missing, protoFiles, descriptorSet, service, method,
     *   metadata, messageText, deadlineMs, assertions, extracts}}
     */
    function prepareCall(req, project, body) {
        var connection = resolveConnection(req, project, body);

        /* -------- 消息文本：整段替换，没替换掉的原样留着（和地址一个规则） -------- */
        var message = variables.resolve(dto.str(body.message), connection.vars);
        var deadline = Number(body.deadlineMs);

        return {
            target: connection.target,
            tls: connection.tls,
            note: connection.note,
            missing: connection.missing.concat(message.missing),
            protoFiles: grpcLib.normalizeFiles(body.protoFiles),
            descriptorSet: dto.str(body.descriptorSet),
            service: dto.str(body.service).trim(),
            method: dto.str(body.method).trim(),
            metadata: connection.metadata,
            messageText: message.text,
            deadlineMs: Number.isFinite(deadline) && deadline > 0 ? deadline : grpcLib.DEFAULT_DEADLINE_MS,
            // 断言和提取：和 HTTP 接口用的是同一份清洗（lib/assertions.js）
            assertions: dto.toAssertions(body.assertions),
            extracts: dto.toExtracts(body.extracts),
            vars: connection.vars,
            hasEnvironment: Boolean(connection.environmentId),
            environmentId: connection.environmentId,
            apiId: connection.apiId
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
                /**
                 * 提取到的变量**在写这一行之前**落库，落库的提示也补进这一行 ——
                 * 事件对象是同一个引用，`ndjson.write` 在后面，所以还来得及改。
                 */
                if (event.type === 'end') {
                    var warnings = applyExtracted({
                        shared: shared,
                        role: req.role,
                        projectId: req.project.id,
                        environmentId: prepared.environmentId,
                        userId: req.user ? req.user.id : null,
                        extracted: event.extracted
                    });
                    if (warnings.length) {
                        event.warnings = (event.warnings || []).concat(warnings);
                    }
                }

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

    /* ---------------------------------------------------------- 流式会话 */

    /**
     * 客户端流 / 双向流的会话（第十二轮第 2 节）。
     *
     * 路由形状和 Socket.IO 那一组（`lib/api/sio.js`）一样：建会话、`/events` 收 NDJSON、
     * `/send` 发、`/end` 半关、`DELETE` 取消。**`/grpc/streams/:id/*` 刻意不挂 guard**：
     * 和 WebSocket / Socket.IO 一样，会话只有创建者能访问（admin 也不例外），
     * 任何一步不满足都返回**同一个** 404。
     */
    function sessionMissing() {
        return respond.apiError(404, 'gRPC 流式会话不存在');
    }

    function locateSession(req) {
        var session = registry.get(req.params.id, req.user && req.user.id);
        if (!session) return null;
        if (!access.roleOf(handle, req.user, session.projectId)) return null;
        return session;
    }

    /** 这条会话的变量表：每次发消息都重新算，用户在中途改了环境变量也能用上 */
    function varsOf(session) {
        var project = projectsRepo.getById(handle, session.projectId);
        if (!project) return {};

        var environment = session.environmentId ? environmentsRepo.get(handle, session.environmentId) : null;
        return shared.resolveVariables(project, session.apiId, environment, session.userId);
    }

    router.post('/projects/:pid/grpc/streams', guard('viewer', byPid), respond.wrap(function (req, res) {
        if (!sendApi.serverSendEnabled()) throw sendApi.serverSendDisabled();

        var prepared = prepareCall(req, req.project, req.body || {});
        if (!prepared.service) throw respond.apiError(400, '请选择服务');
        if (!prepared.method) throw respond.apiError(400, '请选择方法');

        /**
         * **只有客户端流 / 双向流才开会话**。一元和服务端流一次就能拿到结果，
         * 用 `/grpc/call` 更简单 —— 走错门时直接说清楚该去哪儿。
         */
        var ready = grpcLib.loadMethod({
            protoFiles: prepared.protoFiles,
            descriptorSet: prepared.descriptorSet,
            service: prepared.service,
            method: prepared.method
        });
        if (ready.method.requestStream !== true) {
            throw respond.apiError(400, '这个方法请直接调用（一元调用和服务端流用 /grpc/call）');
        }

        var session = registry.create({
            userId: req.user ? req.user.id : null,
            projectId: req.project.id,
            apiId: prepared.apiId,
            environmentId: prepared.environmentId,
            target: prepared.target,
            tls: prepared.tls,
            metadata: prepared.metadata,
            service: prepared.service,
            method: prepared.method,
            protoFiles: prepared.protoFiles,
            descriptorSet: prepared.descriptorSet,
            note: prepared.note,
            missing: prepared.missing,
            assertions: prepared.assertions,
            extracts: prepared.extracts,
            vars: prepared.vars,
            hasEnvironment: prepared.hasEnvironment
        });

        respond.ok(res, { id: session.id });
    }));

    /**
     * 事件流。NDJSON，`after` 之后的事件补发一遍（页面晚连上 / 断开重连都靠它）。
     *
     * 提取到的变量在 `end` 那一行落库（和 `/grpc/call` 同一套），所以这里也要
     * 拿到角色和用户 —— 事件流的连接和建会话是同一个人。
     */
    router.get('/grpc/streams/:id/events', function (req, res) {
        var session;
        try {
            session = locateSession(req);
            if (!session) throw sessionMissing();
        } catch (err) {
            var status = Number(err && err.status);
            return respond.fail(res, Number.isFinite(status) ? status : 404, err.message);
        }

        var after = Number((req.query || {}).after);

        /**
         * 这个人在**会话所属项目**里的角色。
         *
         * 不能用 `req.role`：这条路由刻意不挂 guard（会话只有创建者能访问，任何一步不满足
         * 都是同一个 404），guard 没跑过、`req.role` 根本没被设上 —— 拿它去判断
         * 「能不能写变量」会一律当成只读角色，提取的变量悄悄不落库。
         */
        var role = access.roleOf(handle, req.user, session.projectId);

        ndjson.start(res);

        var unsubscribe = registry.subscribe(session.id, after, function (event) {
            if (!event) {
                if (!res.writableEnded) res.end();
                return;
            }

            if (event.type === 'end') {
                var warnings = applyExtracted({
                    shared: shared,
                    role: role,
                    projectId: session.projectId,
                    environmentId: session.environmentId,
                    userId: req.user ? req.user.id : null,
                    extracted: event.extracted
                });
                if (warnings.length) {
                    event.warnings = (event.warnings || []).concat(warnings);
                }
            }

            ndjson.write(res, event);
        });

        res.on('close', function () { unsubscribe(); });
    });

    /** 发一条消息：变量在这里替换（和建会话时是同一套层级），不是 JSON 对象就是 400 */
    router.post('/grpc/streams/:id/send', respond.wrap(function (req, res) {
        var session = locateSession(req);
        if (!session) throw sessionMissing();

        var body = req.body || {};
        var resolved = variables.resolve(dto.str(body.message), varsOf(session));

        var message;
        try {
            message = grpcLib.parseMessage(resolved.text);
        } catch (err) {
            throw respond.apiError(400, (err && err.message) || '消息不是合法的 JSON');
        }

        registry.send(session.id, message);

        respond.ok(res, { missing: resolved.missing });
    }));

    /** 结束发送（half-close）：之后服务端还可以继续回消息，直到它自己结束 */
    router.post('/grpc/streams/:id/end', respond.wrap(function (req, res) {
        var session = locateSession(req);
        if (!session) throw sessionMissing();

        registry.halfClose(session.id);

        respond.ok(res, {});
    }));

    /** 取消并删掉会话（服务端那边会收到 cancel） */
    router.delete('/grpc/streams/:id', respond.wrap(function (req, res) {
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
