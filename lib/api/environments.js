/**
 * 环境接口（契约第 4 节，权限见第 10 节）。
 *
 * 看环境要 viewer，改要 editor。环境本身不影响 mock 路由，但顺序和内容会进
 * /send 的变量表，事务上带着项目 id 能让相关的缓存保持一致。
 */

var express = require('express');

var respond = require('./respond');
var dto = require('./dto');
var guardModule = require('./guard');
var trash = require('../trash');
var secrets = require('../secrets');
var environmentsRepo = require('../db/repos/environments');
var i18n = require('../i18n');

function createRouter(ctx) {
    var handle = ctx.handle;
    var router = express.Router();

    var g = guardModule.createGuard(ctx);
    var guard = g.guard;
    var byPid = g.byPid;
    var byParam = g.byParam;

    function mustFindEnvironment(req) {
        var environment = environmentsRepo.get(handle, req.params.id);
        if (!environment) throw respond.apiError(404, i18n.m('环境不存在：{id}', { id: req.params.id }));
        return environment;
    }

    router.get('/projects/:pid/environments', guard('viewer', byPid), respond.wrap(function (req, res) {
        respond.ok(res, {
            environments: environmentsRepo.list(handle, req.project.id).map(function (environment) {
                // 保密行按当前用户把自己的值填回去（见 lib/secrets.js）
                return dto.toEnvironmentDto(environment, ctx, req.user);
            })
        });
    }));

    router.post('/projects/:pid/environments', guard('editor', byPid), respond.wrap(function (req, res) {
        var project = req.project;
        var body = req.body || {};

        var created = handle.transaction(function () {
            var environment = environmentsRepo.create(handle, project.id, {
                name: dto.str(body.name),
                variables: dto.toVarRows(body.variables)
            });

            // 保密行：值收进自己的表、共享数据里留空（环境 id 要等建出来才知道，所以建完再分）
            if ((environment.variables || []).some(function (row) { return row.secret; })) {
                return environmentsRepo.update(handle, environment.id, {
                    variables: secrets.split(handle, req.user.id, 'environment', environment.id, environment.variables)
                });
            }
            return environment;
        }, { projectId: project.id });

        respond.ok(res, { environment: dto.toEnvironmentDto(created, ctx, req.user) });
    }));

    router.put('/environments/:id', guard('editor', byParam('environment')), respond.wrap(function (req, res) {
        var environment = mustFindEnvironment(req);
        var body = req.body || {};
        var patch = {};

        if (body.name !== undefined) patch.name = dto.str(body.name);
        if (body.variables !== undefined) {
            patch.variables = secrets.split(handle, req.user.id, 'environment', environment.id, dto.toVarRows(body.variables));
        }

        var updated = handle.transaction(function () {
            return environmentsRepo.update(handle, environment.id, patch);
        }, { projectId: environment.projectId });

        respond.ok(res, { environment: dto.toEnvironmentDto(updated, ctx, req.user) });
    }));

    router.delete('/environments/:id', guard('editor', byParam('environment')), respond.wrap(function (req, res) {
        var environment = mustFindEnvironment(req);

        handle.transaction(function () {
            // 先记回收站，再照常删除（同一个事务）；环境没了，它的保密值也顺手清掉
            trash.captureEnvironment(handle, environment, req.user);
            environmentsRepo.remove(handle, environment.id);
            secrets.forgetScope(handle, 'environment', environment.id);
        }, { projectId: environment.projectId });

        respond.ok(res, {});
    }));

    return router;
}

module.exports = {
    createRouter: createRouter
};
