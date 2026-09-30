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

/**
 * 列表只取摘要，**不把 request / response 两列读出来**。
 *
 * 一页 50 条、每条响应体最多 256KB，整列读出来再 JSON.parse 只为取五个字段，
 * 是白白把几 MB 的字符串搬进内存再丢掉。改成让 SQLite 直接算：`json_extract`
 * 只解出要的那几个路径。
 *
 * 外面那层 `json_valid` 守卫不能省 —— 碰到坏 JSON 时 json_extract 会直接抛
 * "malformed JSON"，一行脏数据就能让整个列表接口 500。以前是靠 readJson 兜底的。
 */
var SUMMARY_SELECT = 'SELECT id, api_id, user_id, created_at, ' +
    "CASE WHEN json_valid(request) THEN json_extract(request, '$.spec.method') END AS method, " +
    "CASE WHEN json_valid(request) THEN json_extract(request, '$.spec.url') END AS url, " +
    "CASE WHEN json_valid(response) THEN json_extract(response, '$.response.status') END AS status, " +
    "CASE WHEN json_valid(response) THEN json_extract(response, '$.error.code') END AS error_code, " +
    "CASE WHEN json_valid(response) THEN json_extract(response, '$.timings.total') END AS total_ms " +
    'FROM history';

function rowToSummary(row) {
    return {
        id: row.id,
        apiId: row.api_id,
        userId: row.user_id,
        method: row.method === null || row.method === undefined ? '' : row.method,
        url: row.url === null || row.url === undefined ? '' : row.url,
        // 没拿到响应 / 请求成功时，对应的字段在 JSON 里本来就不存在，
        // json_extract 给 NULL —— 正是契约要的语义
        status: row.status === undefined ? null : row.status,
        errorCode: row.error_code === undefined ? null : row.error_code,
        totalMs: row.total_ms === undefined ? null : row.total_ms,
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
        rows = handle.db.prepare(SUMMARY_SELECT + ' WHERE project_id = ? ORDER BY id DESC LIMIT ?')
            .all(projectId, limit);
    } else {
        rows = handle.db.prepare(SUMMARY_SELECT + ' WHERE project_id = ? AND id < ? ORDER BY id DESC LIMIT ?')
            .all(projectId, Number(opts.before), limit);
    }

    return rows.map(rowToSummary);
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
