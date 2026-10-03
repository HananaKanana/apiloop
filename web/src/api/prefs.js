import { get, put } from './client';

/**
 * 个人偏好（第七轮第 2 节）：项目分组、收藏、最近打开。
 *
 * 这三项**只属于你自己**，不影响同事，在你登录的设备之间同步；没登录（本机空间）
 * 时也好用，只存在这台电脑，登录后合并上去。接口读写的是当前这台机器上的库
 * （网关上就是本机库），同步由网关的后台同步引擎做，页面不用管。
 */

/** 三个 key 一起拿，没有的给默认空值 */
export function getPrefs() {
  return get('/me/prefs');
}

/**
 * 写一个 key。只认 projectGroups / favorites / recent。
 * 返回理过之后的新值（比如 recent 超过 20 条会被裁掉），页面拿它当准。
 */
export function savePref(key, value) {
  return put('/me/prefs/' + encodeURIComponent(key), { value: value });
}
