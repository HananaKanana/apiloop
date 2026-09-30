<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { NButton, NEmpty, NTag, useDialog, useMessage } from 'naive-ui';
import TopBar from '@/components/layout/TopBar.vue';
import ProjectSwitcher from '@/components/layout/ProjectSwitcher.vue';
import EnvSwitcher from '@/components/layout/EnvSwitcher.vue';
import ApiTree from '@/components/tree/ApiTree.vue';
import RequestTab from '@/components/request/RequestTab.vue';
import HistoryPanel from '@/components/history/HistoryPanel.vue';
import ImportDialog from '@/components/importExport/ImportDialog.vue';
import AboutDialog from '@/components/layout/AboutDialog.vue';
import MockLogDrawer from '@/components/mock/MockLogDrawer.vue';
import { useProjectStore } from '@/stores/project';
import { useTreeStore } from '@/stores/tree';
import { useTabsStore } from '@/stores/tabs';
import { useUiStore } from '@/stores/ui';

const MIN_WIDTH = 180;
const MAX_WIDTH = 640;
const COLLAPSE_BREAKPOINT = 1024;

const router = useRouter();
const projects = useProjectStore();
const tree = useTreeStore();
const tabs = useTabsStore();
const ui = useUiStore();
const message = useMessage();
const dialog = useDialog();

const leftWidth = ref(Number(localStorage.getItem('apiloop.treeWidth')) || 280);
const collapsed = ref(false);
const dragging = ref(false);
const showAbout = ref(false);

function clamp(value) {
  return Math.min(Math.max(value, MIN_WIDTH), MAX_WIDTH);
}

function startDrag() {
  dragging.value = true;
  document.body.style.userSelect = 'none';
  document.body.style.cursor = 'col-resize';
}

function onMove(event) {
  if (!dragging.value) return;
  leftWidth.value = clamp(event.clientX);
}

function stopDrag() {
  if (!dragging.value) return;
  dragging.value = false;
  document.body.style.userSelect = '';
  document.body.style.cursor = '';
  localStorage.setItem('apiloop.treeWidth', String(leftWidth.value));
}

/** 窄屏自动收起来；变宽时不自动展开，免得跟用户的手动选择打架 */
function onResize() {
  if (window.innerWidth < COLLAPSE_BREAKPOINT) collapsed.value = true;
}

/** 有没保存的标签页时，刷新页面要先问一句 */
function onBeforeUnload(event) {
  if (!tabs.hasDirty) return;
  event.preventDefault();
  event.returnValue = '';
}

function onProjectChange(id) {
  if (id === '__settings') {
    if (projects.currentId) {
      router.push('/projects/' + projects.currentId + '/settings');
    }
    return;
  }
  // 切了项目：环境由 EnvSwitcher 的 watcher 重新拉，目录树由 ApiTree 的 watcher 重新拉
}

async function onOpenApi(api) {
  try {
    await tabs.openApi(api.id);
  } catch (err) {
    message.error(err.message);
  }
}

function onNewApi(folderId) {
  tabs.openDraft(folderId);
}

function closeTab(tab) {
  if (!tab.dirty) {
    tabs.close(tab.key);
    return;
  }

  dialog.warning({
    title: '关闭标签页',
    content: '「' + tab.title + '」有没保存的修改，关掉就没了。确定关闭吗？',
    positiveText: '关闭',
    negativeText: '取消',
    onPositiveClick: function () { tabs.close(tab.key); }
  });
}

// 接口被删掉之后，把对应的标签页收掉，别留着一个点开就报错的页
watch(
  function () { return tree.apis; },
  function (list) {
    if (!list) return;
    tabs.syncWithApis(list.map(function (api) { return api.id; }));
  }
);

onMounted(async function () {
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', stopDrag);
  window.addEventListener('resize', onResize);
  window.addEventListener('beforeunload', onBeforeUnload);
  onResize();

  try {
    await projects.load();
  } catch (err) {
    message.error(err.message);
  }
});

