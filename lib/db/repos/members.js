/**
 * project_members 表读写：谁属于哪个项目、是什么角色。
 *
 * 三档角色 viewer < editor < owner，表上有 CHECK 约束兜着。系统角色 admin 不在
 * 这张表里 —— 它不属于任何项目，却对所有项目有 owner 的能力，判定在 lib/access.js。
 *
 * 用户被删除时成员关系由外键级联清掉；项目被删除时同理。
 */

var SELECT = 'SELECT m.project_id, m.user_id, m.role, u.username, u.display_name, u.disabled ' +
    'FROM project_members m JOIN users u ON u.id = m.user_id';

var ROLES = ['viewer', 'editor', 'owner'];

/**
 * 列表要带上用户名和显示名，前端直接就能画成员表；`disabled` 一并给出，
 * 被禁用的成员在界面上要能看出来（否则「他明明在成员里却登不进来」很难查）。
 */
function rowToMember(row) {
    if (!row) return null;
    return {
        projectId: row.project_id,
        userId: row.user_id,
        username: row.username,
        displayName: row.display_name,
        role: row.role,
        disabled: !!row.disabled
    };
}

/** 成员列表。顺序跟 /users 一致（创建时间、用户名），界面上不会跳来跳去 */
function list(handle, projectId) {
    return handle.db.prepare(SELECT + ' WHERE m.project_id = ? ORDER BY u.created_at, u.username')
        .all(projectId)
        .map(function (row) { return rowToMember(row); });
}

function get(handle, projectId, userId) {
    return rowToMember(
        handle.db.prepare(SELECT + ' WHERE m.project_id = ? AND m.user_id = ?').get(projectId, userId)
    );
}

/**
 * 不是成员就加进来，是成员就改角色。
 * 用 UPSERT 而不是「先查再插/改」：两个管理员同时加同一个人时，前者会撞主键。
 */
function upsert(handle, projectId, userId, role) {
    if (ROLES.indexOf(role) === -1) throw new Error('未知的项目角色：' + role);

    handle.db.prepare(
        'INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?) ' +
        'ON CONFLICT (project_id, user_id) DO UPDATE SET role = excluded.role'
    ).run(projectId, userId, role);

    return get(handle, projectId, userId);
}

function remove(handle, projectId, userId) {
    handle.db.prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?')
        .run(projectId, userId);
}

/**
 * 数一数这个项目还有几个 owner。
 * @param {{excludeUserId?: string}} [options] 把某个人排除在外（比如正要把他降级/移除）
 */
function countOwners(handle, projectId, options) {
    var excludeUserId = options && options.excludeUserId;
    var row = excludeUserId
        ? handle.db.prepare("SELECT count(*) AS c FROM project_members WHERE project_id = ? AND role = 'owner' AND user_id <> ?")
            .get(projectId, excludeUserId)
        : handle.db.prepare("SELECT count(*) AS c FROM project_members WHERE project_id = ? AND role = 'owner'")
            .get(projectId);
    return row ? row.c : 0;
}

/** 「我参与的项目」，列表过滤用 */
function projectIdsOf(handle, userId) {
    return handle.db.prepare('SELECT project_id FROM project_members WHERE user_id = ? ORDER BY project_id')
        .all(userId)
        .map(function (row) { return row.project_id; });
}

module.exports = {
    list: list,
    get: get,
    upsert: upsert,
    remove: remove,
    countOwners: countOwners,
    projectIdsOf: projectIdsOf,
    ROLES: ROLES
};
