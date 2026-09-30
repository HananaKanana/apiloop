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
</script>

<template>
  <!--
    abstract：不渲染外层的包裹 div。那个 div 没有高度，会把 html → body → #app → 页面
    这条 height: 100% 链截断，工作台就被目录树撑高、整页一起滚动，右半边跟着滚没了。
  -->
  <n-config-provider abstract :theme="theme" :locale="zhCN" :date-locale="dateZhCN">
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
