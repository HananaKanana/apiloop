/**
 * mock_expectations 表读写：同一个接口按请求条件返回不同的示例。
 *
 * 表在 v1 迁移里就建好了（`example_id` 上有 ON DELETE CASCADE），所以这里
 * 不需要新的迁移 —— 删示例时指向它的期望由数据库自己清掉。
 *
 * `position` 只在同一个接口内部有意义，和示例、目录是同一套约定。
 */

var helpers = require('./helpers');
var json = require('../json');

var SELECT = 'SELECT * FROM mock_expectations';

var COLUMNS = {
    name: 'name',
    position: 'position',
    enabled: 'enabled',
    conditions: 'conditions',
    exampleId: 'example_id'
};

function toExpectation(row) {
    if (!row) return null;
    return {
        id: row.id,
        apiId: row.api_id,
        name: row.name,
        position: row.position,
        enabled: !!row.enabled,
        conditions: json.readJson(row.conditions, []),
        exampleId: row.example_id
    };
}

function listByApi(handle, apiId) {
    return handle.db.prepare(SELECT + ' WHERE api_id = ? ORDER BY position, rowid').all(apiId)
        .map(function (row) { return toExpectation(row); });
}

function get(handle, id) {
    return toExpectation(handle.db.prepare(SELECT + ' WHERE id = ?').get(id));
}

function nextPosition(handle, apiId) {
    var row = handle.db.prepare('SELECT MAX(position) AS m FROM mock_expectations WHERE api_id = ?').get(apiId);
    return row && row.m !== null && row.m !== undefined ? row.m + 1 : 0;
}

function insert(handle, apiId, expectation) {
    var id = expectation.id || helpers.newId('x');

    handle.db.prepare(
        'INSERT INTO mock_expectations (id, api_id, position, name, enabled, conditions, example_id) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(
        id,
        apiId,
        expectation.position === undefined || expectation.position === null
            ? nextPosition(handle, apiId) : Number(expectation.position),
        String(expectation.name || ''),
        expectation.enabled === false ? 0 : 1,
        json.writeJson(expectation.conditions || []),
        expectation.exampleId === undefined || expectation.exampleId === null
            ? null : String(expectation.exampleId)
    );
    return get(handle, id);
}

function update(handle, id, patch) {
    helpers.applyUpdate(handle, 'mock_expectations', COLUMNS, id, patch, function (key, value) {
        if (key === 'conditions') return json.writeJson(value);
        if (key === 'enabled') return value ? 1 : 0;
        if (key === 'position') return Number(value) || 0;
        if (key === 'exampleId') return value === undefined || value === null ? null : String(value);
        return value === undefined || value === null ? '' : String(value);
    });
    return get(handle, id);
}

function remove(handle, id) {
    handle.db.prepare('DELETE FROM mock_expectations WHERE id = ?').run(id);
}

/**
 * 按给定顺序写 position 0..n-1。
 * 认不出来的 id 直接忽略，没提到的按原顺序接在后面 —— 只传一部分也能用，
 * 和分组排序（reorderGroups）是同一套宽容策略。
 */
function setPositions(handle, apiId, orderedIds) {
    var current = listByApi(handle, apiId);
    var known = {};
    current.forEach(function (item) { known[item.id] = true; });

    var seen = {};
    var ordered = [];
    (orderedIds || []).forEach(function (id) {
        var key = String(id);
        if (!known[key] || seen[key]) return;
        seen[key] = true;
        ordered.push(key);
    });
    current.forEach(function (item) {
        if (!seen[item.id]) ordered.push(item.id);
    });

    var statement = handle.db.prepare('UPDATE mock_expectations SET position = ? WHERE id = ?');
    ordered.forEach(function (id, index) { statement.run(index, id); });
    return listByApi(handle, apiId);
}

module.exports = {
    listByApi: listByApi,
    get: get,
    insert: insert,
    update: update,
    remove: remove,
    setPositions: setPositions,
    nextPosition: nextPosition
};
