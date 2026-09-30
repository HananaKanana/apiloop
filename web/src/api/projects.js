import { get, post, put, del } from './client';

export function listProjects() {
  return get('/projects');
}

export function createProject(payload) {
  return post('/projects', payload);
}

export function getProject(pid) {
  return get('/projects/' + encodeURIComponent(pid));
}

export function updateProject(pid, patch) {
  return put('/projects/' + encodeURIComponent(pid), patch);
}

export function removeProject(pid) {
  return del('/projects/' + encodeURIComponent(pid));
}
