import { get, put, del } from './client';

/**
 * 项目成员（契约第 10 节）。
 *
 * 角色是 `viewer < editor < owner`；系统角色 admin 不在成员表里，
 * 服务端对任何项目都把它当 owner 看待，所以这里不会出现 admin 这个值。
 */
export function listMembers(pid) {
  return get('/projects/' + encodeURIComponent(pid) + '/members');
}

/** 不是成员就添加，是成员就改角色 */
export function setMemberRole(pid, userId, role) {
  return put('/projects/' + encodeURIComponent(pid) + '/members/' + encodeURIComponent(userId), {
    role: role
  });
}

/** owner 移除别人；或者成员自己退出 */
export function removeMember(pid, userId) {
  return del('/projects/' + encodeURIComponent(pid) + '/members/' + encodeURIComponent(userId));
}

/** 加成员时用来搜人。登录即可，最多 20 条，不含已禁用的用户 */
export function lookupUsers(keyword) {
  return get('/users/lookup?q=' + encodeURIComponent(keyword || ''));
}
