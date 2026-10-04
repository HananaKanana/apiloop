/**
 * suite_runs 表读写（第八轮第 1 节）。
 *
 * **只在云端，不同步**：本机跑完把结果交给云端（网关转发），第九轮的命令行也交给云端，
 * 大家在一处看历次结果。所以这里没有 rev / 触发器那套。
 *
 * `result` 可能很大（每轮的每一步），所以列表查询**不取它** —— 只有打开某一条记录时才读。
 * 每条测试集只留最近 100 条，插入新的时顺手删掉更早的。
 */

var helpers = require('./helpers');
var json = require('../json');

/** 每条测试集保留的运行记录条数（计划里定的：只留最近 100 条） */
var KEEP_PER_SUITE = 100;

var LIST_COLUMNS = 'id, suite_id, project_id, source, environment_name, status, summary, ' +
    'triggered_by, label, started_at, finished_at';

function toRun(row, withResult) {
    if (!row) return null;

    var run = {
        id: row.id,
        suiteId: row.suite_id,
        projectId: row.project_id,
        source: row.source,
        environmentName: row.environment_name,
        status: row.status,
        summary: json.readJson(row.summary, {}),
        triggeredBy: row.triggered_by,
        label: row.label,
        startedAt: row.started_at,
        finishedAt: row.finished_at
    };

    if (withResult) run.result = json.readJson(row.result, {});
    return run;
}

/**
 * 某个测试集的运行记录，新的在前。
 *
 * @param {number} [limit] 默认 100（和保留条数一致，界面上也只显示这么多）
 */
function list(handle, suiteId, limit) {
    var size = Number(limit);
    if (!Number.isFinite(size) || size <= 0) size = KEEP_PER_SUITE;
    size = Math.min(Math.floor(size), KEEP_PER_SUITE);

    return handle.db.prepare(
        'SELECT ' + LIST_COLUMNS + ' FROM suite_runs WHERE suite_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?'
    ).all(suiteId, size).map(function (row) { return toRun(row, false); });
}

/** 一条记录，带 `result` */
function get(handle, id) {
    return toRun(handle.db.prepare('SELECT * FROM suite_runs WHERE id = ?').get(id), true);
}

/**
 * 存一条运行记录。
 *
 * @param {{suiteId: string, projectId: string, source?: string, environmentName?: string,
 *   status: string, summary: object, result: object, triggeredBy?: string|null,
 *   label?: string, startedAt: number, finishedAt: number}} input
 */
function insert(handle, input) {
    var id = input.id || helpers.newId('run');

    handle.db.prepare(
        'INSERT INTO suite_runs (id, suite_id, project_id, source, environment_name, status, summary, result, ' +
        'triggered_by, label, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
        id,
        input.suiteId,
        input.projectId,
        input.source === 'cli' ? 'cli' : 'app',
        String(input.environmentName || ''),
        String(input.status || 'error'),
        json.writeJson(input.summary || {}),
        json.writeJson(input.result || {}),
        input.triggeredBy || null,
        String(input.label || ''),
        Number(input.startedAt) || Date.now(),
        Number(input.finishedAt) || Date.now()
    );

    prune(handle, input.suiteId);
    return get(handle, id);
}

/** 只留最近 KEEP_PER_SUITE 条（多出来的删掉） */
function prune(handle, suiteId) {
    handle.db.prepare(
        'DELETE FROM suite_runs WHERE suite_id = ? AND id NOT IN (' +
        '  SELECT id FROM suite_runs WHERE suite_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?' +
        ')'
    ).run(suiteId, suiteId, KEEP_PER_SUITE);
}

function remove(handle, id) {
    handle.db.prepare('DELETE FROM suite_runs WHERE id = ?').run(id);
}

module.exports = {
    KEEP_PER_SUITE: KEEP_PER_SUITE,
    list: list,
    get: get,
    insert: insert,
    remove: remove
};
