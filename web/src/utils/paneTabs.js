import { computed } from 'vue';
import { useOsTheme } from 'naive-ui';

/**
 * 功能页签（Params / Headers / Body …）的主题覆盖，**三处共用**：
 * 请求区、响应区、WebSocket 页 —— 之前是三种样子。
 *
 * 为什么必须走 `theme-overrides`：naive-ui 把这些变量写在组件的**内联样式**上，
 * 在样式表里改 `--n-tab-gap` 是盖不住的（Task 6 在表格上踩过同一个坑）。
 *
 * naive-ui 的 line 型页签默认间距是 `tabGapSmallLine: 36px`、字号 14px，
 * 整排会拉得很散、字也比界面其它地方大一号。这里收到 20px / 13px。
 *
 * 暗色下文字颜色不一样，所以和 `App.vue` 一样按 `useOsTheme()` 取一份。
 * 下划线用 `var(--apiloop-primary)`：那是 `App.vue` 里定义的主色变量，
 * 亮暗两套已经各自定好，这里跟着走就行。
 */

const LIGHT = {
  tabGapSmallLine: '20px',
  tabFontSizeSmall: '13px',
  tabPaddingSmallLine: '8px 0',
  tabFontWeightActive: '600',
  // 未选中：次要颜色；悬停和选中都用正文颜色
  tabTextColorLine: 'rgba(51, 54, 57, 0.62)',
  tabTextColorHoverLine: '#333639',
  tabTextColorActiveLine: '#333639',
  barColor: 'var(--apiloop-primary)',
  tabBorderColor: 'rgba(128, 128, 128, 0.24)'
};

const DARK = {
  tabGapSmallLine: '20px',
  tabFontSizeSmall: '13px',
  tabPaddingSmallLine: '8px 0',
  tabFontWeightActive: '600',
  tabTextColorLine: 'rgba(255, 255, 255, 0.52)',
  tabTextColorHoverLine: 'rgba(255, 255, 255, 0.9)',
  tabTextColorActiveLine: 'rgba(255, 255, 255, 0.9)',
  barColor: 'var(--apiloop-primary)',
  tabBorderColor: 'rgba(255, 255, 255, 0.24)'
};

/** 在 setup 里调一次，把结果传给 `<n-tabs :theme-overrides="...">` */
export function usePaneTabsTheme() {
  const osTheme = useOsTheme();
  return computed(function () {
    return osTheme.value === 'dark' ? DARK : LIGHT;
  });
}
