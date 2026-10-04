<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { NButton, NIcon, NInput, NPopconfirm, NTooltip, useMessage } from 'naive-ui';
import { Copy, Pencil, Plus, Trash } from '@vicons/tabler';
import { useProjectStore } from '@/stores/project';
import { useSuitesStore } from '@/stores/suites';
import { useSuiteRunStore } from '@/stores/suiteRun';
import { useTabsStore } from '@/stores/tabs';
import * as suitesApi from '@/api/suites';

/**
 * 侧栏的「测试集」列表（第八轮第 1 节）。
 *
 * 每行：名字 · 步骤数 · 最近一次运行的小圆点（只在这次会话里跑过才有点）；
 * 悬停出现改名 / 复制 / 删除；拖动排序。
 */
const projects = useProjectStore();
const suites = useSuitesStore();
const runs = useSuiteRunStore();
const tabs = useTabsStore();
const message = useMessage();

const canEdit = computed(function () { return projects.canEdit; });

const renamingId = ref('');
const renameText = ref('');
const creating = ref(false);

/** 拖动排序：拖到哪一行上面就插到它前面 */
const dragId = ref('');
const dropId = ref('');

function load() {
  return suites.load(projects.currentId).catch(function (err) {
    message.error(err.message);
  });
}

onMounted(load);

// 切项目：换一份列表
watch(
  function () { return projects.currentId; },
  function () { load(); }
);

// 在别处（复制项目、删除）改了测试集之后，回到侧栏能看到新的
watch(
  function () { return tabs.activeKey; },
  function () { if (projects.currentId && suites.projectId !== projects.currentId) load(); }
);

function open(suite) {
  tabs.openSuite(suite.id, suite.name);
}

async function create() {
  if (creating.value) return;
  creating.value = true;
  try {
    const data = await suitesApi.createSuite(projects.currentId, { name: '新建测试集' });
    suites.put(data.suite);
    open(data.suite);
    startRename(data.suite);
  } catch (err) {
    message.error(err.message);
  } finally {
    creating.value = false;
  }
}

function startRename(suite) {
  renamingId.value = suite.id;
  renameText.value = suite.name;
}

async function commitRename(suite) {
  const name = renameText.value.trim();
  renamingId.value = '';
  if (!name || name === suite.name) return;

  try {
    const data = await suitesApi.updateSuite(suite.id, { name: name });
    suites.put(data.suite);
  } catch (err) {
    message.error(err.message);
  }
}

async function copy(suite) {
  try {
    const data = await suitesApi.copySuite(suite.id);
    suites.put(data.suite);
    message.success('已复制');
  } catch (err) {
    message.error(err.message);
  }
}

async function remove(suite) {
  try {
    await suitesApi.removeSuite(suite.id);
    suites.drop(suite.id);
    tabs.closeSuite(suite.id);
    message.success('已删除');
  } catch (err) {
    message.error(err.message);
  }
}

/** 状态小圆点的颜色：绿 / 红 / 灰（跑过才有） */
function dotClass(suiteId) {
  const status = runs.lastStatus(suiteId);
  if (!status) return '';
  if (status === 'passed') return 'ok';
  if (status === 'failed' || status === 'error') return 'bad';
  return 'idle';
}

function onDragStart(suite) {
  dragId.value = suite.id;
}

function onDragOver(suite) {
  if (!dragId.value || dragId.value === suite.id) return;
  dropId.value = suite.id;
}

async function onDrop() {
  const from = dragId.value;
  const to = dropId.value;
  dragId.value = '';
  dropId.value = '';
  if (!from || !to || from === to) return;

  const ids = suites.suites.map(function (item) { return item.id; });
  const fromAt = ids.indexOf(from);
  const toAt = ids.indexOf(to);
  if (fromAt === -1 || toAt === -1) return;

  ids.splice(toAt, 0, ids.splice(fromAt, 1)[0]);

  try {
    const data = await suitesApi.reorderSuites(projects.currentId, ids);
    suites.suites = data.suites || suites.suites;
  } catch (err) {
    message.error(err.message);
  }
}
</script>

<template>
  <div class="suite-list">
    <div class="head">
      <span class="title">测试集</span>
      <n-tooltip v-if="canEdit" trigger="hover">
        <template #trigger>
          <n-button size="tiny" quaternary :loading="creating" @click="create">
            <template #icon><n-icon :component="Plus" /></template>
          </n-button>
        </template>
        新建测试集
      </n-tooltip>
    </div>

    <p v-if="!suites.suites.length" class="empty">
      还没有测试集。点上面的 + 建一个，或者从「批量运行」里「存为测试集」。
    </p>

    <div
      v-for="suite in suites.suites"
      :key="suite.id"
      class="row"
      :class="{ dragging: dragId === suite.id, dropping: dropId === suite.id }"
      draggable="true"
      @click="open(suite)"
      @dragstart="onDragStart(suite)"
      @dragover.prevent="onDragOver(suite)"
      @drop.prevent="onDrop"
      @dragend="dragId = ''; dropId = ''"
    >
      <span class="dot" :class="dotClass(suite.id)" />

      <n-input
        v-if="renamingId === suite.id"
        v-model:value="renameText"
        size="tiny"
        autofocus
        @click.stop
        @keyup.enter="commitRename(suite)"
        @blur="commitRename(suite)"
      />
      <span v-else class="name" :title="suite.name">{{ suite.name }}</span>

      <span class="count">{{ suite.stepCount }}</span>

      <span v-if="canEdit" class="actions" @click.stop>
        <button class="act" title="改名" @click="startRename(suite)">
          <n-icon size="13" :component="Pencil" />
        </button>
        <button class="act" title="复制" @click="copy(suite)">
          <n-icon size="13" :component="Copy" />
        </button>
        <n-popconfirm @positive-click="remove(suite)">
          <template #trigger>
            <button class="act danger" title="删除">
              <n-icon size="13" :component="Trash" />
            </button>
          </template>
          删除「{{ suite.name }}」？运行记录也会一起删掉（不可撤销）。
        </n-popconfirm>
      </span>
    </div>
  </div>
</template>

<style scoped>
.suite-list {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
  overflow: auto;
}

.head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px 4px 10px;
}

.title {
  flex: 1;
  font-size: 12px;
  font-weight: 600;
  opacity: 0.7;
}

.empty {
  margin: 8px 10px;
  font-size: 12px;
  line-height: 1.7;
  opacity: 0.55;
}

.row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px 4px 10px;
  font-size: 12px;
  cursor: pointer;
  border-radius: 4px;
}

.row:hover {
  background: rgba(128, 128, 128, 0.1);
}

.row.dragging {
  opacity: 0.5;
}

.row.dropping {
  box-shadow: inset 0 2px 0 var(--apiloop-primary);
}

.dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: transparent;
}

/* 只有跑过才有点：绿 / 红 / 灰。没跑过就是一个空位，不占视觉 */
.dot.ok { background: #18a058; }
.dot.bad { background: #d03050; }
.dot.idle { background: rgba(128, 128, 128, 0.5); }

.name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.count {
  flex: none;
  font-size: 11px;
  opacity: 0.45;
}

.actions {
  flex: none;
  display: none;
  align-items: center;
  gap: 2px;
}

.row:hover .actions {
  display: flex;
}

.act {
  display: flex;
  align-items: center;
  padding: 2px;
  border: none;
  border-radius: 3px;
  background: transparent;
  color: inherit;
  opacity: 0.6;
  cursor: pointer;
}

.act:hover {
  opacity: 1;
  background: rgba(128, 128, 128, 0.16);
}

.act.danger:hover {
  color: #d03050;
}
</style>
