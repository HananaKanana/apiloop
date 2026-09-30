<script setup>
import { NIcon, NTooltip } from 'naive-ui';
import {
  Folder,
  History,
  LayoutSidebarLeftCollapse,
  LayoutSidebarLeftExpand,
  Variable
} from '@vicons/tabler';
import { useUiStore } from '@/stores/ui';
import ApiTree from '@/components/tree/ApiTree.vue';
import EnvList from '@/components/env/EnvList.vue';
import HistoryPanel from '@/components/history/HistoryPanel.vue';

/**
 * 左侧栏：最上面一排图标页签（目录 / 环境 / 历史），下面是对应的内容，
 * 最底下是展开 / 收起的开关。
 *
 * 收起之后不是整块消失，而是缩成一条 40px 的图标栏（和 Postman 一样）：
 * 图标竖排，点任意一个会展开侧栏并切到那一页；开关留在最底下，
 * 和展开时是同一个位置 —— 免得像之前那样浮在内容区上压住第一个标签页。
 */
const props = defineProps({
  collapsed: { type: Boolean, default: false }
});

const ui = useUiStore();

const TABS = [
  { key: 'tree', label: '目录', icon: Folder },
  { key: 'env', label: '环境', icon: Variable },
  { key: 'history', label: '历史', icon: History }
];

const emit = defineEmits(['open', 'new-api', 'new-ws', 'open-folder', 'import', 'toggle']);

function onTabClick(key) {
  ui.setSidebarTab(key);
  // 收起状态下点图标：顺手把侧栏展开，不然点了看不到东西
  if (props.collapsed) emit('toggle');
}
</script>

<template>
  <div class="sidebar" :class="{ collapsed: collapsed }">
    <div class="rail" :class="{ vertical: collapsed }">
      <n-tooltip
        v-for="tab in TABS"
        :key="tab.key"
        trigger="hover"
        :placement="collapsed ? 'right' : 'bottom'"
      >
        <template #trigger>
          <button
            class="rail-item"
            :class="{ active: ui.sidebarTab === tab.key }"
            @click="onTabClick(tab.key)"
          >
            <n-icon size="16" :component="tab.icon" />
          </button>
        </template>
        {{ tab.label }}
      </n-tooltip>
    </div>

    <div v-show="!collapsed" class="panel">
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

    <!-- 展开 / 收起：两种状态都在最底下，位置一样 -->
    <button
      class="toggle"
      :title="collapsed ? '展开侧栏（⌘\）' : '收起侧栏（⌘\）'"
      @click="emit('toggle')"
    >
      <n-icon size="16" :component="collapsed ? LayoutSidebarLeftExpand : LayoutSidebarLeftCollapse" />
    </button>
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

/* 收起时竖排 */
.rail.vertical {
  flex-direction: column;
  gap: 2px;
  padding: 6px 0;
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

.toggle {
  flex: none;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  border-top: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.16));
  background: transparent;
  color: inherit;
  opacity: 0.55;
  cursor: pointer;
}

.toggle:hover {
  opacity: 1;
}
</style>
