<script setup>
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  NConfigProvider,
  NDialogProvider,
  NGlobalStyle,
  NMessageProvider,
  NNotificationProvider,
  darkTheme,
  dateEnUS,
  dateZhCN,
  useOsTheme,
  enUS,
  zhCN
} from 'naive-ui';
import '@fontsource-variable/nunito';
import { skin } from '@/utils/skin';

// 跟随系统的亮色 / 暗色。「小岛」皮肤只有亮色一套，选了它就不跟随系统（见 utils/skin.js）
const osTheme = useOsTheme();
const isIsland = computed(() => skin.value === 'island');
const theme = computed(() => (!isIsland.value && osTheme.value === 'dark' ? darkTheme : null));

/**
 * 界面语言（第十五轮）。`locale` 是 vue-i18n 的全局 locale，头像菜单里切换后这里跟着变，
 * naive-ui 内置组件（日期选择、分页、空状态……）的文案也跟着切。
 */
const { locale } = useI18n();
const naiveLocale = computed(() => (locale.value === 'en' ? enUS : zhCN));
const naiveDateLocale = computed(() => (locale.value === 'en' ? dateEnUS : dateZhCN));

/**
 * 主色用 Postman 橙（用户 2026-09-30 选定），替换 naive-ui 默认的绿色。
 * 选中的页签、勾选框、按钮、目录树的选中行都从主色派生，所以只改这一处。
 * 暗色主题下用亮一档的橙，否则在深底上发闷。
 */
const LIGHT_OVERRIDES = {
  common: {
    primaryColor: '#ff6c37',
    primaryColorHover: '#ff8559',
    primaryColorPressed: '#e5562a',
    primaryColorSuppl: '#ff8559'
  }
};

const DARK_OVERRIDES = {
  common: {
    primaryColor: '#ff7a4d',
    primaryColorHover: '#ff9470',
    primaryColorPressed: '#e5623a',
    primaryColorSuppl: '#ff9470'
  }
};

/**
 * 确认框（useDialog）：标题小一号、四周留白匀一点、圆角大一点。
 * 图标和按钮样式在 utils/dialog.js 里统一（用户 2026-10-02 嫌「清空历史」框丑）。
 */
const DIALOG_OVERRIDES = {
  titleFontSize: '16px',
  padding: '20px 24px',
  contentMargin: '10px 0 22px 0',
  borderRadius: '10px',
  closeMargin: '18px 20px 0 0'
};

/**
 * 「小岛」皮肤（用户 2026-10-09）：照着 animal-island-ui 的设计规范 ——
 * 暖色羊皮纸底（不用冷灰）、大地棕文字（不用纯黑）、薄荷绿主色、按钮是药丸形、
 * 输入框聚焦是黄色（不用冷蓝）、圆角都不小于 12px、Nunito 圆体字、`cubic-bezier(0.4, 0, 0.2, 1)` 的动效。
 * 主按钮的「游戏按钮」立体阴影在下面的全局样式里（naive-ui 的主题变量管不到 box-shadow）。
 */
const ISLAND_FONT = "'Nunito Variable', Nunito, 'Noto Sans SC', -apple-system, 'PingFang SC', " +
  "'Hiragino Sans GB', 'Microsoft YaHei', sans-serif";

const ISLAND_FOCUS = '1px solid #ffcc00';
const ISLAND_FOCUS_SHADOW = '0 0 0 2px rgba(255, 204, 0, 0.28)';

