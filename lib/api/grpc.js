/**
 * gRPC 调试（第十一轮第 1 节）。
 *
 * **只在本机网关上挂**（`ctx.localSend` 为真），云端连路由都没有。
 * 主会话先放的空壳，具体内容见 docs/plans/2026-10-05-round11.md。
 */

var express = require('express');

function createRouter(ctx) {
    var router = express.Router();

    // 云端（不是本机网关）：这个 router 什么都不挂
    if (!ctx.localSend) return router;

    return router;
}

module.exports = {
    createRouter: createRouter
};
