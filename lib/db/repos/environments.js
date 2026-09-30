/**
 * environments 表读写。
 *
 * 「当前选中哪个环境」是每个用户、每个项目各自的界面状态，由前端保存在
 * localStorage 里，服务端不存 —— 所以这里只关心环境本身的增删改查。
 */

var helpers = require('./helpers');
var json = require('../json');

var SELECT = 'SELECT * FROM environments';

var COLUMNS = {
    name: 'name',
    variables: 'variables',
    position: 'position'
};

function toEnvironment(row) {
    if (!row) return null;
    return {
        id: row.id,
        projectId: row.project_id,
        name: row.name,
        position: row.position,
        variables: json.readJson(row.variables, [])
    };
}

function list(handle, projectId) {
    return handle.db.prepare(SELECT + ' WHERE project_id = ? ORDER BY position, rowid').all(projectId)
        .map(function (row) { return toEnvironment(row); });
}

function get(handle, id) {
    return toEnvironment(handle.db.prepare(SELECT + ' WHERE id = ?').get(id));
}

function nextPosition(handle, projectId) {
    var row = handle.db.prepare('SELECT MAX(position) AS m FROM environments WHERE project_id = ?').get(projectId);
    return row && row.m !== null && row.m !== undefined ? row.m + 1 : 0;
}

function create(handle, projectId, input) {
    var env = input || {};
    var id = env.id || helpers.newId('env');

    handle.db.prepare(
        'INSERT INTO environments (id, project_id, name, variables, position) VALUES (?, ?, ?, ?, ?)'
    ).run(
        id,
        projectId,
        String(env.name || ''),
        json.writeJson(env.variables || []),
        env.position === undefined || env.position === null ? nextPosition(handle, projectId) : Number(env.position)
    );
    return get(handle, id);
}

function update(handle, id, patch) {
    helpers.applyUpdate(handle, 'environments', COLUMNS, id, patch, function (key, value) {
        if (key === 'variables') return json.writeJson(value);
        if (key === 'position') return Number(value) || 0;
        return value === undefined || value === null ? '' : String(value);
    });
    return get(handle, id);
}

function remove(handle, id) {
    handle.db.prepare('DELETE FROM environments WHERE id = ?').run(id);
}

module.exports = {
    list: list,
    get: get,
    create: create,
    update: update,
    remove: remove,
    nextPosition: nextPosition
};
