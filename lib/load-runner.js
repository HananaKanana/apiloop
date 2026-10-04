/**
 * 简单压测的执行模块（第八轮第 2 节）。
 *
 * 上线前想知道「这个接口 50 个并发扛不扛得住、P95 多少」。不需要场景编排：
 * **一个接口、一组参数**，同一份请求反复打，只统计状态码和响应时间。
 *
 * 三个刻意的取舍，先说清楚：
 *
 * 1. **直接调 `executor.execute`，不走 `sendCore.run`。** prepare 出来的东西照样用
 *    （变量分层、鉴权继承、公共请求头都由它算好了），但执行这一段不要 send-core：
 *    它每次都会重新拼变量表、跑脚本 / 断言、建 Cookie jar，压测一样都不需要，
 *    而它又不接受 `agent` / `discardBody` 这两个执行器选项。压测要的恰好就是这两个
 *    （复用连接、不攒响应体），所以自己拿着 `prepared.spec` 反复执行。
 * 2. **变量在开始前算一次**（`variables.resolveSpec`），之后每个请求都发同一份。
 *    压测里脚本不跑，变量不可能中途变；每个请求再解析一遍只是白花 CPU。
 * 3. **不统计单个请求的耗时**：按时长跑十分钟可能有几十万个请求，存数组会吃光内存。
 *    用固定桶的直方图（1 ms 一桶到 10 秒，之后 100 ms 一桶到 300 秒），P95 从桶上算。
 *
 * 这个文件不碰 `req` / `res`、不写库、不发 NDJSON —— 事件通过 `onEvent` 回调出去，
 * 路由层（`lib/api/load.js`）负责写流。
 */

var http = require('http');
var https = require('https');

var executor = require('./executor');
var variables = require('./variables');
var sendCore = require('./send-core');
var proxySettings = require('./proxy-settings');

/* ------------------------------------------------------------------ 参数 */

/**
 * 每个参数的范围。**越界一律 400**，不悄悄截断 —— 用户填了 5000 个并发却只跑了 200，
 * 出来的数就是错的，比报错更坑。
 */
var LIMITS = {
    concurrency: { min: 1, max: 200, def: 10 },
    count: { min: 1, max: 100000, def: 1000 },
    durationSec: { min: 5, max: 600, def: 30 },
    rampUpSec: { min: 0, max: 60, def: 0 },
    timeoutMs: { min: 1, max: 300000, def: 10000 }
};

/** 直方图：前 10 秒按 1 ms 一桶，之后按 100 ms 一桶到 300 秒 */
var FINE_LIMIT_MS = 10000;
var COARSE_WIDTH_MS = 100;
var COARSE_LIMIT_MS = 300000;
var FINE_BUCKETS = FINE_LIMIT_MS;
var BUCKET_COUNT = FINE_BUCKETS + (COARSE_LIMIT_MS - FINE_LIMIT_MS) / COARSE_WIDTH_MS;

/** 网络错误翻成中文分组（数字状态码在「状态码分布」里，不进这里） */
var ERROR_LABELS = {
    TIMEOUT: '超时',
    DNS: 'DNS 解析失败',
    TLS: '证书 / TLS 握手失败',
    PROXY: '代理不可用',
    CONNECT: '连接失败',
    INVALID_HEADER: '请求头不合法',
    INVALID_URL: '地址不合法',
    FILE: '读取本地文件失败',
    SCRIPT: '脚本出错',
    OTHER: '其他错误'
};

function str(value) {
    return value === null || value === undefined ? '' : String(value);
}

/** 一个范围参数：不是数字、不是整数、越界都返回中文错误 */
function numberIn(raw, name, label, range) {
    if (raw === undefined || raw === null || raw === '') return { value: range.def };

    var value = Number(raw);
    if (!isFinite(value) || Math.floor(value) !== value) {
        return { error: label + '要填整数' };
    }
    if (value < range.min || value > range.max) {
        return { error: label + '要在 ' + range.min + ' ~ ' + range.max + ' 之间（收到 ' + str(raw) + '）' };
    }
    return { value: value };
}

