import { postNdjson } from './stream';

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