const ISLAND_OVERRIDES = {
  common: {
    primaryColor: '#19c8b9',
    primaryColorHover: '#3dd4c6',
    primaryColorPressed: '#11a89b',
    primaryColorSuppl: '#3dd4c6',
    infoColor: '#19c8b9',
    infoColorHover: '#3dd4c6',
    infoColorPressed: '#11a89b',
    infoColorSuppl: '#3dd4c6',
    successColor: '#6fba2c',
    successColorHover: '#82c944',
    successColorPressed: '#5a9e1e',
    successColorSuppl: '#82c944',
    warningColor: '#f5c31c',
    warningColorHover: '#f7cf45',
    warningColorPressed: '#d9aa0c',
    warningColorSuppl: '#f7cf45',
    errorColor: '#e05a5a',
    errorColorHover: '#e77373',
    errorColorPressed: '#c94646',
    errorColorSuppl: '#e77373',
    textColorBase: '#794f27',
    textColor1: '#794f27',
    textColor2: '#725d42',
    textColor3: '#9f927d',
    textColorDisabled: '#c4b89e',
    placeholderColor: '#b3a68c',
    placeholderColorDisabled: '#c4b89e',
    iconColor: '#9f927d',
    iconColorHover: '#794f27',
    iconColorPressed: '#725d42',
    bodyColor: '#f8f8f0',
    cardColor: '#fffdf5',
    modalColor: '#fffdf5',
    popoverColor: '#fffdf5',
    tableColor: '#fffdf5',
    tableHeaderColor: 'rgb(247, 243, 223)',
    tableColorHover: 'rgba(196, 184, 158, 0.14)',
    tableColorStriped: 'rgba(247, 243, 223, 0.6)',
    inputColor: '#fffdf5',
    inputColorDisabled: '#f0ece2',
    actionColor: 'rgb(247, 243, 223)',
    tagColor: 'rgb(247, 243, 223)',
    codeColor: 'rgb(247, 243, 223)',
    borderColor: '#c4b89e',
    dividerColor: 'rgba(196, 184, 158, 0.45)',
    hoverColor: 'rgba(196, 184, 158, 0.22)',
    pressedColor: 'rgba(196, 184, 158, 0.32)',
    scrollbarColor: 'rgba(159, 146, 125, 0.35)',
    scrollbarColorHover: 'rgba(159, 146, 125, 0.55)',
    boxShadow1: '0 1px 2px -2px rgba(121, 79, 39, 0.1), 0 3px 6px 0 rgba(121, 79, 39, 0.08)',
    boxShadow2: '0 3px 6px -4px rgba(121, 79, 39, 0.14), 0 6px 16px 0 rgba(121, 79, 39, 0.1)',
    boxShadow3: '0 6px 16px -9px rgba(121, 79, 39, 0.16), 0 9px 28px 0 rgba(121, 79, 39, 0.1)',
    borderRadius: '12px',
    borderRadiusSmall: '10px',
    fontFamily: ISLAND_FONT,
    fontWeight: '500',
    fontWeightStrong: '700',
    cubicBezierEaseInOut: 'cubic-bezier(0.4, 0, 0.2, 1)'
  },
  Button: {
    borderRadiusTiny: '50px',
    borderRadiusSmall: '50px',
    borderRadiusMedium: '50px',
    borderRadiusLarge: '50px',
    fontWeight: '600'
  },
  Input: {
    borderRadius: '12px',
    borderHover: '1px solid #a89878',
    borderFocus: ISLAND_FOCUS,
    boxShadowFocus: ISLAND_FOCUS_SHADOW,
    caretColor: '#794f27'
  },
  InternalSelection: {
    borderRadius: '12px',
    borderHover: '1px solid #a89878',
    borderFocus: ISLAND_FOCUS,
    borderActive: ISLAND_FOCUS,
    boxShadowFocus: ISLAND_FOCUS_SHADOW,
    boxShadowActive: ISLAND_FOCUS_SHADOW,
    caretColor: '#794f27'
  },
  Tag: { borderRadius: '12px' },
  Card: { borderRadius: '18px' },
  Drawer: { color: '#fffdf5' },
  Dialog: { ...DIALOG_OVERRIDES, borderRadius: '24px' }
};

const themeOverrides = computed(() => {
  if (isIsland.value) return ISLAND_OVERRIDES;
  return {
    ...(osTheme.value === 'dark' ? DARK_OVERRIDES : LIGHT_OVERRIDES),
    Dialog: DIALOG_OVERRIDES
  };
});
</script>

<template>
  <!--
    abstract：不渲染外层的包裹 div。那个 div 没有高度，会把 html → body → #app → 页面
    这条 height: 100% 链截断，工作台就被目录树撑高、整页一起滚动，右半边跟着滚没了。
  -->
  <n-config-provider
    abstract
    :theme="theme"
    :theme-overrides="themeOverrides"
    :locale="naiveLocale"
    :date-locale="naiveDateLocale"
  >
    <!--
      页面底色和文字颜色跟着主题走（body 上）。config-provider 是 abstract 的，不会自己渲染
      带底色的外层 div —— 没有这一行时暗色主题下文字变白、底还是浏览器默认的白，什么都看不见
      （2026-10-08 用户反馈）。
    -->
    <n-global-style />
    <n-message-provider>
      <n-dialog-provider>
        <n-notification-provider>
          <router-view />
        </n-notification-provider>
      </n-dialog-provider>
    </n-message-provider>
  </n-config-provider>
