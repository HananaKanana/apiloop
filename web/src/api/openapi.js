import { post } from './client';

/**
 * 从 OpenAPI 同步更新（第四轮第 3 节）。
 *
 * 两个接口都要 editor；地址由**服务端**去拉（客户端里就是本机网关，内网地址也拉得到）。
 */

/**
 * 只算不改：列出「新增 / 有改动 / 文档里已删除」三组。
 *
 * @param {string} pid
 * @param {{url?: string, text?: string, folderId?: string|null}} payload
 *        `url` 和 `text` 给一个；两个都不给时服务端会用**这个目录上次同步用的地址**
 */
export function diffOpenapi(pid, payload) {
  return post('/projects/' + encodeURIComponent(pid) + '/openapi/diff', payload);
}

/**
 * 同步所选。服务端会**重新拉一次、重新算一次**再执行，所以传过去的只要「选了哪些」：
 * `add` 是 route 的 key，`update` / `remove` 是接口 id。
 *
 * @returns {Promise<{added: number, updated: number, removed: number}>}
 */
export function applyOpenapi(pid, payload) {
  return post('/projects/' + encodeURIComponent(pid) + '/openapi/apply', payload);
}