/**
 * 清洗压测参数。
 *
 * @param {object} input 请求体里的 `load`
 * @returns {{value: object} | {error: string}} `error` 是给用户看的中文，路由层转成 400
 */
function normalizeLoad(input) {
    var raw = input || {};

    var mode = raw.mode === 'duration' ? 'duration' : 'count';

    var checked = [
        ['concurrency', '并发数'],
        ['rampUpSec', '预热秒数'],
        ['timeoutMs', '超时毫秒'],
        [mode === 'duration' ? 'durationSec' : 'count', mode === 'duration' ? '时长（秒）' : '总请求数']
    ];

    var value = { mode: mode };
    for (var i = 0; i < checked.length; i++) {
        var key = checked[i][0];
        var result = numberIn(raw[key], key, checked[i][1], LIMITS[key]);
        if (result.error) return { error: result.error };
        value[key] = result.value;
    }

    // 两种停止条件都填上，界面切换时不用清空另一个的值
    var countResult = numberIn(raw.count, 'count', '总请求数', LIMITS.count);
    if (countResult.error) return { error: countResult.error };
    value.count = countResult.value;

    var durationResult = numberIn(raw.durationSec, 'durationSec', '时长（秒）', LIMITS.durationSec);
    if (durationResult.error) return { error: durationResult.error };
    value.durationSec = durationResult.value;

    var okStatus = normalizeOkStatus(raw.okStatus);
    if (okStatus.error) return { error: okStatus.error };
    value.okStatus = okStatus.value;

    return { value: value };
}

/** 算成功的状态码：空数组 = 2xx / 3xx；给的话每个都要是 100~599 的整数 */
function normalizeOkStatus(raw) {
    if (raw === undefined || raw === null || raw === '') return { value: [] };

    var list = Array.isArray(raw) ? raw : String(raw).split(',');
    var out = [];

    for (var i = 0; i < list.length; i++) {
        var text = str(list[i]).trim();
        if (!text) continue;

        var value = Number(text);
        if (!isFinite(value) || Math.floor(value) !== value || value < 100 || value > 599) {
            return { error: '「算成功的状态码」只能填 100 ~ 599 之间的整数（收到 ' + text + '）' };
        }
        if (out.indexOf(value) === -1) out.push(value);
    }

    return { value: out };
}

/** 这个状态码算不算成功 */
function isOkStatus(status, okStatus) {
    if (okStatus && okStatus.length) return okStatus.indexOf(status) !== -1;
    return status >= 200 && status < 400;
}

/* ------------------------------------------------------------------ 统计 */

/** 耗时落在第几个桶 */
function bucketOf(ms) {
    if (!(ms > 0)) return 0;
    if (ms < FINE_LIMIT_MS) return Math.floor(ms);
    return Math.min(BUCKET_COUNT - 1, FINE_BUCKETS + Math.floor((ms - FINE_LIMIT_MS) / COARSE_WIDTH_MS));
}

/** 桶的下界（毫秒）：P95 报「不超过这个值」 */
function bucketValue(index) {
    if (index < FINE_BUCKETS) return index;
    return FINE_LIMIT_MS + (index - FINE_BUCKETS) * COARSE_WIDTH_MS;
}

/**
 * 这次压测的所有计数。**没有数组按请求存耗时**：只有直方图、每秒小结和分组表。
 */
