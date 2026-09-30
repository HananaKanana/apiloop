/**
 * Mock 调用日志接口（契约第 11 节，权限见第 10 节）。
 *
 * 日志本体在内存里（lib/mock-log.js）：记录发生在 mock 运行时和 mock-host，
 * 这里只负责读和清。
 *
 * 定位一律走 `byPid` —— 日志按项目分桶，拿别人的 pid 必须和「项目不存在」
 * 长得一模一样（404），否则拿 id 挨个试就能问出「这个项目存在，只是我看不到」。
 * 读要 viewer、清空要 editor，和历史的权限一致。
 */

var express = require('express');

var respond = require('./respond');
var guardModule = require('./guard');
var mockLog = require('../mock-log');

function createRouter(ctx) {
    var router = express.Router();

    var g = guardModule.createGuard(ctx);
    var guard = g.guard;
    var byPid = g.byPid;

    /**
     * 增量拉取：前端每 2 秒带 `after=上次的 lastSeq` 调一次，只拿新增的记录。
     * `limit` 默认 100、最大 200（也就是单个项目缓冲的上限）。
     */
    router.get('/projects/:pid/mock-log', guard('viewer', byPid), respond.wrap(function (req, res) {
        var query = req.query || {};

        respond.ok(res, mockLog.list(req.project.id, {
            after: query.after,
            limit: query.limit
        }));
    }));

    /** 清空某个项目的日志。只清内存，不碰任何落库的数据 */
    router.delete('/projects/:pid/mock-log', guard('editor', byPid), respond.wrap(function (req, res) {
        mockLog.clear(req.project.id);
        respond.ok(res, {});
    }));

    return router;
}

module.exports = {
    createRouter: createRouter
};
