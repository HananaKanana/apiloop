/**
 * 项目总览（管理员，2026-10-08）。
 *
 * 管理员**不再自动看到所有项目**（见 `lib/access.js` 的 roleOf：所有人都要是成员才看得到），
 * 所以给管理员一个只读入口看「一共有哪些项目、各自有哪些人」，并能直接调整成员 ——
 * 包括把自己加进某个项目（加进去之后项目下拉里才有它）。
 *
 * 只在云端有意义（成员表以云端为准），网关把 `/admin/*` 原样转发到云端
 * （`lib/gateway/account.js` 的 cloudOnlyPath）。
 *
 * 改成员的规矩和 `lib/api/members.js` 一样：项目至少留一个 owner。
 */

var express = require('express');

var respond = require('./respond');
var dto = require('./dto');
var auth = require('../auth');
var usersRepo = require('../db/repos/users');
var membersRepo = require('../db/repos/members');
var projectsRepo = require('../db/repos/projects');
var membersApi = require('./members');
var i18n = require('../i18n');

function createRouter(ctx) {
    var handle = ctx.handle;
    var router = express.Router();

    function countOf(sql, projectId) {
        var row = handle.db.prepare(sql).get(projectId);
        return row ? row.c : 0;
    }

    function projectPayload(project) {
        return {
            id: project.id,
            name: project.name,
            description: dto.str(project.description),
            isRoot: Boolean(ctx.rootProjectId && ctx.rootProjectId === project.id),
            createdAt: project.createdAt,
            updatedAt: project.updatedAt,
            apiCount: countOf('SELECT count(*) AS c FROM apis WHERE project_id = ?', project.id),
            folderCount: countOf('SELECT count(*) AS c FROM folders WHERE project_id = ?', project.id),
            members: membersRepo.list(handle, project.id).map(dto.toMemberDto)
        };
    }

    function userPayload(user) {
        return {
            id: user.id,
            username: user.username,
            displayName: user.displayName || '',
            role: user.role,
            disabled: Boolean(user.disabled),
            pending: Boolean(user.pending)
        };
    }

    router.get('/admin/projects', auth.requireAdmin, respond.wrap(function (req, res) {
        respond.ok(res, {
            projects: projectsRepo.list(handle).map(projectPayload),
            users: usersRepo.list(handle).map(userPayload)
        });
    }));

    function requireProject(pid) {
        var project = projectsRepo.getById(handle, String(pid));
        if (!project) throw respond.apiError(404, i18n.m('项目不存在'));
        return project;
    }

    router.put('/admin/projects/:pid/members/:userId', auth.requireAdmin, respond.wrap(function (req, res) {
        var project = requireProject(req.params.pid);
        var userId = String(req.params.userId);
        var role = dto.str((req.body || {}).role);

        if (membersApi.ROLES.indexOf(role) === -1) {
            throw respond.apiError(400, i18n.m('角色只能是 {roles}', { roles: membersApi.ROLES.join(' / ') }));
        }
        if (!usersRepo.getById(handle, userId)) throw respond.apiError(400, i18n.m('用户不存在'));

        handle.transaction(function () {
            var current = membersRepo.get(handle, project.id, userId);
            if (current && current.role === 'owner' && role !== 'owner' &&
                membersRepo.countOwners(handle, project.id, { excludeUserId: userId }) === 0) {
                throw respond.apiError(400, i18n.m('项目至少要保留一个 owner'));
            }
            membersRepo.upsert(handle, project.id, userId, role);
        }, { projectId: project.id });

        respond.ok(res, { project: projectPayload(projectsRepo.getById(handle, project.id)) });
    }));

    router.delete('/admin/projects/:pid/members/:userId', auth.requireAdmin, respond.wrap(function (req, res) {
        var project = requireProject(req.params.pid);
        var userId = String(req.params.userId);

        handle.transaction(function () {
            var current = membersRepo.get(handle, project.id, userId);
            if (!current) throw respond.apiError(404, i18n.m('这个用户不是项目成员'));
            if (current.role === 'owner' &&
                membersRepo.countOwners(handle, project.id, { excludeUserId: userId }) === 0) {
                throw respond.apiError(400, i18n.m('项目至少要保留一个 owner'));
            }
            membersRepo.remove(handle, project.id, userId);
        }, { projectId: project.id });

        respond.ok(res, { project: projectPayload(projectsRepo.getById(handle, project.id)) });
    }));

    return router;
}

module.exports = {
    createRouter: createRouter
};
