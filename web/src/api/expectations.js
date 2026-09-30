import { post, put, del } from './client';

/**
 * Mock 期望（契约第 9 节）。
 *
 * 注意各接口返回的东西不一样：
 * - 新增回 `{ expectation, api }`；
 * - 修改只回 `{ expectation }`（不重发整个 api，调用方要自己把它并回本地）；
 * - 删除和排序回 `{ api }`。
 */
export function createExpectation(apiId, expectation) {
  return post('/apis/' + encodeURIComponent(apiId) + '/expectations', {
    expectation: expectation
  });
}

export function updateExpectation(id, patch) {
  return put('/expectations/' + encodeURIComponent(id), { expectation: patch });
}

export function removeExpectation(id) {
  return del('/expectations/' + encodeURIComponent(id));
}

/** ids 是排好序的期望 id 数组 */
export function reorderExpectations(apiId, ids) {
  return post('/apis/' + encodeURIComponent(apiId) + '/expectations/reorder', { ids: ids });
}
