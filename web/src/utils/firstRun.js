/**
 * 本机 apiloop 第一次打开时先看登录页（用户 2026-10-01：「安装完进去不是登录页面，
 * 直接就是未登录状态」）。
 *
 * 在网关上，未绑定空间本来就自带一个本机身份，路由守卫看到「已登录」就直接进工作台了。
 * 这里记一笔「这台电脑上已经选过了」：点过「不登录，继续在本机使用」或者登录过一次，
 * 以后打开就直接进工作台，不再每次都停在登录页。
 *
 * 存在 localStorage：网关页面的源固定是 127.0.0.1:<端口>，壳子的数据目录是持久的；
 * 万一被清掉，也只是再看一次登录页。
 */
const KEY = 'apiloop.firstRunChosen';

export function hasChosen() {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch (err) {
    return true;   // 存储不可用时别把人卡在登录页
  }
}

export function markChosen() {
  try {
    localStorage.setItem(KEY, '1');
  } catch (err) {
    // 存不下就下次再看一次登录页，不影响使用
  }
}
