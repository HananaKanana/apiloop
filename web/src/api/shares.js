import { get, post, del } from './client';

/**
 * 接口文档分享（第三轮第 4 节）。
 *
 * 前三个是**管理**接口（要登录，网关里会转给云端）；最后一个是**公开**的文档数据，
 * 不登录也能读 —— 打开分享链接的人走的就是它。
 */

/** 这个项目已生成的分享链接（viewer 就能看） */
export function listShares(pid) {
  return get('/projects/' + encodeURIComponent(pid) + '/shares');
}

/**
 * **当前用户能看到的全部项目**的分享链接（第 6 节「我的分享」）。
 * 每条多带 `projectId` / `projectName` / `canRevoke`，按创建时间倒序。
 *
 * 它不在任何项目下面，所以网关转发时也要单独放行（见 `lib/gateway/account.js`）。
 */
export function listMyShares() {
  return get('/shares');
}

/**
 * 生成一条分享链接。
 *
 * @param {string} pid
 * @param {{folderId?: string|null, expiresInDays?: 7|30|null}} payload
 *        `folderId` 为空是「整个项目」；`expiresInDays` 传 null 是永久，
 *        不传按服务端默认的 30 天
 * @returns {Promise<{share: object}>}
 */
export function createShare(pid, payload) {
  return post('/projects/' + encodeURIComponent(pid) + '/shares', payload);
}

/** 撤销一条（服务端是删行，删了链接立刻失效） */
export function revokeShare(id) {
  return del('/shares/' + encodeURIComponent(id));
}

/**
 * 公开的文档数据。过期 / 撤销 / 不存在都是 404 + `{ ok:false, error:'这个链接已失效' }`，
 * 所以调用方按 `err.message` 提示就行。
 */
export function getPublicDoc(token) {
  return get('/public/shares/' + encodeURIComponent(token));
}
