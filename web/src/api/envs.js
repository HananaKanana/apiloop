import { get, post, put, del } from './client';

export function listEnvironments(pid) {
  return get('/projects/' + encodeURIComponent(pid) + '/environments');
}

export function createEnvironment(pid, payload) {
  return post('/projects/' + encodeURIComponent(pid) + '/environments', payload);
}

export function updateEnvironment(id, patch) {
  return put('/environments/' + encodeURIComponent(id), patch);
}

export function removeEnvironment(id) {
  return del('/environments/' + encodeURIComponent(id));
}
