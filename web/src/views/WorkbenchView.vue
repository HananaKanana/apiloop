<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { NAlert, NEmpty, NIcon, useMessage } from 'naive-ui';
import { useDialog } from '@/utils/dialog';
import { Plus } from '@vicons/tabler';
import TopBar from '@/components/layout/TopBar.vue';
import UpdateAction from '@/components/layout/UpdateAction.vue';
import ProjectSwitcher from '@/components/layout/ProjectSwitcher.vue';
import EnvSwitcher from '@/components/layout/EnvSwitcher.vue';
import QuickOpen from '@/components/layout/QuickOpen.vue';
import FindReplaceDialog from '@/components/search/FindReplaceDialog.vue';
import SideBar from '@/components/layout/SideBar.vue';
import RequestTab from '@/components/request/RequestTab.vue';
import WsTab from '@/components/ws/WsTab.vue';
import SioTab from '@/components/sio/SioTab.vue';
import GrpcTab from '@/components/grpc/GrpcTab.vue';
import MqttTab from '@/components/mqtt/MqttTab.vue';
import SocketTab from '@/components/socket/SocketTab.vue';
import FolderTab from '@/components/folder/FolderTab.vue';
import RunnerTab from '@/components/runner/RunnerTab.vue';
import LoadTab from '@/components/load/LoadTab.vue';
import EnvDiffTab from '@/components/env/EnvDiffTab.vue';
import SuiteTab from '@/components/suite/SuiteTab.vue';
import EnvTab from '@/components/env/EnvTab.vue';
import MockEnvTab from '@/components/env/MockEnvTab.vue';
import ImportDialog from '@/components/importExport/ImportDialog.vue';
import AboutDialog from '@/components/layout/AboutDialog.vue';
import MockLogDrawer from '@/components/mock/MockLogDrawer.vue';
import HelpDrawer from '@/components/help/HelpDrawer.vue';
import ContextMenu from '@/components/common/ContextMenu.vue';
import { useProjectStore } from '@/stores/project';
import { usePrefsStore } from '@/stores/prefs';
import { useTreeStore } from '@/stores/tree';
import { useTabsStore } from '@/stores/tabs';
import { useUiStore } from '@/stores/ui';
import { useEnvStore } from '@/stores/env';
import { useGatewayStore } from '@/stores/gateway';
import { methodColor } from '@/utils/method';

const MIN_WIDTH = 180;
const MAX_WIDTH = 640;
const COLLAPSE_BREAKPOINT = 1024;

const router = useRouter();
const projects = useProjectStore();
const prefs = usePrefsStore();
const tree = useTreeStore();
const tabs = useTabsStore();
const ui = useUiStore();
const envs = useEnvStore();
const gateway = useGatewayStore();
const message = useMessage();
const dialog = useDialog();
const { t } = useI18n();

const leftWidth = ref(Number(localStorage.getItem('apiloop.treeWidth')) || 280);
const collapsed = ref(false);
const dragging = ref(false);
const showAbout = ref(false);

/** 侧栏开关：⌘\ / Ctrl+\ 或者点侧栏最底下那个图标 */
function toggleSidebar() {
  collapsed.value = !collapsed.value;
}

function onKeydown(event) {
  if (!(event.metaKey || event.ctrlKey)) return;

  // ⌘⇧F / Ctrl+Shift+F：全局查找替换（和编辑器的「项目内查找」一个键位）。
  // 放在 ⌘\ 前面判，免得以后有人改 \\ 那段时漏掉 shift 这一路。
  if (event.shiftKey && String(event.key).toLowerCase() === 'f') {
    event.preventDefault();
    ui.openFindReplace();
    return;
  }

  if (event.key !== '\\') return;
  event.preventDefault();
  toggleSidebar();
}

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

