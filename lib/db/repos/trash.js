/**
 * trash 表读写（回收站，第三轮第 1 节）。
 *
 * 这张表存的是「删掉的东西」：删目录 / 接口 / 环境时，把真正会被删掉的那些原始行
 * 整包存进 `payload`（格式见 lib/sync/rows.js），再照常真删。恢复时按 payload 重新插回去。
 *
 * `trash` 是第 7 种会同步的实体（迁移 v9 给了它 `rev` 和三条触发器）：同事删的东西
 * 你也能在回收站里看到、恢复。所以这里的写入会照常往 `changes` 里记流水。
 *
 * `payload` 存的是 JSON 字符串（和同步的原始行口径一致），读写时用 json 小工具容错。
 */

var helpers = require('./helpers');
var json = require('../json');

var SELECT = 'SELECT * FROM trash';

function toTrash(row) {
    if (!row) return null;
    return {
        id: row.id,
        projectId: row.project_id,
        kind: row.kind,
        name: row.name,
        location: row.location,
        payload: json.readJson(row.payload, {}),
        deletedBy: row.deleted_by,
        deletedAt: row.deleted_at,
        rev: row.rev
    };
}

/** 某个项目的回收站，按删除时间倒序（最近删的在最上面） */
function list(handle, projectId) {
    return handle.db.prepare(SELECT + ' WHERE project_id = ? ORDER BY deleted_at DESC, rowid DESC')
        .all(projectId).map(function (row) { return toTrash(row); });
}

function get(handle, id) {
    return toTrash(handle.db.prepare(SELECT + ' WHERE id = ?').get(id));
}

/**
 * 记一条回收站。`input.payload` 直接是对象，这里序列化成字符串。
 *
 * @param {{id?: string, kind: string, name?: string, location?: string, payload?: object,
 *          deletedBy?: string|null, deletedAt?: number}} input
 */
function insert(handle, projectId, input) {
    var item = input || {};
    var id = item.id || helpers.newId('t');
    var deletedAt = Number(item.deletedAt);
    if (!Number.isFinite(deletedAt) || deletedAt <= 0) deletedAt = Date.now();

    handle.db.prepare(
        'INSERT INTO trash (id, project_id, kind, name, location, payload, deleted_by, deleted_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
        id,
        projectId,
        String(item.kind || ''),
        String(item.name || ''),
        String(item.location || ''),
        json.writeJson(item.payload || {}),
        item.deletedBy || null,
        deletedAt
    );
    return get(handle, id);
}

function remove(handle, id) {
    handle.db.prepare('DELETE FROM trash WHERE id = ?').run(id);
}

/** 清空某个项目的回收站，返回删了几条 */
function clear(handle, projectId) {
    var result = handle.db.prepare('DELETE FROM trash WHERE project_id = ?').run(projectId);
    return Number(result && result.changes) || 0;
}

module.exports = {
    list: list,
    get: get,
    insert: insert,
    remove: remove,
    clear: clear,
    toTrash: toTrash
};
