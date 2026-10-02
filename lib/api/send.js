/**
 * 发送请求、历史与文件上传（契约第 5、14 节，权限见第 10 节）。
 *
 * 一次发送被拆成三段（G1，设计稿第 3.3 节）：
 *   **prepare**（读库）→ **run**（`lib/send-core.js`，把请求发出去）→ **record**（写库）。
 *
 * `/send`（一次性返回）与 `/send/stream`（NDJSON 事件流）都是把这三段在同一个进程里
 * 串起来，差别只有响应形状；网关（`lib/gateway/index.js`）则是把「执行」那一段搬到
 * 用户本机 —— 云端只提供 `prepare` / `record` 两个接口。
 *
 * 这样拆的收益是**只有一份发送实现**：「云端自己发」和「经网关发」不可能跑出两种行为。
 *
 * 权限：viewer 就能发请求（这正是只读角色要做的事），也能上传文件 —— 文件上传是
 * 「发请求要用的」那一半；清空历史属于改数据，要 editor。**变量写回只有 editor 及以上
 * 才落库**，这一条在 `record` 里判（网关把角色一起带上来它就做不了主）。
 *
 * 三个容易出事的点：
 * - **必须传 fileRoots**。执行器允许读本地文件当请求体，不限根目录就等于让前端
 *   把 ~/.ssh/id_rsa 发到任意地址去。这里只放项目目录和管理台上传目录。
 * - **浏览器断开时要取消在途请求**，但历史照样要写。所以「写历史」和「回响应」
 *   是两件事：前者无条件做，后者看连接还在不在。
 * - **`prepare` 返回的东西要 JSON 出去**（网关要用），所以它里面不能有函数、jar、
 *   AbortController —— 那几个都由拿到 `prepared` 的那一方自己重建。
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
var sendCore = require('../send-core');
var curlExport = require('../curl-export');
var variables = require('../variables');
var access = require('../access');
var appInfo = require('../app-info');
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
var mockEnv = require('./mock-env');

var TIMEOUT_MIN = 1;
var TIMEOUT_MAX = 300000;
var TIMEOUT_DEFAULT = 30000;

/** 历史里存的响应体上限：超过就截断并标记 */
var HISTORY_BODY_LIMIT = 256 * 1024;

/** 能带到本机网关上的文件总大小上限（超了这次只能留在云端发） */
var GATEWAY_FILES_LIMIT = 50 * 1024 * 1024;

/**
 * 云端自己发不发请求（设计稿第 3 节）。
 *
 * `APILOOP_SERVER_SEND=0` 时关掉 `/send`、`/send/stream`、建 WebSocket 会话这三条路，
 * Docker 部署默认就是关的：请求由**本机的 apiloop 网关**发出，云端只负责读库
 * （`send/prepare`，它**不受这个开关影响**）和写库（`send/record`）。
 *
 * 不设置时默认打开 —— 现有测试和「本机直接 apiloop web」都要照旧能用。
 */
function serverSendEnabled() {
    return process.env.APILOOP_SERVER_SEND !== '0';
}

/**
 * 云端不发送时的统一错误：409 + 一个前端认得出的 `code`。
 *
 * 文案是给用户看的行动指引（G2 的界面用它做提示），`code` 是给界面做判断的 ——
 * 光看状态码 409 分不出这是「云端故意不发」还是别的地方冲突。
 */
