/**
 * 测试集的执行（第八轮第 1 节）。**第九轮的命令行直接用它**。
 *
 * 三条硬约束：
 * - **不碰 express / `req` / `res`** —— 给什么跑什么；
 * - **不写库** —— 提取和脚本设置的变量只活在这次运行的内存里（计划里那句「不会改环境里
 *   保存的值」），Cookie 也只在这一份运行里流转；
 * - 结果整份回给调用方（接口层去存运行记录、去推 NDJSON 事件）。
 *
 * 每一步的动作和界面里点「发送」是同一套：`preparer.prepare` 拼出「准备好的请求」
 * （变量、鉴权继承、公共请求头都在里面），`sendCore.run` 发出去并跑脚本 / 断言。
 * 区别只有：不写历史、不读也不写 Cookie 表、变量改动只留在这份运行里。
 */

var sendCore = require('./send-core');
var suiteData = require('./suite-data');
var redact = require('./redact');
var mockEnv = require('./api/mock-env');
var helpers = require('./db/repos/helpers');
var apisRepo = require('./db/repos/apis');
var environmentsRepo = require('./db/repos/environments');

/** 失败步骤的响应体最多存这么多（报告里能看出问题就够了） */
var MAX_RESPONSE_BYTES = 32 * 1024;

/** 整个 result 超过这个大小就去掉所有 request / response 再存 */
var MAX_RESULT_BYTES = 2 * 1024 * 1024;

function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function sleep(ms, signal) {
    var wait = Number(ms);
    if (!Number.isFinite(wait) || wait <= 0) return Promise.resolve();

    return new Promise(function (resolve) {
        var timer = setTimeout(function () {
            if (signal) signal.removeEventListener('abort', onAbort);
            resolve();
        }, Math.min(wait, 10 * 60 * 1000));

        function onAbort() {
            clearTimeout(timer);
            resolve();
        }

        if (signal) signal.addEventListener('abort', onAbort);
    });
}

/**
 * 把接口当前保存的内容拼成 `request`（和前端 `specFromApi` 一个形状）。
 *
 * 地址里的查询串只在**地址自己没带 `?`** 时才从 query 行拼进去（和界面上的地址栏
 * 双向同步同一个规则）；真发的时候 `buildUrl` 以 query 行为准，所以这里拼不拼都不影响
 * 实际发出的请求，拼上只是让报告里显示的请求和界面上看到的一致。
 */
function requestOfApi(api) {
    var params = api.params || {};
    var query = clone(params.query || []) || [];
    var url = String(api.url || '');

    if (url.indexOf('?') === -1) {
        var extra = query.filter(function (row) {
            return row && row.enabled !== false && row.key;
        }).map(function (row) {
            return encodeURIComponent(row.key) + '=' +
                encodeURIComponent(row.value === undefined || row.value === null ? '' : row.value);
        }).join('&');

        if (extra) url = url.split('#')[0] + '?' + extra;
    }

    return {
        method: String(api.method || 'GET').toUpperCase(),
        url: url,
        params: {
            path: clone(params.path || []) || [],
            query: query,
            headers: clone(params.headers || []) || []
        },
        body: clone(api.body || { mode: 'none' }),
        auth: api.auth ? clone(api.auth) : null,
        scripts: clone(api.scripts || []) || [],
        // 断言 / 提取：接口自己的 + 步骤追加的（都在下面拼好再传进来）
        assertions: [],
        extracts: []
    };
}

/** 把 `{ set, unset }` 落到一张变量表上 */
function applyChanges(table, change) {
    if (!table || !change) return;

    Object.keys(change.set || {}).forEach(function (key) { table[key] = change.set[key]; });
    (change.unset || []).forEach(function (key) { delete table[key]; });
}

/** 合并一份变量改动（后写的覆盖先写的，unset 要把之前记下的 set 撤掉） */
function mergeChanges(target, change) {
    if (!target || !change) return;

    Object.keys(change.set || {}).forEach(function (key) { target.set[key] = change.set[key]; });
    (change.unset || []).forEach(function (key) {
        delete target.set[key];
        if (target.unset.indexOf(key) === -1) target.unset.push(key);
    });
}

/** 这次运行里累积的变量改动，叠到 prepare 出来的那几层上 */
function overlayScopes(scopes, changes, row) {
    var next = {
        project: Object.assign({}, scopes.project || {}),
        folders: (scopes.folders || []).map(function (map) { return Object.assign({}, map); }),
        environment: scopes.environment ? Object.assign({}, scopes.environment) : scopes.environment,
        // 数据驱动这一轮的那一行（没有数据时是 undefined，行为照旧）
        data: row || undefined,
        transient: {}
    };

    applyChanges(next.project, changes.project);
    if (next.environment) applyChanges(next.environment, changes.environment);
    return next;
}

