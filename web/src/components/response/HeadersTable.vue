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
      <div class="row head">
        <div class="key">名称</div>
        <div class="value">值</div>
      </div>
      <div v-for="(pair, index) in headers" :key="index" class="row">
        <div class="key">{{ pair[0] }}</div>
        <div class="value">{{ pair[1] }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 和请求区那些键值表格同一套细线网格（这里只读，所以没有输入框和删除按钮） */
.rows {
  border: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.24));
  border-radius: 4px;
  overflow: hidden;
}

.row {
  display: grid;
  grid-template-columns: minmax(0, 30%) minmax(0, 1fr);
  border-bottom: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.16));
}

.row:last-child {
  border-bottom: none;
}

.row:hover {
  background: rgba(128, 128, 128, 0.06);
}

.row.head {
  background: rgba(128, 128, 128, 0.08);
  font-size: 12px;
}

.key,
.value {
  min-width: 0;
  display: flex;
  align-items: center;
  min-height: 30px;
  padding: 0 8px;
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  word-break: break-all;
}

.key {
  border-right: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.16));
  color: #097bed;
}

.row.head .key,
.row.head .value {
  font-family: inherit;
  color: inherit;
  opacity: 0.6;
}

.value {
  opacity: 0.85;
}
</style>
