import { get, post, put, del } from './client';

export function getApi(id) {
  return get('/apis/' + encodeURIComponent(id));
}

export function createApi(pid, api) {
  return post('/projects/' + encodeURIComponent(pid) + '/apis', { api: api });
}

export function updateApi(id, patch) {
  return put('/apis/' + encodeURIComponent(id), { api: patch });
}

export function removeApi(id) {
  return del('/apis/' + encodeURIComponent(id));
}

export function duplicateApi(id) {
  return post('/apis/' + encodeURIComponent(id) + '/duplicate');
}

export function createExample(apiId, example) {
  return post('/apis/' + encodeURIComponent(apiId) + '/examples', { example: example });
}

export function updateExample(id, patch) {
  return put('/examples/' + encodeURIComponent(id), { example: patch });
}

export function removeExample(id) {
  return del('/examples/' + encodeURIComponent(id));
}

/**
 * 「代码片段 → cURL」：按发送时的同一套规则（变量、鉴权继承）生成 curl 命令，不发请求。
 * payload 和发送接口一样：{ request, apiId, environmentId, mockBase }
 *
 * @returns {Promise<{curl: string, missing: string[]}>}
 */
export function curlFor(projectId, payload) {
  return post('/projects/' + encodeURIComponent(projectId) + '/send/curl', payload);
}
