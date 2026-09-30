<script setup>
import { computed } from 'vue';
import { NEmpty, NIcon, NPopover } from 'naive-ui';
import { Eye } from '@vicons/tabler';
import { useEnvStore } from '@/stores/env';

/**
 * 环境「快速查看」：点一下列出当前环境里的变量名和值（secret 遮住）。
 * 只是看，改还是去环境管理里改。
 */
const envs = useEnvStore();

const rows = computed(function () {
  const env = envs.selected;
  if (!env) return [];
  return (env.variables || []).map(function (row) {
    return {
      key: row.key,
      secret: row.secret === true,
      value: row.secret === true ? '••••' : String(row.value === undefined || row.value === null ? '' : row.value)
    };
  });
});
</script>

<template>
  <n-popover trigger="click" placement="bottom-end" :disabled="!envs.selected">
    <template #trigger>
      <button class="quick-view" :class="{ disabled: !envs.selected }" title="快速查看环境变量">
        <n-icon size="16" :component="Eye" />
      </button>
    </template>

    <div class="panel">
      <div class="title">{{ envs.selected ? envs.selected.name : '' }}</div>
      <div v-if="rows.length" class="rows">
        <div v-for="row in rows" :key="row.key" class="row">
          <span class="key">{{ row.key }}</span>
          <span class="value" :class="{ secret: row.secret }">{{ row.value }}</span>
        </div>
      </div>
      <n-empty v-else size="small" description="这个环境里还没有变量" />
    </div>
  </n-popover>
</template>

<style scoped>
.quick-view {
  width: 26px;
  height: 26px;
  padding: 0;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0.7;
}

.quick-view:hover {
  background: rgba(128, 128, 128, 0.14);
  opacity: 1;
}

.quick-view.disabled {
  opacity: 0.35;
  cursor: default;
}

.panel {
  min-width: 200px;
  max-width: 340px;
}

.title {
  font-size: 12px;
  opacity: 0.6;
  margin-bottom: 6px;
}

.rows {
  max-height: 40vh;
  overflow: auto;
}

.row {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 2px 0;
  font-size: 12px;
}

.key {
  flex: none;
  font-weight: 600;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.value {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.75;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.value.secret {
  letter-spacing: 1px;
}
</style>
