/**
 * examples 表读写。「示例」一处数据两用：调试时是保存下来的响应，
 * mock 时就是返回的数据 —— 这是「调通即 mock」在模型上的落点。
 */

var helpers = require('./helpers');
var json = require('../json');

var SELECT = 'SELECT * FROM examples';

var COLUMNS = {
    name: 'name',
    position: 'position',
    status: 'status',
    headers: 'headers',
    body: 'body',
    responseType: 'response_type',
    isTemplate: 'is_template',
    source: 'source',
    extra: 'extra'
};

function toExample(row) {
    if (!row) return null;
    return {
        id: row.id,
        apiId: row.api_id,
        name: row.name,
        position: row.position,
        status: row.status,
        headers: json.readJson(row.headers, []),
        body: row.body,
        responseType: row.response_type,
        isTemplate: !!row.is_template,
        source: row.source,
        extra: json.readJson(row.extra, {}),
        createdAt: row.created_at
    };
}

function listByApi(handle, apiId) {
    return handle.db.prepare(SELECT + ' WHERE api_id = ? ORDER BY position, rowid').all(apiId)
        .map(function (row) { return toExample(row); });
}

function get(handle, id) {
    return toExample(handle.db.prepare(SELECT + ' WHERE id = ?').get(id));
}

function nextPosition(handle, apiId) {
    var row = handle.db.prepare('SELECT MAX(position) AS m FROM examples WHERE api_id = ?').get(apiId);
    return row && row.m !== null && row.m !== undefined ? row.m + 1 : 0;
}

function insert(handle, apiId, example) {
    var id = example.id || helpers.newId('e');

    handle.db.prepare(
        'INSERT INTO examples (id, api_id, name, position, status, headers, body, response_type, is_template, source, extra, created_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
        id,
        apiId,
        String(example.name || ''),
        example.position === undefined || example.position === null ? nextPosition(handle, apiId) : Number(example.position),
        Number(example.status) || 200,
        json.writeJson(example.headers || []),
        String(example.body === undefined || example.body === null ? '' : example.body),
        String(example.responseType || 'json'),
        example.isTemplate === false ? 0 : 1,
        ['manual', 'recorded', 'imported'].indexOf(example.source) > -1 ? example.source : 'manual',
        json.writeJson(example.extra || {}),
        example.createdAt || Date.now()
    );
    return get(handle, id);
}

function update(handle, id, patch) {
    helpers.applyUpdate(handle, 'examples', COLUMNS, id, patch, function (key, value) {
        if (key === 'headers') return json.writeJson(value);
        if (key === 'extra') return json.writeJson(value);
        if (key === 'isTemplate') return value ? 1 : 0;
        if (key === 'status' || key === 'position') return Number(value) || 0;
        return value === undefined || value === null ? '' : String(value);
    });
    return get(handle, id);
}

/**
 * 删除示例，并把指向它的 apis.mock_example_id 置空。
 * mock_example_id 故意没有外键（它和本表互相引用），所以这步得手动做，
 * 否则接口会指向一条已经不存在的示例。
 */
function remove(handle, id) {
    handle.db.prepare('UPDATE apis SET mock_example_id = NULL WHERE mock_example_id = ?').run(id);
    handle.db.prepare('DELETE FROM examples WHERE id = ?').run(id);
}

/** 删除整个接口时用；apis 上有 ON DELETE CASCADE，其实会被自动清理，这里留给显式调用 */
function removeByApi(handle, apiId) {
    handle.db.prepare('DELETE FROM examples WHERE api_id = ?').run(apiId);
}

module.exports = {
    listByApi: listByApi,
    get: get,
    insert: insert,
    update: update,
    remove: remove,
    removeByApi: removeByApi,
    nextPosition: nextPosition
};