function serverSendDisabled() {
    return respond.apiError(409, '云端不发送请求，请从本机的 apiloop 打开', 'SERVER_SEND_DISABLED');
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

    /**
     * macOS 上第一次访问局域网会直接失败（授权框还没被点掉），这时把错误换成一段
     * 能自救的指引。**只有跑在用户自己那台机器上的管理台才需要**（网关里的那一份，
     * `ctx.localSend`）：云端到不了私有地址是网络不通，换上这段话只会误导人。
     */
    function localNetworkHint(result) {
        if (!ctx.localSend) return result;
        return sendCore.applyLocalNetworkHint(result);
    }

    /** 把异常转成 JSON 错误；/send 是异步的，不能靠 respond.wrap 兜同步那部分 */
    function failFrom(res, err) {
        if (res.headersSent || res.writableEnded) return;

        var status = Number(err && err.status);
        if (Number.isFinite(status) && status >= 400 && status < 600) {
            // `err.code` 要给前端（`SERVER_SEND_DISABLED` 就是靠它认出来的）
            return respond.fail(res, status, err.message, err.code);
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
     * 脚本那一段（跑沙箱、串状态、pm.sendRequest）整套搬去了 `lib/send-core.js`：
     * 它要在网关上跑，所以不能出现「读库」和「req / res」。这里只留 `collectSteps`
     * —— 那一半要顺着目录链读库，属于 prepare 的活。
     */

    /**
     * 把脚本改过的变量落库（契约第 16 节的第 3 步）。
     *
     * 三个要点：
     * - **只有 editor 及以上才写**。viewer 的修改只在本请求内有效，并给一条警告。
     * - 写的时候**读出最新的变量行，只动涉及到的 key** —— 描述、启用状态、顺序都要保持原样，
     *   新增的追加到末尾、默认启用。整表覆盖会把用户刚在界面上改的东西冲掉。
     * - 所有写回在**一个事务**里完成；失败也只给警告，不能让已经发出去的请求变成失败。
     *
     * @param {object} input `{ role, projectId, environmentId, state }` —— 全部来自
     *   `record` 的入参：**角色判断必须在云端做**，网关传上来的东西不能自己做主。
     */
    function writeBackVariables(input) {
        var state = input.state;
        if (!state) return;

        var envChange = state.variables.environment;
        var projectChange = state.variables.project;
        var envTouched = Object.keys(envChange.set).length > 0 || envChange.unset.length > 0;
        var projectTouched = Object.keys(projectChange.set).length > 0 || projectChange.unset.length > 0;

        state.variables.persisted = false;
        if (!envTouched && !projectTouched) return;

        if (!access.atLeast(input.role, 'editor')) {
            state.warnings.push('只读角色：脚本对变量的修改没有保存');
            return;
        }

        try {
            handle.transaction(function () {
                if (envTouched && input.environmentId) {
                    var environment = environmentsRepo.get(handle, input.environmentId);
                    if (environment) {
                        environmentsRepo.update(handle, environment.id, {
                            variables: applyVarChanges(environment.variables, envChange)
                        });
                    }
                }

                if (projectTouched) {
                    var project = projectsRepo.getById(handle, input.projectId);
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
     * 允许读本地文件当请求体的那几个目录。
     *
     * **两个都不能少**：项目目录（`sourceDir`，老项目里的静态文件）和管理台上传目录。
     * 上传目录还必须**先建出来**，否则 `fileRoots` 里就少了一条，用户刚上传的文件
     * 反而发不出去。
     */
    function sendFileRoots(project) {
        var uploadDir = path.join(appInfo.DATA_DIR, 'files', project.id);
        if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

        var roots = [];
        if (project.sourceDir) roots.push(project.sourceDir);
        roots.push(uploadDir);

        return roots;
    }

    /**
     * **第一段：prepare。** 把这次发送需要的一切从库里读出来，交给「执行」那一段。
     *
     * 校验不过就抛带状态码的错，由调用方转成 JSON —— **流式版本必须在 `ndjson.start`
     * 之前调它**，否则错误就只能在事件里发出去了。
     *
     * 返回的东西**要能 JSON 出去**（网关要用），所以这里不建 jar、不建 AbortController：
     * Cookie 给的是行数组、取消信号由拿到它的那一方自己造。
     *
     * @param {object} req
     * @param {object} project `req.project`（guard 已经查过、也校验过权限）
     * @param {object} body 请求体
     * @param {object} [extra] `{ collectFiles }` —— 网关那条路要true，
     *   它得把文件内容一起带走；云端自己发送时不用（文件就在本机，读了反而多一份内存）
     * @returns {object} 可序列化的 `prepared`
     */
    function prepare(req, project, body, extra) {
        var opts = extra || {};
        var input = dto.plainObject(body.request);
        if (!input) throw respond.apiError(400, '缺少 request');

        var method = dto.str(input.method || 'GET').toUpperCase();
        if (sendCore.SEND_METHODS.indexOf(method) === -1) {
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
            // WebSocket 接口不能从 /send 发（契约第 17 节）：它不是 HTTP 请求，
            // 得走 WebSocket 标签页
            if (String(api.method || '').toUpperCase() === 'WS') {
                throw respond.apiError(400, 'WebSocket 接口请用 WebSocket 标签页连接');
            }
        }

        var environment = null;
        if (mockEnv.isMockEnvironment(environmentId)) {
            // 内置的 Mock 环境：不存库，用页面算好的 mock 地址临时拼一个（见 mock-env.js）
            environment = mockEnv.createMockEnvironment(project, body.mockBase);
        } else if (environmentId) {
            environment = environmentsRepo.get(handle, environmentId);
            if (!environment || environment.projectId !== project.id) {
                throw respond.apiError(400, '环境不存在或不属于这个项目');
            }
        }

        // 写回变量、record 校验用的环境 id：Mock 环境不在库里，脚本对它的修改只在这次请求里有效
        var storedEnvironmentId = mockEnv.isMockEnvironment(environmentId) ? null : environmentId;

        spec.auth = shared.inheritAuth(project, apiId, spec.auth);

        var options = dto.plainObject(body.options) || {};
        var timeoutMs = options.timeoutMs === undefined ? TIMEOUT_DEFAULT : Number(options.timeoutMs);
        if (!Number.isFinite(timeoutMs)) timeoutMs = TIMEOUT_DEFAULT;
        timeoutMs = Math.min(TIMEOUT_MAX, Math.max(TIMEOUT_MIN, timeoutMs));

        // 上传目录建出来（顺便确认它能建），文件根目录由调用方另行取用
        sendFileRoots(project);

        var userId = req.user ? req.user.id : null;

        /**
         * Cookie（契约第 12 节）。读之前先清过期的：契约要求过期的不能再发送，
         * 顺手让它从库里消失。
         *
         * 作用范围是「当前用户 × 当前项目」：同一个项目的另一个成员登录的是别的
         * 账号，他的 cookie 绝不能出现在我的请求里。
         *
         * `options.cookies === false` 时不读也不写 —— 传 null 就是「这次不碰 cookie」。
         */
        var cookieRows = null;
        if (options.cookies !== false && userId) {
            cookieRows = shared.readCookies(project.id, userId);
        }

        /**
         * 代理（契约第 12 节）：默认按系统设置走，`options.proxy === false` 时这次直连。
         * 这里给的是**设置本身**（可序列化），具体按目标地址取哪条代理到真要发的时候再算
         * —— 地址可能被脚本改过。
         */
        var proxySetting = options.proxy === false ? null : proxySettings.get(handle);

        /**
         * 变量各层：项目 → 目录链（从外到内）→ 环境。脚本要按优先级查找，
         * 而且是**按层**改（`pm.environment` 写环境、`pm.globals` 写项目），
         * 所以不能先拼成一张表 —— 分层带过去，改完再拼。
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

        var prepared = {
            project: { id: project.id, name: project.name },
            role: req.role,
            apiId: apiId,
            apiName: api ? api.name : '',
            environmentId: storedEnvironmentId,
            spec: spec,
            // 写历史用的「用户当初怎么写的这份请求」，和 spec 分开存 —— 执行过程中
            // 脚本会改 spec，历史要的是改之前的那份
            requesting: { spec: JSON.parse(JSON.stringify(spec)), environmentId: environmentId },
            options: {
                timeoutMs: timeoutMs,
                followRedirects: options.followRedirects !== false,
                // 契约第 16 节：`options.scripts` 默认 true，传 false 时一段脚本都不执行
                scripts: options.scripts !== false,
                cookies: options.cookies !== false,
                proxy: options.proxy !== false
            },
            scopes: scopes,
            steps: {
                prerequest: collectSteps(project, apiId, apiScripts, 'prerequest'),
                test: collectSteps(project, apiId, apiScripts, 'test')
            },
            cookies: cookieRows,
            proxy: proxySetting
        };

        if (opts.collectFiles) prepared.files = collectFiles(prepared, project);

        return prepared;
    }

    /**
     * 把 spec 里引用到的文件读出来，交给网关（G1 设计稿第 3.3 节第 1 步）。
     *
     * 三条约定：
     * - **只收真的被引用到的**：formdata 里 `kind === 'file'` 的行、binary 的 `file.src`；
     * - **路径必须在允许的目录里**（项目目录 / 管理台上传目录）。这一条和网关那边
     *   `fileRoots` 是同一套判断，但要在**把内容发出去之前**判一次 —— 否则一份恶意集合
     *   就能让云端把 `~/.ssh/id_rsa` 读出来送到网关上；
     * - **读不到的跳过，不报错**。云端自己发送时这种情况会变成 `error.code = FILE`
     *   的正常结果，prepare 阶段抛出去就等于改了行为。跳过的那些在网关上会原样保留
     *   原路径，照样报 FILE。
     *
     * 键是**用户在 spec 里写的那段原文**（可能带 `{{变量}}`）。网关按这个键做替换，
     * 不用自己去解析变量 —— 两边各解析一次迟早会不一致。
     */
    function collectFiles(prepared, project) {
        var spec = prepared.spec;
        var body = spec.body || {};
        var roots = sendFileRoots(project);

        var vars = sendCore.mergeScopes(prepared.scopes);
        var files = {};
        var total = 0;

        var srcs = [];
        if (body.mode === 'formdata') {
            (body.form || []).forEach(function (row) {
                if (row && row.enabled !== false && row.kind === 'file' && row.src) srcs.push(row.src);
            });
        } else if (body.mode === 'binary') {
            var binary = (body.file || {}).src;
            if (binary) srcs.push(binary);
        }

        srcs.forEach(function (raw) {
            var rawText = String(raw);
            if (Object.prototype.hasOwnProperty.call(files, rawText)) return;

            // 变量替换之后才是磁盘上的真实路径（和 executor 里同一套规则）
            var resolved = variables.resolve(rawText, vars).text;

            var content;
            try {
                executor.assertReadable(resolved, roots);
                content = fs.readFileSync(resolved);
            } catch (err) {
                return;  // 交给网关按「读不到」处理，见上面的说明
            }

            total += content.length;
            files[rawText] = { base64: content.toString('base64'), size: content.length };
        });

        return { map: files, total: total };
    }

    /**
     * **第三段：record。** 把一次执行的结果落库：写回变量、应用 Cookie 增量、写历史。
     *
     * 三件事都「失败只打日志」（写历史失败返回 null），返回 historyId 与脚本状态
     * 供响应使用。流式版本要在写 `end` 事件**之前**调用它。
     *
     * **不信任入参里的 apiId / environmentId**（审阅重点第 3 条）：`record` 是网关
     * 传上来的，可以伪造，所以两个都必须重新校验属于这个项目。
     *
     * @param {object} req
     * @param {object} project
     * @param {object} payload `{ apiId, environmentId, requesting, resolvedAuth, result, changes }`
     * @returns {{historyId: string|null, scripts: object|null}}
     */
    function record(req, project, payload) {
        var input = dto.plainObject(payload) || {};

        var apiId = input.apiId ? dto.str(input.apiId) : null;
        var environmentId = input.environmentId ? dto.str(input.environmentId) : null;

        if (apiId) {
            var api = apisRepo.get(handle, apiId);
            if (!api || api.projectId !== project.id) {
                throw respond.apiError(400, '接口不存在或不属于这个项目');
            }
        }
        if (environmentId) {
            var environment = environmentsRepo.get(handle, environmentId);
            if (!environment || environment.projectId !== project.id) {
                throw respond.apiError(400, '环境不存在或不属于这个项目');
            }
        }

        var changes = dto.plainObject(input.changes) || {};
        var userId = req.user ? req.user.id : null;

        /**
         * 契约第 16 节的第 3、4 步：**先把脚本改过的变量写回库，再写历史**。
         * 没有脚本时 `changes.scriptState` 是 null，`result.scripts` 也就保持 null ——
         * 前端据此就能区分「跑了脚本但没结果」和「压根没跑」。
         */
        var scripts = null;
        if (changes.scriptState) {
            writeBackVariables({
                role: req.role,
                projectId: project.id,
                environmentId: environmentId,
                state: changes.scriptState
            });
            scripts = changes.scriptState;
        }

        /**
         * 挂回结果上，**必须在写历史之前**：历史里存的是这份 `result` 的副本，
         * 挂晚了历史里就没有 `scripts`（而回给前端的却有）。
         * 顺序和拆分之前一样：写回变量 → 挂 scripts → 写历史。
         */
        if (input.result) input.result.scripts = scripts;

        // Cookie 增量。顺序其实无所谓，但 cookie 失败只打日志，历史失败也只打日志，
        // 两者互不影响
        if (changes.cookies && userId) {
            applyCookieChanges(project.id, userId, changes.cookies);
        }

        // 写历史不带 change：它不影响 mock 路由，没必要让各项目的 store 白读一遍
        var historyId = null;
        try {
            historyId = handle.transaction(function () {
                return historyRepo.insert(handle, {
                    projectId: project.id,
                    apiId: apiId,
                    userId: userId,
                    request: input.requesting,
                    response: forHistory(input.result, input.resolvedAuth)
                });
            });
        } catch (err) {
            console.error('[send] 写历史失败', err && err.message);
        }

        return { historyId: historyId, scripts: scripts };
    }

    /**
     * 把网关传上来的 Cookie 增量落库。
     *
     * 形状就是内存 jar 的 `changes()`：`{ set: [行...], removed: [行...] }`。
     * 失败只打日志：用户要的是「这次请求发了什么、回来什么」，
     * cookie 没存上不该让整个请求变成失败。
     */
    function applyCookieChanges(projectId, userId, changes) {
        try {
            var upserts = Array.isArray(changes.set) ? changes.set : [];
            var deletes = Array.isArray(changes.removed) ? changes.removed : [];
            if (!upserts.length && !deletes.length) return;

            handle.transaction(function () {
                upserts.forEach(function (cookie) {
                    cookiesRepo.upsert(handle, projectId, userId, cookie);
                });
                if (deletes.length) {
                    cookiesRepo.removeWhere(handle, projectId, userId, { keys: deletes });
                }
            });
        } catch (err) {
            console.error('[send] 写回 cookie 失败', err && err.message);
        }
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

    /* ---------------------------------------------------------- 三段串起来 */

    /**
     * 云端自己发送时，三段在同一条链上：prepare → run → record。
     *
     * `/send` 与 `/send/stream` 只在这条链的两头不一样（一个整包返回、一个写 NDJSON
     * 事件），中间那段**一个字都不差** —— 这正是这次拆分要的效果。
     *
     * @returns {{prepared: object, fileRoots: string[], respond: Function, hooks: object}}
     */
    function openSendChain(req, res, body) {
        var prepared = prepare(req, req.project, body);
        var fileRoots = sendFileRoots(req.project);

        var controller = new AbortController();
        res.on('close', function () {
            // 响应还没写完就关了，说明浏览器走了 —— 取消在途请求，
            // 别让服务端继续等一个没人要的结果。历史照样会写。
            if (!res.writableEnded) controller.abort();
        });

        /**
         * 把这次执行的结果落库。`record` 会把脚本状态挂回 `result`（前端读的是
         * `result.scripts`），这里只把 `historyId` 取出来。
         * 两条路都走这一个函数，所以「经网关发」和「这里发」对库的影响完全一致。
         */
        function recordInto(result, changes, resolvedAuth) {
            var saved = record(req, req.project, {
                apiId: prepared.apiId,
                environmentId: prepared.environmentId,
                requesting: prepared.requesting,
                resolvedAuth: resolvedAuth,
                result: result,
                changes: changes
            });

            return saved.historyId;
        }

        return {
            prepared: prepared,
            fileRoots: fileRoots,
            hooks: { signal: controller.signal, fileRoots: fileRoots },
            recordInto: recordInto
        };
    }

    /* ---------------------------------------------------------- 网关要用的两个接口 */

    /**
     * 给本机网关的「准备」接口：把这次发送需要的东西读出来交给它（设计稿第 3.3 节第 1 步）。
     *
     * 和 `/send` 用的是同一个 `prepare`，只多要了一样东西：**要带入的文件内容**
     * （`collectFiles`）—— 文件在云端的磁盘上，网关上要发就得把内容送过去。
     *
     * **不受 `APILOOP_SERVER_SEND` 影响**：关掉的是「云端替用户发请求」，
     * 这个接口恰恰是为了让请求能从用户自己的电脑发出去。
     */
    router.post('/projects/:pid/send/prepare', guard('viewer', byPid), respond.wrap(function (req, res) {
        var prepared = prepare(req, req.project, req.body || {}, { collectFiles: true });

        var total = (prepared.files && prepared.files.total) || 0;
        if (total > GATEWAY_FILES_LIMIT) {
            throw respond.apiError(413, '要上传的文件太大（超过 ' +
                Math.round(GATEWAY_FILES_LIMIT / 1024 / 1024) + 'MB），暂时不能从本机发送');
        }

        respond.ok(res, { prepared: prepared });
    }));

    /**
     * 给本机网关的「记录」接口：请求已经在用户电脑上发出去了，这里只负责落库
     * （写回变量、应用 Cookie 增量、写历史）。
     *
     * 权限判定、脱敏、apiId / environmentId 的归属校验全在 `record` 里 —— 网关传上来的
     * 东西一律当作不可信。
     */
    router.post('/projects/:pid/send/record', guard('viewer', byPid), respond.wrap(function (req, res) {
        respond.ok(res, record(req, req.project, req.body || {}));
    }));

    /**
     * 「代码片段 → cURL」：按发送时的同一套规则（变量、鉴权继承、地址拼接）生成 curl 命令，
     * **不发请求**。请求体的形状和「发送」接口一样（request / apiId / environmentId / mockBase）。
     */
    router.post('/projects/:pid/send/curl', guard('viewer', byPid), respond.wrap(function (req, res) {
        var prepared = prepare(req, req.project, req.body || {});
        respond.ok(res, curlExport.fromPrepared(prepared));
    }));

    /* ---------------------------------------------------------- 发送 */

    router.post('/projects/:pid/send', guard('viewer', byPid), function (req, res) {
        var chain;
        try {
            if (!serverSendEnabled()) throw serverSendDisabled();
            chain = openSendChain(req, res, req.body || {});
        } catch (err) {
            return failFrom(res, err);
        }

        sendCore.run(chain.prepared, chain.hooks).then(function (outcome) {
            // 落库（写回变量 + Cookie + 历史）后把结果整体回给前端
            localNetworkHint(outcome.result);
            var historyId = chain.recordInto(outcome.result, outcome.changes, outcome.resolvedAuth);

            if (res.headersSent || res.writableEnded) return;
            respond.ok(res, { result: outcome.result, historyId: historyId });
        }).catch(function (err) {
            // 执行器承诺永不 reject，走到这里说明是我们自己的 bug
            return failFrom(res, err);
        });

        return undefined;
    });

    /**
     * 流式发送（契约第 14 节）：SSE 与大响应。
     *
     * 请求体与 `/send` **完全相同**，区别只有响应形状 —— NDJSON 事件流。
     * 中间那段（跑脚本、发请求、跑测试）是同一份 `sendCore.run`，落库是同一个
     * `record`，所以两种发送方式对库的影响完全一致。
     */
    router.post('/projects/:pid/send/stream', guard('viewer', byPid), function (req, res) {
        var chain;
        try {
            if (!serverSendEnabled()) throw serverSendDisabled();
            // 必须在 ndjson.start 之前 —— 契约第 14 节：开始流式输出之前出的错按普通 JSON 返回
            chain = openSendChain(req, res, req.body || {});
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

        /**
         * 「前置脚本跑完、请求将要发出」的那一刻才吐出响应头。
         *
         * 早一步的话，前置脚本内部出错就没法按契约改回普通 JSON 错误（`failFrom` 那条路）；
         * 晚一步的话，`head` / `chunk` 事件就没有可写的响应了。
         */
        chain.hooks.onReady = function (execOptions) {
            ndjson.start(res);
            void execOptions;
        };

        chain.hooks.onHead = function (head, headControls) {
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

        chain.hooks.onChunk = function (buffer) {
            if (textResponse) {
                // 不管发得出去发不出去，都要先喂给 decoder：它内部要攒着被切断的多字节字符
                writeChunk({ type: 'chunk', text: decoder.write(buffer) });
                return;
            }
            writeChunk({ type: 'chunk', base64: Buffer.from(buffer).toString('base64') });
        };

        sendCore.run(chain.prepared, chain.hooks).then(function (outcome) {
            /**
             * 测试脚本已经在 run 里跑完了（契约第 16 节：要在 `end` 事件**之前**）。
             * 顺序按契约：先写回 Cookie 与变量、写历史，再写 end 事件。
             */
            localNetworkHint(outcome.result);
            var historyId = chain.recordInto(outcome.result, outcome.changes, outcome.resolvedAuth);

            if (textResponse) {
                // 把 StringDecoder 内部剩下的半个字符吐出来（响应正常收完时是空的）
                var tail = decoder.end();
                if (tail) ndjson.write(res, { type: 'chunk', text: tail });
            }

            endWith(outcome.result, historyId);
        }).catch(function (err) {
            /**
             * 执行器承诺永不 reject；`record` 里几个写操作各自吞掉了异常。
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
    createShared: createShared,
    // 「云端发不发请求」这件事有两个出口要用到（`/send`、WebSocket 会话），
    // 判定和文案都收在上面那两个函数里，别处不要再写一份
    serverSendEnabled: serverSendEnabled,
    serverSendDisabled: serverSendDisabled
};
