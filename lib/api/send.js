/**
 * 发送请求、历史与文件上传（契约第 5、14 节，权限见第 10 节）。
 *
 * 这一层做四件事，顺序不能乱：
 *   清洗 request → 补变量 → 定鉴权 → 交执行器，最后无论成败都写一条历史。
 *
 * `/send`（一次性返回）和 `/send/stream`（NDJSON 事件流）**共用** `prepareSend` 与
 * `finishSend`，差别只有响应形状。这样「调通即 mock」的两处落点 —— 写回 Cookie、
 * 写历史 —— 在两条路上永远一致。
 *
 * 权限：viewer 就能发请求（这正是只读角色要做的事），也能上传文件 —— 文件上传是
 * 「发请求要用的」那一半；清空历史属于改数据，要 editor。
 *
 * 两个容易出事的点：
 * - **必须传 fileRoots**。执行器允许读本地文件当请求体，不限根目录就等于让前端
 *   把 ~/.ssh/id_rsa 发到任意地址去。这里只放项目目录和管理台上传目录。
 * - **浏览器断开时要取消在途请求**，但历史照样要写。所以「写历史」和「回响应」
 *   是两件事：前者无条件做，后者看连接还在不在。
 */

var express = require('express');
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var StringDecoder = require('string_decoder').StringDecoder;

var respond = require('./respond');
var dto = require('./dto');
var ndjson = require('./ndjson');
var guardModule = require('./guard');
var tree = require('../tree');
var executor = require('../executor');
var variables = require('../variables');
var appInfo = require('../app-info');
var apisRepo = require('../db/repos/apis');
var foldersRepo = require('../db/repos/folders');
var environmentsRepo = require('../db/repos/environments');
var historyRepo = require('../db/repos/history');
var cookiesRepo = require('../db/repos/cookies');
var cookies = require('../cookies');
var redact = require('../redact');
var proxySettings = require('../proxy-settings');
var urlUtils = require('../url-utils');

/** 真正发得出去的 HTTP 方法。mock 那边还有个 ALL，是路由匹配用的，不是方法 */
var SEND_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];

var TIMEOUT_MIN = 1;
var TIMEOUT_MAX = 300000;
var TIMEOUT_DEFAULT = 30000;

/** 历史里存的响应体上限：超过就截断并标记 */
var HISTORY_BODY_LIMIT = 256 * 1024;

/**
 * 与 `handle` 绑定、而且**别的模块也要用**的那几个函数。
 *
 * 目前有第二个用户：WebSocket 调试会话（`lib/api/ws.js`）。它同样要装 Cookie jar、
 * 同样要按目录树继承鉴权 —— 这两套规则一旦各写一份，迟早会有一处漏掉
 * 「找到 noauth 也算找到」或者「cookie 作用范围是用户×项目」这类细节。
 *
 * 所以这里只做「抽出来 + 导出」，没有改动任何行为。
 *
 * @param {{handle: object}} ctx
 */
