/**
 * 管理台接口的响应约定。
 *
 * 统一形状（契约第 0 节）：
 *   成功 { ok: true, ...数据 }    失败 { ok: false, error: '可以直接给用户看的中文' }
 *
 * 错误信息一律给人看，**不要把堆栈返回给前端**：没预料到的异常统一是 500，信息写成
 * 「服务端出错：<原因>」，真正的堆栈打到服务端日志里（由 admin.js 的兜底中间件负责）。
 *
 * 几个路由文件都用同一句话表达同一件事，所以错误文案尽量收在这里，
 * 免得同一个意思在三处写法不同。
 */

/** 成功 */
function ok(res, payload) {
    var body = { ok: true };
    Object.keys(payload || {}).forEach(function (key) { body[key] = payload[key]; });
    res.json(body);
}

/** 失败 */
function fail(res, status, message) {
    res.status(status).json({ ok: false, error: message });
}

/**
 * 造一个带状态码的错误往外抛。
 *
 * 路由里最省事的写法是「校验不过就抛」，由 wrap 统一转成 JSON —— 否则每个 handler
 * 都得自己 if/return fail(...)，漏掉一处就是一个没接住的异常。
 */
function apiError(status, message) {
    var err = new Error(message);
    err.status = status;
    err.exposed = true;
    return err;
}

function notFound(res, what) {
    fail(res, 404, what ? ('找不到' + what) : '找不到');
}

/**
 * 包一层 handler，把它同步抛出的异常转成 JSON 错误。
 *
 * 带 status 的错误（apiError 造出来的那些）按自己的状态码返回，其余一律 500
 * 并带上「服务端出错」。异步操作自己 try/catch —— 这里只兜同步的部分。
 */
function wrap(handler) {
    return function (req, res, next) {
        try {
            return handler(req, res, next);
        } catch (err) {
            if (res.headersSent) return next(err);

            var status = Number(err && err.status);
            if (Number.isFinite(status) && status >= 400 && status < 600) {
                return fail(res, status, err.message);
            }

            console.error('[' + req.method + ' ' + req.originalUrl + ']', err && err.stack ? err.stack : err);
            return fail(res, 500, '服务端出错：' + ((err && err.message) || '未知错误'));
        }
    };
}

module.exports = {
    ok: ok,
    fail: fail,
    wrap: wrap,
    notFound: notFound,
    apiError: apiError
};
