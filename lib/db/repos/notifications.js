/**
 * notifications 表读写（第五轮第 4 节 @ 提醒）。
 *
 * 一条评论里 @ 了几个人就是几行（**自己 @ 自己不发**）。`read_at` 为空表示未读。
 *
 * 和评论一样**只在云端**（网关把 `/notifications` 转给云端）。
 *
 * 列表要显示「谁在哪个项目的哪个接口里提到了你」，所以查询直接 join 出那几样名字 ——
 * 50 条里逐条再查三次太浪费，而且这几个名字都是「显示用」的，join 出来更直接。
 */

var helpers = require('./helpers');

/** 列表最多给多少条（接口也允许传更小的 limit） */
var MAX_LIMIT = 50;
var DEFAULT_LIMIT = 50;

function toNotification(row) {
    if (!row) return null;
    return {
        id: row.id,
        userId: row.user_id,
        projectId: row.project_id,
        apiId: row.api_id,
        commentId: row.comment_id,
        actorId: row.actor_id,
        createdAt: row.created_at,
        readAt: row.read_at,
        // join 出来的几个显示名（下面 list 才带，get 不带）
        actorName: row.actor_name === undefined ? undefined : row.actor_name,
        actorUsername: row.actor_username === undefined ? undefined : row.actor_username,
        projectName: row.project_name === undefined ? undefined : row.project_name,
        apiName: row.api_name === undefined ? undefined : row.api_name,
        commentBody: row.comment_body === undefined ? undefined : row.comment_body
    };
}

/**
 * 当前用户的提醒，倒序。
 *
 * @param {number} [limit] 1–50，默认 50
 */
/**
 * `projectIds`（可选）：只要这些项目里的。传了空数组就是一条都没有。
 * 被移出项目的人不该再从提醒里看到那个项目的评论摘要，调用方传「现在能看到的项目」。
 */
function projectFilter(alias, projectIds) {
    if (!Array.isArray(projectIds)) return { sql: '', args: [] };
    if (!projectIds.length) return { sql: ' AND 0', args: [] };
    return {
        sql: ' AND ' + alias + 'project_id IN (' + projectIds.map(function () { return '?'; }).join(', ') + ')',
        args: projectIds.map(String)
    };
}

function list(handle, userId, limit, projectIds) {
    var size = Number(limit);
    if (!Number.isFinite(size) || size <= 0) size = DEFAULT_LIMIT;
    size = Math.min(MAX_LIMIT, Math.floor(size));
    var filter = projectFilter('n.', projectIds);

    var statement = handle.db.prepare(
        'SELECT n.*, u.display_name AS actor_name, u.username AS actor_username, ' +
        '       p.name AS project_name, a.name AS api_name, ' +
        // 评论被删了就不给正文（摘要里带出被删的内容不合适）
        "       CASE WHEN c.deleted_at IS NULL THEN c.body ELSE '' END AS comment_body " +
        'FROM notifications n ' +
        'LEFT JOIN users u ON u.id = n.actor_id ' +
        'LEFT JOIN projects p ON p.id = n.project_id ' +
        'LEFT JOIN apis a ON a.id = n.api_id ' +
        'LEFT JOIN comments c ON c.id = n.comment_id ' +
        'WHERE n.user_id = ?' + filter.sql + ' ' +
        'ORDER BY n.created_at DESC, n.rowid DESC LIMIT ?'
    );
    return statement.all.apply(statement, [String(userId)].concat(filter.args, [size])).map(toNotification);
}

function get(handle, id) {
    return toNotification(handle.db.prepare('SELECT * FROM notifications WHERE id = ?').get(String(id || '')));
}

function insert(handle, input) {
    var item = input || {};
    var id = item.id || helpers.newId('nt');

    handle.db.prepare(
        'INSERT INTO notifications (id, user_id, project_id, api_id, comment_id, actor_id, created_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(
        id,
        String(item.userId),
        String(item.projectId),
        String(item.apiId),
        String(item.commentId),
        item.actorId || null,
        item.createdAt || Date.now()
    );

    return get(handle, id);
}

function unreadCount(handle, userId, projectIds) {
    var filter = projectFilter('', projectIds);
    var statement = handle.db.prepare(
        'SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL' + filter.sql
    );
    var row = statement.get.apply(statement, [String(userId)].concat(filter.args));
    return Number(row && row.n) || 0;
}

/** 把这几条标成已读（已经读过的行不动，`read_at` 记的是第一次读的时间） */
function markRead(handle, userId, ids) {
    var list = (ids || []).map(function (id) { return String(id); });
    if (!list.length) return 0;

    var placeholders = list.map(function () { return '?'; }).join(', ');
    var statement = handle.db.prepare(
        'UPDATE notifications SET read_at = ? ' +
        'WHERE user_id = ? AND read_at IS NULL AND id IN (' + placeholders + ')'
    );
    var result = statement.run.apply(statement, [Date.now(), String(userId)].concat(list));
    return Number(result && result.changes) || 0;
}

/** 全部标为已读 */
function markAllRead(handle, userId) {
    var result = handle.db.prepare(
        'UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL'
    ).run(Date.now(), String(userId));
    return Number(result && result.changes) || 0;
}

/**
 * 某条评论带来的提醒全部标已读（评论被删时用）。
 *
 * 不管是谁的提醒都标 —— 评论都删了，再留着「XX 提到了你」点进去是一片空白。
 */
function markReadByComment(handle, commentId) {
    var result = handle.db.prepare(
        'UPDATE notifications SET read_at = ? WHERE comment_id = ? AND read_at IS NULL'
    ).run(Date.now(), String(commentId));
    return Number(result && result.changes) || 0;
}

module.exports = {
    MAX_LIMIT: MAX_LIMIT,
    list: list,
    get: get,
    insert: insert,
    unreadCount: unreadCount,
    markRead: markRead,
    markAllRead: markAllRead,
    markReadByComment: markReadByComment,
    toNotification: toNotification
};
