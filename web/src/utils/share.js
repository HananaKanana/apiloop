import { useGatewayStore } from '@/stores/gateway';

/**
 * 分享链接的地址拼装（第 4 节 接口文档分享）。
 *
 * **必须用云端地址拼**，和 `utils/mock.js` 的 `mockBaseUrl()` 是同一个道理：
 * 打开链接的人是从云端看文档的，而客户端里 `window.location.origin` 是
 * `127.0.0.1:47321`（本机网关），拿它拼出来的链接发出去别人打不开。
 *
 * 拼出来的形状是 `<云端地址>/#/share/<链接串>`（hash 路由，服务端不用为前端路由做任何事）。
 */

/** 云端地址（去掉末尾的斜杠）。直接打开云端时就是当前 origin */
export function shareBaseUrl() {
  const gateway = useGatewayStore();
  const base = gateway.isGateway && gateway.cloudUrl ? gateway.cloudUrl : window.location.origin;
  return String(base).replace(/\/+$/, '');
}

/** 完整的分享链接 */
export function shareUrl(id) {
  return shareBaseUrl() + '/#/share/' + String(id || '');
}

/** 这个项目的 mock 地址前缀（服务端给的是 `/mock-<项目ID>`，根项目是空串） */
export function mockUrlFor(mockPath) {
  return shareBaseUrl() + String(mockPath || '');
}
