/**
 * shares 表读写（接口文档分享，第三轮第 4 节）。
 *
 * 一条行 = 一个分享链接。`id` 本身就是链接里的那串随机码（24 位 base64url），
 * 所以**不要**用别处的 `helpers.newId` 前缀规则 —— 它要的是「猜不出来」，
 * 不是「肉眼可读」。
 *
 * 这张表**只在云端用**，不进同步实体（迁移 v11 没给它触发器）：分享链接是「云端
 * 对外发布出去的一个地址」，客户端本机那份数据同步上去之前分享不了，这是设计上认了的。
 */

var crypto = require('crypto');

var SELECT = 'SELECT * FROM shares';

function toShare(row) {
    if (!row) return null;
    return {
        id: row.id,
        projectId: row.project_id,
        folderId: row.folder_id,
        title: row.title,
        createdBy: row.created_by,
        createdAt: row.created_at,
        expiresAt: row.expires_at
    };
}

/**
 * 链接串：18 个随机字节的 base64url（正好 24 个字符，不带 `+/=`，放地址里不用转义）。
 * 它是**唯一的访问凭据**，所以用 crypto 的随机源，不要 Math.random。
 */
function newToken() {
    return crypto.randomBytes(18).toString('base64url');
}

/** 某个项目的分享链接，新建的排在前面 */
function list(handle, projectId) {
    return handle.db.prepare(SELECT + ' WHERE project_id = ? ORDER BY created_at DESC, rowid DESC')
        .all(projectId).map(function (row) { return toShare(row); });
}

function get(handle, id) {
    return toShare(handle.db.prepare(SELECT + ' WHERE id = ?').get(String(id || '')));
}

/**
 * @param {{id?: string, folderId?: string|null, title?: string, createdBy?: string|null,
 *          createdAt?: number, expiresAt?: number|null}} input
 */
function insert(handle, projectId, input) {
    var item = input || {};
    var id = item.id || newToken();
    var createdAt = Number(item.createdAt);
    if (!Number.isFinite(createdAt) || createdAt <= 0) createdAt = Date.now();

    var expiresAt = item.expiresAt === undefined || item.expiresAt === null
        ? null
        : Number(item.expiresAt);

    handle.db.prepare(
        'INSERT INTO shares (id, project_id, folder_id, title, created_by, created_at, expires_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(
        id,
        projectId,
        item.folderId || null,
        String(item.title || ''),
        item.createdBy || null,
        createdAt,
        Number.isFinite(expiresAt) ? expiresAt : null
    );

    return get(handle, id);
}

/** 撤销 = 删行（契约里就是这么定的） */
function remove(handle, id) {
    handle.db.prepare('DELETE FROM shares WHERE id = ?').run(String(id || ''));
}

module.exports = {
    newToken: newToken,
    list: list,
    get: get,
    insert: insert,
    remove: remove,
    toShare: toShare
};
