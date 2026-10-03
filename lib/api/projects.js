/**
 * 项目接口（契约第 2 节，权限见第 10 节）。
 *
 * 除了「列项目」和「建项目」，每条路由都挂了 guard：
 *   - 看项目 / 建项目：登录即可（列表按成员关系过滤）；
 *   - 改变量、描述：editor；
 *   - 改名字 / 标识、删项目：owner。
 *
 * 删项目还有两条额外限制：根项目和默认项目一律不许删 —— 根项目承载着
 * 「老接口挂在 /api/xxx」这个兼容面，默认项目是启动时兜底建出来的，删了下次启动
 * 又会冒出来一个空的。
 */

var express = require('express');
var fs = require('fs');
var path = require('path');

var respond = require('./respond');
var dto = require('./dto');
var guardModule = require('./guard');
var access = require('../access');
var secrets = require('../secrets');
var commonHeaders = require('../common-headers');
var appInfo = require('../app-info');
var projectsRepo = require('../db/repos/projects');
var projectStores = require('../project-stores');
var mockLog = require('../mock-log');

function createRouter(ctx) {
    var handle = ctx.handle;
    var router = express.Router();

    var g = guardModule.createGuard(ctx);
    var guard = g.guard;
    var byPid = g.byPid;

    router.get('/projects', respond.wrap(function (req, res) {
        // 默认项目排最前，其余按创建时间 —— 排序由 repo 负责；
        // 过滤由 access 负责（admin 看全部，其他人只看自己参与的）
        respond.ok(res, {
            projects: access.visibleProjects(handle, req.user).map(function (project) {
                return dto.toProjectDto(project, ctx, req.user);
            })
        });
    }));

    router.post('/projects', respond.wrap(function (req, res) {
        var body = req.body || {};
        var name = dto.str(body.name).trim();
        if (!name) throw respond.apiError(400, '请填写项目名');

        var created = handle.transaction(function () {
            var project = projectsRepo.create(handle, {
                name: name,
                slug: body.slug ? String(body.slug) : undefined,
                description: dto.str(body.description),
                created_by: req.user ? req.user.id : null
            });
            // 创建者自动成为 owner —— 不开这个口子的话，「仅成员可见」一上线，
            // 他刚建好的项目自己就看不见了
            access.addOwner(handle, project.id, req.user ? req.user.id : null);
            return project;
        }, { projectId: null });

        respond.ok(res, { project: dto.toProjectDto(created, ctx, req.user) });
    }));

    router.get('/projects/:pid', guard('viewer', byPid), respond.wrap(function (req, res) {
        respond.ok(res, { project: dto.toProjectDto(req.project, ctx, req.user) });
    }));

    router.put('/projects/:pid', guard('editor', byPid), respond.wrap(function (req, res) {
        var project = req.project;
        var body = req.body || {};
        var patch = {};

        // 改名 / 改标识属于 owner 的地盘。guard 挂的是 editor（描述和变量要让它过），
        // 所以这两项在这里单独再判一次。
        if (body.name !== undefined || body.slug !== undefined) {
            if (!access.atLeast(req.role, 'owner')) {
                throw respond.apiError(403, '需要 owner 权限');
            }
        }

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
        if (body.variables !== undefined) {
            // 保密行的值收进自己的表、共享数据里留空；关掉保密 / 删掉行的残留一起清
            patch.variables = secrets.split(handle, req.user.id, 'project', project.id, dto.toVarRows(body.variables));
        }
        if (body.auth !== undefined) patch.auth = dto.toAuth(body.auth);
        // 契约第 16 节：脚本从「只读展示」改成可编辑
        if (body.scripts !== undefined) patch.scripts = dto.toScriptsStrict(body.scripts);
        /* 内置 Mock 环境的变量 + 公共请求头（第五轮第 1 节）：两样都住在 extra 里，
         * 所以**读出原来的 extra 再合并**，别把对方冲掉。 */
        if (body.mockVariables !== undefined || body.headers !== undefined) {
            var extra = Object.assign({}, project.extra || {});

            if (body.mockVariables !== undefined) {
                if (body.mockVariables === null) delete extra.mockVariables;
                else extra.mockVariables = dto.toVarRows(body.mockVariables);
            }

            if (body.headers !== undefined) extra = commonHeaders.withHeaders(extra, body.headers);

            patch.extra = extra;
        }

        var updated = handle.transaction(function () {
            return projectsRepo.update(handle, project.id, patch);
        }, { projectId: project.id });

        respond.ok(res, { project: dto.toProjectDto(updated, ctx, req.user) });
    }));

    router.delete('/projects/:pid', guard('owner', byPid), respond.wrap(function (req, res) {
        var project = req.project;

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

        // 调用日志在内存里按 projectId 分桶，项目没了就顺手丢掉 ——
        // 不丢的话这份日志会一直留着，直到进程重启。
        mockLog.forget(project.id);

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
