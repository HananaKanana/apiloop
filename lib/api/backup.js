/**
 * 项目备份与恢复（第十四轮）。
 *
 * 主会话先放的空壳，具体内容见 docs/plans/2026-10-05-round14.md。
 * 恢复的请求体可能很大：`/backup/restore` 已经在 lib/admin.js 的 BIG_BODY_PREFIXES 里（50 MB）。
 */

var express = require('express');

function createRouter(ctx) {
    var router = express.Router();
    return router;
}

module.exports = {
    createRouter: createRouter
};