/**
 * 给 Mac 原生壳留的钩子：壳子关窗口、退出、刷新之前会问一句，
 * 返回 true 就弹「还有没保存的修改」（壳子代码在 agent-installer/mac/shell/）。
 *
 * **只在工作台挂着的时候存在** —— 离开工作台（比如回登录页）就删掉。
 * 壳子那边拿不到这个对象、或者调用报错，一律当「没有未保存的修改」直接关，
 * 所以这里不用做任何兜底。
 */
function mountShellHook() {
  window.apiloopShell = {
    /** 壳子关窗口、退出、刷新之前问一句（Mac 原生壳） */
    hasUnsavedChanges: function () { return Boolean(tabs.hasDirty); }
  };
}

function unmountShellHook() {
  delete window.apiloopShell;
}

/* ---------------- 别的电脑同步过来的改动 ---------------- */

/**
 * 网关在后台同步，拉下来新项目、新接口时页面不会知道 —— 以前要重开 apiloop 才看得到
 * （用户 2026-10-01：「Windows 显示已同步，但是项目没有同步过来」）。
 * 网关的 `sync.dataVersion` 每次同步改了本机数据就加一，这里盯着它重新加载项目、目录树和环境。
 * 打开着的标签页不动：里面可能有没保存的修改。
 */
watch(
  function () { return gateway.sync ? gateway.sync.dataVersion : undefined; },
  async function (version, previous) {
    if (version === undefined || previous === undefined || version === previous) return;
    try {
      await projects.load();
      // 偏好也要重拉：别的设备改了分组 / 收藏，或者这边推上去的被合并过
      await prefs.load();
      await tree.refresh();
      if (projects.currentId) await envs.load(projects.currentId);
    } catch (err) {
      // 下一次同步还会再触发，这次拉不到不打扰用户
    }
  }
);

/* ---------------- 版本不一致的横幅 ---------------- */

/**
 * 版本不一致的横幅。判断本身在 gateway store 里（顶栏的「有新版本」用的是同一个），
 * 这里只多管一件事：**这个版本组合**被关掉过就不再出现（sessionStorage）。
 * 换个版本组合（升级了一边）还会再提示一次。
 */
const VERSION_DISMISS_KEY = 'apiloop.versionMismatch.dismissed';

function readDismissedVersion() {
  try {
    return sessionStorage.getItem(VERSION_DISMISS_KEY) || '';
  } catch (err) {
    return '';
  }
}

const dismissedVersion = ref(readDismissedVersion());

const versionMismatch = computed(function () {
  const mismatch = gateway.versionMismatch;
  if (!mismatch) return null;

  const key = mismatch.gatewayVersion + '|' + mismatch.cloudVersion;
  if (dismissedVersion.value === key) return null;
  return { gatewayVersion: mismatch.gatewayVersion, cloudVersion: mismatch.cloudVersion, key: key };
});

