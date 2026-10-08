<script setup>
// 和 Mac / Windows 客户端同一个图标：make-icon.swift 画的 1024 图裁掉四周留白、缩到 96px
import logoUrl from '@/assets/logo.png';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { NIcon, NLayoutHeader, NTag, NTooltip } from 'naive-ui';
import { Activity, BrandGithub, Download, Help, PlayerRecord, Search, Settings } from '@vicons/tabler';
import { useRouter } from 'vue-router';
import { useSessionStore } from '@/stores/session';
import { useProjectStore } from '@/stores/project';
import { useUiStore } from '@/stores/ui';
import { useGatewayStore } from '@/stores/gateway';
import { FAST_POLL_MS, SLOW_POLL_MS, useRecordStore } from '@/stores/record';
import * as mockLogApi from '@/api/mockLog';
import ConnectionStatus from './ConnectionStatus.vue';
import NotificationBell from './NotificationBell.vue';
import UserMenu from './UserMenu.vue';
import InstallDialog from './InstallDialog.vue';
import RecordDrawer from '@/components/record/RecordDrawer.vue';

/**
 * 顶栏：左（Logo + 项目切换 + 标签）、中（搜索）、右（Mock 日志 / 系统设置 / 头像）。
 *
 * 导入、历史、侧栏开关都不在这里了 —— 分别去了侧栏的目录页头部、侧栏的「历史」页、
 * 以及侧栏最底下的折叠按钮。这里的每个图标按钮都有悬停提示。
 */
const emit = defineEmits(['about']);

/**
 * 网页版的「下载客户端」（2026-10-08 用户：网页版找不到下载入口）。
 * 以前入口藏在连接状态那个圆点里，而云端默认不替网页版发请求时圆点不显示，入口就跟着没了。
 * 客户端里不显示 —— 那边有「有新版本」提示。
 */
const showInstall = ref(false);

/** 项目的 git 仓库。客户端里点开会交给系统浏览器 */
const REPO_URL = 'https://github.com/HananaKanana/apiloop';

const router = useRouter();
const session = useSessionStore();
const projects = useProjectStore();
const ui = useUiStore();
const gateway = useGatewayStore();
const { t } = useI18n();

/* ---------------- Mock 日志的新记录小红点 ---------------- */

/** 轮询间隔。抽屉开着的时候不用提示，也就不拉 */
const MOCK_POLL_MS = 15000;

const mockDot = ref(false);
/** 已经看过的水位：抽屉打开时推到最新 */
let seenSeq = 0;
let timer = null;

