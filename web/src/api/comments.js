import { get, post, put, del } from './client';

/**
 * 接口评论和 @ 提醒（第五轮第 4 节）。
 *
 * 评论**只在云端保存**，客户端里这几个请求会被网关转给云端
 * （`lib/gateway/account.js` 的 `cloudOnlyPath`）。
 */

/** 某个接口的评论（含已删除的楼层，已删除的 `body` 是空串、`deleted` 为 true） */
export function listComments(apiId) {
  return get('/apis/' + encodeURIComponent(apiId) + '/comments');
}

/**
 * 发一条评论。viewer 也能发（只读成员正是最需要提问的人）。
 * @param {{body: string, mentions: Array<string>}} payload
 */
export function createComment(apiId, payload) {
  return post('/apis/' + encodeURIComponent(apiId) + '/comments', payload);
}

/** 改内容：**只有作者本人**能改。`mentions` 是整份替换，客户端每次都要带上。 */
export function updateComment(id, payload) {
  return put('/comments/' + encodeURIComponent(id), payload);
}

/** 删除：标记删除（楼层留着）；作者本人或管理员 */
export function removeComment(id) {
  return del('/comments/' + encodeURIComponent(id));
}

/** 每个接口有几条评论 `{ counts: { apiId: n } }`（不含已删除的） */
export function commentCounts(pid) {
  return get('/projects/' + encodeURIComponent(pid) + '/comment-counts');
}

/** 我的提醒，倒序，最多 50 条 */
export function listNotifications(limit) {
  return get('/notifications' + (limit ? '?limit=' + encodeURIComponent(limit) : ''));
}

export function unreadCount() {
  return get('/notifications/unread-count');
}

/** `{ ids: [...] }` 标这几条；`{ all: true }` 全部标为已读 */
export function markRead(payload) {
  return post('/notifications/read', payload);
}
