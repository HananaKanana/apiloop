import * as membersApi from '@/api/members';

/**
 * 项目成员的一份小缓存（第四轮第 1 节）。
 *
 * 「负责人」下拉要拿成员列表，但它挂在每个接口标签页上 —— 每开一个标签页就拉一次成员
 * 太浪费，这里按项目缓存一份 Promise。成员变动（成员面板改了角色 / 加了人）之后
 * 调 `invalidateMembers(pid)` 清掉。
 *
 * 没登录（本机空间）时接口返回 409 `LOGIN_REQUIRED`，这时**不缓存**：
 * 登录之后同一个项目要能重新拉到。
 */

const cache = new Map();

/**
 * @param {string} pid
 * @returns {Promise<Array<object>>} 成员列表（`{ userId, username, displayName, role, disabled }`）
 */
export function loadMembers(pid) {
  if (!pid) return Promise.resolve([]);
  if (!cache.has(pid)) {
    cache.set(pid, membersApi.listMembers(pid).then(function (data) {
      return data.members || [];
    }, function (err) {
      cache.delete(pid);
      throw err;
    }));
  }
  return cache.get(pid);
}

export function invalidateMembers(pid) {
  if (pid) cache.delete(pid);
  else cache.clear();
}

/**
 * 成员面板拿到最新的一份之后把它塞回来。
 *
 * 面板自己拉完 / 改完就直接给出新列表，写进缓存比「清掉再等下次读时重拉」更省一次请求，
 * 也不会出现「刚加了人、负责人下拉里还没有他」。
 */
export function setMembers(pid, members) {
  if (!pid) return;
  cache.set(pid, Promise.resolve(members || []));
}
