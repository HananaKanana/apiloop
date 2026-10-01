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
 *                    cloudReachable?: boolean, mode?: string}>}
 *          `mode` 取 `'local'` 或 `'cloud'`，网关没给时当 `'cloud'`
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
    mode: data.mode === 'local' ? 'local' : 'cloud'
  };
}

/**
 * 进入本机模式（L1）：网关打开本机空间、发一个本机用户的会话 Cookie，
 * 并把 `mode` 记成 `'local'`。
 *
 * 返回之后**要整页刷新** —— 所有 store 里现在装的还是云端（或本机）的数据，
 * 只有重新加载才会按新的模式取数。
 */
export function enterLocal() {
  return requestGateway('POST', '/local/enter');
}
