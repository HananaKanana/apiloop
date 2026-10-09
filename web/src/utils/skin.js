import { ref } from 'vue';

/**
 * 界面皮肤（用户 2026-10-09）。
 *
 * - `classic`：原来的样子（橙色主色，跟随系统亮色 / 暗色）；
 * - `island`：「小岛」皮肤 —— 照着 animal-island-ui 的设计规范（暖色羊皮纸底、大地棕文字、
 *   薄荷绿主色、药丸形按钮、圆体字）做的。那个库是 React 组件，这里是 Vue + naive-ui，
 *   所以只借它的设计规范（颜色、圆角、字体、动效），落在 naive-ui 的主题覆盖和 `--apiloop-*` 变量上。
 *   它只有亮色一套，选了它就不跟随系统暗色。
 *
 * 选择记在 localStorage（`apiloop.skin`，每台电脑 / 每个浏览器各自记），
 * 当前皮肤同时写到 `<html data-skin="…">` 上，全局样式按它切换（见 App.vue）。
 */

export const SKINS = ['classic', 'island'];
export const DEFAULT_SKIN = 'classic';

const STORAGE_KEY = 'apiloop.skin';

function readSkin() {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return SKINS.indexOf(value) > -1 ? value : DEFAULT_SKIN;
  } catch (err) {
    return DEFAULT_SKIN;
  }
}

/** 当前皮肤（响应式）。App.vue 读它切主题，头像菜单改它 */
export const skin = ref(readSkin());

function applyToDocument(value) {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-skin', value);
}

applyToDocument(skin.value);

export function setSkin(value) {
  const next = SKINS.indexOf(value) > -1 ? value : DEFAULT_SKIN;
  skin.value = next;
  applyToDocument(next);
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch (err) {
    // 存不下就只在这次生效
  }
}