function dismissVersionBanner() {
  const current = versionMismatch.value;
  if (!current) return;
  dismissedVersion.value = current.key;
  try {
    sessionStorage.setItem(VERSION_DISMISS_KEY, current.key);
  } catch (err) {
    // 存不下就这次会话里多显示几次，不影响用
  }
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

/** 这个项目的 Mock 故障模拟开着吗（第七轮第 1 节）：开着就在项目名旁边挂个橙色小标 */
const mockFaultsOn = computed(function () {
  const faults = projects.current && projects.current.mockFaults;
  return Boolean(faults && faults.enabled === true);
});

function openFaultSettings() {
  // 直接打开「Mock」那一页（项目设置分了页签之后，不带 tab 会落在「基本信息」上）
  if (projects.currentId) router.push({ path: '/projects/' + projects.currentId + '/settings', query: { tab: 'mock' } });
}

async function onOpenApi(api, options) {
  try {
    await tabs.openApi(api.id, options);
  } catch (err) {
    message.error(err.message);
  }
}

function onNewApi(folderId) {
  tabs.openDraft(folderId);
}

/** WebSocket 标签页不进目录树，和当前选中的目录没关系 */
function onNewWs() {
  tabs.openWs();
}

/** Socket.IO 调试标签页（第九轮第 4 节）：同上，不进目录树 */
function onNewSio() {
  tabs.openSio();
}

/** gRPC 调试标签页（第十一轮第 3 节）：同上，不进目录树 */
function onNewGrpc() {
  tabs.openGrpc();
}

/** MQTT 调试标签页（第十三轮第 4 节）：同上，不进目录树 */
function onNewMqtt() {
  tabs.openMqtt();
}

/** TCP / UDP 调试标签页（第十六轮）：同上，不进目录树。两种协议共用一个组件，方法决定字段 */
function onNewTcp() {
  tabs.openSocket('TCP');
}

function onNewUdp() {
  tabs.openSocket('UDP');
}

/** 目录设置也是一种标签页，和接口并列（Postman 的习惯） */
function onOpenFolder(folderId, options) {
  tabs.openFolder(folderId, options);
}

/**
 * 打开「运行」标签页（第 2 节）：目录右键「运行」、目录标签页右上角「运行」传目录 id；
 * 目录树空白处右键「运行全部」传 null（整个项目）。
 */
function onRun(folderId) {
  tabs.openRunner(folderId || null);
}

/**
 * 标签页标题前面的方法缩写（Postman 那一行也是这么排的）。
 * 目录页签没有方法；WebSocket 页签固定 WS；其余取 spec 里的方法。
 */
function tabMethod(tab) {
  if (!tab) return '';
  if (tab.kind === 'ws') return 'WS';
  // Socket.IO 调试标签页固定 SIO（第九轮第 4 节）
  if (tab.kind === 'sio') return 'SIO';
  // gRPC 调试标签页固定 GRPC（第十一轮第 3 节）：它的 spec 里没有 method 字段，
  // 不在这里拦掉的话会走到下面那个默认值、显示成「GET」
  if (tab.kind === 'grpc') return 'GRPC';
  // MQTT 调试标签页固定 MQTT（第十三轮第 4 节）：同上，spec 里没有 method 字段
  if (tab.kind === 'mqtt') return 'MQTT';
  // TCP / UDP 调试标签页（第十六轮）：两种协议共用一个 kind，方法在 spec.method 上
  if (tab.kind === 'socket') return String((tab.spec && tab.spec.method) || 'TCP').toUpperCase();
  // 目录页签、「运行」页签、「压测」页签、「环境对比」页签都没有「方法」这一说，不显示缩写
  if (tab.kind === 'folder' || tab.kind === 'runner' || tab.kind === 'load' ||
      tab.kind === 'suite' || tab.kind === 'envdiff') return '';
  return String((tab.spec && tab.spec.method) || 'GET').toUpperCase();
}

function closeTab(tab) {
  if (!tab.dirty) {
    tabs.close(tab.key);
    return;
  }

  dialog.warning({
    title: t('views.wbCloseTabTitle'),
    content: t('views.wbCloseTabBody', { name: tab.title }),
    positiveText: t('views.wbClose'),
    negativeText: t('app.cancel'),
    onPositiveClick: function () { tabs.close(tab.key); }
  });
}

/* ---------------- 标签页右键菜单 ---------------- */

const tabMenu = ref({ show: false, x: 0, y: 0, tab: null });

const TAB_MENU_OPTIONS = computed(function () {
  return [
    { label: t('views.wbClose'), key: 'close' },
    { label: t('views.wbCloseOthers'), key: 'others' },
    { label: t('views.wbCloseRight'), key: 'right' },
    { type: 'divider', key: 'd' },
    { label: t('views.wbCloseAll'), key: 'all' }
  ];
});

function openTabMenu(event, tab) {
  tabMenu.value = { show: true, x: event.clientX, y: event.clientY, tab: tab };
}

/**
 * 一次关好几个：里面有没保存的，就问一次（说清楚有几个），确定了一起关。
 */
function closeTabs(list) {
  if (!list.length) return;
  const dirty = list.filter(function (tab) { return tab.dirty; });
  const doClose = function () {
    list.forEach(function (tab) { tabs.close(tab.key); });
  };

  if (!dirty.length) {
    doClose();
    return;
  }

  dialog.warning({
    title: t('views.wbCloseTabTitle'),
    content: t('views.wbCloseTabsBody', { n: dirty.length }),
    positiveText: t('views.wbClose'),
    negativeText: t('app.cancel'),
    onPositiveClick: doClose
  });
}

function onTabMenuSelect(key) {
  const target = tabMenu.value.tab;
  tabMenu.value.show = false;
  if (!target) return;

  const list = tabs.tabs.slice();
  const index = list.findIndex(function (tab) { return tab.key === target.key; });
  if (index === -1) return;

  if (key === 'close') return closeTab(target);
  if (key === 'others') return closeTabs(list.filter(function (tab) { return tab.key !== target.key; }));
  if (key === 'right') return closeTabs(list.slice(index + 1));
  if (key === 'all') return closeTabs(list);
}

// 接口被删掉之后，把对应的标签页收掉，别留着一个点开就报错的页
watch(
  function () { return tree.apis; },
  function (list) {
    if (!list) return;
    tabs.syncWithApis(list.map(function (api) { return api.id; }));
  }
);

// 目录同理
watch(
  function () { return tree.folders; },
  function (list) {
    if (!list) return;
    tabs.syncWithFolders(list.map(function (folder) { return folder.id; }));
  }
);

onMounted(async function () {
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', stopDrag);
  window.addEventListener('resize', onResize);
  window.addEventListener('beforeunload', onBeforeUnload);
  window.addEventListener('keydown', onKeydown);
  // 浏览器里的刷新提示（beforeunload）和壳子的钩子都要，两个各管一边
  mountShellHook();
  onResize();

  try {
    await projects.load();
  } catch (err) {
    message.error(err.message);
  }

  // 个人偏好（第七轮第 2 节）：分组、收藏、最近打开。拉不到不影响主流程 ——
  // 顶多是没有分组、没有收藏，项目照常能切
  prefs.load().catch(function () {});

  // 探测「是不是在网关上」。放在项目加载之后：它不影响主流程，慢一点没关系
  gateway.load().catch(function () {}).finally(function () {
    gateway.start();
  });
});

onBeforeUnmount(function () {
  gateway.stop();
  unmountShellHook();
  window.removeEventListener('mousemove', onMove);
  window.removeEventListener('mouseup', stopDrag);
  window.removeEventListener('resize', onResize);
  window.removeEventListener('beforeunload', onBeforeUnload);
  window.removeEventListener('keydown', onKeydown);
  stopDrag();
});
</script>

<template>
  <div class="shell">
    <top-bar @about="showAbout = true">
      <template #project>
        <project-switcher @change="onProjectChange" />
        <!--
          Mock 故障模拟开着时的橙色小标（第七轮第 1 节）：这个项目的 Mock 会按比例故意出错，
          所有调它的人都受影响 —— 放个显眼的标记免得忘了关，点了去设置。
        -->
        <button v-if="mockFaultsOn" class="fault-badge" :title="t('views.wbFaultBadgeTitle')" @click="openFaultSettings">
          {{ t('views.wbFaultBadge') }}
        </button>
      </template>
    </top-bar>

    <n-alert
      v-if="versionMismatch"
      type="warning"
      closable
      class="version-banner"
      @close="dismissVersionBanner"
    >
      <span class="version-text">
        {{ t('views.wbNewVersion', { cloud: versionMismatch.cloudVersion, local: versionMismatch.gatewayVersion }) }}
      </span>
      <update-action />
    </n-alert>

    <div class="body">
      <!--
        侧栏收起时不是整块消失，而是缩成 40px 的图标栏（SideBar 自己管），
        所以这里只改宽度，不用 v-show —— 否则目录树会被卸载重建。
      -->
      <aside class="left" :style="{ width: collapsed ? '40px' : leftWidth + 'px' }">
        <side-bar
          :collapsed="collapsed"
          @toggle="toggleSidebar"
          @open="onOpenApi"
          @new-api="onNewApi"
          @new-ws="onNewWs"
          @new-sio="onNewSio"
          @new-grpc="onNewGrpc"
          @new-mqtt="onNewMqtt"
          @new-tcp="onNewTcp"
          @new-udp="onNewUdp"
          @open-folder="onOpenFolder"
          @run="onRun"
          @import="ui.openImport()"
        />
      </aside>

      <div
        v-show="!collapsed"
        class="splitter"
        :class="{ active: dragging }"
        @mousedown.prevent="startDrag"
      />

      <main class="right">
        <!--
          标签行要一直挂着：右边的环境切换器（和它拉环境列表的 watcher）不能卸载 ——
          否则新建请求时环境变量就没了。侧栏切到「环境」时只是藏起来（v-show）。
        -->
        <div v-show="ui.sidebarTab !== 'env'" class="tab-bar">
          <div class="tab-list">
            <div
              v-for="tab in tabs.tabs"
              :key="tab.key"
              class="tab-item"
              :class="{ active: tab.key === tabs.activeKey, preview: tab.preview }"
              :title="tab.preview ? t('views.wbPreviewHint') : ''"
              @click="tabs.activate(tab.key)"
              @dblclick="tabs.pin(tab.key)"
              @contextmenu.prevent="openTabMenu($event, tab)"
            >
              <span
                v-if="tabMethod(tab)"
                class="tab-method"
                :style="{ color: methodColor(tabMethod(tab)) }"
              >{{ tabMethod(tab) }}</span>
              <span v-if="tab.dirty" class="dot" :title="t('views.wbDirtyDot')" />
              <span class="tab-title">{{ tab.title }}</span>
              <span class="tab-close" :title="t('views.wbClose')" @click.stop="closeTab(tab)">×</span>
            </div>

            <button class="tab-add" :title="t('views.wbNewRequest')" @click="tabs.openDraft(null)">
              <n-icon size="15" :component="Plus" />
            </button>
          </div>

          <div class="tab-tail">
            <env-switcher />
          </div>
        </div>

        <!--
          侧栏切到「环境」：右边整块是环境编辑区，不和接口挤在一排标签页里（用户 2026-09-30）。
          请求区这时用 v-if 卸掉，免得它的 ⌘S 也跟着响；标签页的状态都在 store 里，切回来照旧。
        -->
        <div v-if="ui.sidebarTab === 'env'" class="tab-body">
          <mock-env-tab v-if="envs.editing && envs.editing.builtin" />
          <env-tab v-else-if="envs.editing" :key="envs.editing.id" :env-id="envs.editing.id" />
          <div v-else class="placeholder">
            <n-empty :description="t('views.wbNoEnvs')" />
          </div>
        </div>

        <div v-else class="tab-body">
          <folder-tab
            v-if="tabs.active && tabs.active.kind === 'folder'"
            :key="tabs.activeKey"
            :tab="tabs.active"
            @run="onRun"
          />
          <runner-tab
            v-else-if="tabs.active && tabs.active.kind === 'runner'"
            :key="tabs.activeKey"
            :tab="tabs.active"
          />
          <load-tab
            v-else-if="tabs.active && tabs.active.kind === 'load'"
            :key="tabs.activeKey"
            :tab="tabs.active"
          />
          <suite-tab
            v-else-if="tabs.active && tabs.active.kind === 'suite'"
            :key="tabs.activeKey"
            :tab="tabs.active"
          />
          <env-diff-tab
            v-else-if="tabs.active && tabs.active.kind === 'envdiff'"
            :key="tabs.activeKey"
            :tab="tabs.active"
          />
          <ws-tab
            v-else-if="tabs.active && tabs.active.kind === 'ws'"
            :key="tabs.activeKey"
            :tab="tabs.active"
          />
          <sio-tab
            v-else-if="tabs.active && tabs.active.kind === 'sio'"
            :key="tabs.activeKey"
            :tab="tabs.active"
          />
          <grpc-tab
            v-else-if="tabs.active && tabs.active.kind === 'grpc'"
            :key="tabs.activeKey"
            :tab="tabs.active"
          />
          <mqtt-tab
            v-else-if="tabs.active && tabs.active.kind === 'mqtt'"
            :key="tabs.activeKey"
            :tab="tabs.active"
          />
          <socket-tab
            v-else-if="tabs.active && tabs.active.kind === 'socket'"
            :key="tabs.activeKey"
            :tab="tabs.active"
          />
          <request-tab
            v-else-if="tabs.active"
            :key="tabs.activeKey"
            :tab="tabs.active"
          />
          <div v-else class="placeholder">
            <n-empty :description="t('views.wbPickApi')" />
          </div>
        </div>
      </main>
    </div>

    <context-menu
      v-model:show="tabMenu.show"
      :x="tabMenu.x"
      :y="tabMenu.y"
      :options="TAB_MENU_OPTIONS"
      @select="onTabMenuSelect"
    />

    <mock-log-drawer />
    <help-drawer />
    <import-dialog />
    <quick-open />
    <find-replace-dialog />
    <about-dialog v-model:show="showAbout" />
  </div>
</template>

<style scoped>
/* 「故障模拟中」小标：橙色、低饱和，别抢项目名的注意力但要看得见 */
.fault-badge {
  flex: none;
  height: 20px;
  padding: 0 7px;
  border: none;
  border-radius: 10px;
  background: rgba(240, 160, 32, 0.18);
  color: #d9821a;
  font-size: 11px;
  line-height: 20px;
  white-space: nowrap;
  cursor: pointer;
}

.fault-badge:hover {
  background: rgba(240, 160, 32, 0.3);
}
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

/* 版本不一致的横幅：横在顶栏下面，别把它挤到视口外 */
.version-banner {
  flex: none;
  border-radius: 0;
  font-size: 12px;
}

.left {
  flex: none;
  min-width: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.16));
}

