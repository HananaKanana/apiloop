/**
 * history 表读写。
 *
 * 两列 JSON 各存一半：
 * - `request` 存 `{ spec, environmentId }` —— 原始的、**未替换变量**的 RequestSpec，
 *   加上当时用的环境。存原样的意义是「重放」时能复现当时的条件；
 * - `response` 存执行器返回的 ExecResult，原样透传。
 *
 * 摘要字段（列表页要用的 method / url / status / errorCode / totalMs）不单独存列，
 * 而是读的时候从这两块 JSON 里取 —— 多存一份列就要多维护一次同步，而历史是只写不改的，
 * 每次现算反而更简单。
 */

var json = require('../json');

/** 每个项目最多保留多少条 */
var KEEP_PER_PROJECT = 500;

var SELECT = 'SELECT * FROM history';

function toSummary(row, request, result) {
    var spec = (request && request.spec) || {};

    return {
        id: row.id,
        apiId: row.api_id,
        userId: row.user_id,
        method: spec.method || '',
        url: spec.url || '',
        status: result && result.response ? result.response.status : null,
        errorCode: result && result.error ? result.error.code : null,
        totalMs: result && result.timings ? result.timings.total : null,
        createdAt: row.created_at
    };
}

/**
 * 只保留该项目最新的 KEEP_PER_PROJECT 条。
 * 用 `id NOT IN (子查询)` 而不是「算出一个阈值再比大小」：history.id 是自增主键，
 * 但项目之间交错写入，阈值法要按项目分别求，反而绕。
 */
function prune(handle, projectId) {
    handle.db.prepare(
        'DELETE FROM history WHERE project_id = ? AND id NOT IN (' +
        '    SELECT id FROM history WHERE project_id = ? ORDER BY id DESC LIMIT ?' +
        ')'
    ).run(projectId, projectId, KEEP_PER_PROJECT);
}

/**
 * @param {object} entry { projectId, apiId?, userId?, request, response }
 * @returns {number} 新记录的 id
 */
function insert(handle, entry) {
    var info = handle.db.prepare(
        'INSERT INTO history (project_id, api_id, user_id, request, response, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(
        entry.projectId,
        entry.apiId || null,
        entry.userId || null,
        json.writeJson(entry.request || {}),
        json.writeJson(entry.response || {}),
        entry.createdAt || Date.now()
    );

    var id = Number(info.lastInsertRowid);
    prune(handle, entry.projectId);
    return id;
}

/**
 * 按 id 倒序列出摘要。
 *
 * @param {object} options { limit, before } before 传上一页最后一条的 id，取更小的那些
 * @returns {Array} 摘要数组
 */
function list(handle, projectId, options) {
    var opts = options || {};
    var limit = Number(opts.limit) > 0 ? Number(opts.limit) : 50;

    var rows;
    if (opts.before === undefined || opts.before === null || opts.before === '') {
        rows = handle.db.prepare(SELECT + ' WHERE project_id = ? ORDER BY id DESC LIMIT ?')
            .all(projectId, limit);
    } else {
        rows = handle.db.prepare(SELECT + ' WHERE project_id = ? AND id < ? ORDER BY id DESC LIMIT ?')
            .all(projectId, Number(opts.before), limit);
    }

    return rows.map(function (row) {
        return toSummary(row, json.readJson(row.request, {}), json.readJson(row.response, {}));
    });
}

function get(handle, id) {
    var row = handle.db.prepare(SELECT + ' WHERE id = ?').get(Number(id));
    if (!row) return null;

    return {
        id: row.id,
        projectId: row.project_id,
        apiId: row.api_id,
        userId: row.user_id,
        request: json.readJson(row.request, {}),
        result: json.readJson(row.response, {}),
        createdAt: row.created_at
    };
}

function clear(handle, projectId) {
    handle.db.prepare('DELETE FROM history WHERE project_id = ?').run(projectId);
}

module.exports = {
    insert: insert,
    list: list,
    get: get,
    clear: clear,
    KEEP_PER_PROJECT: KEEP_PER_PROJECT
};
