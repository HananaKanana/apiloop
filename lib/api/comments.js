/**
 * 接口评论和 @ 提醒（第五轮第 4 节）。
 *
 * 前后端联调时的问题（「这个字段什么意思」「联调报 500 了」）散在聊天软件里，
 * 过几天就找不到、也和接口对不上。评论挂在接口上，@ 到的人在右上角铃铛里收到提醒。
 *
 * **只在云端**：评论是给人看的协作内容，不同步到本机 —— 网关把
 * `/apis/<id>/comments`、`/comments/<id>`、`/notifications*`、
 * `/projects/<pid>/comment-counts` 转给云端（`lib/gateway/account.js` 的 `cloudOnlyPath`）。
 *
 * 几个约定：
 * - 接口在云端库里不存在（刚建、还没同步上去）→ 404 + `code: 'API_NOT_SYNCED'`，
 *   前端据此显示「同步后才能评论」，而不是「接口不存在」；
 * - @ 的人**只保留这个项目的成员**（管理员也算），自己 @ 自己不发提醒；
 * - 删除是**标记**（`deleted_at`），楼层留着，界面上显示「这条评论已删除」；
 * - 正文原样存，**前端显示时当纯文本**（不许 v-html，网址自己拆成链接）。
 */

var express = require('express');

var respond = require('./respond');
var guardModule = require('./guard');
var access = require('../access');
var commentsRepo = require('../db/repos/comments');
var notificationsRepo = require('../db/repos/notifications');
var apisRepo = require('../db/repos/apis');
var projectsRepo = require('../db/repos/projects');
var membersRepo = require('../db/repos/members');
var usersRepo = require('../db/repos/users');

/** 评论正文长度（计划里定的 1–2000 字） */
var BODY_MAX = 2000;

/** 提醒里的摘要取多少个字 */
var SUMMARY_LENGTH = 40;

