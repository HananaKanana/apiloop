/**
 * 「创建样例项目」（2026-10-04 用户要的）：`POST /projects/demo`，建好一个什么都配齐了的项目拿来试功能。
 *
 * 请求体 `{ origin }`：云端地址（Mock 地址的前半段）。样例项目的接口都打到它自己的 Mock 上，
 * 环境里的 `host` 要写成 `origin/mock-<项目 id>`，而云端地址只有页面知道
 * （客户端里是网关记着的云端地址，网页版是当前页面的地址，见前端 utils/mock.js 的 mockBaseUrl）。
 *
 * 权限和 `POST /projects` 一样：登录了就能建，建的人是 owner。内容见 lib/demo-project.js。
 */

var express = require('express');

var respond = require('./respond');
var dto = require('./dto');
var demoProject = require('../demo-project');
var i18n = require('../i18n');

function createRouter(ctx) {
    var handle = ctx.handle;
    var router = express.Router();

    router.post('/projects/demo', respond.wrap(function (req, res) {
        var origin = dto.str((req.body || {}).origin).trim();
        if (!/^https?:\/\/[^\s/]+/i.test(origin)) {
            throw respond.apiError(400, i18n.m('缺少云端地址（origin），没法算出 Mock 地址'));
        }

        var created = demoProject.createDemoProject(handle, req.user || null, origin);
        respond.ok(res, {
            project: dto.toProjectDto(created.project, ctx, req.user),
            environmentId: created.environmentId
        });
    }));

    return router;
}

module.exports = {
    createRouter: createRouter
};
