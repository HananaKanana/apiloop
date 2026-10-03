import { post } from './client';

/**
 * 全局查找替换（第五轮第 2 节）。
 *
 * 两个接口的请求体形状一样，只有 replace 多要 `replacement` / `targets` / `skipApiIds`。
 */

/**
 * @param {string} pid
 * @param {{query: string, caseSensitive?: boolean, wholeWord?: boolean, regex?: boolean,
 *   fields?: string[], folderId?: string}} payload
 * @returns {Promise<{matches: Array, total: number, truncated: boolean}>}
 */
export function search(pid, payload) {
  return post('/projects/' + encodeURIComponent(pid) + '/search', payload);
}

/**
 * @param {string} pid
 * @param {object} payload 查找条件 + `{ replacement, targets: [{ apiId, field, location }], skipApiIds }`
 * @returns {Promise<{changedApis: number, changed: number}>}
 */
export function replace(pid, payload) {
  return post('/projects/' + encodeURIComponent(pid) + '/replace', payload);
}
