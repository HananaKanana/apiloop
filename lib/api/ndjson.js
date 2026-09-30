/**
 * NDJSON 流式响应（契约第 14 节，流式发送与 WebSocket 的 `/events` 共用）。
 *
 * NDJSON = 每行一个 JSON 对象，行之间用 `\n` 分隔。用它而不是 SSE，是因为
 * 事件里既有结构化数据（响应头、执行结果）也有任意文本；SSE 的 `data:` 前缀要多一层
 * 转义，而且我们的前端本来就是自己解析的，不依赖 `EventSource`。
 *
 * 两个必须记住的点：
 * - **响应头照契约写死**：`application/x-ndjson; charset=utf-8`、`Cache-Control: no-cache`、
 *   `X-Accel-Buffering: no`。最后那个是给 Nginx 看的，没有它整段响应会被 Nginx 缓冲住，
 *   「实时」就成了摆设。
 * - **`start` 之后一定要 `flushHeaders()`**：Express / Node 默认攒够一定字节才发响应头，
 *   不 flush 的话前端要等到第一个事件才看到 200，连接还没建立起来的观感就没了。
 */

/** 契约第 14 节的响应类型 */
var CONTENT_TYPE = 'application/x-ndjson; charset=utf-8';

/**
 * 开始流式输出：设置响应头并立刻把响应头发出去。
 *
 * 调用它之前**不能**有任何写入 —— 一旦 `res.write` 过，状态码和响应头就定死了，
 * 校验阶段的错误就只能按 JSON 返回（契约第 14 节：开始流式输出之前出的错按普通 JSON 返回）。
 *
 * @param {object} res Express 的响应对象
 */
function start(res) {
    res.status(200);
    res.setHeader('Content-Type', CONTENT_TYPE);
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
}

/**
 * 写一行 JSON。
 *
 * **连接已经断开时返回 false，绝不抛异常。** 流式发送的每一段数据后面都跟着一次写入，
 * 这里抛出去就能把一个「用户已经关掉页签」的场景变成服务端 500。
 *
 * @param {object} res
 * @param {object} payload 会被 JSON.stringify
 * @returns {boolean} 是否真的写进了缓冲区
 */
function write(res, payload) {
    if (!res || res.writableEnded || res.destroyed) return false;

    var line;
    try {
        // 用 Buffer 长度算不出换行，直接拼字符串；JSON.stringify 出来的不会有裸换行
        line = JSON.stringify(payload) + '\n';
    } catch (err) {
        // 循环引用之类：这一条事件发不出去，也不能把整个响应打断
        return false;
    }

    try {
        return res.write(line);
    } catch (err) {
        return false;
    }
}

module.exports = {
    CONTENT_TYPE: CONTENT_TYPE,
    start: start,
    write: write
};
