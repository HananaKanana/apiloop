<script setup>
import { computed } from 'vue';
import {
  NConfigProvider,
  NDialogProvider,
  NMessageProvider,
  NNotificationProvider,
  darkTheme,
  dateZhCN,
  useOsTheme,
  zhCN
} from 'naive-ui';

// 跟随系统的亮色 / 暗色
const osTheme = useOsTheme();
const theme = computed(() => (osTheme.value === 'dark' ? darkTheme : null));

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

const themeOverrides = computed(() => (osTheme.value === 'dark' ? DARK_OVERRIDES : LIGHT_OVERRIDES));
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
    :locale="zhCN"
    :date-locale="dateZhCN"
  >
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
