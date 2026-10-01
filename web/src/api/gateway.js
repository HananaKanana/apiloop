import { CUSTOM_HEADERS } from './client';

/**
 * 网关自己的地址。
 *
 * L1 起前缀是 **`/__apiloop`**（原来是 `/__gateway`）。它**不在 `/__admin/api` 下面**，
 * 所以不能用 `client.js` 里那个带前缀的 `request`。自定义头 `X-Apiloop: 1` 还是要带 ——
 * 网关的安全闸门对 `/__apiloop/*` 的非 GET 请求同样要求它（`lib/gateway/index.js` 的 createGuard）。
 */
const GATEWAY_PREFIX = '/__apiloop';

async function requestGateway(method, path, body) {
  const init = {
    method: method,
    headers: Object.assign({}, CUSTOM_HEADERS),
    credentials: 'same-origin'
  };

  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  const res = await fetch(GATEWAY_PREFIX + path, init);
  if (!res.ok) {
    const text = await res.text().catch(function () { return ''; });
    let message = '';
    try {
      message = JSON.parse(text).error || '';
    } catch (err) {
      // 不是 JSON，用兜底文案
    }
    throw new Error(message || '请求失败（HTTP ' + res.status + '）');
  }
  return res.json();
}

/**
 * 探测「页面是不是从网关上打开的」。
 *
 * 只有网关上有这个地址：直接打开云端时它会 404，或者被静态服务当成前端路由，
 * 返回一个 200 + HTML 的 index.html。两种情况都**不能抛错、不能卡住**，
 * 一律当成「不是网关」。
 *
 * 所以判断要两道：先看状态码，再看回来的到底是不是一个带 `version` 的 JSON ——
 * 只看状态码会被那个 200 的 HTML 骗过去。
 *
 * @returns {Promise<{isGateway: boolean, version?: string, cloudUrl?: string,
 *                    cloudReachable?: boolean, space?: {state: string, user: object|null},
 *                    sync?: object}>}
 */
export async function getStatus() {
  let res;
  try {
    res = await fetch(GATEWAY_PREFIX + '/status', {
      method: 'GET',
      headers: Object.assign({}, CUSTOM_HEADERS),
      credentials: 'same-origin'
    });
  } catch (err) {
    // 网络层面就失败了（比如页面是从 file:// 打开的），当不是网关
    return { isGateway: false };
  }

  if (!res.ok) return { isGateway: false };

  const text = await res.text().catch(function () { return ''; });
  let data = null;
  try {
    data = JSON.parse(text);
  } catch (err) {
    data = null;
  }

  if (!data || typeof data !== 'object' || typeof data.version !== 'string') {
    return { isGateway: false };
  }

  return {
    isGateway: true,
    version: data.version,
    cloudUrl: data.cloudUrl || '',
    cloudReachable: Boolean(data.cloudReachable),
    space: data.space || null,
    sync: data.sync || null
  };
}

/**
 * 删掉当前空间的本机数据（设计稿 4.4）。
 *
 * 网关会关库、删目录，再换成一个新的空的未绑定空间。删完要**整页刷新** ——
 * 页面里所有 store 装的都是刚被删掉的那份数据。
 */
export function deleteSpace() {
  return requestGateway('POST', '/space/delete', {});
}
