import { get, post, put, del } from './client';

/**
 * 测试集（第八轮第 1 节）。
 *
 * 运行（`/suites/:id/run`）返回的是 NDJSON 流，用 `api/stream.js` 的 `postNdjson`，
 * 不在这里包 —— 这里只放普通的 JSON 接口。
 */

function pidPath(pid) {
  return '/projects/' + encodeURIComponent(pid) + '/suites';
}

export function listSuites(pid) {
  return get(pidPath(pid));
}

export function createSuite(pid, payload) {
  return post(pidPath(pid), payload || {});
}

export function getSuite(id) {
  return get('/suites/' + encodeURIComponent(id));
}

export function updateSuite(id, patch) {
  return put('/suites/' + encodeURIComponent(id), patch || {});
}

export function removeSuite(id) {
  return del('/suites/' + encodeURIComponent(id));
}

export function copySuite(id) {
  return post('/suites/' + encodeURIComponent(id) + '/copy', {});
}

export function reorderSuites(pid, ids) {
  return post(pidPath(pid) + '/reorder', { ids: ids || [] });
}

/** 预览数据（数据页签那张表）：`{ format, text }` → `{ columns, rows, total }` */
export function previewData(pid, payload) {
  return post(pidPath(pid) + '/preview-data', payload || {});
}

/* ---------------------------------------------------------------- 运行记录（云端） */

export function listRuns(suiteId) {
  return get('/suites/' + encodeURIComponent(suiteId) + '/runs');
}

export function getRun(id) {
  return get('/suite-runs/' + encodeURIComponent(id));
}

export function removeRun(id) {
  return del('/suite-runs/' + encodeURIComponent(id));
}

/**
 * 请服务端停下正在跑的测试集。收尾、存记录、`done` 事件照常从运行那条流上回来，
 * 所以「停止」不要直接断开连接 —— 断开就不知道记录存没存上了。
 */
export function stopSuite(id) {
  return post('/suites/' + encodeURIComponent(id) + '/stop', {});
}
