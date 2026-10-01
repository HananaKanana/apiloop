import { get, post, put, request } from './client';

/**
 * 用户名或密码错误时后端返回 401。必须带 noAuthRedirect：
 * 否则 client 会当成「登录过期」去跳登录页，并返回一个永远不结束的 Promise ——
 * 人已经在登录页上了，按钮就一直转圈，没法重新输入（2026-10-01 用户反馈）。
 */
export function login(username, password) {
  return request('POST', '/auth/login', { username: username, password: password }, { noAuthRedirect: true });
}

export function logout() {
  return post('/auth/logout');
}

export function me() {
  return get('/auth/me');
}

export function changePassword(oldPassword, newPassword) {
  return put('/auth/password', { oldPassword: oldPassword, newPassword: newPassword });
}
