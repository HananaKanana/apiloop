import { get, post, put, del } from './client';

export function listUsers() {
  return get('/users');
}

export function createUser(payload) {
  return post('/users', payload);
}

export function updateUser(id, patch) {
  return put('/users/' + encodeURIComponent(id), patch);
}

export function resetPassword(id) {
  return post('/users/' + encodeURIComponent(id) + '/reset-password');
}

export function removeUser(id) {
  return del('/users/' + encodeURIComponent(id));
}
