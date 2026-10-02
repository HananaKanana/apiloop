<script setup>
import { computed } from 'vue';
import Handlebars from 'handlebars';

/**
 * 「可视化」页签（参考 Postman 的 Visualize）：测试脚本里 `pm.visualizer.set(模板, 数据)`，
 * 这里用 Handlebars 把模板和数据渲染成 HTML，放进 iframe 显示。
 *
 * iframe 是 `sandbox="allow-scripts"`、**不带 allow-same-origin**：模板里的脚本（画图表常用）
 * 能跑，但它在一个不透明的源里，碰不到管理台的页面、Cookie 和存储。
 * 和 Postman 一样，页面里的脚本可以用 `pm.getData(function (err, data) {})` 拿到数据。
 */
const props = defineProps({
  visualizer: { type: Object, required: true }
});

/** 放进 <script> 里的 JSON：把 `</` 拆开，免得数据里的「结束 script 标签」提前结束脚本 */
function inlineJson(value) {
  return JSON.stringify(value === undefined ? null : value).replace(/<\//g, '<\\/');
}

const rendered = computed(function () {
  const data = props.visualizer.data;
  let html;
  try {
    html = Handlebars.compile(String(props.visualizer.template || ''))(data);
  } catch (err) {
    return { error: '模板渲染失败：' + err.message };
  }

  const bootstrap = '<script>window.pm = { getData: function (callback) { callback(null, ' +
    inlineJson(data) + '); } };<\/script>';
  return { html: '<!DOCTYPE html><html><head><meta charset="utf-8">' + bootstrap + '</head><body>' + html + '</body></html>' };
});
</script>

<template>
  <div class="visualizer">
    <div v-if="rendered.error" class="error">{{ rendered.error }}</div>
    <iframe v-else class="frame" sandbox="allow-scripts" :srcdoc="rendered.html" />
  </div>
</template>

<style scoped>
.visualizer {
  height: 100%;
  min-height: 0;
  display: flex;
}

.frame {
  flex: 1;
  width: 100%;
  min-height: 320px;
  border: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.24));
  border-radius: 6px;
  background: #fff;
}

.error {
  font-size: 12px;
  color: #d03050;
}
</style>
