/**
 * 表格格子里那种「没有边框的输入框」用的主题覆盖。
 *
 * **为什么必须走 `theme-overrides`**：naive-ui 把 `--n-border` / `--n-color`
 * 这些变量写在组件的**内联样式**上（见 `Input.mjs` 里那个返回 `--n-*` 的对象）。
 * 在样式表里写 `.cell :deep(.n-input) { --n-border: none }`，优先级比内联样式低，
 * 根本盖不住 —— Task 6 就是这么踩的坑：看着像生效了，其实边框一直在。
 * **不要用 `!important`**：那只是把问题藏起来，换一个组件又得再来一次。
 */

/** n-input：没有边框、底色透明、内边距为 0（内边距交给外面的格子） */
export const BARE_INPUT_THEME = {
  border: 'none',
  borderHover: 'none',
  borderFocus: 'none',
  borderDisabled: 'none',
  boxShadowFocus: 'none',
  color: 'transparent',
  colorHover: 'transparent',
  colorFocus: 'transparent',
  colorDisabled: 'transparent',
  paddingSmall: '0'
};

/**
 * n-select：它自己的边框画在内部的 `InternalSelection` 上，
 * 所以覆盖要写进 `peers`，写在最外层是不生效的。
 */
export const BARE_SELECT_THEME = {
  peers: {
    InternalSelection: {
      border: 'none',
      borderHover: 'none',
      borderFocus: 'none',
      borderActive: 'none',
      boxShadowFocus: 'none',
      boxShadowHover: 'none',
      boxShadowActive: 'none',
      color: 'transparent',
      colorActive: 'transparent'
    }
  }
};
