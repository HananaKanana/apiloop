import { get, del } from './client';

/**
 * Mock 调用日志（契约第 11 节）。日志只存在服务端内存里，重启即清空。
 *
 * `after` 传上次拿到的 lastSeq，服务端只回 seq 比它大的记录 —— 前端每 2 秒
 * 这样拉一次就能增量拿到新记录。注意 after=0 是合法值（表示「从头开始」），
 * 不能用 `if (after)` 判断，那会把 0 当成没传。
 */
export function listMockLog(pid, options) {
  const opts = options || {};
  const params = [];

  if (opts.after !== undefined && opts.after !== null) {
    params.push('after=' + encodeURIComponent(opts.after));
  }
  if (opts.limit) params.push('limit=' + encodeURIComponent(opts.limit));

  const suffix = params.length ? '?' + params.join('&') : '';
  return get('/projects/' + encodeURIComponent(pid) + '/mock-log' + suffix);
}

export function clearMockLog(pid) {
  return del('/projects/' + encodeURIComponent(pid) + '/mock-log');
}
