/**
 * 发送请求、历史与文件上传（契约第 5 节，权限见第 10 节）。
 *
 * 这一层做四件事，顺序不能乱：
 *   清洗 request → 补变量 → 定鉴权 → 交执行器，最后无论成败都写一条历史。
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

var respond = require('./respond');
var dto = require('./dto');
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

/** 真正发得出去的 HTTP 方法。mock 那边还有个 ALL，是路由匹配用的，不是方法 */
var SEND_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];

var TIMEOUT_MIN = 1;
var TIMEOUT_MAX = 300000;
var TIMEOUT_DEFAULT = 30000;

/** 历史里存的响应体上限：超过就截断并标记 */
var HISTORY_BODY_LIMIT = 256 * 1024;

function createRouter(ctx) {
    var handle = ctx.handle;
    var router = express.Router();

    var g = guardModule.createGuard(ctx);
    var guard = g.guard;
    var byPid = g.byPid;
    var byParam = g.byParam;

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

    /* ---------------------------------------------------------- 变量与鉴权 */

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

    /* ---------------------------------------------------------- 发送 */

    router.post('/projects/:pid/send', guard('viewer', byPid), function (req, res) {
        var project;
        var spec;
        var environmentId = null;
        var controller;

        try {
            project = req.project;

            var body = req.body || {};
            var input = dto.plainObject(body.request);
            if (!input) throw respond.apiError(400, '缺少 request');

            var method = dto.str(input.method || 'GET').toUpperCase();
            if (SEND_METHODS.indexOf(method) === -1) {
                throw respond.apiError(400, '不支持的请求方法：' + input.method);
            }

            // 清洗成完整形状：执行器不负责兜底，params / body 缺字段它会当成没有
            spec = {
                method: method,
                url: dto.str(input.url),
                params: dto.toParams(input.params),
                body: dto.toBody(input.body),
                auth: dto.toAuth(input.auth)
            };

            var apiId = body.apiId ? dto.str(body.apiId) : null;
            environmentId = body.environmentId ? dto.str(body.environmentId) : null;

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

            spec.auth = inheritAuth(project, apiId, spec.auth);

            /* 变量：环境覆盖同名的项目变量（fromRows 后面的键覆盖前面的） */
            var vars = variables.fromRows(
                (project.variables || []).concat(environment ? environment.variables : [])
            );

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

            controller = new AbortController();
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

            var requesting = { spec: spec, environmentId: environmentId };
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
                cookieJar = cookies.createMemoryJar(
                    readCookies(project.id, userId),
                    function () { return Date.now(); }
                );
                execOptions.cookieJar = cookieJar;
            }

            executor.execute(spec, execOptions).then(function (result) {
                var historyId = null;

                // 先把这次请求攒下的 cookie 写回去，再写历史 ——
                // 顺序其实无所谓，但 cookie 失败只打日志，历史失败也只打日志，
                // 两者互不影响
                if (cookieJar) writeCookies(cookieJar, project.id, userId);

                // 写历史不带 change：它不影响 mock 路由，没必要让各项目的 store 白读一遍
                try {
                    historyId = handle.transaction(function () {
                        return historyRepo.insert(handle, {
                            projectId: project.id,
                            apiId: apiId,
                            userId: userId,
                            request: requesting,
                            response: forHistory(result)
                        });
                    });
                } catch (err) {
                    console.error('[send] 写历史失败', err && err.message);
                }

                if (res.headersSent || res.writableEnded) return;
                respond.ok(res, { result: result, historyId: historyId });
            }).catch(function (err) {
                // 执行器承诺永不 reject，走到这里说明是我们自己的 bug
                failFrom(res, err);
            });

            return undefined;
        } catch (err) {
            return failFrom(res, err);
        }
    });

    /**
     * 历史里必须打码的请求头。名字比大小写不敏感 —— 少比一次就是把凭据写进历史。
     */
    var HISTORY_MASKED_HEADERS = ['cookie', 'authorization', 'proxy-authorization'];

    function maskHeaderValue(name, value) {
        return HISTORY_MASKED_HEADERS.indexOf(String(name).toLowerCase()) > -1 ? '***' : value;
    }

    function maskHeaderPairs(pairs, options) {
        if (!Array.isArray(pairs)) return pairs;

        return pairs.map(function (pair) {
            if (!Array.isArray(pair) || pair.length < 2) return pair;

            var name = String(pair[0]);
            // 响应里的 Set-Cookie 特殊处理：保留 cookie 名和属性，只把值换成 ***
            if (options && options.setCookie && name.toLowerCase() === 'set-cookie') {
                return [pair[0], cookies.maskSetCookie(pair[1])];
            }
            return [pair[0], maskHeaderValue(name, pair[1])];
        });
    }

    /**
     * 准备写进历史的那一份结果。
     *
     * 两件事，都**只针对历史这一份副本**，回给发送者本人的结果保持原样：
     *   1. 打码：请求头里的 Cookie / Authorization / Proxy-Authorization，
     *      响应头里的 Set-Cookie 只留名字和属性 —— 历史是项目里所有成员都能看的；
     *   2. 响应体超过 256KB 就截断，并按字节截（不是按字符），否则中文会超出去三倍。
     */
    function forHistory(result) {
        if (!result) return result;

        var copy = Object.assign({}, result);
        if (result.request) {
            copy.request = Object.assign({}, result.request, {
                headers: maskHeaderPairs(result.request.headers)
            });
        }
        if (result.response) {
            copy.response = Object.assign({}, result.response, {
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
        respond.ok(res, { entry: entry });
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
    createRouter: createRouter
};
