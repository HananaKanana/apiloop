<script setup>
import { NIcon, NTooltip } from 'naive-ui';
import { Folder, History, Variable } from '@vicons/tabler';
import { useUiStore } from '@/stores/ui';
import ApiTree from '@/components/tree/ApiTree.vue';
import EnvList from '@/components/env/EnvList.vue';
import HistoryPanel from '@/components/history/HistoryPanel.vue';

/**
 * 左侧栏：最上面一排图标页签（目录 / 环境 / 历史），下面是对应的内容。
 * 选中的是哪一页存在 ui store 里（并写进 localStorage），刷新后还在原来那页。
 */
const ui = useUiStore();

const TABS = [
  { key: 'tree', label: '目录', icon: Folder },
  { key: 'env', label: '环境', icon: Variable },
  { key: 'history', label: '历史', icon: History }
];

const emit = defineEmits(['open', 'new-api', 'new-ws', 'open-folder', 'import']);
</script>

<template>
  <div class="sidebar">
    <div class="rail">
      <n-tooltip v-for="tab in TABS" :key="tab.key" trigger="hover" placement="bottom">
        <template #trigger>
          <button
            class="rail-item"
            :class="{ active: ui.sidebarTab === tab.key }"
            @click="ui.setSidebarTab(tab.key)"
          >
            <n-icon size="16" :component="tab.icon" />
          </button>
        </template>
        {{ tab.label }}
      </n-tooltip>
    </div>

    <div class="panel">
      <api-tree
        v-show="ui.sidebarTab === 'tree'"
        @open="(api) => emit('open', api)"
        @new-api="(folderId) => emit('new-api', folderId)"
        @new-ws="emit('new-ws')"
        @open-folder="(folderId) => emit('open-folder', folderId)"
        @import="emit('import')"
      />
      <env-list v-if="ui.sidebarTab === 'env'" />
      <history-panel v-if="ui.sidebarTab === 'history'" />
    </div>
  </div>
</template>

<style scoped>
.sidebar {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

/* 最上面一排图标页签：选中的那一个用浅灰底 */
.rail {
  flex: none;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px 6px;
}

.rail-item {
  width: 28px;
  height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  opacity: 0.7;
  cursor: pointer;
  padding: 0;
}

.rail-item:hover {
  background: rgba(128, 128, 128, 0.12);
  opacity: 1;
}

.rail-item.active {
  background: rgba(128, 128, 128, 0.2);
  opacity: 1;
}

.panel {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.panel > * {
  flex: 1;
  min-height: 0;
}
</style>
