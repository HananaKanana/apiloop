/**
 * 脚本链的执行（契约第 16 节）：按「项目 → 目录链（从外到内）→ 接口」的顺序，
 * 一段一段交给沙箱跑，把结果汇总成 `ExecResult.scripts`。
 *
 * 三件事只有这里做：
 * - **链上串状态**：前一段脚本改过的变量、改过的请求，后面的脚本必须看得见
 *   （同一级里先后两段脚本就是这么协作的）。
 * - **整条链共用一个 30 秒挂钟上限**：`budget.deadline` 由调用方创建，
 *   前置脚本和测试脚本用同一个 —— 契约说的是「一次发送中」所有脚本加起来。
 * - **`pm.sendRequest` 的次数预算**同理，也是按一次发送算的。
 *
 * 沙箱是**懒加载**的：`require('./sandbox')` 放到第一次真的要跑脚本时。
 * 这样「没有任何脚本」的请求连 quickjs 的 JS 都不进，更不会碰 wasm。
 */

var CHAIN_WALL_MS = 30 * 1000;
var SEND_REQUEST_LIMIT = 10;

var sandboxCache = null;

function sandboxModules() {
    if (!sandboxCache) {
        sandboxCache = {
            sandbox: require('./sandbox'),
            prelude: require('./prelude')
        };
    }
    return sandboxCache;
}

/**
 * 一次发送共用的预算。前置脚本和测试脚本各调一次 `runChain`，但传同一个 budget。
 */
function createBudget(options) {
    var opts = options || {};
    return {
        sendRequestsLeft: typeof opts.sendRequestLimit === 'number' ? opts.sendRequestLimit : SEND_REQUEST_LIMIT,
        deadline: Date.now() + (typeof opts.wallMs === 'number' ? opts.wallMs : CHAIN_WALL_MS)
    };
}

/** 有内容的脚本才算数：只写了空白的 `exec` 不必新建一个 context */
function hasRunnable(steps) {
    return (Array.isArray(steps) ? steps : []).some(function (step) {
        return step && String(step.exec || '').trim() !== '';
    });
}

function emptyState() {
    return {
        tests: [],
        /** pm.visualizer.set 的结果：{ template, data, options } 或 null */
        visualizer: null,
        console: [],
        errors: [],
        warnings: [],
        variables: {
            environment: { set: {}, unset: [] },
            project: { set: {}, unset: [] },
            persisted: false
        }
    };
}

function mergeChanges(target, change) {
    if (!change) return;
    Object.keys(change.set || {}).forEach(function (key) { target.set[key] = change.set[key]; });
    (change.unset || []).forEach(function (key) {
        delete target.set[key];
        if (target.unset.indexOf(key) === -1) target.unset.push(key);
    });
}

/** 把一次导出的差量落到链上的工作副本里，后面的脚本才看得见 */
function applyToScope(table, change) {
    if (!table || !change) return;
    Object.keys(change.set || {}).forEach(function (key) { table[key] = change.set[key]; });
    (change.unset || []).forEach(function (key) { delete table[key]; });
}

/**
 * @param {'prerequest'|'test'} phase
 * @param {Array<{source: string, exec: string}>} steps 按执行顺序
 * @param {object} env
 * @param {object} env.request 当前请求（前置脚本可以改它）
 * @param {object|null} [env.response] 测试脚本才有
 * @param {object} env.scopes `{ project, folders, environment, transient }`——
 *   **会被就地修改**（链上串状态），调用方自己持有一份即可
 * @param {Function} env.sendRequest `(json: string) => Promise<string>`
 * @param {object} [env.info] `{ requestName }`
 * @param {object} [env.budget] 由 `createBudget()` 建，两条链共用
 * @param {object} [env.limits] `{ cpuMs, memoryBytes }`
 * @returns {Promise<{aborted: boolean, request: object, state: object}>}
 */
