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
  document.body.appendChild(area);
  const active = document.activeElement;
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
