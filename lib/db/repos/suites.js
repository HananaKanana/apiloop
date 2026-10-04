/**
 * suites 表读写（第八轮第 1 节）。
 *
 * 测试集是**会同步的实体**（`suite`）：团队共享，第九轮的命令行也要从云端拉它。
 * `rev` 和变更流水由迁移 v15 建的触发器负责，这里只管增删改查。
 *
 * `data` 是**原文**（`{ format, fileName, text }` 或 null），解析在 `lib/suite-data.js` ——
 * 存原文才能让用户改完数据接着用，解析结果落库没有意义（格式一变就得重来）。
 */

var helpers = require('./helpers');
var json = require('../json');

var SELECT = 'SELECT * FROM suites';

var COLUMNS = {
    name: 'name',
    description: 'description',
    position: 'position',
    steps: 'steps',
    data: 'data',
    settings: 'settings',
    updatedAt: 'updated_at'
};

function toSuite(row) {
    if (!row) return null;

    return {
        id: row.id,
        projectId: row.project_id,
        name: row.name,
        description: row.description,
        position: row.position,
        steps: json.readJson(row.steps, []),
        // null 表示「不用数据」，和空对象不是一回事
        data: row.data === null || row.data === undefined ? null : json.readJson(row.data, null),
        settings: json.readJson(row.settings, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}

function list(handle, projectId) {
    return handle.db.prepare(SELECT + ' WHERE project_id = ? ORDER BY position, rowid').all(projectId)
        .map(function (row) { return toSuite(row); });
}

function get(handle, id) {
    return toSuite(handle.db.prepare(SELECT + ' WHERE id = ?').get(id));
}

function nextPosition(handle, projectId) {
    var row = handle.db.prepare('SELECT MAX(position) AS m FROM suites WHERE project_id = ?').get(projectId);
    return row && row.m !== null && row.m !== undefined ? row.m + 1 : 0;
}

/** 项目里已经用过的名字（复制时加「（副本）」要用） */
function namesOf(handle, projectId) {
    return handle.db.prepare('SELECT name FROM suites WHERE project_id = ?').all(projectId)
        .map(function (row) { return row.name; });
}

function create(handle, projectId, input) {
    var suite = input || {};
    var id = suite.id || helpers.newId('s');
    var now = Date.now();

    handle.db.prepare(
        'INSERT INTO suites (id, project_id, name, description, position, steps, data, settings, created_at, updated_at, rev) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)'
    ).run(
        id,
        projectId,
        String(suite.name || ''),
        String(suite.description || ''),
        suite.position === undefined || suite.position === null ? nextPosition(handle, projectId) : Number(suite.position),
        json.writeJson(suite.steps || []),
        suite.data === undefined || suite.data === null ? null : json.writeJson(suite.data),
        json.writeJson(suite.settings || {}),
        now,
        now
    );

    return get(handle, id);
}

function update(handle, id, patch) {
    var touched = helpers.applyUpdate(handle, 'suites', COLUMNS, id, patch, function (key, value) {
        if (key === 'steps') return json.writeJson(value || []);
        if (key === 'data') return value === null || value === undefined ? null : json.writeJson(value);
        if (key === 'settings') return json.writeJson(value || {});
        if (key === 'position') return Number(value) || 0;
        return value === undefined || value === null ? '' : String(value);
    });

    // updated_at 不是触发器管的（触发器只管 rev 和流水），和 apis 一样在这里补
    if (touched) handle.db.prepare('UPDATE suites SET updated_at = ? WHERE id = ?').run(Date.now(), id);
    return get(handle, id);
}

function remove(handle, id) {
    handle.db.prepare('DELETE FROM suites WHERE id = ?').run(id);
}

/** 按给定顺序重排（只认这个项目里的 id，别的忽略） */
function reorder(handle, projectId, ids) {
    var statement = handle.db.prepare('UPDATE suites SET position = ? WHERE id = ? AND project_id = ?');
    var now = Date.now();

    (ids || []).forEach(function (id, index) {
        statement.run(index, String(id), projectId);
    });
    handle.db.prepare('UPDATE suites SET updated_at = ? WHERE project_id = ?').run(now, projectId);
}

module.exports = {
    list: list,
    get: get,
    create: create,
    update: update,
    remove: remove,
    reorder: reorder,
    nextPosition: nextPosition,
    namesOf: namesOf
};
