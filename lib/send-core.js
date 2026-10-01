/**
 * 发送的「执行」那一段（G1，设计稿第 3.3 节）。
 *
 * 一次发送被拆成三段：
 *   1. **prepare**（云端，`lib/api/send.js`）：读库 —— 变量各层、继承好的鉴权、脚本链、
 *      Cookie、代理设置、要上传的文件内容；
 *   2. **run**（就是这个文件）：**把请求真正发出去**，在本机执行。不碰数据库，
 *      不碰 `req` / `res`；
 *   3. **record**（云端，`lib/api/send.js`）：写库 —— 变量写回、Cookie 落库、写历史。
 *
 * 云端自己发请求时（`/send`、`/send/stream`）三段在同一个进程里串起来，**共用这一份
 * 实现**。所以「经网关发」和「云端自己发」不会有第二种行为，现有的 71 个测试就是
 * 这次拆分的回归网。
 *
 * 两边的边界：
 * - **入参 `prepared` 是云端 JSON 过来的**，所以它里面不能有函数、jar、AbortController；
 * - **出参 `changes` 也要 JSON 回去**，所以只放普通对象（脚本状态 + Cookie 增量）；
 * - 需要的东西（取消信号、文件根目录、流式回调）由调用方通过 `hooks` 传进来 ——
 *   网关给的是它自己解出来的临时目录，云端给的是项目目录加管理台上传目录。
 *
 * 为什么 `changes.scriptState` 在没有脚本时是 `null`：契约要求「跑了脚本但没结果」和
 * 「压根没跑」在返回里能分开，所以这里在**源头**就把没跑过的那种判成 null，
 * 而不是让下游去猜。
 */

var variables = require('./variables');
var urlUtils = require('./url-utils');
var executor = require('./executor');
var runner = require('./scripts/runner');
var cookies = require('./cookies');
var proxySettings = require('./proxy-settings');
var dto = require('./api/dto');

/** 真正发得出去的 HTTP 方法。mock 那边还有个 ALL，是路由匹配用的，不是方法 */
var SEND_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];

/** 脚本里 `pm.sendRequest` 的超时（契约第 16 节固定 10 秒） */
var SUB_REQUEST_TIMEOUT_MS = 10000;

/* ------------------------------------------------------------------ 脚本 */

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
 * **只写回脚本真正改过的部分**（和脚本拿到的 `before` 比）。交给脚本的地址是变量替换
 * **之前**用 `buildUrl` 拼的：`{{host}}/x?q={{ev}}` 会变成 `http://{{host}}/x?q=%7B%7Bev%7D%7D`
 * （补了协议、查询值被编码）。以前不管改没改都整体写回，接着替换变量就成了
 * `http://http://…`，`{{ev}}` 也再认不出来 —— 只要带前置脚本、地址里有变量，请求就发不出去
 * （2026-10-01 审阅 G1 端到端实测）。
 *
 * 地址真被改了时是**整体替换 + 清空 query / path 行**：`buildUrl` 已经把那些行拼进地址里了，
 * 不清空的话紧接着的变量替换会再拼一遍，参数直接翻倍。
 *
 * @param {object} spec 要发的请求，就地修改
 * @param {object} next 脚本跑完后的请求
 * @param {object} before 交给脚本时的请求（`toRunnerRequest` 的结果）
 */
