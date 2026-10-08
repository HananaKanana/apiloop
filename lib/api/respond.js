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
 *
 * 文案本身走 `lib/i18n`（第十六轮）：`m(...)` 按请求的 `Accept-Language` 返回中文或英文，
 * 中文原文就是查翻译用的键。**拼接出来的句子一律写成整句 + 占位符** ——
 * 半句拼起来的英文语序是错的。
 */

var i18n = require('../i18n');

/** 成功 */
function ok(res, payload) {
    var body = { ok: true };
    Object.keys(payload || {}).forEach(function (key) { body[key] = payload[key]; });
    res.json(body);
}

/**
 * 失败。
 *
 * `code` 是给前端做判断用的机器可读标记（可选的）：错误文案是给人看的，改文案不该
 * 让前端的判断跟着失效。目前只有「云端不发送请求」用它（`SERVER_SEND_DISABLED`）。
 */
function fail(res, status, message, code) {
    var body = { ok: false, error: message };
    if (code) body.code = code;
    res.status(status).json(body);
}

/**
 * 造一个带状态码的错误往外抛。
 *
 * 路由里最省事的写法是「校验不过就抛」，由 wrap 统一转成 JSON —— 否则每个 handler
 * 都得自己 if/return fail(...)，漏掉一处就是一个没接住的异常。
 */
function apiError(status, message, code) {
    var err = new Error(message);
    err.status = status;
    err.exposed = true;
    if (code) err.code = code;
    return err;
}

function notFound(res, what) {
    fail(res, 404, what ? i18n.m('找不到{what}', { what: what }) : i18n.m('找不到'));
}

/**
 * 包一层 handler，把它抛出的异常（同步抛出的，或者返回的 promise 被拒绝）转成 JSON 错误。
 *
 * 带 status 的错误（apiError 造出来的那些）按自己的状态码返回，其余一律 500
 * 并带上「服务端出错」。
 */
function wrap(handler) {
    return function (req, res, next) {
        function handle(err) {
            if (res.headersSent) return next(err);

            var status = Number(err && err.status);
            if (Number.isFinite(status) && status >= 400 && status < 600) {
                return fail(res, status, err.message, err.code);
            }

            console.error('[' + req.method + ' ' + req.originalUrl + ']', err && err.stack ? err.stack : err);
            return fail(res, 500, i18n.m('服务端出错：{reason}', {
                reason: (err && err.message) || i18n.m('未知错误')
            }));
        }

        var result;
        try {
            result = handler(req, res, next);
        } catch (err) {
            return handle(err);
        }

        // handler 返回 promise（`return registry.publish(...).then(...)` 这种）时，它的 rejection
        // 也要接住：Express 4 不管返回值，没人接的话请求会一直挂着不返回
        if (result && typeof result.then === 'function') {
            return result.then(undefined, handle);
        }
        return result;
    };
}

module.exports = {
    ok: ok,
    fail: fail,
    wrap: wrap,
    notFound: notFound,
    apiError: apiError
};
