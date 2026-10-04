import { post } from './client';

/**
 * 数据库连接（第九轮第 3 节）。
 *
 * 只有一条接口：**测试连接**。连接本身是项目设置的一部分，跟着 `PUT /projects/:pid`
 * 一起保存（`databases`），所以这里没有增删改。
 *
 * 服务端把 `{ ok, timeMs, error }` 直接回在 200 里 —— 「连不上」是一种正常结果，
 * 不是接口出错，前端用 `ok` 决定显示绿的还是红的，不用去 catch。
 *
 * @param {string} pid
 * @param {{connection: object, environmentId?: string}} payload
 * @returns {Promise<{ok: boolean, timeMs: number, error: string|null}>}
 */
export function testConnection(pid, payload) {
  return post('/projects/' + encodeURIComponent(pid) + '/databases/test', payload);
}
