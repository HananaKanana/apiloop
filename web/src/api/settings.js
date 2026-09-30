import { get, put } from './client';

/**
 * 系统设置（契约第 12 节）。
 *
 * 代理是**全局**设置（不是按项目）——代理是「这台机器怎么出去」的事，
 * 所以它不挂在项目下。读只要登录，写要 admin。
 *
 * 密码出接口一律是 `***`；提交时把 `***` 原样传回去就表示「密码不变」。
 */
export function getProxySetting() {
  return get('/settings/proxy');
}

export function updateProxySetting(proxy) {
  return put('/settings/proxy', { proxy: proxy });
}