function createShared(ctx) {
    var handle = ctx.handle;

    /* ---------------------------------------------------------- Cookie */

    /**
     * 读当前用户在这个项目里的 cookie。
     * 先清过期的：契约要求过期的不能再发送，顺手让它从库里消失。
     */
    function readCookies(projectId, userId) {
        var now = Date.now();

        // 不带 change 参数：cookie 不影响 mock 路由，没必要让各项目的 store 白读一遍
        handle.transaction(function () {
            cookiesRepo.purgeExpired(handle, projectId, userId, now);
        });

        return cookiesRepo.listFor(handle, projectId, userId);
    }

    /** 按「用户 × 项目」装一个内存 jar，供一次请求（或一次 WebSocket 握手）使用 */
    function createCookieJar(projectId, userId) {
        return cookies.createMemoryJar(readCookies(projectId, userId), function () { return Date.now(); });
    }

    /**
     * 把这次请求里 cookie 的变化写回库。
     *
     * 失败只打日志：用户要的是「这次请求发了什么、回来什么」，
     * cookie 没存上不该让整个请求变成失败。
     */
    function writeCookies(jar, projectId, userId) {
        try {
            var changes = jar.changes();
            if (!changes.upserts.length && !changes.deletes.length) return;

            handle.transaction(function () {
                changes.upserts.forEach(function (cookie) {
                    cookiesRepo.upsert(handle, projectId, userId, cookie);
                });
                if (changes.deletes.length) {
                    cookiesRepo.removeWhere(handle, projectId, userId, { keys: changes.deletes });
                }
            });
        } catch (err) {
            console.error('[send] 写回 cookie 失败', err && err.message);
        }
    }

    /* ---------------------------------------------------------- 鉴权继承 */

    /**
     * 鉴权继承：request.auth 是 null 或 inherit 时，从接口所在目录往上找，
     * 最后看项目。找到 noauth 也算找到 —— 它的意思正是「不加鉴权」，
     * 继续往上找会把上层目录的鉴权又捞回来，跟用户写的相反。
     */
    function inheritAuth(project, apiId, requestAuth) {
        if (requestAuth && requestAuth.type && requestAuth.type !== 'inherit') return requestAuth;

        var api = apiId ? apisRepo.get(handle, apiId) : null;
        if (api && api.projectId !== project.id) api = null;

        var chain = [];
        if (api && api.folderId) {
            var folder = foldersRepo.get(handle, api.folderId);
            if (folder) chain = [folder].concat(tree.ancestors(handle, folder.id));
        }

        for (var i = 0; i < chain.length; i++) {
            var auth = chain[i].auth;
            if (auth && auth.type && auth.type !== 'inherit') return auth;
        }

        if (project.auth && project.auth.type && project.auth.type !== 'inherit') return project.auth;
        return null;
    }

    return {
        readCookies: readCookies,
        createCookieJar: createCookieJar,
        writeCookies: writeCookies,
        inheritAuth: inheritAuth
    };
}

