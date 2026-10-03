import { post } from './client';

/**
 * GraphQL 自动补全（第七轮第 3 节）。
 *
 * introspection 由**服务端**发出去（网关里就是本机发，内网地址也行），
 * 所以这里只负责把「这次要发什么请求」告诉服务端 —— 和 `/send` 同一个形状。
 */

/**
 * 拉一份 schema。
 *
 * @param {string} pid
 * @param {{request: object, apiId?: string, environmentId?: string, mockBase?: string}} payload
 * @returns {Promise<{schema: object}>} `schema` 是 introspection 结果的 `data`
 *   （也就是 `{ __schema: {...} }`）
 */
export function fetchSchema(pid, payload) {
  return post('/projects/' + encodeURIComponent(pid) + '/graphql/schema', payload);
}