/** Cookie 的唯一键：域名 + 路径 + 名字（和 lib/cookies.js 的 keyOf 同一个口径） */
function cookieKey(cookie) {
    return [
        String((cookie && cookie.domain) || '').toLowerCase(),
        String((cookie && cookie.path) || '/'),
        String((cookie && cookie.name) || '')
    ].join('|');
}

/**
 * 把一步跑完的 Cookie 增量合进这次运行自己那份（不碰库）。
 *
 * 增量的字段名是 **`{ set, removed }`** —— 这是 `send-core` 的 `changes.cookies` 的口径
 * （它从内存 jar 的 `{ upserts, deletes }` 转过来的），别拿 jar 内部那套名字来对。
 */
function applyCookieChanges(rows, change) {
    var byKey = {};
    var order = [];

    (rows || []).forEach(function (cookie) {
        var key = cookieKey(cookie);
        if (!byKey[key]) order.push(key);
        byKey[key] = cookie;
    });

    ((change && change.removed) || []).forEach(function (cookie) {
        delete byKey[cookieKey(cookie)];
    });
    ((change && change.set) || []).forEach(function (cookie) {
        var key = cookieKey(cookie);
        if (!byKey[key]) order.push(key);
        byKey[key] = cookie;
    });

    return order.filter(function (key) { return Boolean(byKey[key]); })
        .map(function (key) { return byKey[key]; });
}

/** 响应体太长就截断（报告里只要够看出问题） */
function trimBody(text) {
    var value = typeof text === 'string' ? text : '';
    if (Buffer.byteLength(value, 'utf8') <= MAX_RESPONSE_BYTES) return value;

    var buffer = Buffer.from(value, 'utf8').subarray(0, MAX_RESPONSE_BYTES);
    return buffer.toString('utf8') + '\n…（响应体超过 32 KB，已截断）';
}

/** 失败步骤要存下来的请求 / 响应（**打码之后**才进记录） */
function payloadFor(result, secretValues) {
    var masked = redact.maskSecrets({
        request: result.request
            ? {
                method: result.request.method,
                url: result.request.url,
                headers: result.request.headers,
                bodyPreview: result.request.bodyPreview
            }
            : null,
        response: result.response
            ? {
                status: result.response.status,
                statusText: result.response.statusText,
                headers: result.response.headers,
                body: trimBody(result.response.body)
            }
            : null
    }, secretValues || []);

    if (masked.request) masked.request.headers = redact.redactHeaders(masked.request.headers);
    if (masked.response) masked.response.headers = redact.redactHeaders(masked.response.headers);
    return masked;
}

/**
 * 跑一个测试集。
 *
 * @param {object} input
 * @param {object} input.handle
 * @param {object} input.preparer `lib/api/send.js` 的 `createPreparer(ctx)`
 * @param {object} input.project 项目行
 * @param {object} input.suite 测试集（DTO）
 * @param {string} [input.environmentId]
 * @param {string} [input.mockBase]
 * @param {{user: {id: string}, role: string}} input.who
 * @param {AbortSignal} [input.signal]
 * @param {string[]} [input.fileRoots]
 * @param {Function} [input.onEvent] 每步跑完回调一次（`start` / `step` 两种事件）
 * @returns {Promise<{runId, status, summary, result, environmentName, startedAt, finishedAt}>}
 */
