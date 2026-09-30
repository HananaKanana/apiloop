import { get, del } from './client';

/**
 * 历史。列表按 id 倒序，limit 最大 200，翻页用上一页最后一条的 id 当 before。
 */
export function listHistory(pid, options) {
  const opts = options || {};
  const params = [];
  if (opts.limit) params.push('limit=' + encodeURIComponent(opts.limit));
  if (opts.before) params.push('before=' + encodeURIComponent(opts.before));
  const suffix = params.length ? '?' + params.join('&') : '';

  return get('/projects/' + encodeURIComponent(pid) + '/history' + suffix);
}

export function getHistory(id) {
  return get('/history/' + encodeURIComponent(id));
}

export function clearHistory(pid) {
  return del('/projects/' + encodeURIComponent(pid) + '/history');
}
