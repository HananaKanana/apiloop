/**
 * 环境接口（契约第 4 节）。
 *
 * 环境只是「一组变量」，和项目一样属于写操作要带 projectId 的那一类 ——
 * 变量本身不影响 mock 路由，但顺序和内容会进 /send 的变量表，事务上带着项目 id
 * 能让相关的缓存保持一致。
 */

var express = require('express');

var respond = require('./respond');
var dto = require('./dto');
var environmentsRepo = require('../db/repos/environments');

function createRouter(ctx) {
    var handle = ctx.handle;
    var router = express.Router();

    function mustFindProject(req) {
        var project = dto.findProject(handle, req.params.pid);
        if (!project) throw respond.apiError(404, '项目不存在：' + req.params.pid);
        return project;
    }

    function mustFindEnvironment(req) {
        var environment = environmentsRepo.get(handle, req.params.id);
        if (!environment) throw respond.apiError(404, '环境不存在：' + req.params.id);
        return environment;
    }

    router.get('/projects/:pid/environments', respond.wrap(function (req, res) {
        var project = mustFindProject(req);
        respond.ok(res, {
            environments: environmentsRepo.list(handle, project.id).map(dto.toEnvironmentDto)
        });
    }));

    router.post('/projects/:pid/environments', respond.wrap(function (req, res) {
        var project = mustFindProject(req);
        var body = req.body || {};

        var created = handle.transaction(function () {
            return environmentsRepo.create(handle, project.id, {
                name: dto.str(body.name),
                variables: dto.toVarRows(body.variables)
            });
        }, { projectId: project.id });

        respond.ok(res, { environment: dto.toEnvironmentDto(created) });
    }));

    router.put('/environments/:id', respond.wrap(function (req, res) {
        var environment = mustFindEnvironment(req);
        var body = req.body || {};
        var patch = {};

        if (body.name !== undefined) patch.name = dto.str(body.name);
        if (body.variables !== undefined) patch.variables = dto.toVarRows(body.variables);

        var updated = handle.transaction(function () {
            return environmentsRepo.update(handle, environment.id, patch);
        }, { projectId: environment.projectId });

        respond.ok(res, { environment: dto.toEnvironmentDto(updated) });
    }));

    router.delete('/environments/:id', respond.wrap(function (req, res) {
        var environment = mustFindEnvironment(req);

        handle.transaction(function () {
            environmentsRepo.remove(handle, environment.id);
        }, { projectId: environment.projectId });

        respond.ok(res, {});
    }));

    return router;
}

module.exports = {
    createRouter: createRouter
};
