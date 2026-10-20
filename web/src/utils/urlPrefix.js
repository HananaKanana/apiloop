/**
 * OpenAPI 导入的地址前缀（用户 2026-10-20：导进来的地址是光秃秃的 `/login`，想统一加 `{{host}}`）。
 *
 * 默认 `{{host}}`，改过就记住（每台电脑 / 每个浏览器各自记，localStorage `apiloop.openapi.urlPrefix`）。
 * 清空也记住 —— 那就是「不加前缀」。导入页和「从 OpenAPI 同步更新」共用这一份。
 */

const STORAGE_KEY = 'apiloop.openapi.urlPrefix';
export const DEFAULT_URL_PREFIX = '{{host}}';

export function readUrlPrefix() {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === null ? DEFAULT_URL_PREFIX : value;
  } catch (err) {
    return DEFAULT_URL_PREFIX;
  }
}

export function saveUrlPrefix(value) {
  try {
    localStorage.setItem(STORAGE_KEY, String(value || '').trim());
  } catch (err) {
    // 存不下就只在这次生效
  }
}

/** 前缀里引用的变量名：`{{host}}` → `host`；不是变量开头的（写死的地址、空）返回空串 */
export function prefixVariable(prefix) {
  const match = /^\s*\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/.exec(String(prefix || ''));
  return match ? match[1] : '';
}