async function pollMockLog() {
  const pid = projects.currentId;
  // mock 日志存在云端，没登录就没有（本机库里没有这张表）
  if (!pid || !gateway.cloudFeaturesAvailable || ui.mockLogVisible || document.hidden) return;

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

/* ---------------- Mock 录制 ---------------- */

const record = useRecordStore();
const recordVisible = ref(false);

/**
 * 轮询：抽屉开着 1 秒一次（列表要实时刷新）；关着只在客户端里 5 秒一次 ——
 * 顶栏那个红点（「录制中：N 条」）要靠它，网页版没有这些接口，一次都不拉。
 */
function syncRecordPolling() {
  if (!gateway.isGateway) {
    record.stopPolling();
    return;
  }
  record.startPolling(recordVisible.value ? FAST_POLL_MS : SLOW_POLL_MS);
}

// 是不是客户端、以及当前项目，两个都变了才重新拉
watch(
  function () { return gateway.isGateway; },
  function (yes) {
    if (!yes) {
      record.stopPolling();
      return;
    }
    record.load(projects.currentId);
    syncRecordPolling();
  },
  { immediate: true }
);

watch(
  function () { return projects.currentId; },
  function (pid) {
    if (!gateway.isGateway) return;
    record.load(pid);
  }
);

watch(
  function () { return recordVisible.value; },
  function () { syncRecordPolling(); }
);

/* ---------------- 搜索 ---------------- */

const isMac = computed(function () {
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
});

const searchHint = computed(function () {
  return t('layout.searchHint', { key: isMac.value ? '⌘K' : 'Ctrl+K' });
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
  record.stopPolling();
});
</script>

<template>
  <n-layout-header bordered class="topbar">
    <div class="group left">
      <img class="logo" :src="logoUrl" alt="" />
      <span class="brand">{{ session.appName || 'apiloop' }}</span>

      <slot name="project" />
      <n-tag v-if="projects.current && !projects.canEdit" size="tiny" :bordered="false">
        {{ t('layout.readonly') }}
      </n-tag>
    </div>

    <div class="group middle">
      <button class="search" @click="ui.openQuickOpen()">
        <n-icon size="15" :component="Search" />
        <span class="search-text">{{ searchHint }}</span>
      </button>
    </div>

    <div class="group right">
      <button
        v-if="gateway.loaded && !gateway.isGateway"
        class="download-button"
        :title="t('layout.downloadClientHint')"
        @click="showInstall = true"
      >
        <n-icon size="15" :component="Download" />
        <span>{{ t('layout.downloadClient') }}</span>
      </button>

      <n-tooltip v-if="gateway.isGateway" trigger="hover">
        <template #trigger>
          <button class="icon-button" @click="recordVisible = true">
            <n-icon size="18" :component="PlayerRecord" />
            <span v-if="record.isRecording" class="dot recording" />
            <span v-else-if="record.busy" class="dot idle" />
          </button>
        </template>
        <template v-if="record.isRecording">{{ t('layout.recordRecording', { n: record.count }) }}</template>
        <template v-else-if="record.busy">{{ t('layout.recordBusy', { name: record.busy.projectName }) }}</template>
        <template v-else>{{ t('layout.recordTitle') }}</template>
      </n-tooltip>

      <n-tooltip v-if="gateway.cloudFeaturesAvailable" trigger="hover">
        <template #trigger>
          <button class="icon-button" @click="openMockLog">
            <n-icon size="18" :component="Activity" />
            <span v-if="mockDot" class="dot" />
          </button>
        </template>
        {{ t('layout.mockLog') }}
      </n-tooltip>

      <n-tooltip trigger="hover">
        <template #trigger>
          <button class="icon-button" @click="ui.openHelp()">
            <n-icon size="18" :component="Help" />
          </button>
        </template>
        {{ t('layout.help') }}
      </n-tooltip>

      <n-tooltip trigger="hover">
        <template #trigger>
          <a class="icon-button" :href="REPO_URL" target="_blank" rel="noopener">
            <n-icon size="18" :component="BrandGithub" />
          </a>
        </template>
        {{ t('layout.github') }}
      </n-tooltip>

      <n-tooltip v-if="session.isAdmin" trigger="hover">
        <template #trigger>
          <button class="icon-button" @click="router.push('/settings')">
            <n-icon size="18" :component="Settings" />
          </button>
        </template>
        {{ t('layout.systemSettings') }}
      </n-tooltip>

      <connection-status />

      <!-- @ 提醒的铃铛（第五轮第 4 节）：提醒只在云端，没登录时它自己不渲染 -->
      <notification-bell />

      <user-menu @about="emit('about')" />
    </div>

    <!-- Mock 录制抽屉：只在客户端里渲染（网页版没有那几个接口） -->
    <record-drawer v-if="gateway.isGateway" v-model:show="recordVisible" />
    <install-dialog
      v-if="!gateway.isGateway"
      v-model:show="showInstall"
      :is-gateway="false"
      :cloud-url="gateway.cloudUrl"
    />
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

/* 和客户端一样的应用图标 */
.logo {
  flex: none;
  width: 22px;
  height: 22px;
  display: block;
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
  text-decoration: none;
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

/* 正在录的是当前项目：红点轻轻闪一下，一眼能看出在录 */
.dot.recording {
  animation: record-blink 1.4s ease-in-out infinite;
}

/* 正在录别的项目：灰点，悬停能看到是哪个项目 */
.dot.idle {
  background: #9ca3af;
}

@keyframes record-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.25; }
}

/* 网页版的「下载客户端」：顶栏里唯一带文字的按钮，用主色细边框，不抢搜索框 */
.download-button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 28px;
  margin-right: 6px;
  padding: 0 10px;
  border: 1px solid var(--apiloop-primary, #ff6c37);
  border-radius: 6px;
  background: transparent;
  color: var(--apiloop-primary, #ff6c37);
  font: inherit;
  font-size: 12px;
  white-space: nowrap;
  cursor: pointer;
}

.download-button:hover {
  background: rgba(255, 108, 55, 0.1);
}
</style>
