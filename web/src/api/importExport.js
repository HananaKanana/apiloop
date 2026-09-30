import { get, post } from './client';

/* ---------------- 解析（纯解析，不写库） ---------------- */

export function parseCurl(text) {
  return post('/import/curl', { text: text });
}

export function parseOpenapi(text) {
  return post('/import/openapi', { text: text });
}

/* ---------------- Postman ---------------- */

export function previewPostman(text) {
  return post('/import/postman/preview', { text: text });
}

/** mode 为 'new'（默认，新建项目）或 'into'（导入到 projectId 指定的项目） */
export function importPostman(text, options) {
  const opts = options || {};
  const payload = { text: text, mode: opts.mode || 'new' };
  if (opts.projectId) payload.projectId = opts.projectId;
  return post('/import/postman', payload);
}

/* ---------------- HAR ---------------- */

/**
 * HAR 预览（纯解析，不写库）。
 * options.keepCredentials 会改变 stats.credentialsStripped，所以勾选状态一变就要重新预览。
 */
export function previewHar(text, options) {
  return post('/import/har/preview', { text: text, options: options || {} });
}

/** mode 为 'new'（默认，新建项目）或 'into'（导入到 projectId 指定的项目） */
export function importHar(text, options) {
  const opts = options || {};
  const payload = { text: text, mode: opts.mode || 'new', options: opts.options || {} };
  if (opts.projectId) payload.projectId = opts.projectId;
  return post('/import/har', payload);
}

/* ---------------- 落库 ---------------- */

export function importRoutes(pid, routes, folderId) {
  const payload = { routes: routes };
  if (folderId) payload.folderId = folderId;
  return post('/projects/' + encodeURIComponent(pid) + '/import/routes', payload);
}

/* ---------------- 导出 ---------------- */

export function exportCollection(pid) {
  return get('/projects/' + encodeURIComponent(pid) + '/export/postman');
}

export function exportEnvironment(environmentId) {
  return get('/environments/' + encodeURIComponent(environmentId) + '/export/postman');
}