.splitter {
  position: relative;
  flex: none;
  /* 可拖的区域 5px 宽；看得见的只有中间那条线，和上下分栏的分隔线同一套样式 */
  width: 5px;
  cursor: col-resize;
  margin-left: -3px;
  margin-right: -2px;
  z-index: 2;
  background: transparent;
}

.splitter::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 2px;
  width: 1px;
  background: transparent;
  transition: background 0.15s, width 0.15s, left 0.15s;
}

.splitter:hover::after,
.splitter.active::after {
  left: 1.5px;
  width: 2px;
  background: var(--apiloop-divider-active);
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
  align-items: center;
  gap: 8px;
  padding: 3px 8px 3px 6px;
  border-bottom: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.24));
  background: rgba(128, 128, 128, 0.06);
}

/* 标签列表占满剩下的宽度，标签多了就横向滚 */
.tab-list {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 2px;
  overflow-x: auto;
}

.tab-item {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px 0 10px;
  height: 26px;
  max-width: 220px;
  border-radius: 5px;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}

.tab-item:hover {
  background: rgba(128, 128, 128, 0.12);
}

/* 选中的标签页：浅灰底胶囊，不用下划线 */
.tab-item.active {
  background: rgba(128, 128, 128, 0.2);
}

/* 标签行最后面的「＋」：新建一个空白请求 */
.tab-add {
  flex: none;
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

.tab-add:hover {
  background: rgba(128, 128, 128, 0.14);
  opacity: 1;
}

/* 最右边：环境快速查看 + 环境切换 */
.tab-tail {
  flex: none;
  display: flex;
  align-items: center;
  gap: 2px;
}

.tab-title {
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 预览标签页：标题斜体（和 Postman / VS Code 一样），再单击别的接口会被替换 */
.tab-item.preview .tab-title {
  font-style: italic;
}

/* 方法缩写：只有文字颜色，没有边框和底色 */
.tab-method {
  flex: none;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.2px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
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
