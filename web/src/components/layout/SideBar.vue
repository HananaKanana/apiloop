<script setup>
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { NIcon, NTooltip } from 'naive-ui';
import {
  Folder,
  History,
  LayoutSidebarLeftCollapse,
  LayoutSidebarLeftExpand,
  Trash,
  Variable
} from '@vicons/tabler';
import { useUiStore } from '@/stores/ui';
import { useProjectStore } from '@/stores/project';
import { useTreeStore } from '@/stores/tree';
import { useEnvStore } from '@/stores/env';
import { useTrashStore } from '@/stores/trash';
import ApiTree from '@/components/tree/ApiTree.vue';
import EnvList from '@/components/env/EnvList.vue';
import HistoryPanel from '@/components/history/HistoryPanel.vue';
import TrashDialog from '@/components/trash/TrashDialog.vue';
import SuiteList from '@/components/suite/SuiteList.vue';

/**
 * 左侧栏：最上面一排图标页签（目录 / 环境 / 历史），下面是对应的内容，
 * 再下面是回收站入口，最底下是展开 / 收起的开关。
 *
 * 收起之后不是整块消失，而是缩成一条 40px 的图标栏（和 Postman 一样）：
 * 图标竖排，点任意一个会展开侧栏并切到那一页；开关留在最底下，
 * 和展开时是同一个位置 —— 免得像之前那样浮在内容区上压住第一个标签页。
 */
const props = defineProps({
  collapsed: { type: Boolean, default: false }
});

const ui = useUiStore();
const projects = useProjectStore();
const tree = useTreeStore();
const envs = useEnvStore();
const trash = useTrashStore();

const { t } = useI18n();

/** 用 computed 包住：切换语言后页签上的文字要立刻变 */
const TABS = computed(function () {
  return [
    { key: 'tree', label: t('layout.tabTree'), icon: Folder },
    { key: 'env', label: t('layout.tabEnv'), icon: Variable },
    { key: 'history', label: t('layout.tabHistory'), icon: History }
  ];
});

const toggleTitle = computed(function () {
  return props.collapsed ? t('layout.expandSidebar') : t('layout.collapseSidebar');
});

const emit = defineEmits(['open', 'new-api', 'new-ws', 'new-sio', 'new-grpc', 'new-mqtt', 'new-tcp', 'new-udp', 'open-folder', 'run', 'import', 'toggle']);

function onTabClick(key) {
  ui.setSidebarTab(key);
  // 收起状态下点图标：顺手把侧栏展开，不然点了看不到东西
  if (props.collapsed) emit('toggle');
}

/* ---------------- 回收站 ---------------- */

/** 目录树那一栏现在切「接口 / 测试集」两个视图（第八轮第 1 节） */
const treeView = ref('apis');

const showTrash = ref(false);

function openTrash() {
  showTrash.value = true;
  trash.refresh().catch(function () {});
}

// 切项目时换一份回收站（条数跟着变）
watch(
  function () { return projects.currentId; },
  function (pid) { trash.load(pid).catch(function () {}); },
  { immediate: true }
);

// 目录树 / 环境变了（删了东西、恢复了东西）就重算条数
watch(
  function () { return [tree.folders, tree.apis, envs.environments]; },
  function () { trash.refresh().catch(function () {}); }
);
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
      <!--
        目录树上方：接口 / 测试集 两个视图切一下（第八轮第 1 节）。
        测试集是「排好的流程」，和接口树是两种东西，所以放在同一个位置切，不各占一栏。
      -->
      <div v-show="ui.sidebarTab === 'tree'" class="view-switch">
        <button
          class="switch-item"
          :class="{ active: treeView === 'apis' }"
          @click="treeView = 'apis'"
        >
          {{ t('layout.viewApis') }}
        </button>
        <button
          class="switch-item"
          :class="{ active: treeView === 'suites' }"
          @click="treeView = 'suites'"
        >
          {{ t('layout.viewSuites') }}
        </button>      </div>

      <api-tree
        v-show="ui.sidebarTab === 'tree' && treeView === 'apis'"
        @open="(api, options) => emit('open', api, options)"
        @new-api="(folderId) => emit('new-api', folderId)"
        @new-ws="emit('new-ws')"
        @new-sio="emit('new-sio')"
        @new-grpc="emit('new-grpc')"
        @new-mqtt="emit('new-mqtt')"
        @new-tcp="emit('new-tcp')"
        @new-udp="emit('new-udp')"
        @open-folder="(folderId, options) => emit('open-folder', folderId, options)"
        @run="(folderId) => emit('run', folderId)"
        @import="emit('import')"
      />
      <suite-list v-if="ui.sidebarTab === 'tree' && treeView === 'suites'" />
      <env-list v-if="ui.sidebarTab === 'env'" />
      <history-panel v-if="ui.sidebarTab === 'history'" />
    </div>

    <!-- 回收站：和云端 / 本机哪个空间无关，始终在侧栏底部 -->
    <button
      class="trash-entry"
      :class="{ collapsed: collapsed }"
      :title="t('layout.trash')"
      @click="openTrash"
    >
      <n-icon size="15" :component="Trash" />
      <span v-show="!collapsed" class="label">{{ t('layout.trash') }}</span>
      <span v-if="trash.count" class="badge">{{ trash.count }}</span>
    </button>

    <!-- 展开 / 收起：两种状态都在最底下，位置一样 -->
    <button
      class="toggle"
      :title="toggleTitle"
      @click="emit('toggle')"
    >
      <n-icon size="16" :component="collapsed ? LayoutSidebarLeftExpand : LayoutSidebarLeftCollapse" />
    </button>

    <trash-dialog v-model:show="showTrash" />
  </div>
</template>

<style scoped>
/*
 * 接口 / 测试集 的切换：两个小按钮，选中那个底色浅、字色正。
 *
 * 选择器写成 `.panel > .view-switch`：下面的 `.panel > *` 让面板里每一块都 `flex: 1` 平分高度，
 * 只写 `.view-switch` 的话两条优先级一样、后写的赢，切换条就被撑成半屏高（2026-10-04 用户截图）。
 */
.panel > .view-switch {
  flex: none;
  display: flex;
  gap: 2px;
  padding: 6px 8px 4px;
}

.switch-item {
  flex: 1;
  padding: 3px 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  font-size: 12px;
  opacity: 0.6;
  cursor: pointer;
}

.switch-item:hover {
  background: rgba(128, 128, 128, 0.12);
}

.switch-item.active {
  background: rgba(128, 128, 128, 0.16);
  opacity: 1;
  font-weight: 500;
}

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

/* 回收站入口：图标 + 文字，有东西时右边显示条数 */
.trash-entry {
  position: relative;
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 30px;
  padding: 0 10px;
  border: none;
  border-top: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.16));
  background: transparent;
  color: inherit;
  opacity: 0.72;
  cursor: pointer;
  font-size: 13px;
}

.trash-entry.collapsed {
  justify-content: center;
  padding: 0;
  gap: 0;
}

.trash-entry:hover {
  background: rgba(128, 128, 128, 0.1);
  opacity: 1;
}

.trash-entry .label {
  flex: 1;
  min-width: 0;
  text-align: left;
}

.trash-entry .badge {
  flex: none;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 9px;
  background: rgba(128, 128, 128, 0.28);
  font-size: 11px;
  line-height: 18px;
  text-align: center;
}

.trash-entry.collapsed .badge {
  position: absolute;
  top: 2px;
  right: 3px;
  min-width: 14px;
  height: 14px;
  padding: 0 3px;
  font-size: 10px;
  line-height: 14px;
  background: #d03050;
  color: #fff;
}
</style>
