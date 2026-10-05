/**
 * 项目备份与恢复的接口（第十四轮）。
 *
 * 七条路由：
 *
 *   - `GET /projects/:pid/backup`（editor）：导出，直接下文件；
 *   - `POST /backup/restore`：恢复（`mode: new` / `overwrite`）。**不挂项目 guard** ——
 *     目标项目在请求体里（`overwrite` 时），权限由 `lib/backup.js` 判（要 owner）；
 *     `new` 是建自己的新项目，登录就能做；
 *   - `GET / PUT /settings/backup`：自动备份的设置（写要管理员）。放在这个文件里而不是
 *     `lib/api/settings.js`：这本来就是备份自己的设置，而且 settings.js 这次不在改动范围里；
 *   - `GET /projects/:pid/backups`（owner）、`GET /projects/:pid/backups/:id`（owner）、
 *     `POST /projects/:pid/backups/:id/restore`（owner）：云端自动备份的列表 / 下载 / 恢复。
 *
 * **导出和恢复在网关上照常可用**（读写本机库，离线也能恢复，之后同步上去）；
 * `/settings/backup` 和 `/projects/:pid/backups*` 是「只有云端有的」（文件在云端的磁盘上），
 * 网关由 `lib/gateway/account.js` 的 `cloudOnlyPath` 转给云端。
 */

var express = require('express');

var respond = require('./respond');
var dto = require('./dto');
var guardModule = require('./guard');
var auth = require('../auth');
var backup = require('../backup');
var scheduler = require('../backup-scheduler');

/** 下载用的响应头：不缓存（备份是「导出那一刻」的快照，缓存住反而误导） */
function sendDownload(res, fileName, text) {
    res.status(200);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', backup.disposition(fileName));
    res.setHeader('Cache-Control', 'no-store');
    res.send(text);
}

/** 恢复的响应体：`trashed` / `deletedSuites` 只有覆盖模式才有 */
function restorePayload(ctx, req, outcome) {
    var payload = {
        project: dto.toProjectDto(outcome.project, ctx, req.user),
        warnings: outcome.warnings || []
    };
    if (outcome.trashed) {
        payload.trashed = outcome.trashed;
        payload.deletedSuites = outcome.deletedSuites;
    }
    return payload;
}

function createRouter(ctx) {
    var handle = ctx.handle;
    var router = express.Router();

    var g = guardModule.createGuard(ctx);
    var guard = g.guard;
    var byPid = g.byPid;

    /* ---------------------------------------------------------- 导出 */

    router.get('/projects/:pid/backup', guard('editor', byPid), respond.wrap(function (req, res) {
        var payload = backup.build(handle, req.project.id);
        sendDownload(res, backup.fileName(req.project.name, payload.exportedAt),
            JSON.stringify(payload, null, 2));
    }));

    /* ---------------------------------------------------------- 恢复 */

    /**
     * 恢复。请求体最大 50 MB（`/backup/restore` 在 `lib/admin.js` 的 BIG_BODY_PREFIXES 里）。
     *
     * `userId` / `user` 都传：前者用来给新项目记 owner、记回收站的 `deleted_by`，
     * 后者给 `access.roleOf` 判「能不能覆盖这个项目」。
     */
    router.post('/backup/restore', respond.wrap(function (req, res) {
        var body = req.body || {};

        var outcome = backup.restore(handle, {
            backup: body.backup,
            mode: body.mode,
            name: body.name,
            projectId: body.projectId,
            userId: req.user ? req.user.id : null,
            user: req.user
        });

        respond.ok(res, restorePayload(ctx, req, outcome));
    }));

    /* ---------------------------------------------------------- 自动备份设置 */

    router.get('/settings/backup', respond.wrap(function (req, res) {
        respond.ok(res, { backup: scheduler.getSettings(handle) });
    }));

    router.put('/settings/backup', auth.requireAdmin, respond.wrap(function (req, res) {
        var input = dto.plainObject((req.body || {}).backup);
        if (!input) throw respond.apiError(400, '缺少 backup');

        respond.ok(res, { backup: scheduler.setSettings(handle, input) });
    }));

    /* ---------------------------------------------------------- 云端自动备份的文件 */

    router.get('/projects/:pid/backups', guard('owner', byPid), respond.wrap(function (req, res) {
        respond.ok(res, { items: scheduler.listBackups(handle, req.project.id) });
    }));

    router.get('/projects/:pid/backups/:id', guard('owner', byPid), respond.wrap(function (req, res) {
        var got = scheduler.readBackup(handle, req.project.id, req.params.id);

        sendDownload(res,
            'apiloop-' + (backup.safeFileName(req.project.name) || '项目') + '-' + got.id + '.json',
            JSON.stringify(got.backup, null, 2));
    }));

    /**
     * 拿一份自动备份恢复，等于把那份文件交给 `/backup/restore`。
     *
     * `mode: 'new'` 时名字由调用方给（不给就用备份里那个名字加「（恢复）」，见 lib/backup.js）；
     * `mode: 'overwrite'` 时覆盖的就是**当前这个项目**（`:pid`）。
     */
    router.post('/projects/:pid/backups/:id/restore', guard('owner', byPid), respond.wrap(function (req, res) {
        var body = req.body || {};
        var got = scheduler.readBackup(handle, req.project.id, req.params.id);

        var outcome = backup.restore(handle, {
            backup: got.backup,
            mode: body.mode,
            name: body.name,
            projectId: req.project.id,
            userId: req.user ? req.user.id : null,
            user: req.user
        });

        respond.ok(res, restorePayload(ctx, req, outcome));
    }));

    return router;
}

module.exports = {
    createRouter: createRouter
};
