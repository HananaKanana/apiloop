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
var assertions = require('./assertions');
var dbOps = require('./db-ops');
var mockEnv = require('./api/mock-env');
var regexGuard = require('./regex-guard');

/** 可视化断言和提取变量最多跑多久（里面可能有用户写的正则） */
var ASSERTION_TIMEOUT_MS = 2000;
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
    if (source.visualizer) target.visualizer = source.visualizer;
    target.console = target.console.concat(source.console);
    target.errors = target.errors.concat(source.errors);

    source.warnings.forEach(function (text) {
        if (target.warnings.indexOf(text) === -1) target.warnings.push(text);
    });

    mergeVarChanges(target.variables.environment, source.variables.environment);
    mergeVarChanges(target.variables.project, source.variables.project);

    return target;
}

/** cookie 对象 → 一条 `Set-Cookie` 头（把内存 jar 里的增量倒回去，见 applyCookieChanges） */
function toSetCookieHeader(cookie) {
    var parts = [String(cookie.name) + '=' + String(cookie.value)];

    if (cookie.domain) parts.push('Domain=' + String(cookie.domain));
    if (cookie.path) parts.push('Path=' + String(cookie.path));
    if (cookie.expires) parts.push('Expires=' + new Date(Number(cookie.expires)).toUTCString());
    if (cookie.secure) parts.push('Secure');
    if (cookie.httpOnly) parts.push('HttpOnly');

    return parts.join('; ');
}

/** 这条 cookie 是从哪个地址种下来的（host-only 的 cookie 靠它认域名） */
function cookieOrigin(cookie) {
    var host = String(cookie.domain || 'localhost').replace(/^\./, '');
    return 'https://' + host + (cookie.path || '/');
}

/**
 * 把一份 cookie 增量（`{ set: [cookie], removed: [cookie] }`）喂进内存 jar。
 *
 * 前置接口（第十轮第 3 节）常常是**种 Cookie** 而不是给 token，所以它那一次拿到的
 * Set-Cookie 必须并进主请求这一份 jar：主请求要带得上，`record` 也要一起写回库。
 *
 * jar 只开了 `cookieHeaderFor` / `storeFrom` / `changes` 三个口子，所以这里把 cookie
 * 对象**倒回 `Set-Cookie` 头**再走 `storeFrom` —— 走别的路（直接改 jar 内部）就等于
 * 绕过了 `initialByKey`，那些 cookie 永远不会出现在 `changes()` 里、写不回库。
 */
function applyCookieChanges(jar, change) {
    if (!jar || !change) return;

    (change.set || []).forEach(function (cookie) {
        if (!cookie || !cookie.name) return;
        jar.storeFrom(cookieOrigin(cookie), [toSetCookieHeader(cookie)]);
    });

    (change.removed || []).forEach(function (cookie) {
        if (!cookie || !cookie.name) return;
        jar.storeFrom(cookieOrigin(cookie), [toSetCookieHeader(cookie) + '; Max-Age=0']);
    });
}

