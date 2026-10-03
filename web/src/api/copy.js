import { post } from './client';

/**
 * 跨项目复制 / 移动（第六轮第 3 节）。
 *
 * 移动 = 服务端先复制到目标、再把原来的放进回收站（不是真删），移错了能从回收站找回来。
 */

/**
 * 把一个接口或一个目录复制（或移动）到别的项目。
 *
 * @param {'api'|'folder'} kind
 * @param {string} id
 * @param {{projectId: string, folderId?: string|null, move?: boolean}} payload
 * @returns {Promise<{projectId, projectName, folderId, folderName, folderIds, apiIds,
 *   apiCount, folderCount, move}>}
 */
export function copyNode(kind, id, payload) {
  const base = kind === 'folder' ? '/folders/' : '/apis/';
  return post(base + encodeURIComponent(id) + '/copy', payload);
}

/**
 * 复制整个项目为新项目。
 *
 * @param {string} pid 源项目
 * @param {{name: string}} payload
 * @returns {Promise<{project: object}>}
 */
export function duplicateProject(pid, payload) {
  return post('/projects/' + encodeURIComponent(pid) + '/duplicate', payload);
}