onBeforeUnmount(function () {
  window.removeEventListener('mousemove', onMove);
  window.removeEventListener('mouseup', stopDrag);
  window.removeEventListener('resize', onResize);
  window.removeEventListener('beforeunload', onBeforeUnload);
  stopDrag();
});
</script>

<template>
  <div class="shell">
    <top-bar @about="showAbout = true">
      <template #project>
        <project-switcher @change="onProjectChange" />
      </template>
      <template #env>
        <env-switcher />
      </template>
      <template #actions>
        <!-- 只读角色：说清楚为什么页面上少了那些按钮 -->
        <n-tag v-if="projects.current && !projects.canEdit" size="tiny" :bordered="false">
          只读
        </n-tag>
        <n-button quaternary size="small" @click="ui.openImport()">导入</n-button>
        <n-button quaternary size="small" @click="ui.openHistory()">历史</n-button>
        <n-button quaternary size="small" @click="ui.openMockLog()">Mock 日志</n-button>
        <n-button quaternary size="small" @click="collapsed = !collapsed">
          {{ collapsed ? '显示目录' : '隐藏目录' }}
        </n-button>
      </template>
    </top-bar>

    <div class="body">
      <aside v-show="!collapsed" class="left" :style="{ width: leftWidth + 'px' }">
        <api-tree @open="onOpenApi" @new-api="onNewApi" />
      </aside>

      <div
        v-show="!collapsed"
        class="splitter"
        :class="{ active: dragging }"
        @mousedown.prevent="startDrag"
      />

      <main class="right">
        <div v-if="tabs.tabs.length" class="tab-bar">
          <div
            v-for="tab in tabs.tabs"
            :key="tab.key"
            class="tab-item"
            :class="{ active: tab.key === tabs.activeKey }"
            @click="tabs.activate(tab.key)"
          >
            <span v-if="tab.dirty" class="dot" title="有没保存的修改" />
            <span class="tab-title">{{ tab.title }}</span>
            <span class="tab-close" title="关闭" @click.stop="closeTab(tab)">×</span>
          </div>
        </div>

        <div class="tab-body">
          <request-tab v-if="tabs.active" :key="tabs.activeKey" :tab="tabs.active" />
          <div v-else class="placeholder">
            <n-empty description="从左边选一个接口，或者点目录树右上角的 ＋ 新建请求" />
          </div>
        </div>
      </main>
    </div>

    <history-panel />
    <mock-log-drawer />
    <import-dialog />
    <about-dialog v-model:show="showAbout" />
  </div>
</template>

<style scoped>
.shell {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.body {
  flex: 1;
  min-height: 0;
  display: flex;
}

.left {
  flex: none;
  min-width: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.24));
}

.splitter {
  flex: none;
  width: 5px;
  cursor: col-resize;
  margin-left: -3px;
  margin-right: -2px;
  z-index: 2;
  background: transparent;
  transition: background 0.15s;
}

.splitter:hover,
.splitter.active {
  background: var(--n-primary-color, #2080f0);
}

.right {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.tab-bar {
  flex: none;
  display: flex;
  align-items: stretch;
  gap: 1px;
  overflow-x: auto;
  border-bottom: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.24));
  background: rgba(128, 128, 128, 0.06);
}

.tab-item {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  height: 32px;
  max-width: 220px;
  font-size: 12px;
  cursor: pointer;
  border-right: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.16));
  white-space: nowrap;
}

.tab-item:hover {
  background: rgba(128, 128, 128, 0.12);
}

.tab-item.active {
  background: var(--n-color, #fff);
  box-shadow: inset 0 -2px 0 var(--n-primary-color, #2080f0);
}

.tab-title {
  overflow: hidden;
  text-overflow: ellipsis;
}

.dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #f0a020;
}

.tab-close {
  flex: none;
  opacity: 0.45;
  font-size: 14px;
  line-height: 1;
}

.tab-close:hover {
  opacity: 1;
}

.tab-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.placeholder {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0.5;
}
</style>
