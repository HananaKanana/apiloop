/**
 * 本机 apiloop **没登录时，每次打开先看登录页**（用户 2026-10-01：「没登录按道理先应该是
 * 登录页面，现在还是直接进本地的页面了」）。
 *
 * 在网关上，没登录时本机空间也自带一个本机身份，路由守卫看到「已登录」就直接进工作台了，
 * 所以要单独拦一下。点了「不登录，继续在本机使用」（或者登录成功）之后，**这一次打开**
 * 就不再拦；下次重新打开 apiloop、还是没登录，就再看一次登录页。
 *
 * 存在 sessionStorage：壳子的窗口关掉、页面重新打开就清空，正好是「这一次打开」。
 */
const KEY = 'apiloop.loginChoiceMade';

export function hasChosen() {
  try {
    return sessionStorage.getItem(KEY) === '1';
  } catch (err) {
    return true;   // 存储不可用时别把人卡在登录页
  }
}

export function markChosen() {
  try {
    sessionStorage.setItem(KEY, '1');
  } catch (err) {
    // 存不下就是这次打开里会多看一次登录页，不影响使用
  }
}
