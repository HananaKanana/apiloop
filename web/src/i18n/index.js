/**
 * 前端国际化（第十五轮）。
 *
 * 约定（细节见同目录 README.md）：
 * - 按区域拆文件放在 `locales/<语言>/<区域>.js`，这个文件用 glob 收集成
 *   `{ 'zh-CN': { layout: {...}, ... }, en: {...} }`，键就是 `t('<区域>.<键>')`；
 * - 组件里 `const { t } = useI18n()`；store / 工具函数 / 非组件代码用这里导出的 `t`；
 * - 切换语言用 `setLocale()`，它会同时写 localStorage 和 `<html lang>`。
 *
 * 语言先做中文（zh-CN）和英文（en）两种：第一次打开按浏览器语言判断（`zh*` → 中文，
 * 其余英文），用户在头像菜单里手动选过之后就以选的那个为准，记在 localStorage。
 */

import { createI18n } from 'vue-i18n';

/** 支持的语言，顺序就是头像菜单里的顺序 */
export const LOCALES = ['zh-CN', 'en'];

/** 头像菜单里显示的名字（语言名用各自的语言写，不翻译） */
export const LOCALE_LABELS = {
  'zh-CN': '中文',
  en: 'English'
};

/** 认不出语言时的兜底：和 vue-i18n 的 fallbackLocale 一致 */
export const DEFAULT_LOCALE = 'zh-CN';

/** localStorage 的键名。前端界面状态都叫 `apiloop.*`（见 web/README.md） */
const STORAGE_KEY = 'apiloop.locale';

/**
 * 把 `locales/<语言>/<区域>.js` 收成 vue-i18n 要的 messages。
 * 区域名就是文件名（区域名 → 目录名一一对应），所以 `locales/zh-CN/layout.js` 里的键
 * 在组件里写 `t('layout.xxx')`。
 *
 * 用 glob 而不是手写 import：后面 T21–T25 各自往自己区域的目录里加文件，
 * 互不打扰，也不用改这个文件。
 */
function collectMessages() {
  const modules = import.meta.glob('./locales/*/*.js', { eager: true });
  const messages = {};

  Object.keys(modules).forEach(function (path) {
    const match = /^\.\/locales\/([^/]+)\/([^/]+)\.js$/.exec(path);
    if (!match) return;

    const locale = match[1];
    const region = match[2];
    const mod = modules[path];
    const content = mod && mod.default ? mod.default : {};

    if (!messages[locale]) messages[locale] = {};
    messages[locale][region] = content;
  });

  return messages;
}

/**
 * 读用户上次选的语言。localStorage 在隐私模式 / 被禁用时会抛异常，所以包了 try/catch ——
 * 读不到就当作没选过，回到浏览器语言。
 */
function readStoredLocale() {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    if (value && LOCALES.indexOf(value) > -1) return value;
  } catch (err) {
    // 拿不到 localStorage：不记也没关系，下次还是按浏览器语言
  }
  return null;
}

/** 第一次打开：浏览器语言是 `zh` 打头的用中文，其余英文 */
export function detectLocale() {
  const stored = readStoredLocale();
  if (stored) return stored;

  if (typeof navigator === 'undefined') return DEFAULT_LOCALE;
  const lang = String(navigator.language || navigator.userLanguage || '').toLowerCase();
  return lang.indexOf('zh') === 0 ? 'zh-CN' : 'en';
}

export const i18n = createI18n({
  legacy: false,
  locale: detectLocale(),
  fallbackLocale: DEFAULT_LOCALE,
  // 有些文案里本来就带尖括号（比如 mock 前缀的 `<项目ID>`），不是 HTML，别每次用到都警告
  warnHtmlMessage: false,
  messages: collectMessages()
});

/**
 * 给非组件代码用的翻译函数：store、工具函数、api 层拿不到 `useI18n()`。
 * `i18n.global.t` 是响应式的（依赖当前 locale）。
 */
export const t = i18n.global.t;

/** 当前语言（`'zh-CN'` / `'en'`） */
export function currentLocale() {
  return i18n.global.locale.value;
}

/** 把 `<html lang>` 改成当前语言（无障碍和浏览器翻译靠它） */
function syncDocumentLang() {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('lang', currentLocale());
}

/**
 * 切换语言：立刻生效（不刷新页面），写 localStorage，改 `<html lang>`。
 * 传不认识的语言就忽略（调用方基本只会从 LOCALES 里选）。
 */
export function setLocale(locale) {
  if (LOCALES.indexOf(locale) === -1) return;
  i18n.global.locale.value = locale;

  try {
    window.localStorage.setItem(STORAGE_KEY, locale);
  } catch (err) {
    // 写不进去也不影响这次切换，只是下次打开要重新判断
  }

  syncDocumentLang();
}

// 启动时把 index.html 里写死的 lang="zh-CN" 纠正是实际语言
syncDocumentLang();
