/**
 * 复制文字到剪贴板。
 *
 * `navigator.clipboard` 只在「安全上下文」里有（https 或 127.0.0.1 / localhost）。
 * 直接用 http 打开云端（比如 http://leonaz.top:8765）时它是 undefined，
 * 一调用就报「undefined is not an object」（用户 2026-10-02 遇到）。
 * 那种情况退回老办法：放进一个看不见的输入框、选中、execCommand('copy')。
 *
 * @param {string} text
 * @returns {Promise<void>} 复制不了就 reject
 */
export async function copyText(text) {
  const value = String(text === undefined || text === null ? '' : text);

  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function' && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch (err) {
      // 权限被拒之类：再试一次老办法
    }
  }

  const area = document.createElement('textarea');
  area.value = value;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.top = '-1000px';
  area.style.opacity = '0';
  const active = document.activeElement;
  // 弹窗（naive-ui 的 modal / drawer）会把焦点锁在自己里面：输入框放在 body 上的话，
  // 一选中焦点就被抢回弹窗、选区丢了，复制失败（2026-10-03 用户在分享弹窗里遇到）。
  // 所以放进当前焦点所在的那个弹窗里
  // Safari 点按钮时不把焦点给按钮，从焦点找不到弹窗时，退到页面上最后打开的那个弹窗
  const selector = '[role="dialog"], [aria-modal="true"]';
  const opened = document.querySelectorAll('[aria-modal="true"]');
  const host = (active && typeof active.closest === 'function' && active.closest(selector)) ||
    opened[opened.length - 1] || document.body;
  host.appendChild(area);
  area.focus();
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch (err) {
    ok = false;
  }
  area.remove();
  if (active && typeof active.focus === 'function') active.focus();
  if (!ok) throw new Error('浏览器不允许复制，请手动选中复制');
}
