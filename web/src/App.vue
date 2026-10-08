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

// 跟随系统的亮色 / 暗色
const osTheme = useOsTheme();
const theme = computed(() => (osTheme.value === 'dark' ? darkTheme : null));

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

const themeOverrides = computed(() => ({
  ...(osTheme.value === 'dark' ? DARK_OVERRIDES : LIGHT_OVERRIDES),
  Dialog: DIALOG_OVERRIDES
}));
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
    --apiloop-surface: #101014;
    /* 滚动条、原生输入框、选中色这些浏览器自己画的东西也用暗色 */
    color-scheme: dark;
  }
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