function createStats(load) {
    var histogram = new Uint32Array(BUCKET_COUNT);
    var perSecond = [];

    var state = {
        sent: 0,
        ok: 0,
        failed: 0,
        aborted: 0,
        active: 0,
        sumMs: 0,
        minMs: null,
        maxMs: 0,
        statusCodes: new Map(),
        errors: new Map()
    };

    /**
     * 占一个名额再发。`limit` 是「按次数」的总量上限（按时长跑时传 null）。
     *
     * 检查和自增之间不能有 await：并发工人同时跨过「查一下还没到上限」，总量就会超。
     * 这里是一次同步的判断 + 自增，所以正好停在第 count 个。
     */
    function claim(limit) {
        if (limit !== null && limit !== undefined && state.sent >= limit) return false;
        state.sent += 1;
        state.active += 1;
        return true;
    }

    function secondSlot(elapsedMs) {
        var index = Math.max(0, Math.floor(elapsedMs / 1000) - 1);
        while (perSecond.length <= index) perSecond.push({ count: 0, failed: 0, sumMs: 0 });
        return perSecond[index];
    }

    /** 一个请求结束了 */
    function finish(result, elapsedMs) {
        var ms = result && result.timings && isFinite(result.timings.total)
            ? result.timings.total
            : elapsedMs;

        state.active = Math.max(0, state.active - 1);

        var code = result && result.error ? result.error.code : null;
        if (code === 'ABORTED') {
            // 被停时在途的那些：不是失败，响应时间也没有意义
            state.aborted += 1;
            return;
        }

        var slot = secondSlot(elapsedMs);
        slot.count += 1;

        if (!code && result.response) {
            var status = result.response.status;
            state.statusCodes.set(status, (state.statusCodes.get(status) || 0) + 1);

            if (isOkStatus(status, load.okStatus)) {
                state.ok += 1;
            } else {
                state.failed += 1;
                slot.failed += 1;
            }
        } else {
            state.failed += 1;
            slot.failed += 1;

            var group = errorGroup(result);
            var entry = state.errors.get(group) || { group: group, count: 0, sample: '' };
            entry.count += 1;
            if (!entry.sample) entry.sample = str(result && result.error && result.error.message);
            state.errors.set(group, entry);
        }

        slot.sumMs += ms;
        state.sumMs += ms;
        if (state.minMs === null || ms < state.minMs) state.minMs = ms;
        if (ms > state.maxMs) state.maxMs = ms;
        histogram[bucketOf(ms)] += 1;
    }

    /** 已完成的总数（成功 + 失败，不含被取消的） */
    function completed() {
        return state.ok + state.failed;
    }

    /** 累计分位值。`p` 是 0~1 */
    function percentile(p) {
        var total = completed();
        if (!total) return 0;

        var target = Math.ceil(p * total);
        var seen = 0;
        for (var i = 0; i < histogram.length; i++) {
            seen += histogram[i];
            if (seen >= target) return bucketValue(i);
        }
        return bucketValue(histogram.length - 1);
    }

    function round(value) {
        return Math.round(value * 10) / 10;
    }

    /** 某一秒的小结（t 是第几秒） */
    function secondAt(index) {
        return perSecond[index] || { count: 0, failed: 0, sumMs: 0 };
    }

    function snapshot(elapsedMs, secondIndex) {
        var slot = secondAt(secondIndex);
        var total = completed();

        return {
            sent: state.sent,
            ok: state.ok,
            failed: state.failed,
            active: state.active,
            qps: slot.count,
            // 「这一秒」的两个数（图上那条线用 secondAvgMs，累计平均在 avgMs 里）
            failedInSecond: slot.failed,
            secondAvgMs: slot.count ? round(slot.sumMs / slot.count) : 0,
            avgMs: total ? round(state.sumMs / total) : 0,
            p95Ms: percentile(0.95),
            elapsedMs: elapsedMs
        };
    }

    /** 结束时的汇总 */
    function summary(status, elapsedMs) {
        var total = completed();
        var seconds = Math.max(elapsedMs / 1000, 0.001);

        return {
            status: status,
            concurrency: load.concurrency,
            mode: load.mode,
            count: load.mode === 'count' ? load.count : null,
            durationSec: load.mode === 'duration' ? load.durationSec : null,
            rampUpSec: load.rampUpSec,
            timeoutMs: load.timeoutMs,
            okStatus: load.okStatus,
            sent: state.sent,
            ok: state.ok,
            failed: state.failed,
            aborted: state.aborted,
            errorRate: total ? Math.round((state.failed / total) * 10000) / 10000 : 0,
            durationMs: Math.round(elapsedMs),
            qps: round(total / seconds),
            minMs: state.minMs === null ? 0 : round(state.minMs),
            avgMs: total ? round(state.sumMs / total) : 0,
            maxMs: round(state.maxMs),
            p50Ms: percentile(0.5),
            p90Ms: percentile(0.9),
            p95Ms: percentile(0.95),
            p99Ms: percentile(0.99),
            statusCodes: Array.from(state.statusCodes.entries())
                .map(function (pair) { return { status: pair[0], count: pair[1] }; })
                .sort(function (a, b) { return b.count - a.count; }),
            errors: Array.from(state.errors.values())
                .sort(function (a, b) { return b.count - a.count; })
        };
    }

    return {
        claim: claim,
        finish: finish,
        completed: completed,
        snapshot: snapshot,
        summary: summary,
        secondAt: secondAt
    };
}