async function runSuite(input) {
    var handle = input.handle;
    var preparer = input.preparer;
    var project = input.project;
    var suite = input.suite || {};
    var who = input.who || { user: { id: null }, role: 'viewer' };
    var signal = input.signal;
    var onEvent = typeof input.onEvent === 'function' ? input.onEvent : function () {};
    var settings = suite.settings || {};

    var runId = helpers.newId('run');
    var startedAt = Date.now();

    /** 每一步之间的间隔（步骤自己的等待在它之外） */
    var gapMs = Math.max(0, Number(settings.delayMs) || 0);
    var timeoutMs = Number(settings.timeoutMs);

    var steps = (suite.steps || []).filter(function (step) {
        return step && step.enabled !== false && step.apiId;
    });

    function finish(status, extra) {
        return Object.assign({
            runId: runId,
            status: status,
            startedAt: startedAt,
            finishedAt: Date.now()
        }, extra);
    }

    function failure(status, message) {
        return finish(status, {
            summary: { iterations: 0, requests: 0, passed: 0, failed: 0, errors: 1, assertions: { passed: 0, failed: 0 }, durationMs: Date.now() - startedAt, avgMs: 0, message: message },
            result: { iterations: [] },
            environmentName: environmentName()
        });
    }

    /** 环境名（记录里存名字，第九轮的命令行也按名字选环境） */
    function environmentName() {
        if (mockEnv.isMockEnvironment(input.environmentId)) return 'Mock（内置）';
        if (!input.environmentId) return '';

        var environment = environmentsRepo.get(handle, input.environmentId);
        return environment ? environment.name : '';
    }

    /* ---- 数据：每一行跑一轮 ---- */

    var rows = [];
    if (suite.data && suite.data.format && suite.data.format !== 'none') {
        var parsed = suiteData.parse(suite.data);
        if (!parsed.ok) return failure('error', parsed.error);
        rows = parsed.rows;
    }

    var iterations = rows.length || Math.max(1, Math.min(100, Number(settings.iterations) || 1));

    if (!steps.length) return failure('error', '这个测试集一个步骤都没有');

    onEvent({ type: 'start', runId: runId, iterations: iterations, steps: steps.length });

    /* ---- 这次运行自己那份变量改动与 Cookie（都不落库） ---- */

    var runChanges = {
        project: { set: {}, unset: [] },
        environment: { set: {}, unset: [] }
    };
    var cookieRows = [];

    var summary = {
        iterations: iterations,
        requests: 0,
        passed: 0,
        failed: 0,
        errors: 0,
        assertions: { passed: 0, failed: 0 },
        durationMs: 0,
        avgMs: 0
    };
    var resultIterations = [];
    var totalMs = 0;
    var stopped = false;

    for (var iteration = 0; iteration < iterations; iteration += 1) {
        var row = rows.length ? rows[iteration] : null;
        var stepResults = [];
        var skipRest = false;

        for (var index = 0; index < steps.length; index += 1) {
            var step = steps[index];

            if (signal && signal.aborted) {
                stopped = true;
                break;
            }

            if (skipRest) {
                var skipped = {
                    stepId: step.id || '',
                    apiId: step.apiId,
                    name: '',
                    method: '',
                    url: '',
                    status: 0,
                    timeMs: 0,
                    size: 0,
                    ok: true,
                    skipped: true,
                    error: '上一轮剩下的步骤被跳过',
                    tests: []
                };
                stepResults.push(skipped);
                onEvent(Object.assign({ type: 'step', iteration: iteration, index: index }, skipped));
                continue;
            }

            var stepOutcome = await runStep(step, index, iteration, row);
            stepResults.push(stepOutcome);

            summary.requests += 1;
            if (stepOutcome.ok) summary.passed += 1;
            else summary.failed += 1;
            totalMs += stepOutcome.timeMs || 0;

            stepOutcome.tests.forEach(function (test) {
                if (test.passed) summary.assertions.passed += 1;
                else summary.assertions.failed += 1;
            });

            onEvent(Object.assign({ type: 'step', iteration: iteration, index: index }, stepOutcome));

            if (!stepOutcome.ok && step.onFail === 'skipIteration') skipRest = true;

            // 步骤自己的等待 + 每次请求之间的间隔
            if (index < steps.length - 1) {
                await sleep((Number(step.delayMs) || 0) + gapMs, signal);
            }
        }

        resultIterations.push({
            index: iteration,
            data: row ? clone(row) : null,
            steps: stepResults
        });

        if (stopped) break;
    }

    summary.durationMs = Date.now() - startedAt;
    summary.avgMs = summary.requests ? Math.round(totalMs / summary.requests) : 0;

    var result = { iterations: resultIterations };
    var trimmed = trimResult(result, summary);

    return finish(stopped ? 'stopped' : (summary.failed || summary.errors ? 'failed' : 'passed'), {
        summary: summary,
        result: trimmed.result,
        environmentName: environmentName()
    });

    /* ------------------------------------------------------------ 单个步骤 */

    /**
     * 跑一步。任何异常都**变成这一步的失败**，不能把整次运行打断 ——
     * 「接口被删了」「环境不存在」这类问题要出现在报告里，而不是让用户看到一个 500。
     */
    async function runStep(step, index, iteration, row) {
        var startedStepAt = Date.now();
        var base = {
            stepId: step.id || '',
            apiId: step.apiId,
            name: '',
            method: '',
            url: '',
            status: 0,
            timeMs: 0,
            size: 0,
            ok: false,
            skipped: false,
            error: '',
            tests: []
        };

        var api = apisRepo.get(handle, step.apiId);
        if (!api || api.projectId !== project.id) {
            summary.errors += 1;
            return Object.assign(base, { error: '接口已删除', timeMs: Date.now() - startedStepAt });
        }

        base.name = api.name || api.url || '';
        base.method = String(api.method || 'GET').toUpperCase();

        var request = requestOfApi(api);
        request.assertions = (request.assertions || []).concat(step.assertions || []);
        request.extracts = (request.extracts || []).concat(step.extracts || []);

        var prepared;
        try {
            prepared = preparer.prepare(who, project, {
                apiId: api.id,
                environmentId: input.environmentId,
                mockBase: input.mockBase,
                request: request,
                options: {
                    skipHistory: true,
                    // Cookie 由这次运行自己管：不读库、也不写库
                    cookies: false,
                    timeoutMs: timeoutMs
                }
            });
        } catch (err) {
            summary.errors += 1;
            return Object.assign(base, {
                error: (err && err.message) || '准备请求失败',
                timeMs: Date.now() - startedStepAt
            });
        }

        // 这次运行累积的变量改动 + 这一轮的数据行
        prepared.scopes = overlayScopes(prepared.scopes, runChanges, row);
        // 这次运行自己的 Cookie（开始时是空的，步骤之间共用）
        prepared.cookies = cookieRows;
        // 断言 / 提取已经在 request 里拼好了，这里以拼好的那份为准
        prepared.assertions = request.assertions;
        prepared.extracts = request.extracts;

        var outcome;
        try {
            outcome = await sendCore.run(prepared, { signal: signal, fileRoots: input.fileRoots });
        } catch (err) {
            summary.errors += 1;
            return Object.assign(base, {
                error: (err && err.message) || '执行失败',
                timeMs: Date.now() - startedStepAt
            });
        }

        var result = outcome.result || {};
        var scriptState = (outcome.changes && outcome.changes.scriptState) || null;

        // 变量与 Cookie 的改动合进这次运行（**不写库**）
        if (scriptState) {
            mergeChanges(runChanges.project, scriptState.variables && scriptState.variables.project);
            mergeChanges(runChanges.environment, scriptState.variables && scriptState.variables.environment);
        }
        if (outcome.changes && outcome.changes.cookies) {
            cookieRows = applyCookieChanges(cookieRows, outcome.changes.cookies);
        }

        var tests = ((scriptState && scriptState.tests) || []).map(function (entry) {
            return {
                name: String(entry.name || ''),
                passed: entry.passed === true,
                message: String(entry.error || entry.message || ''),
                source: String(entry.source || '')
            };
        });
        var failedTests = tests.filter(function (test) { return !test.passed; });

        var stepResult = Object.assign(base, {
            status: result.response ? result.response.status : 0,
            url: result.request ? result.request.url : '',
            timeMs: (result.timings && result.timings.total) || (Date.now() - startedStepAt),
            size: result.response ? result.response.size : 0,
            ok: !result.error && failedTests.length === 0,
            error: result.error ? String(result.error.message || result.error.code || '请求失败') : '',
            tests: tests
        });

        // 只有失败的步骤才存请求 / 响应（成功的存下来只会把记录撑爆）
        if (!stepResult.ok) {
            var payload = payloadFor(result, prepared.secretValues);
            stepResult.request = payload.request;
            stepResult.response = payload.response;
        }

        return stepResult;
    }
}

/**
 * `result` 太大时去掉所有 `request` / `response`，并在 summary 里记一笔。
 *
 * 2 MB 是计划里定的上限：按时长跑几千轮、每轮都存失败响应的话，一条运行记录能到几十 MB，
 * 云端存不下也没人看。
 */
function trimResult(result, summary) {
    var text = JSON.stringify(result);
    if (Buffer.byteLength(text, 'utf8') <= MAX_RESULT_BYTES) return { result: result, truncated: false };

    (result.iterations || []).forEach(function (item) {
        (item.steps || []).forEach(function (step) {
            delete step.request;
            delete step.response;
        });
    });

    summary.truncated = true;
    return { result: result, truncated: true };
}

module.exports = {
    runSuite: runSuite,
    requestOfApi: requestOfApi,
    MAX_RESPONSE_BYTES: MAX_RESPONSE_BYTES,
    MAX_RESULT_BYTES: MAX_RESULT_BYTES
};
