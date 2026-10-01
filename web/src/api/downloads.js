import { get } from './client';

/**
 * 云端提供的安装包。
 *
 * 注意**下载本身不走这里**：文件地址是 `/__admin/downloads/<文件名>`（不在 `/__admin/api`
 * 下面），而且不要求登录 —— 链接可以直接发给同事。所以那边用普通链接，
 * 不要用 fetch 拿回来再存，那样大文件会先进内存。
 */

/** 安装包列表。目录不存在时服务端返回空数组，不报错 */
export function listDownloads() {
  return get('/downloads');
}

/**
 * 某个安装包的下载地址。
 *
 * 页面在**网关上**时要用云端地址：网关不转发 `/__admin/downloads/`（计划 Task 2 写明），
 * 而网关自己的 `/__admin` 下没有这些文件。
 *
 * @param {string} name 文件名
 * @param {{onGateway?: boolean, cloudUrl?: string}} [options]
 */
export function downloadUrl(name, options) {
  const opts = options || {};
  const base = opts.onGateway && opts.cloudUrl
    ? String(opts.cloudUrl).replace(/\/+$/, '')
    : window.location.origin;

  return base + '/__admin/downloads/' + encodeURIComponent(name);
}
