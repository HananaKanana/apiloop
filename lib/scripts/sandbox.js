/**
 * 脚本沙箱（契约第 16 节）。
 *
 * 用 QuickJS 的 wasm 版本跑用户从 Postman 导进来的脚本。这里是**唯一**接触
 * quickjs-emscripten 的地方，`prelude.js` 和 `runner.js` 都不直接碰它。
 *
 * 三条资源约束，都在这里落实：
 * - **CPU 1 秒 / 段**：自己实现 interrupt handler。等待 `pm.sendRequest` 的这段时间
 *   **不计入**（进入宿主函数时暂停计时，返回后接着计）—— 按墙上时间一刀切的话，
 *   前面一次慢请求就会把后面的脚本误判成超时。
 * - **内存 32MB**：`runtime.setMemoryLimit`。
 * - **挂钟上限**：整条链共用一个 deadline（由 runner 传进来），到点就中断。
 *
 * 两个踩过的坑：
 * - 异步版本里 **`evalCode` 会抛「Function unexpectedly returned a Promise」**，
 *   必须用 `ctx.evalCodeAsync`。
 * - 宿主函数的入参是 **QuickJSHandle**，不是原始值。所以这一层约定「宿主和沙箱之间
 *   只传 JSON 字符串」，转换就只剩 `getString` / `newString` 两个方向。
 *
 * QuickJS 只带 ECMAScript 内置对象：**没有 `URL`、`console`、`setTimeout`、
 * `TextEncoder`**。所以 prelude 里自己实现了最小 URL 解析和 console，别指望这些全局。
 */

var core = require('quickjs-emscripten-core');
var variantModule = require('@jitl/quickjs-wasmfile-release-asyncify');

// CJS 下 require 拿到的是带 default 的命名空间对象
var variant = variantModule.default || variantModule;

/** 每段脚本的 CPU 时间上限 */
var CPU_LIMIT_MS = 1000;

/** 每个 context 的内存上限 */
var MEMORY_LIMIT_BYTES = 32 * 1024 * 1024;

/**
 * wasm 模块只加载一次：编译 wasm 不便宜，而每次执行只是新建一个 context。
 * 存的是 Promise，避免并发调用时重复加载。
 */
var modulePromise = null;

function loadModule() {
    if (!modulePromise) {
        modulePromise = core.newQuickJSAsyncWASMModuleFromVariant(variant);
    }
    return modulePromise;
}

/**
 * JSON 里不会转义 U+2028 / U+2029，但把它们塞进 JS 源码里在旧引擎上会断行。
 * 现代引擎（含 QuickJS）已经允许，这里还是转掉，属于便宜的保险。
 */
function toJsLiteral(value) {
    return JSON.stringify(value)
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
}

/** 把脚本包成 IIFE：用户脚本里的 var / function 不会漏进全局 */
function wrapSource(source) {
    return '(function () {\n' + String(source === undefined || source === null ? '' : source) +
        '\n})();\n';
}

function readError(ctx, handle) {
    var dumped = ctx.dump(handle);
    if (!dumped || typeof dumped !== 'object') {
        return { name: 'Error', message: String(dumped) };
    }
    return {
        name: String(dumped.name || 'Error'),
        message: String(dumped.message === undefined ? dumped : dumped.message)
    };
}

/**
 * 在一个全新的 context 里跑一段脚本，跑完销毁。
 *
 * @param {object} options
 * @param {string} options.prelude 沙箱内运行时源码（`lib/scripts/prelude.js` 的 SOURCE）
 * @param {string} options.source 用户脚本
 * @param {object} options.input 注入沙箱的数据，会被 JSON 序列化后赋给 `__input`
 * @param {object} options.api
 * @param {Function} options.api.sendRequest `(json: string) => Promise<string>`
 * @param {Function} options.api.log `(level, text) => void`
 * @param {Function} options.api.now `() => number`
 * @param {object} [options.limits] `{ cpuMs, memoryBytes, wallMs }`
 * @returns {Promise<{ok: boolean, error: object|null, output: object|null, waitingMs: number}>}
 */