async function runChain(phase, steps, env) {
    var options = env || {};
    var list = Array.isArray(steps) ? steps : [];
    var budget = options.budget || createBudget();
    var scopes = options.scopes || { project: {}, folders: [], environment: null, transient: {} };
    var request = options.request;
    var state = emptyState();
    var aborted = false;

    for (var i = 0; i < list.length; i++) {
        var step = list[i];
        if (!step || String(step.exec || '').trim() === '') continue;

        if (Date.now() >= budget.deadline) {
            state.warnings.push('脚本总时长超过 ' + Math.round(CHAIN_WALL_MS / 1000) + ' 秒，后面的脚本没有执行');
            break;
        }

        var modules = sandboxModules();

        var result = await modules.sandbox.execute({
            prelude: modules.prelude.SOURCE,
            source: step.exec,
            input: {
                phase: phase,
                request: request,
                response: options.response || null,
                scopes: scopes,
                info: options.info || {}
            },
            api: {
                sendRequest: makeSendRequest(budget, options.sendRequest),
                // 日志实时收走：脚本被中断时，已经打出来的那几行也要看得到
                log: function (level, text) {
                    state.console.push({ level: level, text: text, source: step.source });
                },
                now: function () { return Date.now(); }
            },
            limits: {
                cpuMs: options.limits && options.limits.cpuMs,
                memoryBytes: options.limits && options.limits.memoryBytes,
                wallMs: Math.max(1, budget.deadline - Date.now())
            }
        });

        if (result.output) {
            collect(state, result.output, step);
            applyToScope(scopes.project, result.output.variables && result.output.variables.project);
            applyToScope(scopes.environment, result.output.variables && result.output.variables.environment);
            if (result.output.variables && result.output.variables.transient) {
                scopes.transient = result.output.variables.transient;
            }
            if (result.output.request) request = result.output.request;
        }

        if (result.error) {
            state.errors.push({
                phase: phase,
                source: step.source,
                message: result.error.message
            });

            // 前置脚本出错：契约要求请求不发送，后面的脚本也不再执行
            if (phase === 'prerequest') {
                aborted = true;
                break;
            }
        }
    }

    return { aborted: aborted, request: request, state: state };
}

function collect(state, output, step) {
    (output.tests || []).forEach(function (item) {
        var entry = { name: item.name, passed: !!item.passed };
        if (item.error) entry.error = item.error;
        state.tests.push(entry);
    });

    (output.warnings || []).forEach(function (text) {
        if (state.warnings.indexOf(text) === -1) state.warnings.push(text);
    });

    // 后面的脚本 set 的覆盖前面的（和 Postman 一样，最后一次生效）
    if (output.visualizer) state.visualizer = output.visualizer;

    if (output.variables) {
        mergeChanges(state.variables.environment, output.variables.environment);
        mergeChanges(state.variables.project, output.variables.project);
    }

    // 沙箱里没来得及导出的错误（极端情况下 output 为 null）由调用方补
    void step;
}

/**
 * 包一层次数预算。超了就按 `err` 回调 —— 契约要求「超出的直接以 err 回调」，
 * 不能把异常抛进脚本里把整段脚本带停。
 */
function makeSendRequest(budget, send) {
    return async function (json) {
        if (typeof send !== 'function') {
            return JSON.stringify({ error: { message: 'pm.sendRequest 当前不可用' } });
        }

        if (budget.sendRequestsLeft <= 0) {
            return JSON.stringify({
                error: { message: '一次发送中最多调用 ' + SEND_REQUEST_LIMIT + ' 次 pm.sendRequest' }
            });
        }
        budget.sendRequestsLeft -= 1;

        try {
            return await send(json);
        } catch (err) {
            return JSON.stringify({ error: { message: (err && err.message) || '请求失败' } });
        }
    };
}

module.exports = {
    runChain: runChain,
    createBudget: createBudget,
    hasRunnable: hasRunnable,
    emptyState: emptyState,
    CHAIN_WALL_MS: CHAIN_WALL_MS,
    SEND_REQUEST_LIMIT: SEND_REQUEST_LIMIT
};
