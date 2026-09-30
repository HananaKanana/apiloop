/**
 * folders 表读写。P1 只用到顶层目录（老的分组对应顶层 folder），
 * parent_id 留给 P2 的目录树。
 */

var helpers = require('./helpers');
var json = require('../json');

var SELECT = 'SELECT * FROM folders';

var COLUMNS = {
    name: 'name',
    description: 'description',
    parentId: 'parent_id',
    position: 'position',
    auth: 'auth',
    variables: 'variables',
    scripts: 'scripts',
    extra: 'extra'
};

function toFolder(row) {
    if (!row) return null;
    return {
        id: row.id,
        projectId: row.project_id,
        parentId: row.parent_id,
        name: row.name,
        description: row.description,
        position: row.position,
        auth: row.auth === null || row.auth === undefined ? null : json.readJson(row.auth, null),
        variables: json.readJson(row.variables, []),
        scripts: json.readJson(row.scripts, []),
        extra: json.readJson(row.extra, {})
    };
}

function list(handle, projectId) {
    return handle.db.prepare(SELECT + ' WHERE project_id = ? ORDER BY position, rowid').all(projectId)
        .map(function (row) { return toFolder(row); });
}

function get(handle, id) {
    return toFolder(handle.db.prepare(SELECT + ' WHERE id = ?').get(id));
}

function create(handle, projectId, input) {
    var id = input.id || helpers.newId('f');
    var position = input.position === undefined || input.position === null
        ? nextPosition(handle, projectId)
        : Number(input.position);

    handle.db.prepare(
        'INSERT INTO folders (id, project_id, parent_id, name, description, position, auth, variables, scripts, extra) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
        id,
        projectId,
        input.parent_id || input.parentId || null,
        String(input.name || ''),
        String(input.description || ''),
        position,
        input.auth ? json.writeJson(input.auth) : null,
        json.writeJson(input.variables || []),
        json.writeJson(input.scripts || []),
        json.writeJson(input.extra || {})
    );
    return get(handle, id);
}

function nextPosition(handle, projectId) {
    var row = handle.db.prepare('SELECT MAX(position) AS m FROM folders WHERE project_id = ?').get(projectId);
    return row && row.m !== null && row.m !== undefined ? row.m + 1 : 0;
}

function update(handle, id, patch) {
    helpers.applyUpdate(handle, 'folders', COLUMNS, id, patch, function (key, value) {
        if (key === 'variables' || key === 'scripts' || key === 'extra') return json.writeJson(value);
        if (key === 'auth') return value === undefined || value === null ? null : json.writeJson(value);
        if (key === 'parentId') return value === undefined || value === null ? null : String(value);
        if (key === 'position') return Number(value) || 0;
        return value === undefined || value === null ? '' : String(value);
    });
    return get(handle, id);
}

function rename(handle, id, name) {
    return update(handle, id, { name: name });
}

/**
 * 按给定的 id 顺序重排 position。没出现在 orderedIds 里的保持原相对顺序排在后面，
 * 这样调用方只传一部分也能用。
 *
 * 注意这是**项目内全局**的重排，对应 P1 时期「老分组都在顶层」的用法。
 * 目录树（可能嵌套）要的是「同一个父目录内」的重排，用 listChildren + setPositionsIn。
 */
function setPositions(handle, projectId, orderedIds) {
    var current = list(handle, projectId);
    var wanted = orderedIds || [];
    var seen = {};
    var ordered = [];

    wanted.forEach(function (id) {
        if (seen[id]) return;
        seen[id] = true;
        ordered.push(id);
    });
    current.forEach(function (folder) {
        if (!seen[folder.id]) ordered.push(folder.id);
    });

    var statement = handle.db.prepare('UPDATE folders SET position = ? WHERE id = ?');
    ordered.forEach(function (id, index) { statement.run(index, id); });
    return list(handle, projectId);
}

/* ---------------------------------------------------------- 同级（同一父目录） */

/**
 * 某个父目录的直接子目录，按 position 排好。parentId 为 null 表示顶层。
 *
 * position 只在同一父目录内部有意义，所以凡是跟顺序有关的操作都得走这里，
 * 不能拿 list() 的全项目结果当成「同级」用。
 */
function listChildren(handle, projectId, parentId) {
    var rows = parentId
        ? handle.db.prepare(SELECT + ' WHERE project_id = ? AND parent_id = ? ORDER BY position, rowid')
            .all(projectId, parentId)
        : handle.db.prepare(SELECT + ' WHERE project_id = ? AND parent_id IS NULL ORDER BY position, rowid')
            .all(projectId);
    return rows.map(function (row) { return toFolder(row); });
}

/** 同级的下一个 position */
function nextPositionIn(handle, projectId, parentId) {
    var row = parentId
        ? handle.db.prepare('SELECT MAX(position) AS m FROM folders WHERE project_id = ? AND parent_id = ?')
            .get(projectId, parentId)
        : handle.db.prepare('SELECT MAX(position) AS m FROM folders WHERE project_id = ? AND parent_id IS NULL')
            .get(projectId);
    return row && row.m !== null && row.m !== undefined ? row.m + 1 : 0;
}

/** 把给定的同级 id 按顺序写成 0..n-1 */
function setPositionsIn(handle, orderedIds) {
    var statement = handle.db.prepare('UPDATE folders SET position = ? WHERE id = ?');
    (orderedIds || []).forEach(function (id, index) { statement.run(index, id); });
}

function remove(handle, id) {
    handle.db.prepare('DELETE FROM folders WHERE id = ?').run(id);
}

module.exports = {
    list: list,
    get: get,
    create: create,
    update: update,
    rename: rename,
    setPositions: setPositions,
    remove: remove,
    nextPosition: nextPosition,
    listChildren: listChildren,
    nextPositionIn: nextPositionIn,
    setPositionsIn: setPositionsIn
};
