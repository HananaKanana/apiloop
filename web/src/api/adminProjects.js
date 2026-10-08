import { get, put, del } from './client';

/**
 * 项目总览（管理员）：所有项目、各自的成员，以及可选的用户列表。
 * 接口在 lib/api/admin-projects.js；客户端里由网关转发到云端。
 */
export function overview() {
  return get('/admin/projects');
}

export function setMember(pid, userId, role) {
  return put('/admin/projects/' + encodeURIComponent(pid) + '/members/' + encodeURIComponent(userId), { role: role });
}

export function removeMember(pid, userId) {
  return del('/admin/projects/' + encodeURIComponent(pid) + '/members/' + encodeURIComponent(userId));
}
