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
var access = require('../access');
var appInfo = require('../app-info');
var runner = require('../scripts/runner');
var apisRepo = require('../db/repos/apis');
var foldersRepo = require('../db/repos/folders');
var projectsRepo = require('../db/repos/projects');
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

/** 脚本里 `pm.sendRequest` 的超时（契约第 16 节固定 10 秒） */
var SUB_REQUEST_TIMEOUT_MS = 10000;

/** 历史里存的响应体上限：超过就截断并标记 */
var HISTORY_BODY_LIMIT = 256 * 1024;

/** 启用且 key 非空的行 */
function enabledRows(rows) {
    if (!Array.isArray(rows)) return [];

    return rows.filter(function (row) {
        if (!row || row.enabled === false) return false;
        return row.key !== null && row.key !== undefined && String(row.key) !== '';
    });
}

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

    /* ---------------------------------------------------------- 目录链 */

    /**
     * 接口所在的目录链，**从最外层到最内层**（含接口直接所在的那个目录）。
     *
     * 鉴权继承和变量替换都要用它，但方向正好相反：
     *   - 鉴权是「最近的一级优先」，要从内往外找；
     *   - 变量是「后面的覆盖前面的」，要从外往内拼。
     *
     * 所以这里**只维护一种顺序（外 → 内）**，要另一种的调用方自己倒过来 ——
     * 两边各记一套顺序的话，迟早有一处会写反，而写反了在界面上根本看不出来。
     *
     * @param {object} project
     * @param {string|null} apiId 没有接口（比如 WebSocket）就传 null
     * @returns {Array<object>} 目录行（带 auth / variables），越靠后越内层
     */
    function folderChain(project, apiId) {
        var api = apiId ? apisRepo.get(handle, apiId) : null;
        // 接口不属于这个项目时当作没有：否则会顺着别人的目录树往上找
        if (api && api.projectId !== project.id) api = null;
        if (!api || !api.folderId) return [];

        var folder = foldersRepo.get(handle, api.folderId);
        if (!folder) return [];

        // tree.ancestors 是从内到外（父、祖父……，不含自己），反转过来再接上自己
        return tree.ancestors(handle, folder.id).reverse().concat([folder]);
    }

    /* ---------------------------------------------------------- 变量与鉴权 */

    /**
     * 把三级变量拼成一张表（契约第 5 节第 1 步，2026-09-30 修订）。
     *
     * 顺序是「项目 → 目录链（从外到内）→ 环境」，**后面的覆盖前面同名的**，
     * 也就是优先级「项目 < 外层目录 < 内层目录 < 环境」。
     *
     * 目录变量以前是漏掉的：「导入到当前项目」时集合变量存在顶层目录上，结果全部丢失。
     *
     * `/send`、`/send/stream`、WebSocket 会话三处共用这一个函数，不要各写一份。
     * WebSocket 的 spec 里没有 `apiId`（它不存目录树），传 null 时目录链天然是空的。
     *
     * @param {object} project
     * @param {string|null} apiId
     * @param {object|null} environment
     * @returns {Object<string,string>}
     */
    function resolveVariables(project, apiId, environment) {
        var rows = (project.variables || []).slice();

        folderChain(project, apiId).forEach(function (folder) {
            rows = rows.concat(folder.variables || []);
        });

        if (environment) rows = rows.concat(environment.variables || []);

        return variables.fromRows(rows);
    }

    /* ---------------------------------------------------------- 鉴权继承 */

    /**
     * 鉴权继承：request.auth 是 null 或 inherit 时，从接口所在目录往上找，
     * 最后看项目。找到 noauth 也算找到 —— 它的意思正是「不加鉴权」，
     * 继续往上找会把上层目录的鉴权又捞回来，跟用户写的相反。
     */
    function inheritAuth(project, apiId, requestAuth) {
        if (requestAuth && requestAuth.type && requestAuth.type !== 'inherit') return requestAuth;

        var chain = folderChain(project, apiId);

        // 从内往外找：folderChain 给的是外 → 内，所以倒着遍历
        for (var i = chain.length - 1; i >= 0; i--) {
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
        folderChain: folderChain,
        resolveVariables: resolveVariables,
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

    /* ---------------------------------------------------------- 脚本（契约第 16 节） */

    /**
     * 按「项目 → 目录链（从外到内）→ 接口」收集某一阶段的脚本。
     *
     * 接口那一层取自**请求体里的 `request.scripts`**，这样界面上没保存的修改也会生效；
     * 项目和目录的从库里读。目录链复用鉴权继承那一份（`shared.folderChain`）。
     */
    function collectSteps(project, apiId, apiScripts, phase) {
        var steps = [];

        function push(source, scripts) {
            (scripts || []).forEach(function (script) {
                if (!script || script.listen !== phase) return;
                if (String(script.exec || '').trim() === '') return;
                steps.push({ source: source, exec: script.exec });
            });
        }

        push('项目', project.scripts);

        shared.folderChain(project, apiId).forEach(function (folder) {
            push('目录「' + folder.name + '」', folder.scripts);
        });

        push('接口', apiScripts);

        return steps;
    }

    /**
     * 交给沙箱的请求形态 —— 字段名和 prelude 里的 `requestState` 一一对应。
     * 地址用 `buildUrl` 拼好（路径参数、query 行都进去了），变量**此时还没替换**，
     * 所以脚本看到的是带 `{{...}}` 的地址。
     */
    function toRunnerRequest(spec) {
        return {
            method: spec.method,
            url: urlUtils.buildUrl(spec),
            headers: enabledRows((spec.params || {}).headers).map(function (row) {
                return [String(row.key), dto.str(row.value)];
            }),
            body: {
                mode: (spec.body && spec.body.mode) || 'none',
                raw: spec.body && typeof spec.body.raw === 'string' ? spec.body.raw : undefined
            }
        };
    }

    /**
     * 把脚本改过的请求写回 spec。校验不过时返回给用户看的原因（由调用方记成脚本错误）。
     *
     * 地址是**整体替换 + 清空 query / path 行**：`buildUrl` 已经把那些行拼进地址里了，
     * 不清空的话紧接着的变量替换会再拼一遍，参数直接翻倍。
     */
    function applyRunnerRequest(spec, next) {
        if (!next || typeof next !== 'object') return null;

        if (next.method) {
            var method = String(next.method).toUpperCase();
            if (SEND_METHODS.indexOf(method) === -1) {
                return '脚本把请求方法改成了不支持的值：' + next.method;
            }
            spec.method = method;
        }

        if (typeof next.url === 'string' && next.url !== '') {
            spec.url = next.url;
            spec.params.query = [];
            spec.params.path = [];
        }

        if (Array.isArray(next.headers)) {
            spec.params.headers = next.headers.map(function (pair) {
                return {
                    key: String(pair[0]),
                    value: dto.str(pair[1]),
                    type: 'string',
                    required: false,
                    desc: '',
                    enabled: true
                };
            });
        }

        if (next.body && typeof next.body === 'object') {
            var mode = dto.str(next.body.mode) || spec.body.mode;
            spec.body = Object.assign({}, spec.body, {
                mode: mode,
                raw: next.body.raw === undefined ? spec.body.raw : dto.str(next.body.raw)
            });
            if (spec.body.mode === 'raw' && !spec.body.language) spec.body.language = 'text';
        }

        return null;
    }

    /** 请求体之外的响应形状，就是 prelude 里 `pm.response` 看到的那些字段 */
    function toScriptResponse(result) {
        if (!result || !result.response) {
            return {
                error: {
                    message: (result && result.error && result.error.message) || '请求失败'
                }
            };
        }

        return {
            code: result.response.status,
            status: result.response.statusText,
            responseTime: result.timings ? result.timings.total : null,
            size: result.response.size,
            headers: result.response.headers,
            body: result.response.body
        };
    }

    /**
     * 把脚本里的 `pm.sendRequest` 交出去。
     *
     * 代理设置和这次请求相同、Cookie jar 用同一个、超时 10 秒（契约第 16 节）。
     * **不记入历史** —— 它是脚本自己的动作，不是用户在发请求。
     */
    function makeSubRequest(context) {
        return function (json) {
            var input;
            try {
                input = JSON.parse(json);
            } catch (err) {
                return Promise.resolve(JSON.stringify({ error: { message: '请求参数不是合法 JSON' } }));
            }

            var spec = {
                method: dto.str(input.method || 'GET').toUpperCase(),
                url: dto.str(input.url),
                params: {
                    path: [],
                    query: [],
                    headers: (input.headers || []).map(function (pair) {
                        return { key: String(pair[0]), value: dto.str(pair[1]), enabled: true };
                    })
                },
                // 脚本里的 auth 不继承主请求的（和 Postman 一致），要用就自己写请求头
                auth: null,
                body: input.body
                    ? {
                        mode: dto.str(input.body.mode) || 'raw',
                        raw: dto.str(input.body.raw),
                        language: 'text'
                    }
                    : { mode: 'none' }
            };

            var options = {
                variables: context.vars,
                timeoutMs: SUB_REQUEST_TIMEOUT_MS,
                followRedirects: true,
                rejectUnauthorized: false,
                fileRoots: context.fileRoots
            };
            if (context.cookieJar) options.cookieJar = context.cookieJar;

            var target = context.proxyFor(urlUtils.buildUrl(spec));
            if (target) options.proxy = target;

            return executor.execute(spec, options).then(function (result) {
                return JSON.stringify(toScriptResponse(result));
            }).catch(function (err) {
                return JSON.stringify({ error: { message: (err && err.message) || '请求失败' } });
            });
        };
    }

    /** 同一个 key 后写的覆盖先写的；`unset` 要能把之前记下的 `set` 撤掉 */
    function mergeVarChanges(target, source) {
        Object.keys((source && source.set) || {}).forEach(function (key) {
            target.set[key] = source.set[key];
        });
        ((source && source.unset) || []).forEach(function (key) {
            delete target.set[key];
            if (target.unset.indexOf(key) === -1) target.unset.push(key);
        });
    }

    /** 前置链 + 测试链 → 一个 `ExecResult.scripts` */
    function mergeScriptStates(target, source) {
        if (!target || !source) return target;

        target.tests = target.tests.concat(source.tests);
        target.console = target.console.concat(source.console);
        target.errors = target.errors.concat(source.errors);

        source.warnings.forEach(function (text) {
            if (target.warnings.indexOf(text) === -1) target.warnings.push(text);
        });

        mergeVarChanges(target.variables.environment, source.variables.environment);
        mergeVarChanges(target.variables.project, source.variables.project);

        return target;
    }

    /**
     * 把脚本改过的变量落库（契约第 16 节的第 3 步）。
     *
     * 三个要点：
     * - **只有 editor 及以上才写**。viewer 的修改只在本请求内有效，并给一条警告。
     * - 写的时候**读出最新的变量行，只动涉及到的 key** —— 描述、启用状态、顺序都要保持原样，
     *   新增的追加到末尾、默认启用。整表覆盖会把用户刚在界面上改的东西冲掉。
     * - 所有写回在**一个事务**里完成；失败也只给警告，不能让已经发出去的请求变成失败。
     */
    function writeBackVariables(context) {
        var state = context.scriptState;
        if (!state) return;

        var envChange = state.variables.environment;
        var projectChange = state.variables.project;
        var envTouched = Object.keys(envChange.set).length > 0 || envChange.unset.length > 0;
        var projectTouched = Object.keys(projectChange.set).length > 0 || projectChange.unset.length > 0;

        state.variables.persisted = false;
        if (!envTouched && !projectTouched) return;

        if (!access.atLeast(context.role, 'editor')) {
            state.warnings.push('只读角色：脚本对变量的修改没有保存');
            return;
        }

        try {
            handle.transaction(function () {
                if (envTouched && context.environmentId) {
                    var environment = environmentsRepo.get(handle, context.environmentId);
                    if (environment) {
                        environmentsRepo.update(handle, environment.id, {
                            variables: applyVarChanges(environment.variables, envChange)
                        });
                    }
                }

                if (projectTouched) {
                    var project = projectsRepo.getById(handle, context.project.id);
                    if (project) {
                        projectsRepo.update(handle, project.id, {
                            variables: applyVarChanges(project.variables, projectChange)
                        });
                    }
                }
            });
            state.variables.persisted = true;
        } catch (err) {
            console.error('[send] 脚本变量写回失败', err && err.message);
            state.warnings.push('脚本对变量的修改没有保存：' + ((err && err.message) || '未知错误'));
        }
    }

    /* ---------------------------------------------------------- 校验与上下文 */

    /**
     * `/send` 与 `/send/stream` 共用的前半段：**同步**的校验与准备。
     *
     * 校验不过就抛带状态码的错，由调用方转成 JSON —— **流式版本必须在 `ndjson.start`
     * 之前调它**，否则错误就只能在事件里发出去了。
     *
     * 脚本是异步的，而且是「开始流式输出**之后**」才跑的，所以放在 `runPrerequestScripts`
     * 里，这里只把脚本需要的东西（变量各层、Cookie jar、fileRoots、预算）准备好。
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
        var api = null;
        if (apiId) {
            api = apisRepo.get(handle, apiId);
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

        var userId = req.user ? req.user.id : null;

        /**
         * Cookie 自动管理（契约第 12 节）。
         *
         * 作用范围是「当前用户 × 当前项目」：同一个项目的另一个成员登录的是别的
         * 账号，他的 cookie 绝不能出现在我的请求里。
         *
         * 发送前先清掉过期的再读出来装进内存 jar；执行完把 jar 的差量写回库。
         * `options.cookies === false` 时两头都不做。
         *
         * 必须在跑脚本**之前**建好：脚本里的 `pm.sendRequest` 用的是同一个 jar，
         * 「先登录拿 token 再调别的接口」那种脚本全靠它。
         */
        var cookieJar = null;
        if (options.cookies !== false && userId) {
            cookieJar = shared.createCookieJar(project.id, userId);
        }

        /**
         * 代理（契约第 12 节）：默认按系统设置走，`options.proxy === false` 时这次直连。
         * 判断目标用的是替换过变量的地址 —— 而地址可能被脚本改过，
         * 所以这里只留一个「按地址取代理」的函数，到真要发的时候再算。
         */
        var proxySetting = options.proxy === false ? null : proxySettings.get(handle);

        /**
         * 变量各层：项目 → 目录链（从外到内）→ 环境。脚本要按优先级查找，
         * 而且是**按层**改（`pm.environment` 写环境、`pm.globals` 写项目），
         * 所以不能像以前那样先拼成一张表 —— 分层传给沙箱，改完再拼。
         */
        var scopes = {
            project: variables.fromRows(project.variables),
            folders: shared.folderChain(project, apiId).map(function (folder) {
                return variables.fromRows(folder.variables);
            }),
            environment: environment ? variables.fromRows(environment.variables) : null,
            transient: {}
        };

        // 接口的脚本以请求体里的为准（界面上没保存的修改也要生效），没传才用库里的
        var apiScripts = input.scripts !== undefined
            ? dto.toScripts(input.scripts)
            : (api ? api.scripts : []);

        return {
            project: project,
            role: req.role,
            apiId: apiId,
            apiName: api ? api.name : '',
            environmentId: environmentId,
            environment: environment,
            spec: spec,
            originalSpec: JSON.parse(JSON.stringify(spec)),
            requesting: { spec: JSON.parse(JSON.stringify(spec)), environmentId: environmentId },
            options: options,
            timeoutMs: timeoutMs,
            followRedirects: options.followRedirects !== false,
            fileRoots: fileRoots,
            controller: controller,
            userId: userId,
            cookieJar: cookieJar,
            proxyFor: function (url) {
                if (!proxySetting) return null;
                return proxySettings.forTarget(proxySetting, url);
            },
            scopes: scopes,
            runnerRequest: toRunnerRequest(spec),
            finalRunnerRequest: null,
            steps: {
                prerequest: collectSteps(project, apiId, apiScripts, 'prerequest'),
                test: collectSteps(project, apiId, apiScripts, 'test')
            },
            // 契约第 16 节：`options.scripts` 默认 true，传 false 时一段脚本都不执行
            scriptsEnabled: options.scripts !== false,
            scriptsRan: false,
            aborted: false,
            scriptState: runner.emptyState(),
            budget: runner.createBudget(),
            vars: null,
            resolvedSpec: null,
            execOptions: null
        };
    }

    /**
     * 脚本跑完之后才算得出的那几样：变量表、替换后的请求、执行选项。
     *
     * 「脚本改过的变量 → 替换变量 → 发送」这条顺序就是契约第 16 节第 1、2 步，
     * 所以变量表必须在这里重建，不能用 prepareSend 里那份。
     */
    function finishPrepare(context) {
        context.vars = mergeScopes(context.scopes);
        context.resolvedSpec = variables.resolveSpec(context.spec, context.vars).spec;

        context.execOptions = {
            variables: context.vars,
            timeoutMs: context.timeoutMs,
            followRedirects: context.followRedirects,
            // 本地接口工作台多半在连自签名的内网地址
            rejectUnauthorized: false,
            signal: context.controller.signal,
            fileRoots: context.fileRoots
        };

        if (context.cookieJar) context.execOptions.cookieJar = context.cookieJar;

        var target = context.proxyFor(context.resolvedSpec.url);
        if (target) context.execOptions.proxy = target;
    }

    /** 各层按「项目 → 目录链（从外到内）→ 环境 → 本次请求的临时变量」拼成一张表 */
    function mergeScopes(scopes) {
        var vars = {};

        [scopes.project].concat(scopes.folders || []).forEach(function (map) {
            Object.keys(map || {}).forEach(function (key) { vars[key] = map[key]; });
        });
        if (scopes.environment) {
            Object.keys(scopes.environment).forEach(function (key) { vars[key] = scopes.environment[key]; });
        }
        Object.keys(scopes.transient || {}).forEach(function (key) { vars[key] = scopes.transient[key]; });

        return vars;
    }

    /** 跑前置脚本，并把它们改过的请求与变量算进上下文 */
    async function runPrerequestScripts(context) {
        var steps = context.steps.prerequest;

        if (!context.scriptsEnabled || !runner.hasRunnable(steps)) {
            finishPrepare(context);
            return;
        }

        var outcome = await runner.runChain('prerequest', steps, {
            request: context.runnerRequest,
            scopes: context.scopes,
            sendRequest: makeSubRequest(context),
            info: { requestName: context.apiName },
            budget: context.budget
        });

        context.scriptsRan = true;
        mergeScriptStates(context.scriptState, outcome.state);

        var problem = applyRunnerRequest(context.spec, outcome.request);
        if (problem) {
            context.scriptState.errors.push({ phase: 'prerequest', source: '接口', message: problem });
            outcome.aborted = true;
        }

        context.aborted = outcome.aborted;
        context.finalRunnerRequest = outcome.request;

        finishPrepare(context);
    }

    /**
     * 跑测试脚本。**取消、或者根本没有响应时不跑**（契约第 14、16 节）。
     * 结果并进 `context.scriptState`，由 finishSend 统一挂到 result 上。
     */
    async function runTestScripts(context, result) {
        var steps = context.steps.test;

        if (!context.scriptsEnabled || !runner.hasRunnable(steps)) return;
        if (!result.response) return;
        if (result.error && result.error.code === 'ABORTED') return;

        var outcome = await runner.runChain('test', steps, {
            request: context.finalRunnerRequest || context.runnerRequest,
            response: toScriptResponse(result),
            scopes: context.scopes,
            sendRequest: makeSubRequest(context),
            info: { requestName: context.apiName },
            budget: context.budget
        });

        context.scriptsRan = true;
        mergeScriptStates(context.scriptState, outcome.state);
    }

    /** 前置脚本出错时的结果：请求没有发出去，但错误码要说清楚是脚本的问题 */
    function scriptFailureResult(context) {
        var message = '前置脚本出错';

        if (context.scriptState.errors.length) {
            message = context.scriptState.errors[0].message;
        }

        return {
            ok: false,
            request: null,
            response: null,
            redirects: [],
            timings: { dns: null, connect: null, tls: null, ttfb: null, download: null, total: null },
            missingVariables: [],
            error: { code: 'SCRIPT', message: message },
            proxy: null,
            scripts: context.scriptsRan ? context.scriptState : null
        };
    }

    /** 把这次请求的变量行应用上脚本的修改，其余行原样保留 */
    function applyVarChanges(rows, change) {
        var source = Array.isArray(rows) ? rows : [];
        var set = (change && change.set) || {};
        var unset = (change && change.unset) || [];

        var out = source.map(function (row) { return Object.assign({}, row); });

        out.forEach(function (row) {
            if (Object.prototype.hasOwnProperty.call(set, row.key)) row.value = set[row.key];
        });

        out = out.filter(function (row) { return unset.indexOf(row.key) === -1; });

        var existing = {};
        out.forEach(function (row) { existing[row.key] = true; });

        Object.keys(set).forEach(function (key) {
            if (existing[key]) return;
            out.push({ key: key, value: set[key], enabled: true });
        });

        return out;
    }

    /**
     * `/send` 与 `/send/stream` 共用的后半段：写回 Cookie、写历史。
     *
     * 两件事都「失败只打日志」，返回 historyId 供响应使用。
     * 流式版本要在写 `end` 事件**之前**调用它，这样 `end` 里带的就是最终的历史 id。
     */
    function finishSend(context, result) {
        /**
         * 契约第 16 节的第 3、4 步：**先把脚本改过的变量写回库，再写历史**。
         * 没有脚本时 `scriptState` 里什么都没有，`result.scripts` 保持 null ——
         * 前端据此就能区分「跑了脚本但没结果」和「压根没跑」。
         */
        if (context.scriptState) {
            writeBackVariables(context);
            result.scripts = context.scriptsRan ? context.scriptState : null;
        }

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

        runPrerequestScripts(context).then(function () {
            // 前置脚本出错：请求不发送，但历史照样写一条（错误码 SCRIPT）
            if (context.aborted) {
                var failed = scriptFailureResult(context);
                var failedHistoryId = finishSend(context, failed);
                if (res.headersSent || res.writableEnded) return;
                return respond.ok(res, { result: failed, historyId: failedHistoryId });
            }

            return executor.execute(context.spec, context.execOptions).then(function (result) {
                return runTestScripts(context, result).then(function () {
                    var historyId = finishSend(context, result);

                    if (res.headersSent || res.writableEnded) return;
                    respond.ok(res, { result: result, historyId: historyId });
                });
            });
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
        /** head 到达时拿到的背压开关，作用在解压之后的响应流上 */
        var controls = null;
        /** 已经因为背压把上游按停过、正在等 drain —— 防止把 pause/resume 的配对打乱 */
        var waitingForDrain = false;

        /**
         * 写一段 chunk；写不进去就把上游按停。
         *
         * `res.write` 返回 false 说明服务端的发送缓冲区已经满了 —— 也就是**浏览器读得慢**。
         * 不按停的话，上游能推多快就推多快，这些数据只能堆在 Node 的发送缓冲区里。
         * 部署在远端时「浏览器到服务端」的带宽通常远小于「服务端到目标接口」的带宽，
         * 下载一个几百 MB 的文件就能把容器的内存撑爆（实测 300MB 的场景 RSS 涨到 568MB）。
         *
         * **只按一次**：暂停期间可能还有几段已经在途的 chunk 进来，重复 pause / resume
         * 会让 drain 的配对错位（第二次 resume 之后就没人再放行了）。
         */
        function writeChunk(payload) {
            if (ndjson.write(res, payload)) return;
            if (waitingForDrain || !controls) return;

            waitingForDrain = true;
            controls.pause();
            res.once('drain', function () {
                waitingForDrain = false;
                controls.resume();
            });
        }

        function endWith(result, historyId) {
            ndjson.write(res, { type: 'end', result: result, historyId: historyId });
            if (!res.writableEnded) res.end();
        }

        runPrerequestScripts(context).then(function () {
            ndjson.start(res);

            /**
             * 前置脚本出错：契约第 16 节说「请求不发送」，返回的 `result.error` 是 SCRIPT。
             * 流式这边已经开始输出了，所以按事件表达 —— `end` 里带上这个结果，
             * 和历史里记的是同一份。
             */
            if (context.aborted) {
                var failed = scriptFailureResult(context);
                return endWith(failed, finishSend(context, failed));
            }

            // head 到达之后不再有总超时（契约第 14 节）：SSE 可以一直连着，由用户主动取消
            context.execOptions.stream = true;

            context.execOptions.onHead = function (head, headControls) {
                controls = headControls;

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
                    // 不管发得出去发不出去，都要先喂给 decoder：它内部要攒着被切断的多字节字符
                    writeChunk({ type: 'chunk', text: decoder.write(buffer) });
                    return;
                }
                writeChunk({ type: 'chunk', base64: Buffer.from(buffer).toString('base64') });
            };

            return executor.execute(context.spec, context.execOptions).then(function (result) {
                /**
                 * 测试脚本要在 `end` 事件**之前**跑完（契约第 16 节）；
                 * 取消和没有响应时 runTestScripts 自己会跳过。
                 */
                return runTestScripts(context, result).then(function () {
                    // 顺序按契约：先写回 Cookie 与变量、写历史，再写 end 事件
                    var historyId = finishSend(context, result);

                    if (textResponse) {
                        // 把 StringDecoder 内部剩下的半个字符吐出来（响应正常收完时是空的）
                        var tail = decoder.end();
                        if (tail) ndjson.write(res, { type: 'chunk', text: tail });
                    }

                    endWith(result, historyId);
                });
            });
        }).catch(function (err) {
            /**
             * 执行器承诺永不 reject；`finishSend` 里几个写操作各自吞掉了异常。
             * 走到这里说明是我们自己的 bug —— 如果响应头已经发出去了，
             * 没法再改成 JSON 错误，只能记日志并结束流。
             *
             * 这里刻意**不发明新的事件类型**：契约第 14 节只定义了 head / chunk / end，
             * 前端按「流断了」处理即可（和用户中途取消是同一条路）。
             */
            console.error('[send/stream]', err && err.stack ? err.stack : err);
            if (!res.headersSent) return failFrom(res, err);
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
                request: redact.redactHistoryRequest(entry.request),
                // 脚本的 console 与变量值同样会带出凭据（契约第 16 节）
                result: entry.result && entry.result.scripts
                    ? Object.assign({}, entry.result, {
                        scripts: redact.redactScriptsResult(entry.result.scripts)
                    })
                    : entry.result
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
