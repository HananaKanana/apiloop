/**
 * 项目成员接口（契约第 10 节）。
 *
 * 权限：看成员列表要 viewer（成员自己得能看到这个项目里有谁），改成员要 owner；
 * 唯一的例外是「自己退出」—— 那是成员自己的事，viewer 就够。
 *
 * 所有会改动成员的操作都要保证**项目至少留下一个 owner**，否则这个项目从此没人
 * 管得了（admin 还能救，但不该让它变成常态）。判断放在事务里，用
 * `countOwners(..., { excludeUserId })` 算「把这个人拿掉之后还剩几个 owner」。
 */

var express = require('express');

var respond = require('./respond');
var dto = require('./dto');
var guardModule = require('./guard');
var access = require('../access');
var usersRepo = require('../db/repos/users');
var membersRepo = require('../db/repos/members');

/** 能被指派的项目角色。admin 是系统角色，不通过成员接口授予 */
var ROLES = ['viewer', 'editor', 'owner'];

function createRouter(ctx) {
    var handle = ctx.handle;
    var router = express.Router();

    var g = guardModule.createGuard(ctx);
    var guard = g.guard;
    var byPid = g.byPid;

    /** 成员列表的响应体。形状按契约：projectId 是内部字段，不外发 */
    function memberPayload(projectId) {
        return membersRepo.list(handle, projectId).map(dto.toMemberDto);
    }

    router.get('/projects/:pid/members', guard('viewer', byPid), respond.wrap(function (req, res) {
        respond.ok(res, { members: memberPayload(req.project.id) });
    }));

    router.put('/projects/:pid/members/:userId', guard('owner', byPid), respond.wrap(function (req, res) {
        var project = req.project;
        var userId = String(req.params.userId);
        var role = dto.str((req.body || {}).role);

        if (ROLES.indexOf(role) === -1) {
            throw respond.apiError(400, '角色只能是 ' + ROLES.join(' / '));
        }
        // 用户不存在是请求写错了（400），不是「资源找不到」——
        // 加成员加到一个不存在的用户 id 上，用户得自己知道是 id 错了
        if (!usersRepo.getById(handle, userId)) {
            throw respond.apiError(400, '用户不存在');
        }

        handle.transaction(function () {
            var current = membersRepo.get(handle, project.id, userId);
            // 把一个 owner 降成别的角色之前，先看看这个项目还有没有别的 owner
            if (current && current.role === 'owner' && role !== 'owner' &&
                membersRepo.countOwners(handle, project.id, { excludeUserId: userId }) === 0) {
                throw respond.apiError(400, '项目至少要保留一个 owner');
            }
            membersRepo.upsert(handle, project.id, userId, role);
        }, { projectId: project.id });

        respond.ok(res, { members: memberPayload(project.id) });
    }));

    router.delete('/projects/:pid/members/:userId', guard('viewer', byPid), respond.wrap(function (req, res) {
        var project = req.project;
        var userId = String(req.params.userId);
        var isSelf = req.user && userId === req.user.id;

        // 自己退出只要 viewer（guard 已经保证了这一点）；移除别人要 owner
        if (!isSelf && !access.atLeast(req.role, 'owner')) {
            throw respond.apiError(403, '需要 owner 权限');
        }

        handle.transaction(function () {
            var current = membersRepo.get(handle, project.id, userId);
            if (!current) throw respond.apiError(404, '这个用户不是项目成员');

            if (current.role === 'owner' &&
                membersRepo.countOwners(handle, project.id, { excludeUserId: userId }) === 0) {
                throw respond.apiError(400, '项目至少要保留一个 owner');
            }

            membersRepo.remove(handle, project.id, userId);
        }, { projectId: project.id });

        respond.ok(res, { members: memberPayload(project.id) });
    }));

    return router;
}

module.exports = {
    createRouter: createRouter,
    ROLES: ROLES
};