/** 各层按「项目 → 目录链（从外到内）→ 环境 → 本次请求的临时变量」拼成一张表 */
function mergeScopes(scopes) {    var source = scopes || {};
    var vars = {};

    [source.project].concat(source.folders || []).forEach(function (map) {
        Object.keys(map || {}).forEach(function (key) { vars[key] = map[key]; });
    });
    if (source.environment) {
        Object.keys(source.environment).forEach(function (key) { vars[key] = source.environment[key]; });
    }
    /*
     * 数据驱动的那一行（第八轮第 1 节）：**在环境之后、本次请求的临时变量之前**。
     * 没有数据时 `source.data` 是 undefined，这一段什么也不做 —— 普通发送、
     * 批量运行的行为一个字都不变。
     */
    Object.keys(source.data || {}).forEach(function (key) { vars[key] = source.data[key]; });

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
     * 数据库操作（第九轮第 3 节）只在**用户自己那台机器**上执行：连接（含密码）配在本机，
     * 云端也不该拿着项目里的库账号去连生产库。`prepared.dbAllowed` 由 `lib/api/send.js`
     * 的 prepare 按 `ctx.localSend` 放进来。
     */
    var dbAllowed = prepared.dbAllowed === true;
    var dbOpsList = dbOps.toDbOps(prepared.dbOps);
    var databases = Array.isArray(prepared.databases) ? prepared.databases : [];
    var dbSkipNoticed = false;

    /**
     * 前置接口（第十轮第 3 节）：`prepared.preflight` 是**另一份完整的 prepared**
     * （由 `lib/api/send.js` 的 prepare 递归准备出来的），条件满足时先跑它一遍。
     * 没配过时它和 `preflightRule` 都是 null —— 那样这次执行和以前一个字都不差。
     */
    var preflight = prepared.preflight || null;
    var preflightRule = prepared.preflightRule || null;
    /** 这次执行里已经自动调过一次前置接口没有（401 只重发一次，别套娃） */
    var preflightRan = false;

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
     * 提取出来的变量并进这次执行：既进变量变更（云端照常写回库、保密变量照常走
     * `secrets.applyChange`），也同步进 `scopes` 和 `vars`。
     *
     * 同步进 `scopes` 是**顺序要求**：后面的脚本 `pm.environment.get` 读的是它；
     * `vars`（给 `pm.sendRequest` 用的那张合并表）也一起更新，免得脚本里两个读法
     * 看到的值不一样。
     *
     * 可视化提取（`lib/assertions.js`）和数据库操作的提取（`lib/db-ops.js`）结果是**同一个
     * 形状**，所以共用这一段 —— 两处各写一遍迟早有一处忘了同步 `scopes`。
     */
    function applyExtracted(outcome) {
        if (!outcome) return;

        [
            { scope: 'environment', values: outcome.environment, changes: state.variables.environment },
            { scope: 'project', values: outcome.project, changes: state.variables.project }
        ].forEach(function (item) {
            Object.keys(item.values).forEach(function (name) {
                item.changes.set[name] = item.values[name];

                var table = item.scope === 'environment'
                    ? (scopes.environment || (scopes.environment = {}))
                    : (scopes.project || (scopes.project = {}));
                table[name] = item.values[name];
                if (vars) vars[name] = item.values[name];
            });
        });

        outcome.console.forEach(function (line) { state.console.push(line); });
        outcome.warnings.forEach(function (text) { state.warnings.push(text); });
    }

    /* ---------------------------------------------------------- 前置接口 */

    /** 「变量 X 没有值」的判据：取不到、null、空串（只有空白也算没有）都算没有 */
    function variableMissing(name) {
        var value = mergeScopes(scopes)[name];
        return value === undefined || value === null || String(value).trim() === '';
    }

    /** 这次要不要先跑前置接口（`forcePreflight` 是界面上 401 重发那条路） */
    function preflightDue() {
        if (!preflight) return false;
        if (options.forcePreflight === true) return true;
        if (!preflightRule || !preflightRule.whenMissing) return false;
        return variableMissing(preflightRule.whenMissing);
    }

    /**
     * 401 重发要不要在**服务端**做。
     *
     * 流式（界面上点「发送」走的就是它）**做不了**：响应头已经吐给浏览器了，
     * 再换一份响应就等于说了两次话。那条路由前端拿到 401 之后带 `forcePreflight` 再发一次。
     */
    function retryOn401Due(result) {
        if (!preflight || !preflightRule || !preflightRule.retryOn401) return false;
        if (preflightRan) return false;
        if (typeof h.onChunk === 'function') return false;
        return Boolean(result && result.response && result.response.status === 401);
    }

    /** 前置接口那一次的变量改动，写进这次执行的变量层（后面替换变量时用得上） */
    function applyPreflightVars(change, scope) {
        if (!change) return;

        var table = scope === 'environment'
            ? (scopes.environment || (scopes.environment = {}))
            : (scopes.project || (scopes.project = {}));

        Object.keys(change.set || {}).forEach(function (name) { table[name] = change.set[name]; });
        (change.unset || []).forEach(function (name) { delete table[name]; });
    }

    /**
     * 跑一遍前置接口，把它那一次的变量改动、Cookie 增量、控制台都并进这次执行。
     *
     * **「变量并进来」是这整件事的关键**：登录接口在「断言」页签里提取的 token 进了这次
     * 执行，`record` 就照常写回环境 —— 下次连前置接口都不用调了（测试集里也是靠这一条
     * 做到「一次运行只登录一次」）。
     *
     * 前置接口失败**不影响主请求**（token 可能其实还有效），只在控制台里写清楚原因。
     */
    function runPreflightOnce(reason) {
        if (!preflight) return Promise.resolve();

        preflightRan = true;

        /**
         * 数据驱动的那一行要跟着走：登录接口常常用 `{{username}}` 这种来自测试集数据行的值，
         * 而 `prepared.preflight.scopes` 是 prepare 那一刻算的，里面没有这一行
         * （主请求的 `prepared.scopes` 会被测试集换成叠加过的那一份）。
         */
        if (preflight.scopes) {
            preflight.scopes.data = scopes.data;
            preflight.scopes.transient = scopes.transient;
        }

        var name = (preflightRule && preflightRule.apiName) || '未命名接口';

        return run(preflight, { signal: h.signal, fileRoots: h.fileRoots }).then(function (outcome) {
            var nested = outcome && outcome.changes ? outcome.changes.scriptState : null;

            if (nested) {
                mergeVarChanges(state.variables.environment, nested.variables.environment);
                mergeVarChanges(state.variables.project, nested.variables.project);
                applyPreflightVars(nested.variables.environment, 'environment');
                applyPreflightVars(nested.variables.project, 'project');

                // 前置接口自己的测试结果 / 控制台也带出来（它失败的原因用户要看得到）
                state.tests = state.tests.concat(nested.tests);
                state.console = state.console.concat(nested.console);
                state.errors = state.errors.concat(nested.errors);
                (nested.warnings || []).forEach(function (text) {
                    if (state.warnings.indexOf(text) === -1) state.warnings.push(text);
                });
            }

            // Cookie 也一样要并进来：登录接口常常是种 Cookie 而不是给 token
            applyCookieChanges(jar, outcome ? outcome.changes.cookies : null);

            /**
             * 这一节跑过就必须置 `scriptsRan` —— 否则 `changes.scriptState` 是 null，
             * 上面合并进来的变量和下面这一行提示都到不了前端（第六轮踩过同一个坑）。
             */
            scriptsRan = true;
            state.console.push({
                level: 'log',
                source: '前置接口',
                text: '已自动调用前置接口「' + name + '」（' + reason + '）'
            });

            var failure = preflightFailure(outcome, nested);
            if (failure) {
                state.console.push({
                    level: 'warn',
                    source: '前置接口',
                    text: '前置接口「' + name + '」没跑成功：' + failure + '。主请求照常发出'
                });
            }
        });
    }

    /**
     * 前置接口那一次算不算「没跑成功」。
     *
     * 三种都算：请求根本没发出去 / 连不上（`result.error`）、响应是 4xx 5xx
     * （登录接口认证失败就是 401）、它自己的断言没过。这三种**都不阻止主请求发出**
     * （token 可能其实还有效），所以只在控制台写一句原因。
     */
    function preflightFailure(outcome, nested) {
        var result = outcome && outcome.result;

        if (result && result.error && result.error.message) return String(result.error.message);

        var status = result && result.response ? Number(result.response.status) : 0;
        if (status >= 400) return '响应 ' + status;

        var failedTest = ((nested && nested.tests) || []).filter(function (item) { return !item.passed; })[0];
        if (failedTest) return failedTest.name + '：' + (failedTest.error || '没通过');

        return '';
    }

    /**
     * 可视化断言与提取变量（第六轮第 1 节）。**拿到响应之后、跑「响应后」脚本之前**：
     * 顺序是刻意的 —— 提取出来的变量要能在这段脚本里读到（`pm.environment.get('token')`）。
     *
     * 和 `runTest` 同一套跳过条件：脚本开关关掉（断言就是一种不用写代码的脚本）、
     * 没有响应、请求被取消。
     *
     * 结果都并进 `state`，由云端的 record 落库 / 挂回 `result.scripts`。**只要这一节
     * 真的跑了就置 `scriptsRan`** —— 否则「只有断言、没有脚本」的接口跑完，
     * `changes.scriptState` 是 null，提取的变量写不回库、前端也看不到测试结果。
     */
    function runAssertionsAndExtracts(result) {
        if (!scriptsEnabled) return;
        if (!result.response) return;
        if (result.error && result.error.code === 'ABORTED') return;

        var rows = assertions.toAssertions(prepared.assertions);
        var extracts = assertions.toExtracts(prepared.extracts);
        if (!rows.length && !extracts.length) return;

        scriptsRan = true;
        var ctx = assertions.createContext(result);

        /**
         * 断言和提取里可以写正则，网页版发请求时是在**云端**跑的 —— 写坏的正则会卡住整个云端，
         * 所以最多跑 2 秒（见 lib/regex-guard.js）。超时就记一条没通过的结果，提取一个都不生效。
         */
        var computed = regexGuard.runWithTimeout(function () {
            return {
                tests: assertions.runAssertions(rows, ctx, vars),
                outcome: assertions.runExtracts(extracts, ctx, { hasEnvironment: hasEnvironment() })
            };
        }, ASSERTION_TIMEOUT_MS);

        if (computed.timedOut) {
            state.tests.push({
                name: '断言和提取变量',
                passed: false,
                error: '执行超时：里面的正则太复杂了，换个写法再试',
                source: '断言'
            });
            return;
        }

        computed.value.tests.forEach(function (entry) {
            state.tests.push(entry);
        });

        applyExtracted(computed.value.outcome);
    }

    /* ---------------------------------------------------------- 数据库操作 */

    /** 这个操作指的是哪个连接（找不到就是 null，运行时会报「没有找到这个连接」） */
    function connectionFor(connectionId) {
        var id = dto.str(connectionId);
        if (!id) return null;
        for (var i = 0; i < databases.length; i++) {
            if (databases[i] && databases[i].id === id) return databases[i];
        }
        return null;
    }

    /** 没选环境（或选的是内置 Mock 环境，它不存库）时「存到环境」的提取不生效 */
    function hasEnvironment() {
        return Boolean(prepared.environmentId) && !mockEnv.isMockEnvironment(prepared.environmentId);
    }

    /**
     * 跑某一阶段的数据库操作。
     *
     * 顺序：**请求前 → 请求前脚本 → 发请求 → 响应后 → 可视化断言和提取 → 响应后脚本**。
     * 响应后那一批排在断言前面，是为了让断言能用「刚从库里查出来的变量」
     * （比如断言 `code` 等于 `{{dbCode}}`）。
     *
     * 请求前的失败了就**不发请求**（和请求前脚本出错一样）：多半是造数据失败了，
     * 这时候发出去只会得到一堆看不懂的结果。响应后的失败**只记一条没通过的测试结果**，
     * 不影响已经拿到的响应。
     *
     * 网页版（云端发送）上一条都不跑，只提示一句 —— 连接里有密码，也不该拿它去连生产库。
     *
     * @param {'pre'|'post'} phase
     * @param {object} [result] 响应后那一批才有（提取的取值基准不是它，见下面）
     * @returns {Promise<{failed: boolean}>}
     */
    function runDbOps(phase) {
        var list = dbOps.opsFor(dbOpsList, phase);
        if (!list.length) return Promise.resolve({ failed: false });

        /**
         * 跑不了的时候也要**置 `scriptsRan`**：不然 `changes.scriptState` 是 null，
         * 这句提示根本到不了前端（`result.scripts` 是挂上去的那一份）。
         */
        if (!dbAllowed) {
            scriptsRan = true;
            if (!dbSkipNoticed) {
                dbSkipNoticed = true;
                state.console.push({
                    level: 'warn',
                    source: '数据库',
                    text: '数据库操作只在客户端里执行，这次跳过了'
                });
            }
            return Promise.resolve({ failed: false });
        }

        // 一次跑一条：造数据常有先后依赖（先插用户、再插订单），乱序并发只会更难查
        return list.reduce(function (chain, op) {
            return chain.then(function (carried) {
                if (carried.failed) return carried;

                return dbOps.run(op, connectionFor(op.connectionId), mergeScopes(scopes))
                    .then(function (outcome) {
                        scriptsRan = true;
                        afterDbOp(op, outcome, phase);
                        return { failed: !outcome.ok && phase === 'pre' };
                    });
            });
        }, Promise.resolve({ failed: false }));
    }

    /** 一次数据库操作跑完之后：控制台一行、提取的变量并进这次执行；失败再记一条测试结果 */
    function afterDbOp(op, outcome, phase) {
        var connection = connectionFor(op.connectionId);
        var line = dbOps.consoleLine(outcome, connection);
        if (line) state.console.push(line);

        if (!outcome.ok) {
            /**
             * 请求前失败要让 `scriptFailureResult` 把原因带出去（那儿取 `state.errors[0]`），
             * 所以这一条得排在最前面 —— 出错的原因就是用户最想先看到的。
             */
            if (phase === 'pre') {
                state.errors.unshift({
                    phase: 'prerequest',
                    source: '数据库操作',
                    message: dbOps.labelOf(outcome, connection) + ' 失败：' + outcome.error
                });
            } else {
                state.tests.push(dbOps.testEntry({ ok: false, error: outcome.error, statement: op.statement }, connection));
            }
            return;
        }

        if (!op.extracts.length) return;

        // SQL 的取值基准是返回的行数组、Redis 是命令的返回值
        var base = outcome.kind === 'value' ? outcome.value : outcome.rows;
        applyExtracted(dbOps.runExtracts(op.extracts, base, { hasEnvironment: hasEnvironment() }));
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

    /** 发一次主请求（每次重新算变量表 —— 脚本 / 前置接口都可能刚改过变量） */
    function sendOnce() {
        return executor.execute(prepared.spec, buildExecOptions());
    }

    /** 拿到响应之后的那一摊：响应后的数据库操作 → 断言和提取 → 响应后脚本 */
    function afterResponse(result) {
        /**
         * 响应后的数据库操作排在断言**前面**：断言要能用刚从库里查出来的变量
         * （`code` 等于 `{{dbCode}}`）。被取消时一次都不跑 —— 用户已经不要这次结果了。
         */
        var skipped = result.error && result.error.code === 'ABORTED';
        return (skipped ? Promise.resolve() : runDbOps('post')).then(function () {
            runAssertionsAndExtracts(result);
            return runTest(result).then(function () { return finish(result); });
        });
    }

    /**
     * 响应是 401 时自动登录一次再重发（只重发一次，见 `retryOn401Due`）。
     *
     * 重发前**必须把变量表重算一遍**（`sendOnce` 里会做）：前置接口刚把 token 提取出来，
     * 地址 / 请求头里那些 `{{token}}` 要用上新的值。
     */
    function retryAfter401(result) {
        state.console.push({
            level: 'warn',
            source: '前置接口',
            text: '响应 401，已自动调用前置接口「' + ((preflightRule && preflightRule.apiName) || '未命名接口') + '」并重发'
        });
        scriptsRan = true;

        return runPreflightOnce('因为响应 401').then(function () {
            return sendOnce().then(afterResponse);
        });
    }

    // 先看要不要调前置接口（「变量没有值」这条），再走原来的顺序
    return (preflightDue() ? runPreflightOnce('因为变量 ' + preflightRule.whenMissing + ' 没有值') : Promise.resolve())
        .then(function () {
            return runDbOps('pre').then(function (pre) {
                // 请求前的数据库操作失败了：不发请求（和请求前脚本出错一样的处理）
                if (pre.failed) return finish(scriptFailureResult(scriptsRan, state));

                return runPrerequest().then(function () {
                    var execOptions = buildExecOptions();

                    // 前置脚本跑完了。流式那边要在这里把响应头吐出去 —— 再早，脚本内部出错就来不及
                    // 改回普通 JSON 错误；再晚，「取消」和「脚本改错了请求方法」这两条路就没机会
                    // 先把响应头发出去。
                    if (typeof h.onReady === 'function') h.onReady(execOptions);

                    // 前置脚本出错：请求不发送（契约第 16 节），结果仍然是完整的一份 ExecResult
                    if (aborted) return finish(scriptFailureResult(scriptsRan, state));

                    return sendOnce().then(function (result) {
                        if (!retryOn401Due(result)) return afterResponse(result);
                        return retryAfter401(result);
                    });
                });
            });
        });
}

/* ------------------------------------------------------------------ 本地网络授权提示 */

/** 私有网段：第一次访问这些地址被系统拦下时，错误信息要换成授权提示 */
var PRIVATE_PATTERNS = [
    /^10\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^192\.168\./,
    /^169\.254\./
];

/** 设计稿（local-agent）第 3.3 节的那段提示，第一次访问局域网必然会看到它 */
var LOCAL_NETWORK_HINT = '请求失败：系统还没有允许 node 访问本地网络。' +
    '请在系统弹出的「本地网络」授权框中点「允许」，然后重新发送。' +
    '如果没看到弹框，到「系统设置 → 隐私与安全性 → 本地网络」里把 node 打开。';

/**
 * 从错误信息里取出**实际连出去的那个地址**（G0 审阅 N5）。
 *
 * 只看 URL 里写的是不是私有 IP 是不够的：`http://dev.lan` 这种主机名解析到
 * 192.168.x.x，URL 上看不出来，而系统照样会拦。执行器把底层错误原样放在消息里
 * （形如 `connect EHOSTUNREACH 192.168.17.3:8080`），从那儿取才准。
 */
function hostFromError(message) {
    var matched = /EHOSTUNREACH[^\dA-Za-z]*(\[[0-9a-fA-F:]+\]|(?:\d{1,3}\.){3}\d{1,3})/
        .exec(String(message || ''));
    if (!matched) return null;
    return matched[1].replace(/^\[/, '').replace(/\]$/, '');
}

/** 这个地址是不是私有网段（含 IPv6 的环回、唯一本地、链路本地） */
function isPrivateAddress(host) {
    var value = String(host || '');
    if (!value) return false;

    if (value.indexOf(':') > -1) {
        var lower = value.toLowerCase();
        if (lower === '::1') return true;
        return /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower);
    }

    return PRIVATE_PATTERNS.some(function (pattern) { return pattern.test(value); });
}