function applyRunnerRequest(spec, next, before) {
    if (!next || typeof next !== 'object') return null;
    var original = before || {};

    if (next.method && next.method !== original.method) {
        var method = String(next.method).toUpperCase();
        if (SEND_METHODS.indexOf(method) === -1) {
            return '脚本把请求方法改成了不支持的值：' + next.method;
        }
        spec.method = method;
    }

    if (typeof next.url === 'string' && next.url !== '' && next.url !== original.url) {
        spec.url = next.url;
        spec.params.query = [];
        spec.params.path = [];
    }

    if (Array.isArray(next.headers) && JSON.stringify(next.headers) !== JSON.stringify(original.headers)) {
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

    if (next.body && typeof next.body === 'object' &&
        JSON.stringify(next.body) !== JSON.stringify(original.body)) {
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

/** 各层按「项目 → 目录链（从外到内）→ 环境 → 本次请求的临时变量」拼成一张表 */
function mergeScopes(scopes) {
    var source = scopes || {};
    var vars = {};

    [source.project].concat(source.folders || []).forEach(function (map) {
        Object.keys(map || {}).forEach(function (key) { vars[key] = map[key]; });
    });
    if (source.environment) {
        Object.keys(source.environment).forEach(function (key) { vars[key] = source.environment[key]; });
    }
    Object.keys(source.transient || {}).forEach(function (key) { vars[key] = source.transient[key]; });

    return vars;
}

/** 前置脚本出错时的结果：请求没有发出去，但错误码要说清楚是脚本的问题 */
function scriptFailureResult(scriptsRan, state) {
    var message = '前置脚本出错';

    if (state.errors.length) {
        message = state.errors[0].message;
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
        scripts: scriptsRan ? state : null
    };
}

/** 启用且 key 非空的行 */
function enabledRows(rows) {
    if (!Array.isArray(rows)) return [];

    return rows.filter(function (row) {
        if (!row || row.enabled === false) return false;
        return row.key !== null && row.key !== undefined && String(row.key) !== '';
    });
}

/* ------------------------------------------------------------------ 执行 */

/**
 * 把请求发出去。**永远 resolve**（执行器的约定），执行本身的问题都在 `result.error` 里。
 *
 * @param {object} prepared 云端 prepare 出来的上下文（可 JSON 序列化，见各自的字段注释）
 * @param {object} [hooks]
 * @param {AbortSignal} [hooks.signal] 取消信号（浏览器断开时调用方自己 abort）
 * @param {string[]} [hooks.fileRoots] 允许读哪些目录里的文件当请求体
 * @param {Function} [hooks.onReady] **前置脚本跑完、请求将要发出的那一刻**调用一次，
 *   参数是还没交给执行器的 `execOptions`。`/send/stream` 用它来开 NDJSON 响应
 *   （`ndjson.start`）并挂上 `onHead` / `onChunk` —— 时机必须在这里，早一步的话
 *   前置脚本内部出错就没法改回普通 JSON 错误了。
 * @param {Function} [hooks.onHead] 流式：响应头到达
 * @param {Function} [hooks.onChunk] 流式：响应体一段到达。**给了它就自动开流式**，
 *   也就是响应头到了之后不再有总超时（契约第 14 节）
 * @returns {Promise<{result: object, changes: object, resolvedAuth: object|null}>}
 *   `changes` = `{ scriptState: object|null, cookies: { set: [], removed: [] }|null }`，
 *   交给云端的 record 落库；`resolvedAuth` 是**变量替换之后**的鉴权，云端写历史时
 *   靠它认出哪些请求头要打码。
 */
function run(prepared, hooks) {
    var h = hooks || {};

    /**
     * 变量各层：会被 runner **就地修改**（链上串状态）。云端 prepare 出来的是刚解析好的
     * 一份，调用方不共用，所以放心改。
     */
    var scopes = prepared.scopes || { project: {}, folders: [], environment: null, transient: {} };
    var steps = prepared.steps || { prerequest: [], test: [] };
    var options = prepared.options || {};

    var scriptsEnabled = options.scripts !== false;
    var state = runner.emptyState();
    var scriptsRan = false;
    var aborted = false;
    var budget = runner.createBudget();

    /**
     * Cookie jar。云端 prepare 时就已经把过期的清掉、把行读出来了；这里按同一套
     * 匹配规则装进内存，执行完把增量交给云端落库 —— 网关从头到尾不碰云端的数据。
     */
    var jar = prepared.cookies
        ? cookies.createMemoryJar(prepared.cookies, function () { return Date.now(); })
        : null;

    var runnerRequest = toRunnerRequest(prepared.spec);
    var finalRunnerRequest = null;

    /**
     * 变量表。**故意留成 null**：`pm.sendRequest` 在前置脚本里被调用时，它还是 null ——
     * 也就是说脚本里那次子请求不做变量替换。这是拆分之前就有的行为，不要「顺手修」，
     * 修了就等于改了既有语义（现有测试没覆盖到，但审阅方会对比）。
     */
    var vars = null;
    var resolvedSpec = null;

    function proxyFor(url) {
        if (!prepared.proxy) return null;
        return proxySettings.forTarget(prepared.proxy, url);
    }

    /**
     * 把脚本里的 `pm.sendRequest` 交出去。
     *
     * 代理设置和这次请求相同、Cookie jar 用同一个、超时 10 秒（契约第 16 节）。
     * **不记入历史** —— 它是脚本自己的动作，不是用户在发请求。
     */
    function sendRequest(json) {
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

        var subOptions = {
            variables: vars,
            timeoutMs: SUB_REQUEST_TIMEOUT_MS,
            followRedirects: true,
            rejectUnauthorized: false,
            fileRoots: h.fileRoots
        };
        if (jar) subOptions.cookieJar = jar;

        var target = proxyFor(urlUtils.buildUrl(spec));
        if (target) subOptions.proxy = target;

        return executor.execute(spec, subOptions).then(function (result) {
            return JSON.stringify(toScriptResponse(result));
        }).catch(function (err) {
            return JSON.stringify({ error: { message: (err && err.message) || '请求失败' } });
        });
    }

    function changes() {
        var jarChanges = jar ? jar.changes() : null;

        return {
            scriptState: scriptsRan ? state : null,
            cookies: jarChanges ? { set: jarChanges.upserts, removed: jarChanges.deletes } : null
        };
    }

    function finish(result) {
        return { result: result, changes: changes(), resolvedAuth: resolvedSpec ? resolvedSpec.auth : null };
    }

    /** 跑前置脚本，并把它们改过的请求与变量算进这次执行 */
    function runPrerequest() {
        if (!scriptsEnabled || !runner.hasRunnable(steps.prerequest)) return Promise.resolve();

        return runner.runChain('prerequest', steps.prerequest, {
            request: runnerRequest,
            scopes: scopes,
            sendRequest: sendRequest,
            info: { requestName: prepared.apiName },
            budget: budget
        }).then(function (outcome) {
            scriptsRan = true;
            mergeScriptStates(state, outcome.state);

            var problem = applyRunnerRequest(prepared.spec, outcome.request, runnerRequest);
            if (problem) {
                state.errors.push({ phase: 'prerequest', source: '接口', message: problem });
                outcome.aborted = true;
            }

            aborted = outcome.aborted;
            finalRunnerRequest = outcome.request;
        });
    }

    /**
     * 跑测试脚本。**取消、或者根本没有响应时不跑**（契约第 14、16 节）。
     * 结果并进 `state`，由云端的 record 挂到 result 上。
     */
    function runTest(result) {
        if (!scriptsEnabled || !runner.hasRunnable(steps.test)) return Promise.resolve();
        if (!result.response) return Promise.resolve();
        if (result.error && result.error.code === 'ABORTED') return Promise.resolve();

        return runner.runChain('test', steps.test, {
            request: finalRunnerRequest || runnerRequest,
            response: toScriptResponse(result),
            scopes: scopes,
            sendRequest: sendRequest,
            info: { requestName: prepared.apiName },
            budget: budget
        }).then(function (outcome) {
            scriptsRan = true;
            mergeScriptStates(state, outcome.state);
        });
    }

    /**
     * 脚本跑完之后才算得出的那几样。顺序就是契约第 16 节第 1、2 步：
     * 「脚本改过的变量 → 替换变量 → 发送」，所以变量表必须在这里重建。
     */
    function buildExecOptions() {
        vars = mergeScopes(scopes);
        resolvedSpec = variables.resolveSpec(prepared.spec, vars).spec;

        var execOptions = {
            variables: vars,
            timeoutMs: options.timeoutMs,
            followRedirects: options.followRedirects,
            // 本地接口工作台多半在连自签名的内网地址
            rejectUnauthorized: false,
            signal: h.signal,
            fileRoots: h.fileRoots
        };

        if (jar) execOptions.cookieJar = jar;

        var target = proxyFor(resolvedSpec.url);
        if (target) execOptions.proxy = target;

        // 给了 onChunk 就是流式：`head` 到了之后不再有总超时（契约第 14 节）
        if (typeof h.onChunk === 'function') execOptions.stream = true;
        if (typeof h.onHead === 'function') execOptions.onHead = h.onHead;
        if (typeof h.onChunk === 'function') execOptions.onChunk = h.onChunk;

        return execOptions;
    }

    return runPrerequest().then(function () {
        var execOptions = buildExecOptions();

        // 前置脚本跑完了。流式那边要在这里把响应头吐出去 —— 再早，脚本内部出错就来不及
        // 改回普通 JSON 错误；再晚，「取消」和「脚本改错了请求方法」这两条路就没机会
        // 先把响应头发出去。
        if (typeof h.onReady === 'function') h.onReady(execOptions);

        // 前置脚本出错：请求不发送（契约第 16 节），结果仍然是完整的一份 ExecResult
        if (aborted) return finish(scriptFailureResult(scriptsRan, state));

        return executor.execute(prepared.spec, execOptions).then(function (result) {
            return runTest(result).then(function () { return finish(result); });
        });
    });
}

module.exports = {
    run: run,
    SEND_METHODS: SEND_METHODS,
    SUB_REQUEST_TIMEOUT_MS: SUB_REQUEST_TIMEOUT_MS,
    // 拆出去的两小块：目录变量那侧要用同一个顺序拼各层，别处不要再写一份
    mergeScopes: mergeScopes,
    toRunnerRequest: toRunnerRequest
};
