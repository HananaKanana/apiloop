<script setup>
import { ref, watch } from 'vue';
import { NButton, NEmpty, NTag, useDialog, useMessage } from 'naive-ui';
import * as historyApi from '@/api/history';
import { useProjectStore } from '@/stores/project';
import { useTabsStore } from '@/stores/tabs';
import { methodColor } from '@/utils/method';

/**
 * 历史列表（侧栏的一页，原来是个抽屉）。
 * 列表按 id 倒序，滚动到底部时用 nextBefore 继续往前翻。
 */
const PAGE_SIZE = 50;

const projects = useProjectStore();
const tabs = useTabsStore();
const message = useMessage();
const dialog = useDialog();

const items = ref([]);
const nextBefore = ref(null);
const loading = ref(false);
const loaded = ref(false);

async function loadPage(reset) {
  const pid = projects.currentId;
  if (!pid || loading.value) return;

  loading.value = true;
  try {
    const data = await historyApi.listHistory(pid, {
      limit: PAGE_SIZE,
      before: reset ? undefined : nextBefore.value
    });
    const list = data.items || [];
    items.value = reset ? list : items.value.concat(list);
    nextBefore.value = data.nextBefore === undefined ? null : data.nextBefore;
    loaded.value = true;
  } catch (err) {
    message.error(err.message);
  } finally {
    loading.value = false;
  }
}

function onScroll(event) {
  const el = event.target;
  if (!nextBefore.value || loading.value) return;
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 80) loadPage(false);
}

async function openEntry(entry) {
  try {
    await tabs.openHistory(entry.id);
  } catch (err) {
    message.error(err.message);
  }
}

function clearAll() {
  dialog.error({
    title: '清空历史',
    content: '确定清空当前项目的全部历史记录吗？此操作不可撤销。',
    positiveText: '清空',
    negativeText: '取消',
    onPositiveClick: async function () {
      try {
        await historyApi.clearHistory(projects.currentId);
        items.value = [];
        nextBefore.value = null;
        message.success('已清空');
      } catch (err) {
        message.error(err.message);
      }
    }
  });
}

function statusType(entry) {
  if (entry.errorCode) return 'error';
  if (entry.status === null || entry.status === undefined) return 'default';
  if (entry.status >= 200 && entry.status < 300) return 'success';
  if (entry.status >= 400 && entry.status < 500) return 'warning';
  if (entry.status >= 500) return 'error';
  return 'default';
}

function statusText(entry) {
  if (entry.errorCode) return entry.errorCode;
  if (entry.status === null || entry.status === undefined) return '—';
  return String(entry.status);
}

function formatTime(value) {
  if (!value) return '';
  const date = new Date(value);
  function pad(number) { return String(number).padStart(2, '0'); }
  return pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' +
    pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
}

function formatMs(value) {
  if (value === null || value === undefined) return '—';
  return Math.round(value) + ' ms';
}

/** 这一页是常驻的（不像抽屉那样开一次拉一次），所以换项目时重新拉 */
watch(
  function () { return projects.currentId; },
  function () {
    items.value = [];
    nextBefore.value = null;
    loaded.value = false;
    loadPage(true);
  },
  { immediate: true }
);
</script>

<template>
  <div class="history-panel">
    <div class="head">
      <span class="group-title">历史</span>
      <n-button
        v-if="projects.canEdit"
        size="tiny"
        quaternary
        @click="clearAll"
      >
        清空
      </n-button>
    </div>

    <div class="list" @scroll="onScroll">
      <div
        v-for="entry in items"
        :key="entry.id"
        class="item"
        @click="openEntry(entry)"
      >
        <div class="item-top">
          <span class="method" :style="{ color: methodColor(entry.method) }">{{ entry.method }}</span>
          <n-tag size="tiny" :bordered="false" :type="statusType(entry)">
            {{ statusText(entry) }}
          </n-tag>
          <span class="spacer" />
          <span class="time">{{ formatTime(entry.createdAt) }}</span>
        </div>
        <div class="item-bottom">
          <span class="url">{{ entry.url }}</span>
          <span class="ms">{{ formatMs(entry.totalMs) }}</span>
        </div>
      </div>

      <n-empty v-if="loaded && !items.length" size="small" description="还没有历史记录" />
      <div v-if="loading" class="loading">加载中…</div>
      <div v-else-if="loaded && !nextBefore && items.length" class="loading">没有更多了</div>
    </div>
  </div>
</template>

<style scoped>
.history-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.head {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 10px 6px 12px;
}

/* 和目录页的分组标题一个样式（对应 Postman 的 COLLECTIONS） */
.group-title {
  font-size: 12px;
  letter-spacing: 0.6px;
  opacity: 0.6;
  text-transform: uppercase;
}

.list {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.item {
  padding: 8px 12px;
  border-bottom: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.16));
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.item:hover {
  background: rgba(128, 128, 128, 0.08);
}

.item-top {
  display: flex;
  align-items: center;
  gap: 6px;
}

.method {
  font-size: 11px;
  font-weight: 700;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.spacer {
  flex: 1;
}

.time,
.ms {
  font-size: 11px;
  opacity: 0.55;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.item-bottom {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.url {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.loading {
  padding: 10px;
  text-align: center;
  font-size: 12px;
  opacity: 0.5;
}
</style>
