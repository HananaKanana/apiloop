import { postNdjson } from './stream';
import { post } from './client';

/**
 * 简单压测（第八轮第 2 节）。
 *
 * 和 `/send/stream` 一样是 NDJSON：`start` / `tick`（每秒一条）/ `done`。
 * 路由只在**本机网关**上存在，网页版调它会是 404 —— 界面上的入口本来就灰着。
 *
 * @param {string} pid
 * @param {object} body `{ request, apiId, environmentId, mockBase, load }`
 * @param {{signal?: AbortSignal, onEvent?: (event: object) => void}} options
 */
export function startLoad(pid, body, options) {
  return postNdjson('/projects/' + encodeURIComponent(pid) + '/load', body, options);
}

/**
 * 请服务端停下正在跑的压测。服务端收尾后照常在那条流上发 `done`（带汇总），
 * 所以「停止」不要直接断开连接 —— 断开就收不到汇总了。
 */
export function stopLoad(pid) {
  return post('/projects/' + encodeURIComponent(pid) + '/load/stop', {});
}
