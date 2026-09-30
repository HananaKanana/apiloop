import { get, post, put } from './client';

export function login(username, password) {
  return post('/auth/login', { username: username, password: password });
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
