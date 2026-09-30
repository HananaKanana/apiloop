<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { NIcon, NLayoutHeader, NTag, NTooltip } from 'naive-ui';
import { Activity, Search, Settings } from '@vicons/tabler';
import { useRouter } from 'vue-router';
import { useSessionStore } from '@/stores/session';
import { useProjectStore } from '@/stores/project';
import { useUiStore } from '@/stores/ui';
import * as mockLogApi from '@/api/mockLog';
import UserMenu from './UserMenu.vue';

/**
 * 顶栏：左（Logo + 项目切换 + 标签）、中（搜索）、右（Mock 日志 / 系统设置 / 头像）。
 *
 * 导入、历史、侧栏开关都不在这里了 —— 分别去了侧栏的目录页头部、侧栏的「历史」页、
 * 以及侧栏最底下的折叠按钮。这里的每个图标按钮都有悬停提示。
 */
const emit = defineEmits(['about']);

const router = useRouter();
const session = useSessionStore();
const projects = useProjectStore();
const ui = useUiStore();

/* ---------------- Mock 日志的新记录小红点 ---------------- */

/** 轮询间隔。抽屉开着的时候不用提示，也就不拉 */
const MOCK_POLL_MS = 15000;

const mockDot = ref(false);
/** 已经看过的水位：抽屉打开时推到最新 */
let seenSeq = 0;
let timer = null;

async function pollMockLog() {
  const pid = projects.currentId;
  if (!pid || ui.mockLogVisible || document.hidden) return;

  try {
    const data = await mockLogApi.listMockLog(pid, { after: seenSeq, limit: 1 });
    if ((data.items || []).length) mockDot.value = true;
  } catch (err) {
    // 轮询失败不打扰用户，下个周期自己会重试
  }
}

function startPolling() {
  stopPolling();
  timer = setInterval(pollMockLog, MOCK_POLL_MS);
}

function stopPolling() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** 打开抽屉就当已读：把水位推到最新的一条 */
async function markMockLogSeen() {
  mockDot.value = false;
  const pid = projects.currentId;
  if (!pid) return;
  try {
    const data = await mockLogApi.listMockLog(pid, { after: 0, limit: 1 });
    if (typeof data.lastSeq === 'number') seenSeq = data.lastSeq;
  } catch (err) {
    // 拿不到水位就先这样，下次打开再对
  }
}

function openMockLog() {
  ui.openMockLog();
  markMockLogSeen();
}

watch(
  function () { return ui.mockLogVisible; },
  function (open) { if (open) markMockLogSeen(); }
);

// 换项目：水位清零，小红点也清掉
watch(
  function () { return projects.currentId; },
  function () {
    seenSeq = 0;
    mockDot.value = false;
  }
);

/* ---------------- 搜索 ---------------- */

const isMac = computed(function () {
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
});

const searchHint = computed(function () {
  return '搜索接口 ' + (isMac.value ? '⌘K' : 'Ctrl+K');
});

/** ⌘K / Ctrl+K 打开快速搜索 */
function onKeydown(event) {
  if (!(event.metaKey || event.ctrlKey)) return;
  if (String(event.key).toLowerCase() !== 'k') return;
  event.preventDefault();
  ui.openQuickOpen();
}

onMounted(function () {
  window.addEventListener('keydown', onKeydown);
  startPolling();
});

onBeforeUnmount(function () {
  window.removeEventListener('keydown', onKeydown);
  stopPolling();
});
</script>

<template>
  <n-layout-header bordered class="topbar">
    <div class="group left">
      <span class="logo">a</span>
      <span class="brand">{{ session.appName || 'apiloop' }}</span>

      <slot name="project" />
      <n-tag v-if="projects.current && projects.current.isRoot" size="tiny" :bordered="false">
        根
      </n-tag>
      <n-tag v-if="projects.current && !projects.canEdit" size="tiny" :bordered="false">
        只读
      </n-tag>
    </div>

    <div class="group middle">
      <button class="search" @click="ui.openQuickOpen()">
        <n-icon size="15" :component="Search" />
        <span class="search-text">{{ searchHint }}</span>
      </button>
    </div>

    <div class="group right">
      <n-tooltip trigger="hover">
        <template #trigger>
          <button class="icon-button" @click="openMockLog">
            <n-icon size="18" :component="Activity" />
            <span v-if="mockDot" class="dot" />
          </button>
        </template>
        Mock 日志
      </n-tooltip>

      <n-tooltip v-if="session.isAdmin" trigger="hover">
        <template #trigger>
          <button class="icon-button" @click="router.push('/settings')">
            <n-icon size="18" :component="Settings" />
          </button>
        </template>
        系统设置
      </n-tooltip>

      <user-menu @about="emit('about')" />
    </div>
  </n-layout-header>
</template>

<style scoped>
.topbar {
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px;
  box-sizing: border-box;
  gap: 12px;
}

.group {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.middle {
  flex: 1;
  justify-content: center;
}

/* 主色方块里一个白色的 a */
.logo {
  flex: none;
  width: 20px;
  height: 20px;
  border-radius: 5px;
  background: var(--apiloop-primary);
  color: #fff;
  font-size: 13px;
  font-weight: 700;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

.brand {
  font-size: 15px;
  font-weight: 600;
  white-space: nowrap;
  margin-right: 4px;
}

.search {
  width: 360px;
  max-width: 100%;
  height: 28px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px;
  border: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.4));
  border-radius: 6px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  opacity: 0.75;
}

.search:hover {
  border-color: var(--apiloop-primary);
  opacity: 1;
}

.search-text {
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.icon-button {
  position: relative;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0.75;
}

.icon-button:hover {
  background: rgba(128, 128, 128, 0.14);
  opacity: 1;
}

/* 抽屉关着的时候有新记录：右上角一个小红点 */
.dot {
  position: absolute;
  top: 3px;
  right: 3px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #eb2013;
}
</style>