function createRouter(ctx) {
    var handle = ctx.handle;
    var router = express.Router();

    var g = guardModule.createGuard(ctx);
    var guard = g.guard;
    var byPid = g.byPid;
    var byParam = g.byParam;

    var shared = createShared(ctx);

    /** 把异常转成 JSON 错误；/send 是异步的，不能靠 respond.wrap 兜同步那部分 */
    function failFrom(res, err) {
        if (res.headersSent || res.writableEnded) return;

        var status = Number(err && err.status);
        if (Number.isFinite(status) && status >= 400 && status < 600) {
            return respond.fail(res, status, err.message);
        }
        console.error('[send]', err && err.stack ? err.stack : err);
        return respond.fail(res, 500, '服务端出错：' + ((err && err.message) || '未知错误'));
    }

    /* ---------------------------------------------------------- 校验与上下文 */

    /**
     * `/send` 与 `/send/stream` 共用的前半段：校验、变量、鉴权继承、Cookie jar、代理、执行选项。
     *
     * 校验不过就抛带状态码的错，由调用方转成 JSON —— **流式版本必须在 `ndjson.start`
     * 之前调它**，否则错误就只能在事件里发出去了。
     *
     * @param {object} req
     * @param {object} res 要注册 close 事件，用来取消在途请求
     * @param {object} project req.project（guard 已经查过、也校验过权限）
     * @param {object} body 请求体
     * @returns {object} 交给执行器与 finishSend 的上下文
     */
    function prepareSend(req, res, project, body) {
        var input = dto.plainObject(body.request);
        if (!input) throw respond.apiError(400, '缺少 request');

        var method = dto.str(input.method || 'GET').toUpperCase();
        if (SEND_METHODS.indexOf(method) === -1) {
            throw respond.apiError(400, '不支持的请求方法：' + input.method);
        }

        // 清洗成完整形状：执行器不负责兜底，params / body 缺字段它会当成没有
        var spec = {
            method: method,
            url: dto.str(input.url),
            params: dto.toParams(input.params),
            body: dto.toBody(input.body),
            auth: dto.toAuth(input.auth)
        };

        var apiId = body.apiId ? dto.str(body.apiId) : null;
        var environmentId = body.environmentId ? dto.str(body.environmentId) : null;

        // 请求体里引用的资源必须属于这个项目。环境用错了会拿到别人的变量表；
        // 接口用错了则会让鉴权继承顺着别人的目录树往上找 —— 两个都得挡。
        if (apiId) {
            var api = apisRepo.get(handle, apiId);
            if (!api || api.projectId !== project.id) {
                throw respond.apiError(400, '接口不存在或不属于这个项目');
            }
        }

        var environment = null;
        if (environmentId) {
            environment = environmentsRepo.get(handle, environmentId);
            if (!environment || environment.projectId !== project.id) {
                throw respond.apiError(400, '环境不存在或不属于这个项目');
            }
        }

        spec.auth = shared.inheritAuth(project, apiId, spec.auth);

        /* 变量：环境覆盖同名的项目变量（fromRows 后面的键覆盖前面的） */
        var vars = variables.fromRows(
            (project.variables || []).concat(environment ? environment.variables : [])
        );

        /**
         * 变量替换之后的请求。执行器内部会自己再算一遍，这里单独留一份是因为
         * 有两件事必须在**替换之后**的值上做：
         *   - 代理的 noProxy 判断要用真实地址（库里存的可能是 `{{baseUrl}}/api/users`）；
         *   - 历史打码要认得出真实凭据（apikey 的 key/value 可能写的是 `{{apiKey}}`，
         *     而实际发出去的是替换后的明文）。
         */
        var resolvedSpec = variables.resolveSpec(spec, vars).spec;

        var options = dto.plainObject(body.options) || {};
        var timeoutMs = options.timeoutMs === undefined ? TIMEOUT_DEFAULT : Number(options.timeoutMs);
        if (!Number.isFinite(timeoutMs)) timeoutMs = TIMEOUT_DEFAULT;
        timeoutMs = Math.min(TIMEOUT_MAX, Math.max(TIMEOUT_MIN, timeoutMs));

        // 上传文件的落地目录。必须存在，否则 fileRoots 里就少了一条，
        // 用户上传的文件反而发不出去。
        var uploadDir = path.join(appInfo.DATA_DIR, 'files', project.id);
        if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

        var fileRoots = [];
        if (project.sourceDir) fileRoots.push(project.sourceDir);
        fileRoots.push(uploadDir);

        var controller = new AbortController();
        res.on('close', function () {
            // 响应还没写完就关了，说明浏览器走了 —— 取消在途请求，
            // 别让服务端继续等一个没人要的结果。历史照样会写。
            if (!res.writableEnded) controller.abort();
        });

        var execOptions = {
            variables: vars,
            timeoutMs: timeoutMs,
            followRedirects: options.followRedirects !== false,
            // 本地接口工作台多半在连自签名的内网地址
            rejectUnauthorized: false,
            signal: controller.signal,
            fileRoots: fileRoots
        };

        var userId = req.user ? req.user.id : null;

        /**
         * Cookie 自动管理（契约第 12 节）。
         *
         * 作用范围是「当前用户 × 当前项目」：同一个项目的另一个成员登录的是别的
         * 账号，他的 cookie 绝不能出现在我的请求里。
         *
         * 发送前先清掉过期的再读出来装进内存 jar；执行完把 jar 的差量写回库。
         * `options.cookies === false` 时两头都不做。
         */
        var cookieJar = null;
        if (options.cookies !== false && userId) {
            cookieJar = shared.createCookieJar(project.id, userId);
            execOptions.cookieJar = cookieJar;
        }

        /**
         * 代理（契约第 12 节）：默认按系统设置走，`options.proxy === false` 时这次直连。
         * 判断目标用的是替换过变量的地址。
         */
        if (options.proxy !== false) {
            var proxyForTarget = proxySettings.forTarget(
                proxySettings.get(handle),
                resolvedSpec.url
            );
            if (proxyForTarget) execOptions.proxy = proxyForTarget;
        }

        return {
            project: project,
            apiId: apiId,
            environmentId: environmentId,
            spec: spec,
            vars: vars,
            resolvedSpec: resolvedSpec,
            options: options,
            execOptions: execOptions,
            cookieJar: cookieJar,
            userId: userId,
            requesting: { spec: spec, environmentId: environmentId }
        };
    }

    /**
     * `/send` 与 `/send/stream` 共用的后半段：写回 Cookie、写历史。
     *
     * 两件事都「失败只打日志」，返回 historyId 供响应使用。
     * 流式版本要在写 `end` 事件**之前**调用它，这样 `end` 里带的就是最终的历史 id。
     */
    function finishSend(context, result) {
        // 先把这次请求攒下的 cookie 写回去，再写历史 ——
        // 顺序其实无所谓，但 cookie 失败只打日志，历史失败也只打日志，两者互不影响
        if (context.cookieJar) {
            shared.writeCookies(context.cookieJar, context.project.id, context.userId);
        }

        // 写历史不带 change：它不影响 mock 路由，没必要让各项目的 store 白读一遍
        try {
            return handle.transaction(function () {
                return historyRepo.insert(handle, {
                    projectId: context.project.id,
                    apiId: context.apiId,
                    userId: context.userId,
                    request: context.requesting,
                    response: forHistory(result, context.resolvedSpec.auth)
                });
            });
        } catch (err) {
            console.error('[send] 写历史失败', err && err.message);
            return null;
        }
    }

    /* ---------------------------------------------------------- 发送 */

    router.post('/projects/:pid/send', guard('viewer', byPid), function (req, res) {
        var context;
        try {
            context = prepareSend(req, res, req.project, req.body || {});
        } catch (err) {
            return failFrom(res, err);
        }

        executor.execute(context.spec, context.execOptions).then(function (result) {
            var historyId = finishSend(context, result);

            if (res.headersSent || res.writableEnded) return;
            respond.ok(res, { result: result, historyId: historyId });
        }).catch(function (err) {
            // 执行器承诺永不 reject，走到这里说明是我们自己的 bug
            failFrom(res, err);
        });

        return undefined;
    });

    /**
     * 流式发送（契约第 14 节）：SSE 与大响应。
     *
     * 请求体与 `/send` **完全相同**，区别只有响应形状 —— NDJSON 事件流。
     * 「调通即 mock」的两处落点（写回 Cookie、写历史）走的是同一个 `finishSend`，
     * 所以两种发送方式对库的影响完全一致。
     */
    router.post('/projects/:pid/send/stream', guard('viewer', byPid), function (req, res) {
        var context;
        try {
            // 必须在 ndjson.start 之前 —— 契约第 14 节：开始流式输出之前出的错按普通 JSON 返回
            context = prepareSend(req, res, req.project, req.body || {});
        } catch (err) {
            return failFrom(res, err);
        }

        /**
         * 多字节字符会被切在两段之间（一个汉字是 3 个字节，而 TCP 分段不认字），
         * 直接 `toString('utf8')` 会在接缝处出乱码。StringDecoder 把不完整的尾巴
         * 留在内部，等下一段到了再接上。
         */
        var decoder = new StringDecoder('utf8');
        var textResponse = false;

        // head 到达之后不再有总超时（契约第 14 节）：SSE 可以一直连着，由用户主动取消
        context.execOptions.stream = true;

        context.execOptions.onHead = function (head) {
            // 文本还是二进制，看 head 里的 content-type —— 后面每一段都要用同一个判断，
            // 它和 result.response.bodyEncoding 是同一个函数算出来的
            textResponse = executor.isTextContentType(headerValue(head.response.headers, 'content-type'));

            ndjson.write(res, {
                type: 'head',
                response: head.response,
                redirects: head.redirects
            });
        };

        context.execOptions.onChunk = function (buffer) {
            if (textResponse) {
                ndjson.write(res, { type: 'chunk', text: decoder.write(buffer) });
                return;
            }
            ndjson.write(res, {
                type: 'chunk',
                base64: Buffer.from(buffer).toString('base64')
            });
        };

        ndjson.start(res);

        executor.execute(context.spec, context.execOptions).then(function (result) {
            // 顺序按契约：先写回 Cookie、写历史，再写 end 事件
            var historyId = finishSend(context, result);

            if (textResponse) {
                // 把 StringDecoder 内部剩下的半个字符吐出来（响应正常收完时是空的）
                var tail = decoder.end();
                if (tail) ndjson.write(res, { type: 'chunk', text: tail });
            }

            // end 恰好一次，而且是最后一条
            ndjson.write(res, { type: 'end', result: result, historyId: historyId });

            if (!res.writableEnded) res.end();
        }).catch(function (err) {
            /**
             * 执行器承诺永不 reject；`finishSend` 里两个写操作各自吞掉了异常。
             * 走到这里说明是我们自己的 bug —— 此时响应头已经发出去了，
             * 没法再改成 JSON 错误，只能记日志并结束流。
             *
             * 这里刻意**不发明新的事件类型**：契约第 14 节只定义了 head / chunk / end，
             * 前端按「流断了」处理即可（和用户中途取消是同一条路）。
             */
            console.error('[send/stream]', err && err.stack ? err.stack : err);
            if (!res.writableEnded) res.end();
        });

        return undefined;
    });

    /** 从 `head.response.headers`（`[[k, v]]`）里按头名取值，大小写不敏感 */
    function headerValue(pairs, name) {
        if (!Array.isArray(pairs)) return '';

        var lower = String(name).toLowerCase();
        for (var i = 0; i < pairs.length; i++) {
            if (String(pairs[i][0]).toLowerCase() === lower) return pairs[i][1];
        }
        return '';
    }

    /**
     * 历史里必须打码的请求头。名字比大小写不敏感 —— 少比一次就是把凭据写进历史。
     */
    var HISTORY_MASKED_HEADERS = ['cookie', 'authorization', 'proxy-authorization'];

    /**
     * 这一次要打码哪些请求头。
     *
     * 除了三个固定的，**apikey 的请求头名是用户自己定的**，得动态加进来：
     * `auth.key` 写什么，执行器就往请求头里放什么。`key` 为空时执行器本来也不会加。
     */
    function maskedHeaderNames(auth) {
        var names = HISTORY_MASKED_HEADERS.slice();

        if (auth && auth.type === 'apikey' && auth.in !== 'query' && auth.key) {
            names.push(String(auth.key).toLowerCase());
        }
        return names;
    }

    function maskHeaderPairs(pairs, options) {
        if (!Array.isArray(pairs)) return pairs;

        var names = (options && options.names) || HISTORY_MASKED_HEADERS;

        return pairs.map(function (pair) {
            if (!Array.isArray(pair) || pair.length < 2) return pair;

            var name = String(pair[0]);
            // 响应里的 Set-Cookie 特殊处理：保留 cookie 名和属性，只把值换成 ***
            if (options && options.setCookie && name.toLowerCase() === 'set-cookie') {
                return [pair[0], cookies.maskSetCookie(pair[1])];
            }
            return [pair[0], names.indexOf(name.toLowerCase()) > -1 ? '***' : pair[1]];
        });
    }

    /**
     * URL 里的 apikey 参数打码。
     *
     * 执行器是在地址末尾追加 `encodeQueryPart(key) + '=' + encodeQueryPart(value)`，
     * 所以这里按**同样的编码方式**拼出这一对来定位，并且**不整体重新拼接 URL** ——
     * 那会把地址里别的编码也改掉，历史就不再是「当时实际发出的那个地址」了。
     *
     * 出现多次时全部替换：用户可能自己也在 query 里写了一遍同样的 key，
     * 只抹掉末尾那一个等于把前面那份明文留在历史里。
     */
    function maskApiKeyInUrl(url, auth) {
        if (!auth || auth.type !== 'apikey' || auth.in !== 'query' || !auth.key) return url;

        var text = String(url === undefined || url === null ? '' : url);
        var value = auth.value === undefined || auth.value === null ? '' : String(auth.value);
        // 值为空就没有什么可掩的；顺带避免把 `key=` 当成前缀误伤别的参数
        if (!value) return text;

        var encodedKey = urlUtils.encodeQueryPart(auth.key);
        return text.split(encodedKey + '=' + urlUtils.encodeQueryPart(value))
            .join(encodedKey + '=***');
    }

    /**
     * 准备写进历史的那一份结果。
     *
     * 三件事，都**只针对历史这一份副本**，回给发送者本人的结果保持原样：
     *   1. 打码：请求头里的 Cookie / Authorization / Proxy-Authorization（apikey 的
     *      请求头名由 auth.key 决定，也一并算上），响应头里的 Set-Cookie 只留名字和属性；
     *   2. apikey 放在 query 时，把地址里那个参数的值也打掉 —— 它和请求头是同一份凭据；
     *   3. 响应体超过 256KB 就截断，并按字节截（不是按字符），否则中文会超出去三倍。
     *
     * @param {object} result 执行结果
     * @param {object|null} auth 继承解析、**变量替换之后**的鉴权
     */
    function forHistory(result, auth) {
        if (!result) return result;

        var copy = Object.assign({}, result);
        var names = maskedHeaderNames(auth);

        if (result.request) {
            copy.request = Object.assign({}, result.request, {
                headers: maskHeaderPairs(result.request.headers, { names: names }),
                url: maskApiKeyInUrl(result.request.url, auth)
            });
        }
        if (result.response) {
            copy.response = Object.assign({}, result.response, {
                // 响应头只认固定那三种：服务端不会因为我们用了 apikey 就回一个同名的头
                headers: maskHeaderPairs(result.response.headers, { setCookie: true })
            });
        }

        var body = result.response && result.response.body;
        if (typeof body !== 'string') return copy;

        var buffer = Buffer.from(body, 'utf8');
        if (buffer.length <= HISTORY_BODY_LIMIT) return copy;

        copy.response.body = buffer.subarray(0, HISTORY_BODY_LIMIT).toString('utf8');
        copy.historyTruncated = true;
        return copy;
    }

    /* ---------------------------------------------------------- 历史 */

    router.get('/projects/:pid/history', guard('viewer', byPid), respond.wrap(function (req, res) {
        var project = req.project;
        var limit = Number((req.query || {}).limit);
        if (!Number.isFinite(limit) || limit <= 0) limit = 50;
        limit = Math.min(200, Math.floor(limit));

        var before = (req.query || {}).before;

        // 多取一条用来判断「还有没有下一页」。只按 items.length===limit 判断的话，
        // 正好取满时会给一个永远空的下一页。
        var rows = historyRepo.list(handle, project.id, { limit: limit + 1, before: before });
        var hasMore = rows.length > limit;
        var items = hasMore ? rows.slice(0, limit) : rows;

        respond.ok(res, {
            items: items,
            nextBefore: hasMore && items.length ? items[items.length - 1].id : null
        });
    }));

    router.get('/history/:id', guard('viewer', byParam('history')), respond.wrap(function (req, res) {
        var entry = historyRepo.get(handle, req.params.id);
        if (!entry) throw respond.apiError(404, '历史不存在：' + req.params.id);

        /**
         * 按查看者区分（契约第 12 节）：发起人自己看完整内容（他要重放），
         * 别人 —— 包括 admin，也包括发起人被删号后 userId 变成 null 的那种 ——
         * 看打码后的副本。
         *
         * **库里存的永远是原文**，这里只改这一份返回值。
         */
        var payload = entry;
        if (!req.user || entry.userId !== req.user.id) {
            payload = Object.assign({}, entry, {
                request: redact.redactHistoryRequest(entry.request)
            });
        }

        respond.ok(res, { entry: payload });
    }));

    router.delete('/projects/:pid/history', guard('editor', byPid), respond.wrap(function (req, res) {
        var project = req.project;

        handle.transaction(function () {
            historyRepo.clear(handle, project.id);
        });

        respond.ok(res, {});
    }));

    /* ---------------------------------------------------------- 文件上传 */

    /**
     * 只在这一条路由上挂 raw 解析：外层的 express.json 只认 JSON 类型，
     * 两者不会抢。要是一开始就全局挂 raw，别的接口的 JSON 体就全变成 Buffer 了。
     */
    router.post('/projects/:pid/files',
        guard('viewer', byPid),
        express.raw({ type: 'application/octet-stream', limit: '50mb' }),
        respond.wrap(function (req, res) {
            var project = req.project;

            var rawName = req.get('X-Filename');
            var name = 'file';

            if (rawName) {
                try {
                    name = decodeURIComponent(rawName);
                } catch (err) {
                    throw respond.apiError(400, 'X-Filename 不是合法的百分号编码');
                }
            }

            var content = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
            var cleaned = cleanFileName(name);
            var target = path.join(appInfo.DATA_DIR, 'files', project.id, shortRandom() + '-' + cleaned);

            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, content);

            respond.ok(res, { src: target, name: cleaned, size: content.length });
        })
    );

    return router;
}

/** 文件名的随机前缀，避免同名覆盖 */
function shortRandom() {
    return crypto.randomBytes(4).toString('hex');
}

/**
 * 清理文件名：去掉路径分隔符和控制字符，长度截到 100。
 *
 * 清掉分隔符之后 `..` 就只是个普通名字了，再加上随机前缀，不会逃出目标目录。
 */
function cleanFileName(name) {
    var cleaned = String(name === undefined || name === null ? '' : name)
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .replace(/[/\\]/g, '')
        .trim();

    if (cleaned.length > 100) cleaned = cleaned.slice(0, 100);
    if (!cleaned || cleaned === '.' || cleaned === '..') cleaned = 'file';

    return cleaned;
}

module.exports = {
    createRouter: createRouter,
    // WebSocket 调试会话要复用同一套鉴权继承与 Cookie 读写规则（见 createShared 上方的说明）
    createShared: createShared
};
