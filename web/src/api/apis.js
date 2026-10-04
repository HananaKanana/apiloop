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
 * 「代码片段」：按发送时的同一套规则（变量、鉴权继承）生成各语言的调用代码，不发请求。
 * payload 和发送接口一样：{ request, apiId, environmentId, mockBase }
 *
 * 后台一次返回**所有语言**（`code` 是「语言 → 代码」的表），切语言不用再打接口。
 *
 * @returns {Promise<{curl: string, code: Object<string,string>, missing: string[]}>}
 */
export function curlFor(projectId, payload) {
  return post('/projects/' + encodeURIComponent(projectId) + '/send/curl', payload);
}
