/**
 * apis 表读写。position 是项目内全局排序（不按目录分层）。
 */

var helpers = require('./helpers');
var json = require('../json');

var SELECT = 'SELECT * FROM apis';

var DEFAULT_PARAMS = { path: [], query: [], headers: [] };
var DEFAULT_BODY = { mode: 'none' };

var COLUMNS = {
    folderId: 'folder_id',
    name: 'name',
    description: 'description',
    position: 'position',
    method: 'method',
    url: 'url',
    params: 'params',
    body: 'body',
    auth: 'auth',
    scripts: 'scripts',
    mockEnabled: 'mock_enabled',
    mockPath: 'mock_path',
    mockDelay: 'mock_delay',
    mockCors: 'mock_cors',
    mockExampleId: 'mock_example_id',
    extra: 'extra',
    updatedAt: 'updated_at'
};

function toApi(row) {
    if (!row) return null;
    return {
        id: row.id,
        projectId: row.project_id,
        folderId: row.folder_id,
        name: row.name,
        description: row.description,
        position: row.position,
        method: row.method,
        url: row.url,
        params: json.readJson(row.params, DEFAULT_PARAMS),
        body: json.readJson(row.body, DEFAULT_BODY),
        auth: row.auth === null || row.auth === undefined ? null : json.readJson(row.auth, null),
        scripts: json.readJson(row.scripts, []),
        mockEnabled: !!row.mock_enabled,
        mockPath: row.mock_path,
        mockDelay: row.mock_delay,
        mockCors: !!row.mock_cors,
        mockExampleId: row.mock_example_id,
        extra: json.readJson(row.extra, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}

function list(handle, projectId) {
    return handle.db.prepare(SELECT + ' WHERE project_id = ? ORDER BY position, rowid').all(projectId)
        .map(function (row) { return toApi(row); });
}

function get(handle, id) {
    return toApi(handle.db.prepare(SELECT + ' WHERE id = ?').get(id));
}

function nextPosition(handle, projectId) {
    var row = handle.db.prepare('SELECT MAX(position) AS m FROM apis WHERE project_id = ?').get(projectId);
    return row && row.m !== null && row.m !== undefined ? row.m + 1 : 0;
}

function insert(handle, projectId, api) {
    var now = Date.now();
    var id = api.id || helpers.newId('a');

    handle.db.prepare(
        'INSERT INTO apis (id, project_id, folder_id, name, description, position, method, url, params, body, auth, ' +
        'scripts, mock_enabled, mock_path, mock_delay, mock_cors, mock_example_id, extra, created_at, updated_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
        id,
        projectId,
        api.folderId || null,
        String(api.name || ''),
        String(api.description || ''),
        api.position === undefined || api.position === null ? nextPosition(handle, projectId) : Number(api.position),
        String(api.method || 'GET'),
        String(api.url || ''),
        json.writeJson(api.params || DEFAULT_PARAMS),
        json.writeJson(api.body || DEFAULT_BODY),
        api.auth ? json.writeJson(api.auth) : null,
        json.writeJson(api.scripts || []),
        api.mockEnabled === false ? 0 : 1,
        api.mockPath === undefined || api.mockPath === null ? null : String(api.mockPath),
        Number(api.mockDelay) || 0,
        api.mockCors ? 1 : 0,
        api.mockExampleId || null,
        json.writeJson(api.extra || {}),
        api.createdAt || now,
        now
    );
    return get(handle, id);
}

function update(handle, id, patch) {
    var touched = helpers.applyUpdate(handle, 'apis', COLUMNS, id, patch, function (key, value) {
        if (key === 'params' || key === 'body' || key === 'scripts' || key === 'extra') return json.writeJson(value);
        if (key === 'auth') return value === undefined || value === null ? null : json.writeJson(value);
        if (key === 'folderId') return value === undefined || value === null ? null : String(value);
        if (key === 'mockPath') return value === undefined || value === null ? null : String(value);
        if (key === 'mockExampleId') return value === undefined || value === null ? null : String(value);
        if (key === 'mockEnabled' || key === 'mockCors') return value ? 1 : 0;
        if (key === 'mockDelay' || key === 'position') return Number(value) || 0;
        return value === undefined || value === null ? '' : String(value);
    });
    if (touched) {
        handle.db.prepare('UPDATE apis SET updated_at = ? WHERE id = ?').run(Date.now(), id);
    }
    return get(handle, id);
}

/** 按给定顺序重排 position（管理台拖动接口排序用） */
function setPositions(handle, projectId, orderedIds) {
    var current = list(handle, projectId);
    var seen = {};
    var ordered = [];

    (orderedIds || []).forEach(function (id) {
        if (seen[id]) return;
        seen[id] = true;
        ordered.push(id);
    });
    current.forEach(function (api) {
        if (!seen[api.id]) ordered.push(api.id);
    });

    var statement = handle.db.prepare('UPDATE apis SET position = ? WHERE id = ?');
    ordered.forEach(function (id, index) { statement.run(index, id); });
    return list(handle, projectId);
}

function remove(handle, id) {
    handle.db.prepare('DELETE FROM apis WHERE id = ?').run(id);
}

/** 删除整个分组（folder）时用它清掉组内接口；调用方随后再删 folder */
function removeByFolder(handle, folderId) {
    handle.db.prepare('DELETE FROM apis WHERE folder_id = ?').run(folderId);
}

function countByFolder(handle, folderId) {
    var row = handle.db.prepare('SELECT count(*) AS c FROM apis WHERE folder_id = ?').get(folderId);
    return row ? row.c : 0;
}

module.exports = {
    list: list,
    get: get,
    insert: insert,
    update: update,
    remove: remove,
    removeByFolder: removeByFolder,
    countByFolder: countByFolder,
    setPositions: setPositions,
    nextPosition: nextPosition
};
