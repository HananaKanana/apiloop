import { get, post, put, del } from './client';

export function getTree(pid) {
  return get('/projects/' + encodeURIComponent(pid) + '/tree');
}

export function createFolder(pid, payload) {
  return post('/projects/' + encodeURIComponent(pid) + '/folders', payload);
}

export function updateFolder(id, patch) {
  return put('/folders/' + encodeURIComponent(id), patch);
}

/** mode 为 'delete' 时连同子项一起删，默认 'move'（子项移到上一级） */
export function removeFolder(id, mode) {
  const apis = mode === 'delete' ? 'delete' : 'move';
  return del('/folders/' + encodeURIComponent(id) + '?apis=' + apis);
}

export function moveNode(pid, payload) {
  return post('/projects/' + encodeURIComponent(pid) + '/move', payload);
}

/** 多选后一起移动：`{ items: [{kind, id}], parentId, folderIndex, apiIndex }` */
export function moveMany(pid, payload) {
  return post('/projects/' + encodeURIComponent(pid) + '/move-many', payload);
}

/** 多选后一起删除（进回收站）：`{ items: [{kind, id}] }` */
export function removeMany(pid, items) {
  return post('/projects/' + encodeURIComponent(pid) + '/remove-many', { items: items });
}

export function importRoutes(pid, payload) {
  return post('/projects/' + encodeURIComponent(pid) + '/import/routes', payload);
}