async function execute(options) {
    var opts = options || {};
    var api = opts.api || {};
    var limits = opts.limits || {};

    var cpuLimit = typeof limits.cpuMs === 'number' && limits.cpuMs > 0 ? limits.cpuMs : CPU_LIMIT_MS;
    var memoryLimit = typeof limits.memoryBytes === 'number' && limits.memoryBytes > 0
        ? limits.memoryBytes
        : MEMORY_LIMIT_BYTES;
    var wallMs = typeof limits.wallMs === 'number' && limits.wallMs > 0 ? limits.wallMs : Infinity;

    var module_ = await loadModule();
    var ctx = module_.newContext();

    /* ---------------- CPU 计时（等 sendRequest 时暂停） ---------------- */

    var waiting = false;
    var waitingMs = 0;
    var cpuUsed = 0;
    var segmentStart = Date.now();
    var stopReason = null;
    var wallDeadline = Date.now() + wallMs;

    function pauseClock() {
        if (waiting) return;
        waiting = true;
        cpuUsed += Date.now() - segmentStart;
        segmentStart = Date.now();
    }

    function resumeClock() {
        if (!waiting) return;
        waiting = false;
        waitingMs += Date.now() - segmentStart;
        segmentStart = Date.now();
    }

    ctx.runtime.setMemoryLimit(memoryLimit);
    ctx.runtime.setInterruptHandler(function () {
        if (Date.now() > wallDeadline) {
            stopReason = 'wall';
            return true;
        }
        if (cpuUsed + (waiting ? 0 : Date.now() - segmentStart) > cpuLimit) {
            stopReason = 'cpu';
            return true;
        }
        return false;
    });

    /* ---------------- 宿主函数 ---------------- */

    var host = ctx.newObject();

    var logFn = ctx.newFunction('log', function (levelHandle, textHandle) {
        try {
            api.log(ctx.getString(levelHandle), ctx.getString(textHandle));
        } catch (err) {
            // 记录日志失败绝不能把脚本带崩
        }
    });
    ctx.setProp(host, 'log', logFn);
    logFn.dispose();

    var nowFn = ctx.newFunction('now', function () {
        return ctx.newNumber(typeof api.now === 'function' ? api.now() : Date.now());
    });
    ctx.setProp(host, 'now', nowFn);
    nowFn.dispose();

    var sendFn = ctx.newAsyncifiedFunction('sendRequest', async function (jsonHandle) {
        var json = ctx.getString(jsonHandle);
        pauseClock();
        try {
            return ctx.newString(String(await api.sendRequest(json)));
        } finally {
            // 不管是成功、失败还是超时，都要把计时接回去
            resumeClock();
        }
    });
    ctx.setProp(host, 'sendRequest', sendFn);
    sendFn.dispose();

    /**
     * `pm.variables.replaceIn()` 用（见 prelude.js）。
     *
     * 替换规则在宿主里（`lib/variables.js`），沙箱不重复实现 —— 内置动态变量表
     * （`{{$手机号}}` 这些）只有那一份，两边各写一份迟早对不上。所以这里是**同步**的：
     * 只是一次纯字符串替换，没有 IO，不需要 asyncify。
     */
    var replaceFn = ctx.newFunction('replaceIn', function (textHandle, varsHandle) {
        var text = ctx.getString(textHandle);
        if (typeof api.replaceIn !== 'function') return ctx.newString(text);
        try {
            return ctx.newString(String(api.replaceIn(text, ctx.getString(varsHandle))));
        } catch (err) {
            // 替换失败就把原文还回去，别把脚本带崩
            return ctx.newString(text);
        }
    });
    ctx.setProp(host, 'replaceIn', replaceFn);
    replaceFn.dispose();

    ctx.setProp(ctx.global, '__host', host);
    host.dispose();

    /* ---------------- 执行 ---------------- */

    var error = null;
    var output = null;

    function take(result) {
        if (result.error) {
            error = readError(ctx, result.error);
            result.error.dispose();
            return false;
        }
        result.value.dispose();
        return true;
    }

    try {
        var ok = take(await ctx.evalCodeAsync(
            'globalThis.__input = ' + toJsLiteral(opts.input || {}) + ';', 'input.js'));

        if (ok) {
            ok = take(await ctx.evalCodeAsync(String(opts.prelude || ''), 'prelude.js'));
        }

        if (ok) {
            take(await ctx.evalCodeAsync(wrapSource(opts.source), 'script.js'));
        }

        // 脚本出错也照样把状态取回来：前置脚本修改过的变量不该因为后面抛异常而整体丢掉
        var exportResult = await ctx.evalCodeAsync('globalThis.__export()', 'export.js');
        if (exportResult.error) {
            exportResult.error.dispose();
            if (!error) error = { name: 'Error', message: '脚本状态导出失败' };
        } else {
            try {
                output = JSON.parse(ctx.getString(exportResult.value));
            } catch (err) {
                if (!error) error = { name: 'Error', message: '脚本状态导出失败：' + err.message };
            }
            exportResult.value.dispose();
        }
    } catch (err) {
        /**
         * `evalCodeAsync` 有时**直接抛**而不是返回 error —— 无限递归就是这一种
         * （Emscripten 层的 "Maximum call stack size exceeded"）。
         */
        if (!error) {
            error = { name: (err && err.name) || 'Error', message: (err && err.message) || String(err) };
        }
    } finally {
        try {
            ctx.dispose();
        } catch (err) {
            // 被中断过的 context 释放时偶有杂音，不能让它盖住真正的错误
        }
    }

    if (error && stopReason === 'cpu' && /interrupted/i.test(error.message)) {
        error = { name: 'Error', message: '脚本执行超时（单段脚本最多 ' + cpuLimit + ' 毫秒）' };
    } else if (error && stopReason === 'wall' && /interrupted/i.test(error.message)) {
        error = { name: 'Error', message: '脚本总时长超过上限' };
    }

    return {
        ok: !error,
        error: error,
        output: output,
        waitingMs: waitingMs
    };
}

module.exports = {
    execute: execute,
    loadModule: loadModule,
    CPU_LIMIT_MS: CPU_LIMIT_MS,
    MEMORY_LIMIT_BYTES: MEMORY_LIMIT_BYTES
};
