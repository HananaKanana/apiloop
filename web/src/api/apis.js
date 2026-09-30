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