function createRouter(ctx) {
    var handle = ctx.handle;
    var router = express.Router();

    var g = guardModule.createGuard(ctx);
    var guard = g.guard;
    var byPid = g.byPid;

    /* ---------------------------------------------------------- 小工具 */

    /** 显示名：没有 displayName 就用用户名；用户被删了给「已注销」 */
    function nameOf(userId) {
        var user = userId ? usersRepo.getById(handle, userId) : null;
        if (!user) return '已注销';
        return user.displayName || user.username || '已注销';
    }

    function commentPayload(comment) {
        return {
            id: comment.id,
            apiId: comment.apiId,
            user: { id: comment.userId, displayName: nameOf(comment.userId) },
            // 已删除的楼层不给正文 —— 界面上只显示「这条评论已删除」
            body: comment.deletedAt ? '' : comment.body,
            mentions: comment.mentions,
            createdAt: comment.createdAt,
            updatedAt: comment.updatedAt,
            deleted: Boolean(comment.deletedAt)
        };
    }

    function notificationPayload(item) {
        return {
            id: item.id,
            projectId: item.projectId,
            projectName: item.projectName || '',
            apiId: item.apiId,
            apiName: item.apiName || '',
            commentId: item.commentId,
            actorName: item.actorName || item.actorUsername || '有人',
            summary: summarize(item.commentBody),
            createdAt: item.createdAt,
            read: Boolean(item.readAt)
        };
    }

    /** 摘要：去掉换行、压掉多余空白，取前 40 个字（超了加省略号） */
    function summarize(text) {
        var flat = String(text === undefined || text === null ? '' : text)
            .replace(/\s+/g, ' ').trim();
        if (flat.length <= SUMMARY_LENGTH) return flat;
        return flat.slice(0, SUMMARY_LENGTH) + '…';
    }

    /**
     * 接口必须已经在**云端**库里、而且属于当前用户能看的项目。
     *
     * 不用现成的 `byParam('api')`：它给的 404 没有 `code`，前端分不出「接口不存在」
     * 和「这个接口还没同步到云端」。这里两种情况都给 `API_NOT_SYNCED` ——
     * 对用户来说要做的事是一样的（先同步），分成两种只会让人困惑。
     */
    function guardApi(level) {
        return function (req, res, next) {
            var api = apisRepo.get(handle, String(req.params.id));
            var project = api ? projectsRepo.getById(handle, api.projectId) : null;
            var role = project ? access.roleOf(handle, req.user, project.id) : null;

            if (!api || !project || !role) {
                return respond.fail(res, 404, '这个接口还没同步到云端，同步后才能评论', 'API_NOT_SYNCED');
            }
            if (!access.atLeast(role, level)) {
                return respond.fail(res, 403, '需要 ' + level + ' 权限');
            }

            req.api = api;
            req.project = project;
            req.role = role;
            next();
        };
    }

    /** 评论必须存在、而且当前用户看得到它所在的项目（看不到就和「不存在」一样） */
    function mustComment(req, id) {
        var comment = commentsRepo.get(handle, id);
        if (!comment) throw respond.apiError(404, '评论不存在');

        var role = access.roleOf(handle, req.user, comment.projectId);
        if (!role) throw respond.apiError(404, '评论不存在');
        return comment;
    }

    /** 成员表里有他，或者他是管理员（管理员不在成员表里，但对任何项目都算 owner） */
    function isProjectMember(projectId, userId) {
        var user = usersRepo.getById(handle, userId);
        if (!user) return false;
        if (user.role === 'admin') return true;
        return Boolean(membersRepo.get(handle, projectId, userId));
    }

    /**
     * @ 的人只保留这个项目的成员，**自己 @ 自己不发提醒**（也不记进 mentions）。
     * 传进来的顺序保留，重复的去掉。
     */
    function resolveMentions(projectId, mentions, selfId) {
        var out = [];
        (mentions || []).forEach(function (userId) {
            var id = String(userId === undefined || userId === null ? '' : userId);
            if (!id || out.indexOf(id) > -1) return;
            if (id === String(selfId === undefined || selfId === null ? '' : selfId)) return;
            if (!isProjectMember(projectId, id)) return;
            out.push(id);
        });
        return out;
    }

    /** 给这几个被 @ 的人各发一条提醒 */
    function notify(project, api, comment, mentionIds, actorId) {
        mentionIds.forEach(function (userId) {
            notificationsRepo.insert(handle, {
                userId: userId,
                projectId: project.id,
                apiId: api.id,
                commentId: comment.id,
                actorId: actorId
            });
        });
    }

    /* ---------------------------------------------------------- 评论 */

    router.get('/apis/:id/comments', guardApi('viewer'), respond.wrap(function (req, res) {
        respond.ok(res, {
            comments: commentsRepo.list(handle, req.api.id).map(commentPayload)
        });
    }));

    /**
     * 发一条评论。**viewer 也能发** —— 只读成员正是最需要提问的人。
     */
    router.post('/apis/:id/comments', guardApi('viewer'), respond.wrap(function (req, res) {
        var body = req.body || {};
        var text = String(body.body === undefined || body.body === null ? '' : body.body).trim();

        if (!text) throw respond.apiError(400, '评论内容不能为空');
        if (text.length > BODY_MAX) throw respond.apiError(400, '评论最长 ' + BODY_MAX + ' 个字');

        var mentions = resolveMentions(req.project.id, body.mentions, req.user.id);

        var comment = handle.transaction(function () {
            var created = commentsRepo.insert(handle, {
                projectId: req.project.id,
                apiId: req.api.id,
                userId: req.user.id,
                body: text,
                mentions: mentions
            });
            notify(req.project, req.api, created, mentions, req.user.id);
            return created;
        });

        respond.ok(res, { comment: commentPayload(comment) });
    }));

    /**
     * 改内容。**只有作者本人** —— 管理员也不行：把别人的话改掉比删掉更糟
     * （删了至少还看得见「已删除」）。
     */
    router.put('/comments/:id', respond.wrap(function (req, res) {
        var comment = mustComment(req, req.params.id);

        if (!req.user || comment.userId !== req.user.id) {
            throw respond.apiError(403, '只能修改自己的评论');
        }
        if (comment.deletedAt) throw respond.apiError(400, '这条评论已经删除了');

        var body = req.body || {};
        var text = String(body.body === undefined || body.body === null ? '' : body.body).trim();
        if (!text) throw respond.apiError(400, '评论内容不能为空');
        if (text.length > BODY_MAX) throw respond.apiError(400, '评论最长 ' + BODY_MAX + ' 个字');

        var mentions = resolveMentions(comment.projectId, body.mentions, req.user.id);
        // **新 @ 的人才发提醒**，原来 @ 过、这次还在名单里的不重复发
        var added = mentions.filter(function (id) { return comment.mentions.indexOf(id) === -1; });

        var updated = handle.transaction(function () {
            var saved = commentsRepo.update(handle, comment.id, { body: text, mentions: mentions });

            var project = projectsRepo.getById(handle, comment.projectId);
            var api = apisRepo.get(handle, comment.apiId);
            if (project && api) notify(project, api, saved, added, req.user.id);

            return saved;
        });

        respond.ok(res, { comment: commentPayload(updated) });
    }));

    /** 删除：**标记删除**，楼层留着；对应的未读提醒一起标已读 */
    router.delete('/comments/:id', respond.wrap(function (req, res) {
        var comment = mustComment(req, req.params.id);

        var isAuthor = req.user && comment.userId === req.user.id;
        var isAdmin = req.user && req.user.role === 'admin';
        if (!isAuthor && !isAdmin) throw respond.apiError(403, '只能删除自己的评论');

        var deleted = handle.transaction(function () {
            var saved = commentsRepo.markDeleted(handle, comment.id);
            // 评论都没了，再留着「XX 提到了你」点进去是一片空白
            notificationsRepo.markReadByComment(handle, comment.id);
            return saved;
        });

        respond.ok(res, { comment: commentPayload(deleted) });
    }));

    /** 每个接口有几条评论（目录树要显示评论数时用得上） */
    router.get('/projects/:pid/comment-counts', guard('viewer', byPid), respond.wrap(function (req, res) {
        respond.ok(res, { counts: commentsRepo.countsByProject(handle, req.project.id) });
    }));

    /* ---------------------------------------------------------- 提醒 */

    /** 现在还能看到的项目：被移出项目后，那个项目里的提醒（带评论摘要）不再给 */
    function visibleIds(req) {
        return access.visibleProjects(handle, req.user).map(function (project) { return project.id; });
    }

    router.get('/notifications', respond.wrap(function (req, res) {
        var limit = Number((req.query || {}).limit);
        respond.ok(res, {
            items: notificationsRepo.list(handle, req.user.id, limit, visibleIds(req)).map(notificationPayload)
        });
    }));

    router.get('/notifications/unread-count', respond.wrap(function (req, res) {
        respond.ok(res, { count: notificationsRepo.unreadCount(handle, req.user.id, visibleIds(req)) });
    }));

    /** `{ ids: [...] }` 标这几条；`{ all: true }` 全部标为已读 */
    router.post('/notifications/read', respond.wrap(function (req, res) {
        var body = req.body || {};
        var changed = body.all === true
            ? notificationsRepo.markAllRead(handle, req.user.id)
            : notificationsRepo.markRead(handle, req.user.id, Array.isArray(body.ids) ? body.ids : []);

        respond.ok(res, {
            changed: changed,
            count: notificationsRepo.unreadCount(handle, req.user.id, visibleIds(req))
        });
    }));

    return router;
}

module.exports = {
    createRouter: createRouter,
    BODY_MAX: BODY_MAX,
    SUMMARY_LENGTH: SUMMARY_LENGTH
};
