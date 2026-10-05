import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import router from './router';
import { i18n } from './i18n';

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

createApp(App).use(createPinia()).use(i18n).use(router).mount('#app');
