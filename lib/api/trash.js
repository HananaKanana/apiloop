/**
 * 回收站接口（第三轮第 1 节，权限见契约第 10 节）。
 *
 * 看回收站要 viewer，恢复 / 彻底删除 / 清空要 editor —— 和「看目录树 / 改目录树」一个口径。
 *
 * 列表**不返回 payload**（那是内部格式，还可能是几十 KB）：
 * 只给 `{ id, kind, name, location, deletedBy: {id, displayName}, deletedAt, count }`，
 * 其中 `count` 是这一条里装了几个接口（目录看整棵子树、接口是 1、环境是 0）。
 *
 * 恢复的落地逻辑在 lib/trash.js（换新 id 重新插回去），这里只管权限和事务。
 */

var express = require('express');

var respond = require('./respond');
var guardModule = require('./guard');
var trashModule = require('../trash');
var trashRepo = require('../db/repos/trash');
var usersRepo = require('../db/repos/users');

function createRouter(ctx) {
    var handle = ctx.handle;
    var router = express.Router();

    var g = guardModule.createGuard(ctx);
    var guard = g.guard;
    var byPid = g.byPid;
    var byParam = g.byParam;

    function mustItem(id) {
        var item = trashRepo.get(handle, id);
        if (!item) throw respond.apiError(404, '回收站里没有这一条：' + id);
        return item;
    }

    /** 这一条里装了几个接口 */
    function countOf(item) {
        var payload = item.payload || {};
        if (item.kind === 'api') return 1;
        if (item.kind === 'folder') return (payload.api || []).length;
        return 0;
    }

    function summaryOf(item) {
        var deleter = item.deletedBy ? usersRepo.getById(handle, item.deletedBy) : null;
        return {
            id: item.id,
            kind: item.kind,
            name: item.name,
            location: item.location,
            deletedBy: item.deletedBy
                ? { id: item.deletedBy, displayName: deleter ? (deleter.displayName || deleter.username) : '' }
                : null,
            deletedAt: item.deletedAt,
            count: countOf(item)
        };
    }

    router.get('/projects/:pid/trash', guard('viewer', byPid), respond.wrap(function (req, res) {
        respond.ok(res, {
            items: trashRepo.list(handle, req.project.id).map(summaryOf)
        });
    }));

    router.post('/trash/:id/restore', guard('editor', byParam('trash')), respond.wrap(function (req, res) {
        var item = mustItem(req.params.id);

        var result = handle.transaction(function () {
            return trashModule.restore(handle, item);
        }, { projectId: item.projectId });

        respond.ok(res, result);
    }));

    router.delete('/trash/:id', guard('editor', byParam('trash')), respond.wrap(function (req, res) {
        var item = mustItem(req.params.id);

        handle.transaction(function () {
            trashRepo.remove(handle, item.id);
        }, { projectId: item.projectId });

        respond.ok(res, {});
    }));

    router.delete('/projects/:pid/trash', guard('editor', byPid), respond.wrap(function (req, res) {
        var removed = handle.transaction(function () {
            return trashRepo.clear(handle, req.project.id);
        }, { projectId: req.project.id });

        respond.ok(res, { removed: removed });
    }));

    return router;
}

module.exports = {
    createRouter: createRouter
};