/**
 * macOS 上第一次访问局域网必然失败：授权框还没被点掉，内核直接回 EHOSTUNREACH。
 * 只看「连不上」用户没法自救，所以把错误信息换成明确指引。
 *
 * **只有跑在用户自己那台机器上的那一次才该换**（网关的本机管理台）：云端（Docker）
 * 到不了私有地址是网络不通，跟 macOS 的授权没有半点关系，换上这段话只会误导人。
 * 所以调用方要按「这个管理台是不是本机的」来决定要不要调它。
 *
 * @param {object} result 执行器的结果的 `result` 那一份，原地改
 */
function applyLocalNetworkHint(result) {
    if (!result || !result.error) return result;
    if (!/EHOSTUNREACH/.test(String(result.error.message || ''))) return result;

    var actual = hostFromError(result.error.message);
    if (!isPrivateAddress(actual)) return result;

    result.error.message = LOCAL_NETWORK_HINT;
    result.error.localNetworkHint = true;
    return result;
}

module.exports = {
    run: run,
    SEND_METHODS: SEND_METHODS,
    SUB_REQUEST_TIMEOUT_MS: SUB_REQUEST_TIMEOUT_MS,
    // 拆出去的两小块：目录变量那侧要用同一个顺序拼各层，别处不要再写一份
    mergeScopes: mergeScopes,
    toRunnerRequest: toRunnerRequest,
    // 本机发送失败时的「本地网络」授权提示（网关那台才用）
    applyLocalNetworkHint: applyLocalNetworkHint,
    hostFromError: hostFromError,
    isPrivateAddress: isPrivateAddress,
    LOCAL_NETWORK_HINT: LOCAL_NETWORK_HINT
};
