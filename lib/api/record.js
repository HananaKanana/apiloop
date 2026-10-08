/**
 * Mock 录制（第十一轮第 2 节）。
 *
 * **只在本机网关上挂**（`ctx.localSend` 为真），云端连路由都没有 —— 代理要在用户自己的
 * 电脑上开端口，云端开一个也没有意义。
 *
 * 五个接口：
 *   - `POST   /projects/:pid/record/start`   editor   开代理
 *   - `POST   /projects/:pid/record/stop`    editor   停代理（记录保留）
 *   - `GET    /projects/:pid/record`         viewer   拉记录（`?after=` 只要增量）
 *   - `DELETE /projects/:pid/record/entries` editor   清空记录
 *   - `POST   /projects/:pid/record/save`    editor   存成示例 / 新建接口
 *
 * 代理、记录、匹配在 `lib/record-proxy.js`；存示例在 `lib/record-save.js`。
 */

var express = require('express');

var respond = require('./respond');
var guardModule = require('./guard');
var environmentsRepo = require('../db/repos/environments');
var variables = require('../variables');
var recorder = require('../record-proxy');
var recordSave = require('../record-save');
var i18n = require('../i18n');

function createRouter(ctx) {
    var router = express.Router();

    // 云端（不是本机网关）：这个 router 什么都不挂
    if (!ctx.localSend) return router;

    var g = guardModule.createGuard(ctx);
    var guard = g.guard;
    var byPid = g.byPid;

    /** 把异常转成 JSON 错误；start 是异步的，不能靠 respond.wrap 兜 */
    function failFrom(res, err) {
        if (res.headersSent || res.writableEnded) return;

        var status = Number(err && err.status);
        if (Number.isFinite(status) && status >= 400 && status < 600) {
            return respond.fail(res, status, err.message, err.code);
        }
        console.error('[record]', err && err.stack ? err.stack : err);
        return respond.fail(res, 500, i18n.m('服务端出错：{reason}', {
            reason: (err && err.message) || i18n.m('未知错误')
        }));
    }

    /**
     * target 里的 `{{变量}}` 按「项目变量 → 环境变量」替换（和执行时的优先级一致）。
     * 保密变量这里不做解密 —— 目标地址里写保密变量没有意义，写了就当没定义。
     */
    function resolveTarget(project, body) {
        var environmentId = body.environmentId ? String(body.environmentId) : '';
        var environment = environmentId ? environmentsRepo.get(ctx.handle, environmentId) : null;
        if (environment && environment.projectId !== project.id) environment = null;

        var rows = (project.variables || []).concat(environment ? (environment.variables || []) : []);
        return variables.resolve(String(body.target || ''), variables.fromRows(rows)).text.trim();
    }

    router.post('/projects/:pid/record/start', guard('editor', byPid), function (req, res) {
        var body = req.body || {};
        var target;

        try {
            target = resolveTarget(req.project, body);
        } catch (err) {
            return failFrom(res, err);
        }

        recorder.start(ctx.handle, req.project, {
            target: target,
            port: body.port,
            lan: body.lan,
            pathPrefix: body.pathPrefix,
            skipStatic: body.skipStatic
        }).then(function (recording) {
            respond.ok(res, { recording: recording });
        }).catch(function (err) {
            failFrom(res, err);
        });

        return undefined;
    });

    router.post('/projects/:pid/record/stop', guard('editor', byPid), respond.wrap(function (req, res) {
        recorder.stop(req.project.id);
        respond.ok(res, { recording: null });
    }));

    router.get('/projects/:pid/record', guard('viewer', byPid), respond.wrap(function (req, res) {
        respond.ok(res, recorder.list(req.project.id, (req.query || {}).after));
    }));

    router.delete('/projects/:pid/record/entries', guard('editor', byPid), respond.wrap(function (req, res) {
        recorder.clear(req.project.id);
        respond.ok(res, recorder.list(req.project.id, 0));
    }));

    router.post('/projects/:pid/record/save', guard('editor', byPid), respond.wrap(function (req, res) {
        respond.ok(res, recordSave.save({
            handle: ctx.handle,
            project: req.project,
            body: req.body || {}
        }));
    }));

    return router;
}

module.exports = {
    createRouter: createRouter
};
