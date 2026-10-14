import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import router from './router';
import { createDiscreteApi } from 'naive-ui';
import { i18n, t } from './i18n';

/**
 * 整个页面不弹浏览器自带的右键菜单（返回 / 重新加载 / 检查元素那一套），用户 2026-09-30 要求。
 * 需要右键的地方（目录树、标签页、环境列表）各自弹自己的菜单，并且会先 preventDefault。
 *
 * 例外：输入框、文本框和代码编辑器里保留原生菜单 —— 那里的右键是拿来复制 / 粘贴的，
 * 拦掉就只能靠快捷键了。
 */
document.addEventListener('contextmenu', function (event) {
  const target = event.target;
  if (target && target.closest && target.closest('input, textarea, [contenteditable="true"], .cm-editor')) return;
  event.preventDefault();
});

/**
 * 标出是不是 Mac（`<html data-os="mac">`），给全局样式用：
 * Windows 上原生滚动条又宽又带上下箭头（用户 2026-10-09 嫌丑），App.vue 里换成细的圆角滚动条；
 * Mac 自己的是悬浮隐藏式的，不动它。
 */
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
document.documentElement.setAttribute('data-os', isMac ? 'mac' : 'other');

/**
 * 按需加载的那几块（router.js、WorkbenchView.vue）文件名带哈希。云端升级以后，
 * 一直开着的旧页面再去要旧文件就 404 了 —— Vite 这时会发 `vite:preloadError`。
 * 刷新一次拿新页面；1 分钟内刷过就不再刷，免得真断网时来回刷个不停。
 */
window.addEventListener('vite:preloadError', function (event) {
  try {
    const last = Number(sessionStorage.getItem('apiloop.chunkReload')) || 0;
    if (Date.now() - last < 60 * 1000) return;
    sessionStorage.setItem('apiloop.chunkReload', String(Date.now()));
  } catch (err) {
    // 存不了就直接刷
  }
  event.preventDefault();
  window.location.reload();
});

const app = createApp(App);

/**
 * 全局兜底（用户 2026-10-13）：组件渲染、生命周期、事件处理里抛出的错误，Vue 默认只打到控制台，
 * 界面上那一块就安安静静地坏掉了（2026-10-09 铃铛：文案编译报错，弹框闪一下就没了、再也点不开，
 * 用户看不出发生了什么）。这里弹一条提示，错误照样打到控制台方便排查。
 *
 * 同一条错误 5 秒内只提示一次 —— 渲染报错常常一口气连着抛好几遍。
 * 提示用 createDiscreteApi：这里在 App 外面，拿不到 App 里的 NMessageProvider。
 */
let discrete = null;
let lastError = { text: '', at: 0 };

app.config.errorHandler = function (err, instance, info) {
  console.error('[apiloop] ' + info, err);
  const text = String((err && err.message) || err || '').split('\n')[0].slice(0, 200);
  const now = Date.now();
  if (text === lastError.text && now - lastError.at < 5000) return;
  lastError = { text: text, at: now };
  try {
    if (!discrete) discrete = createDiscreteApi(['message']);
    discrete.message.error(t('app.uiError', { message: text }), { duration: 8000, closable: true });
  } catch (e) {
    // 提示本身都弹不出来就算了，控制台里已经有了
  }
};

app.use(createPinia()).use(i18n).use(router).mount('#app');
