/**
 * 项目接口（契约第 2 节）。
 *
 * 删除项目是这里唯一有权限要求的接口：**只有 admin 能删**，而且根项目和默认项目
 * 一律不许删 —— 根项目承载着「老接口挂在 /api/xxx」这个兼容面，默认项目是启动时
 * 兜底建出来的，删了下次启动又会冒出来一个空的。
 */

var express = require('express');
var fs = require('fs');
var path = require('path');

var respond = require('./respond');
var dto = require('./dto');
var appInfo = require('../app-info');
var projectsRepo = require('../db/repos/projects');
var projectStores = require('../project-stores');

function createRouter(ctx) {
    var handle = ctx.handle;
    var router = express.Router();

    function mustFind(req) {
        var project = dto.findProject(handle, req.params.pid);
        if (!project) throw respond.apiError(404, '项目不存在：' + req.params.pid);
        return project;
    }

    router.get('/projects', respond.wrap(function (req, res) {
        // 默认项目排最前，其余按创建时间 —— 排序由 repo 负责
        respond.ok(res, {
            projects: projectsRepo.list(handle).map(function (project) {
                return dto.toProjectDto(project, ctx);
            })
        });
    }));

    router.post('/projects', respond.wrap(function (req, res) {
        var body = req.body || {};
        var name = dto.str(body.name).trim();
        if (!name) throw respond.apiError(400, '请填写项目名');

        var created = handle.transaction(function () {
            return projectsRepo.create(handle, {
                name: name,
                slug: body.slug ? String(body.slug) : undefined,
                description: dto.str(body.description),
                created_by: req.user ? req.user.id : null
            });
        }, { projectId: null });

        respond.ok(res, { project: dto.toProjectDto(created, ctx) });
    }));

    router.get('/projects/:pid', respond.wrap(function (req, res) {
        respond.ok(res, { project: dto.toProjectDto(mustFind(req), ctx) });
    }));

    router.put('/projects/:pid', respond.wrap(function (req, res) {
        var project = mustFind(req);
        var body = req.body || {};
        var patch = {};

        if (body.name !== undefined) {
            var name = dto.str(body.name).trim();
            if (!name) throw respond.apiError(400, '项目名不能为空');
            patch.name = name;
        }

        if (body.slug !== undefined) {
            var slug = projectsRepo.normalizeSlug(body.slug);
            // 这里是用户主动改的，不能像新建那样自动加 -2 —— 那样他会以为自己改成功了。
            // 归一化之后可能撞上自己（比如只改了大小写），那种不算占用。
            var occupied = projectsRepo.getBySlug(handle, slug);
            if (occupied && occupied.id !== project.id) {
                throw respond.apiError(400, '标识已被占用');
            }
            patch.slug = slug;
        }

        if (body.description !== undefined) patch.description = dto.str(body.description);
        if (body.variables !== undefined) patch.variables = dto.toVarRows(body.variables);
        if (body.auth !== undefined) patch.auth = dto.toAuth(body.auth);

        var updated = handle.transaction(function () {
            return projectsRepo.update(handle, project.id, patch);
        }, { projectId: project.id });

        respond.ok(res, { project: dto.toProjectDto(updated, ctx) });
    }));

    router.delete('/projects/:pid', respond.wrap(function (req, res) {
        var project = mustFind(req);

        if (!req.user || req.user.role !== 'admin') {
            throw respond.apiError(403, '需要管理员权限');
        }
        if (ctx.rootProjectId === project.id) {
            throw respond.apiError(400, '根项目不能删除');
        }
        if (project.isDefault) {
            throw respond.apiError(400, '默认项目不能删除');
        }

        // 删项目会影响所有项目（slug 映射也变了），所以 projectId 传 null
        handle.transaction(function () {
            projectsRepo.remove(handle, project.id);
        }, { projectId: null });

        // 事务提交之后再摘缓存：store 收到 change 事件会自己重读，
        // 摘早了反而会让它带着一个已经不存在的项目白跑一趟。
        projectStores.forget(handle, project.id);

        // 项目没了，它上传的文件也没有存在的意义。尽力删，失败只记日志 ——
        // 库里已经没有这个项目了，几个残留文件不值得让整个删除请求失败。
        removeUploadedFiles(project.id);

        respond.ok(res, {});
    }));

    return router;
}

module.exports = {
    createRouter: createRouter
};

/**
 * 删掉某个项目上传的文件目录（<DATA_DIR>/files/<pid>）。
 *
 * 尽力而为：删不掉只打日志，不能让它把删除请求弄成 500 —— 数据库里项目已经没了，
 * 留下几个孤儿文件是小事。`force: true` 让目录本来就不存在时也不算错。
 */
function removeUploadedFiles(projectId) {
    var dir = path.join(appInfo.DATA_DIR, 'files', String(projectId));

    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch (err) {
        console.error('[apiloop] 清理项目 ' + projectId + ' 的上传文件失败：' + ((err && err.message) || err));
    }
}
