import { get, post } from './client';

/* ---------------- 解析（纯解析，不写库） ---------------- */

export function parseCurl(text) {
  return post('/import/curl', { text: text });
}

/** source: { text } 粘贴 / 文件内容，或 { url } 由服务端（客户端里是本机）去拉 */
export function parseOpenapi(source) {
  return post('/import/openapi', typeof source === 'string' ? { text: source } : source);
}

/* ---------------- Postman ---------------- */

export function previewPostman(text) {
  return post('/import/json/preview', { text: text });
}

/** mode 为 'new'（默认，新建项目）或 'into'（导入到 projectId 指定的项目） */
export function importPostman(text, options) {
  const opts = options || {};
  const payload = { text: text, mode: opts.mode || 'new' };
  if (opts.projectId) payload.projectId = opts.projectId;
  return post('/import/json', payload);
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
  return get('/projects/' + encodeURIComponent(pid) + '/export/json');
}

/**
 * 导出 OpenAPI（第四轮第 2 节）。返回 `{ filename, format, text }`。
 *
 * @param {string} pid
 * @param {{folderId?: string|null, format?: 'json'|'yaml'}} [options] 不传 folderId 就是整个项目
 */
export function exportOpenapi(pid, options) {
  const opts = options || {};
  const params = ['format=' + encodeURIComponent(opts.format || 'yaml')];
  if (opts.folderId) params.push('folderId=' + encodeURIComponent(opts.folderId));
  return get('/projects/' + encodeURIComponent(pid) + '/export/openapi?' + params.join('&'));
}

export function exportEnvironment(environmentId) {
  return get('/environments/' + encodeURIComponent(environmentId) + '/export/json');
}
