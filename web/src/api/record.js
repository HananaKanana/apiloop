import { get, post, del } from './client';

/**
 * Mock 录制（第十一轮第 2 节）。
 *
 * 这几个接口**只有本机网关有**（云端连路由都没挂），所以网页版调会 404。
 * 录制是按项目分的：`GET` 只回这个项目的记录；别的项目正在录时 `recording` 是 null，
 * 另外给一个 `busy: { projectId, projectName }`。
 */

/** 开代理。body：{ target, environmentId, port, lan, pathPrefix, skipStatic } */
export function startRecord(pid, body) {
  return post('/projects/' + encodeURIComponent(pid) + '/record/start', body);
}

/** 停代理（记录保留）。只有正在录的那个项目能停，别的项目来停会拿到 409 */
export function stopRecord(pid) {
  return post('/projects/' + encodeURIComponent(pid) + '/record/stop');
}

/**
 * 拉记录。`after` 传上次拿到的 lastSeq，只回增量。
 * **after=0 是合法值**（表示从头），不能用 `if (after)` 判断。
 */
export function listRecord(pid, after) {
  const suffix = after === undefined || after === null
    ? ''
    : '?after=' + encodeURIComponent(after);
  return get('/projects/' + encodeURIComponent(pid) + '/record' + suffix);
}

/** 清空这个项目的记录 */
export function clearRecord(pid) {
  return del('/projects/' + encodeURIComponent(pid) + '/record/entries');
}

/** 存成示例 / 新建接口。body：{ items, paramize, setMock, environmentId } */
export function saveRecord(pid, body) {
  return post('/projects/' + encodeURIComponent(pid) + '/record/save', body);
}
