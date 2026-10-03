/**
 * Mock 调用日志（契约第 11 节）。
 *
 * 干什么：记下「最近有哪些请求打到了 mock」—— 每条命中了哪个接口、哪条期望，
 * 或者根本没有命中。联调时最常问的就是「我明明发了请求，怎么没反应」，这份日志
 * 就是回答它的地方。
 *
 * 三条硬约束：
 *
 * 1. **只存在内存里**。每个项目一个环形缓冲，最多 200 条，进程重启即清空。
 *    多个进程共用同一个库时，各自只记打到自己端口上的请求 —— 这是刻意的：
 *    日志是「这一刻这个进程看到了什么」，落库反而会让人以为它是完整的。
 * 2. **绝不能影响 mock 响应本身**。所有字段都只是拷贝一份，截断也只截拷贝；
 *    记录过程中出的任何错都在调用方 try/catch 里咽掉。
 * 3. **只留前 4KB 的预览**。请求体和响应体都可能是几 MB，全存进内存就是泄漏。
 *
 * 时间戳与 seq 由这里统一分配：`seq` 是进程内单调递增的**全局**计数器（所有项目
 * 共用一个），前端每 2 秒用 `after=上次的 lastSeq` 拉一次，就能只拿到新增的记录。
 */

/** 每个项目最多保留多少条 */
var KEEP_PER_PROJECT = 200;

/** 预览（请求体 / 响应体）最多留多少个字符 */
var PREVIEW_LIMIT = 4096;

/** 不传 limit 时返回多少条 */
var DEFAULT_LIMIT = 100;

/**
 * 值一律打码的请求头。名字比大小写不敏感 —— 客户端爱怎么写怎么写，
 * 少比一次就是把凭据明文存进了日志。
 */
var MASKED_HEADERS = ['authorization', 'cookie', 'proxy-authorization'];

var MASK = '***';

/** 进程内单调递增，所有项目共用 */
var seq = 0;

/** @type {Map<string, Array>} projectId → 该项目的日志（按 seq 升序） */
var logs = new Map();

/**
 * 把任意值变成能放进日志的文本，超长就截断。
 *
 * 注意截的是**字符数**而不是字节数：4KB 对中文来说只有 1300 多个字，按字节截
 * 反而会让预览长短随内容随机变化。这里只求「有界」，不求精确到字节。
 */
function preview(value) {
    if (value === null || value === undefined) return '';

    var text;
    if (typeof value === 'string') {
        text = value;
    } else {
        try {
            text = JSON.stringify(value);
        } catch (err) {
            // 循环引用之类：退化成 String()，总比让整条日志丢掉好
            text = String(value);
        }
        // JSON.stringify(undefined) 和函数都返回 undefined
        if (text === undefined || text === null) text = '';
    }

    var cut = text.length > PREVIEW_LIMIT ? text.slice(0, PREVIEW_LIMIT) : text;

    // **必须过一遍 Buffer 复制一份独立的字符串。**
    //
    // V8 对堆上的长字符串做 slice 得到的是 SlicedString，它内部仍然引用着原字符串
    // （只记了个偏移和长度）。所以只要日志里还留着这 4KB 的预览，那段 5MB 的原始
    // 响应就一直无法回收 —— 实测 40 条 5MB 的响应会让堆涨 200MB，按每个项目 200 条
    // 算，一个会返回大响应的项目就能吃掉 GB 级内存，最后被 OOM 杀掉。
    //
    // Buffer 的编解码会真的把字符串拷出来：拷出来的是独立的 SeqString，原串随后就能回收。
    // 代价是截断处可能正好切断一个 emoji 的代理对，落单的那一半会被换成 U+FFFD ——
    // 只影响预览的最后一个字符，可以接受。
    //
    // 注意不能用 `Buffer.from(...).toString()` 生成的字符串来验证这件事：那种字符串
    // 在 V8 里是外部字符串，slice 时本来就会复制，看不出问题。要用模板引擎渲染出来的。
    return Buffer.from(cut, 'utf8').toString('utf8');
}

function isSecret(name) {
    return MASKED_HEADERS.indexOf(String(name).toLowerCase()) > -1;
}

function headerValue(name, value) {
    if (isSecret(name)) return MASK;
    if (value === null || value === undefined) return '';
    // 重名的头在 Node 里会被合成数组，String() 会拼成逗号分隔 —— 够用
    return String(value);
}

/**
 * 请求头 → `[[k, v]]`。对象和数组两种输入都收：
 * Node 的 `req.headers` 是对象，调用方自己拼的表是数组。
 *
 * 输出固定是数组：头的顺序有意义（同名头的先后），而且前端渲染列表时不用再
 * 关心它是不是对象。
 */
function maskHeaders(headers) {
    var rows = [];
    if (!headers) return rows;

    if (Array.isArray(headers)) {
        headers.forEach(function (pair) {
            if (!Array.isArray(pair) || pair.length < 2) return;
            rows.push([String(pair[0]), headerValue(pair[0], pair[1])]);
        });
        return rows;
    }

    Object.keys(headers).forEach(function (name) {
        rows.push([name, headerValue(name, headers[name])]);
    });
    return rows;
}

