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

/**
 * 创建样例项目（试功能用，见 lib/demo-project.js）。`origin` 是云端地址，
 * 样例项目的环境里 `host` 要写成这个项目的 Mock 地址。返回 `{ project, environmentId }`。
 */
export function createDemoProject(origin) {
  return post('/projects/demo', { origin: origin });
}