/**
 * 网络错误翻成中文分组。数字状态码不在这里 —— 那是「拿到了响应但状态不对」，
 * 由状态码分布负责，两处都记只会让人对不上数。
 *
 * 执行器已经把 err.code 归过类（`mapErrorCode`），但「连接被拒绝 / 被重置 / 不可达」
 * 都落在 CONNECT 上，这里再看一眼原始信息把它们分开：排查时这三者的处理方式完全不同。
 */
function errorGroup(result) {
    var error = (result && result.error) || {};
    var code = str(error.code);
    var message = str(error.message);

    if (code === 'CONNECT') {
        if (/ECONNREFUSED/.test(message)) return '连接被拒绝';
        if (/ECONNRESET/.test(message)) return '连接被重置';
        if (/EHOSTUNREACH|ENETUNREACH/.test(message)) return '网络不可达';
        if (/EPIPE/.test(message)) return '连接被中断';
        if (/ECONNABORTED/.test(message)) return '连接被中断';
        return ERROR_LABELS.CONNECT;
    }

    return ERROR_LABELS[code] || ERROR_LABELS.OTHER;
}

/* ------------------------------------------------------------------ 执行 */

/** 可被取消的等待：回来的是「等到了吗」（false 表示被停了） */
function sleep(ms, signal) {
    if (!(ms > 0)) return Promise.resolve(true);

    return new Promise(function (resolve) {
        var done = false;

        function finish(value) {
            if (done) return;
            done = true;
            clearTimeout(timer);
            if (signal) signal.removeEventListener('abort', onAbort);
            resolve(value);
        }

        function onAbort() { finish(false); }

        var timer = setTimeout(function () { finish(true); }, ms);
        if (signal) {
            if (signal.aborted) return finish(false);
            signal.addEventListener('abort', onAbort, { once: true });
        }
        return undefined;
    });
}

/**
 * 跑一次压测。**`prepared` 由调用方先准备好**（`createPreparer(ctx).prepare(...)`）——
 * 准备阶段的错（缺 request、方法不支持、环境不属于这个项目）必须在开始写 NDJSON 之前
 * 按普通 JSON 报出去，进了流就只能当成一条事件发，前端处理起来别扭得多。
 *
 * @param {object} options
 * @param {object} options.prepared `prepare` 的结果（变量、鉴权、公共请求头都算好了）
 * @param {object} options.load `normalizeLoad` 的结果
 * @param {AbortSignal} [options.signal] 浏览器断开时调用方 abort
 * @param {string[]} [options.fileRoots] 允许读哪些目录里的文件当请求体
 * @param {Function} [options.onEvent] `(event) => void`，事件见文件头与计划文档
 * @returns {Promise<{status: string, summary: object}>}
 */