</template>

<style>
/*
 * 组件外面的自定义样式（顶部标签页下划线、分栏拖动条、输入框聚焦边框等）拿不到
 * naive-ui 的 --n-primary-color —— 那个变量只在它自己的组件里有 —— 所以这里另外
 * 定义一份，和上面 themeOverrides 的主色保持一致。
 */
:root {
  --apiloop-primary: #ff6c37;
  /* 主色的 r, g, b，给半透明的浅底用：rgba(var(--apiloop-primary-rgb), 0.1) */
  --apiloop-primary-rgb: 255, 108, 55;
  /* 页面底色。需要「不透明底」的地方（吸顶的表头等）用它 ——
     不要用 var(--n-color)：它会从外层的 naive-ui 组件继承到别的颜色（比如主色橙） */
  --apiloop-surface: #ffffff;
  /* 分隔线：平时 / 悬停或拖动时 */
  --apiloop-divider: rgba(128, 128, 128, 0.2);
  --apiloop-divider-active: rgba(128, 128, 128, 0.55);
}

@media (prefers-color-scheme: dark) {
  :root {
    --apiloop-primary: #ff7a4d;
    --apiloop-primary-rgb: 255, 122, 77;
    --apiloop-surface: #101014;
    /* 滚动条、原生输入框、选中色这些浏览器自己画的东西也用暗色 */
    color-scheme: dark;
  }
}

/*
 * 「小岛」皮肤（见 utils/skin.js）。写成 :root[data-skin] 是为了压过上面暗色 media 里的 :root ——
 * 它只有亮色一套，系统是暗色也照样用亮色。
 */
:root[data-skin='island'] {
  --apiloop-primary: #19c8b9;
  --apiloop-primary-rgb: 25, 200, 185;
  --apiloop-surface: #f8f8f0;
  --apiloop-divider: rgba(196, 184, 158, 0.45);
  --apiloop-divider-active: rgba(168, 152, 120, 0.85);
  color-scheme: light;
}

:root[data-skin='island'] body {
  font-family: 'Nunito Variable', Nunito, 'Noto Sans SC', -apple-system, 'PingFang SC',
    'Hiragino Sans GB', 'Microsoft YaHei', sans-serif;
  font-weight: 500;
}

/*
 * 主按钮的「游戏按钮」立体感：底下一层深一档的实色阴影，按下去往下沉。
 * **只给实心的主按钮 / 危险按钮**：naive-ui 的扁平按钮（quaternary / tertiary / text）
 * 没有单独的类名，但它们的底色变量 --n-color 是透明的 —— 按内联样式里的 --n-color 认实心按钮。
 */
:root[data-skin='island'] .n-button[style*='--n-color: #19c8b9']:not(.n-button--disabled),
:root[data-skin='island'] .n-button[style*='--n-color: #e05a5a']:not(.n-button--disabled) {
  transition: transform 0.15s cubic-bezier(0.4, 0, 0.2, 1), box-shadow 0.15s cubic-bezier(0.4, 0, 0.2, 1);
}

:root[data-skin='island'] .n-button[style*='--n-color: #19c8b9']:not(.n-button--disabled) {
  box-shadow: 0 4px 0 #11a89b;
}

:root[data-skin='island'] .n-button[style*='--n-color: #e05a5a']:not(.n-button--disabled) {
  box-shadow: 0 4px 0 #c94646;
}

:root[data-skin='island'] .n-button[style*='--n-color: #19c8b9']:not(.n-button--disabled):active {
  transform: translateY(2px);
  box-shadow: 0 2px 0 #11a89b;
}

:root[data-skin='island'] .n-button[style*='--n-color: #e05a5a']:not(.n-button--disabled):active {
  transform: translateY(2px);
  box-shadow: 0 2px 0 #c94646;
}

html,
body,
#app {
  height: 100%;
  margin: 0;
  padding: 0;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC',
    'Hiragino Sans GB', 'Microsoft YaHei', sans-serif;
}
</style>
