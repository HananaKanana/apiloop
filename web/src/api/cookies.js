import { get, post, del } from './client';

/**
 * Cookie 库（契约第 12 节）。
 *
 * 作用范围是「每个用户 × 每个项目」——同一个项目的另一个成员登录的是别的账号，
 * 他看不到、也删不掉我的 cookie。所以这里的接口都没有「按 id 查全部」的入口。
 *
 * `GET` 只返回未过期的；`POST` 按 `domain + path + name` 定位，已有就更新。
 */
export function listCookies(pid) {
  return get('/projects/' + encodeURIComponent(pid) + '/cookies');
}

/**
 * 手动新增或修改一条。`domain` 以 `.` 开头表示「域 cookie」（会发给子域名），
 * 否则是 host-only —— 这条约定契约里没写，但实现（lib/api/cookies.js 的 cleanInput）
 * 就是这么判的。
 */
export function saveCookie(pid, cookie) {
  return post('/projects/' + encodeURIComponent(pid) + '/cookies', { cookie: cookie });
}

export function removeCookie(id) {
  return del('/cookies/' + encodeURIComponent(id));
}

/** 不带 domain 时清空自己在这个项目下的全部 cookie */
export function clearCookies(pid, domain) {
  const suffix = domain ? '?domain=' + encodeURIComponent(domain) : '';
  return del('/projects/' + encodeURIComponent(pid) + '/cookies' + suffix);
}