async function runLoad(options) {
    var opts = options || {};
    var prepared = opts.prepared;
    var load = opts.load;
    var onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : function () {};
    var signal = opts.signal;

    /** 变量算一次：脚本不跑，中途不可能变 */
    var resolved = variables.resolveSpec(prepared.spec, sendCore.mergeScopes(prepared.scopes));
    var spec = resolved.spec;

    var proxy = prepared.proxy ? proxySettings.forTarget(prepared.proxy, spec.url) : null;

    /**
     * 复用连接。**只在直连时建**：走代理那一条要按跳改写请求头、https 还要自己打隧道，
     * 复用连接的收益和风险都不划算（见 executor 的 `options.agent` 说明）。
     */
    var agent = null;
    if (!proxy) {
        var factory = /^https:/i.test(str(spec.url)) ? https : http;
        agent = new factory.Agent({
            keepAlive: true,
            maxSockets: load.concurrency,
            maxFreeSockets: load.concurrency,
            keepAliveMsecs: 1000
        });
    }

    var execOptions = {
        timeoutMs: load.timeoutMs,
        followRedirects: true,
        // 内网自签名证书很常见，和「发送」一致的放行策略
        rejectUnauthorized: false,
        signal: signal,
        fileRoots: opts.fileRoots,
        discardBody: true
    };
    if (proxy) execOptions.proxy = proxy;
    if (agent) execOptions.agent = agent;

    var stats = createStats(load);
    var startedAt = Date.now();
    var stopped = false;
    var ticker = null;
    var lastTickSecond = 0;

    function elapsed() {
        return Date.now() - startedAt;
    }

    function stopNow() {
        stopped = true;
    }

    if (signal) {
        if (signal.aborted) stopNow();
        else signal.addEventListener('abort', stopNow, { once: true });
    }

    /** 该不该再发下一个请求 */
    function shouldStop() {
        if (stopped) return true;
        if (load.mode === 'duration') return elapsed() >= load.durationSec * 1000;
        return false;
    }

    function fire() {
        var start = Date.now();
        return executor.execute(spec, execOptions).then(function (result) {
            stats.finish(result, Date.now() - start);
        });
    }

    /** 一个「工人」：自己循环发，直到该停 */
    async function worker(index) {
        var rampMs = load.rampUpSec * 1000;
        if (rampMs > 0 && load.concurrency > 1 && index > 0) {
            var wait = Math.round(rampMs * index / (load.concurrency - 1));
            if (!(await sleep(wait, signal))) return;
        }

        while (!shouldStop()) {
            // 按次数跑：先占名额再发，总量正好是 count
            if (!stats.claim(load.mode === 'count' ? load.count : null)) return;
            await fire();
        }
    }

    onEvent({ type: 'start', missingVariables: resolved.missing });

    ticker = setInterval(function () {
        var seconds = Math.floor(elapsed() / 1000);
        if (seconds <= lastTickSecond) return;

        var event = stats.snapshot(elapsed(), seconds - 1);
        lastTickSecond = seconds;

        onEvent(Object.assign({
            type: 'tick',
            t: seconds
        }, event));
    }, 1000);
    if (ticker.unref) ticker.unref();

    try {
        var workers = [];
        for (var i = 0; i < load.concurrency; i++) workers.push(worker(i));
        await Promise.all(workers);
    } finally {
        if (ticker) clearInterval(ticker);
        if (agent) agent.destroy();
        if (signal) signal.removeEventListener('abort', stopNow);
    }

    var status = stopped ? 'stopped' : 'finished';
    var summary = stats.summary(status, elapsed());

    // 收尾那一秒可能没到整秒，补一条 tick 让图上的最后一段也有数
    var finalSecond = Math.ceil(elapsed() / 1000);
    if (finalSecond > lastTickSecond) {
        onEvent(Object.assign({ type: 'tick', t: finalSecond }, stats.snapshot(elapsed(), finalSecond - 1)));
    }

    onEvent({ type: 'done', status: status, summary: summary });

    return { status: status, summary: summary };
}

module.exports = {
    LIMITS: LIMITS,
    BUCKET_COUNT: BUCKET_COUNT,
    normalizeLoad: normalizeLoad,
    normalizeOkStatus: normalizeOkStatus,
    isOkStatus: isOkStatus,
    errorGroup: errorGroup,
    bucketOf: bucketOf,
    bucketValue: bucketValue,
    createStats: createStats,
    runLoad: runLoad
};
