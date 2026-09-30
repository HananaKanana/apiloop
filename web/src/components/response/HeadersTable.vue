<script setup>
import { NEmpty } from 'naive-ui';

/**
 * 响应头表格。headers 是 [[key, value]] 形式，保留原始顺序和重复项
 * （Set-Cookie 可能出现多条，所以不能转成对象）。
 */
defineProps({
  headers: { type: Array, default: function () { return []; } }
});
</script>

<template>
  <div class="headers-table">
    <n-empty v-if="!headers.length" size="small" description="没有响应头" />

    <div v-else class="rows">
      <div v-for="(pair, index) in headers" :key="index" class="row">
        <div class="key">{{ pair[0] }}</div>
        <div class="value">{{ pair[1] }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.rows {
  border: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.24));
  border-radius: 6px;
  overflow: hidden;
}

.row {
  display: flex;
  gap: 10px;
  padding: 5px 10px;
  border-bottom: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.16));
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.row:last-child {
  border-bottom: none;
}

.key {
  flex: 0 0 32%;
  color: #2080f0;
  word-break: break-all;
}

.value {
  flex: 1;
  min-width: 0;
  word-break: break-all;
  opacity: 0.85;
}
</style>