/**
 * 从请求里取出要落进日志的那几项。
 *
 * **必须在 `req.url` 被改写之前调用**（mock-host 剥 `/mock/<slug>` 前缀时会改）：
 * 契约要的 `url` 是完整原始地址，所以取的是 `originalUrl`。
 *
 * 这里只做快照，不打码也不截断 —— 那两件事在 `record` 里统一做，免得两条调用路径
 * 各写一份、漏掉一处就是把凭据明文写进日志。
 */
function snapshotRequest(req) {
    return {
        method: (req && req.method) || '',
        url: (req && (req.originalUrl || req.url)) || '',
        query: Object.assign({}, (req && req.query) || {}),
        headers: (req && req.headers) || {},
        bodyPreview: preview(req && req.body)
    };
}

/**
 * `matched` 字段归一化。传 null / undefined 表示「没有命中任何接口」。
 */
function normalizeMatched(matched) {
    if (!matched || typeof matched !== 'object') return null;

    var result = {
        apiId: String(matched.apiId || ''),
        apiName: String(matched.apiName || ''),
        via: matched.via === 'expectation' ? 'expectation' : 'default'
    };
    if (result.via === 'expectation') {
        result.expectationName = String(matched.expectationName || '');
    }
    return result;
}

/**
 * 记一条。seq 和 time 由这里分配，调用方只管把看到的字段交上来。
 *
 * @param {string} projectId
 * @param {{method, url, query, headers, bodyPreview, matched, status, durationMs, responsePreview}} item
 * @returns {object|null} 落库形状的那条日志；projectId 缺失时不记
 */
function record(projectId, item) {
    if (!projectId || !item) return null;

    seq += 1;

    var status = Number(item.status);
    var duration = Number(item.durationMs);

    var entry = {
        seq: seq,
        time: Date.now(),
        method: String(item.method || ''),
        url: String(item.url || ''),
        query: item.query && typeof item.query === 'object' ? item.query : {},
        headers: maskHeaders(item.headers),
        bodyPreview: preview(item.bodyPreview),
        matched: normalizeMatched(item.matched),
        status: Number.isFinite(status) ? status : 0,
        durationMs: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : 0,
        responsePreview: preview(item.responsePreview),
        // Mock 故障模拟（第七轮第 1 节）：命中的故障，比如「返回错误 500」「延迟 +1200ms」。
        // 没命中就是空串 —— 前端据此决定要不要显示那个橙色标签。
        fault: String(item.fault || '').slice(0, 120)
    };

    var items = logs.get(projectId);
    if (!items) {
        items = [];
        logs.set(projectId, items);
    }

    items.push(entry);
    // 环形缓冲：只从头部丢，新的永远留着
    if (items.length > KEEP_PER_PROJECT) items.splice(0, items.length - KEEP_PER_PROJECT);

    return entry;
}

/**
 * 取某个项目 `seq > after` 的日志，按 seq 升序。
 *
 * @param {string} projectId
 * @param {{after?: number, limit?: number}} [options] limit 默认 100，最大 200
 * @returns {{items: Array, lastSeq: number}}
 */
function list(projectId, options) {
    options = options || {};
    var items = logs.get(projectId) || [];

    var after = Number(options.after);
    if (!Number.isFinite(after) || after < 0) after = 0;

    var limit = Number(options.limit);
    if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIMIT;
    limit = Math.min(Math.floor(limit), KEEP_PER_PROJECT);

    var picked = [];
    for (var i = 0; i < items.length && picked.length < limit; i++) {
        // items 是按 seq 升序追加的，直接从头扫就是升序
        if (items[i].seq > after) picked.push(Object.assign({}, items[i]));
    }

    return {
        items: picked,
        // **必须是这次真的返回出去的最后一条**，不能是缓冲里最后一条：
        // 一次拉不完（limit 截断）时返回缓冲末尾，中间那批就被前端永久跳过了。
        // 什么都没取到时退回 after，前端拿它继续轮询不会漏。
        lastSeq: picked.length ? picked[picked.length - 1].seq : after
    };
}

/** 清空某个项目的日志（用户在界面上点「清空」） */
function clear(projectId) {
    logs.delete(projectId);
}

/**
 * 项目被删除时调一次：这个 id 不会再产生日志了，留着就是内存泄漏。
 * 和 clear 做的是同一件事，分成两个名字是为了让调用点读起来就是那个意思。
 */
function forget(projectId) {
    logs.delete(projectId);
}

module.exports = {
    record: record,
    list: list,
    clear: clear,
    forget: forget,
    snapshotRequest: snapshotRequest,
    preview: preview,
    KEEP_PER_PROJECT: KEEP_PER_PROJECT,
    PREVIEW_LIMIT: PREVIEW_LIMIT,
    MASKED_HEADERS: MASKED_HEADERS
};
