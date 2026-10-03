import { get, post, del } from './client';

/** 回收站列表（不含 payload）。viewer 也能调 */
export function getTrash(pid) {
  return get('/projects/' + encodeURIComponent(pid) + '/trash');
}

/** 恢复一条，返回 { restoredTo, folderId? / apiId? / environmentId? } */
export function restoreTrash(id) {
  return post('/trash/' + encodeURIComponent(id) + '/restore', {});
}

/** 彻底删除一条 */
export function removeTrash(id) {
  return del('/trash/' + encodeURIComponent(id));
}

/** 清空这个项目的回收站 */
export function clearTrash(pid) {
  return del('/projects/' + encodeURIComponent(pid) + '/trash');
}
