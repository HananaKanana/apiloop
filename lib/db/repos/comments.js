/**
 * comments 表读写（第五轮第 4 节 接口评论）。
 *
 * 评论**只在云端保存**（网关把 `/apis/<id>/comments` 这些路径转给云端，见
 * `lib/gateway/account.js` 的 `cloudOnlyPath`）：评论是给人看的协作内容，
 * 和接口数据不一样，不同步到本机。
 *
 * 删除是**标记**（`deleted_at` 非空），不是删行 —— 楼层要留着，界面上显示
 * 「这条评论已删除」，不然对话的上下文就断了。
 */

var helpers = require('./helpers');
var json = require('../json');

var SELECT = 'SELECT * FROM comments';

function toComment(row) {
    if (!row) return null;
    return {
        id: row.id,
        projectId: row.project_id,
        apiId: row.api_id,
        userId: row.user_id,
        body: row.body,
        mentions: json.readJson(row.mentions, []),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        deletedAt: row.deleted_at
    };
}

/** 某个接口的全部评论（含已删除的楼层），按时间正序 */
function list(handle, apiId) {
    return handle.db.prepare(SELECT + ' WHERE api_id = ? ORDER BY created_at, rowid')
        .all(String(apiId)).map(toComment);
}

function get(handle, id) {
    return toComment(handle.db.prepare(SELECT + ' WHERE id = ?').get(String(id || '')));
}

/**
 * @param {{id?: string, projectId: string, apiId: string, userId?: string|null,
 *          body?: string, mentions?: Array<string>}} input
 */
function insert(handle, input) {
    var item = input || {};
    var id = item.id || helpers.newId('cm');
    var now = Date.now();

    handle.db.prepare(
        'INSERT INTO comments (id, project_id, api_id, user_id, body, mentions, created_at, updated_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
        id,
        item.projectId,
        String(item.apiId),
        item.userId || null,
        String(item.body || ''),
        json.writeJson(item.mentions || []),
        now,
        now
    );

    return get(handle, id);
}

/** 改内容（`mentions` 跟着一起换） */
function update(handle, id, patch) {
    var sets = [];
    var values = [];

    if (patch.body !== undefined) {
        sets.push('body = ?');
        values.push(String(patch.body));
    }
    if (patch.mentions !== undefined) {
        sets.push('mentions = ?');
        values.push(json.writeJson(patch.mentions || []));
    }
    if (!sets.length) return get(handle, id);

    sets.push('updated_at = ?');
    values.push(Date.now());
    values.push(String(id));

    var statement = handle.db.prepare('UPDATE comments SET ' + sets.join(', ') + ' WHERE id = ?');
    statement.run.apply(statement, values);
    return get(handle, id);
}

/** 标记删除（保留楼层） */
function markDeleted(handle, id, at) {
    var now = at || Date.now();
    handle.db.prepare('UPDATE comments SET deleted_at = ?, updated_at = ? WHERE id = ?')
        .run(now, now, String(id));
    return get(handle, id);
}

/** 每个接口有几条（**不含已删除的**），`{ apiId: n }` */
function countsByProject(handle, projectId) {
    var rows = handle.db.prepare(
        'SELECT api_id, COUNT(*) AS n FROM comments ' +
        'WHERE project_id = ? AND deleted_at IS NULL GROUP BY api_id'
    ).all(projectId);

    var counts = {};
    rows.forEach(function (row) { counts[row.api_id] = Number(row.n) || 0; });
    return counts;
}

module.exports = {
    list: list,
    get: get,
    insert: insert,
    update: update,
    markDeleted: markDeleted,
    countsByProject: countsByProject,
    toComment: toComment
};
