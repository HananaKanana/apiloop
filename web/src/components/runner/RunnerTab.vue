<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  NButton,
  NCheckbox,
  NIcon,
  NInputNumber,
  NSelect,
  NTag,
  NTooltip,
  useMessage
} from 'naive-ui';
import { ChevronDown, ChevronRight, PlayerPlay, PlayerStop, DeviceFloppy } from '@vicons/tabler';
import { useProjectStore } from '@/stores/project';
import { useSuitesStore } from '@/stores/suites';
import * as suitesApi from '@/api/suites';
import { useRunnerStore } from '@/stores/runner';
import { useTabsStore } from '@/stores/tabs';
import { useTreeStore } from '@/stores/tree';
import { useEnvStore, MOCK_ENV_ID, MOCK_LOCAL_ENV_ID } from '@/stores/env';
import { useGatewayStore } from '@/stores/gateway';
import { collectApiNodes } from '@/utils/tree';
import { methodColor } from '@/utils/method';
import { runnerSummary } from '@/utils/runner';

/**
 * 「运行」标签页（第 2 节 批量运行）：把某个目录里的接口按顺序跑一遍。
 *
 * 组件只是视图 —— **跑的那一段在 `stores/runner.js`**，状态挂在 `tab.runner` 上。
 * 所以运行中切到别的标签页（这个组件被卸载）不会中断，关掉标签页才会。
 *
 * 结果只活在这个标签页里，关掉就没了（不落库，也不进历史，除非勾了「记到历史里」）。
 */
const props = defineProps({
  tab: { type: Object, required: true }
});

const runnerStore = useRunnerStore();
const tabs = useTabsStore();
const tree = useTreeStore();
const envs = useEnvStore();
const gateway = useGatewayStore();
const { t } = useI18n();

const runner = computed(function () { return props.tab.runner; });

/** 要跑的请求：目录树顺序（WebSocket 不列出来） */
const items = computed(function () {
  return collectApiNodes(tree.nodes, props.tab.folderId);
});

function isChecked(apiId) {
  return runner.value.excluded.indexOf(apiId) === -1;
}

function setChecked(apiId, value) {
  const excluded = runner.value.excluded.slice();
  const index = excluded.indexOf(apiId);
  if (value && index !== -1) excluded.splice(index, 1);
  if (!value && index === -1) excluded.push(apiId);
  runner.value.excluded = excluded;
}

const allChecked = computed(function () {
  return items.value.length > 0 && runner.value.excluded.length === 0;
});

function toggleAll() {
  runner.value.excluded = allChecked.value
    ? items.value.map(function (node) { return node.id; })
    : [];
}

const checkedCount = computed(function () {
  return items.value.filter(function (node) { return isChecked(node.id); }).length;
});

/* ---------------- 存为测试集（第八轮第 1 节） ---------------- */

const projects = useProjectStore();
const suites = useSuitesStore();
const message = useMessage();
const savingSuite = ref(false);

/**
 * 把当前勾选的接口按顺序建成一个新测试集，然后打开它。
 *
 * 批量运行是「这一次跑一批」，测试集是「存下来反复跑」—— 跑完觉得这套顺序有用，
 * 一键存下来最省事（不用再去侧栏一个个加）。
 */
async function saveAsSuite() {
  const picked = items.value.filter(function (node) { return isChecked(node.id); });
  if (!picked.length) return;

  savingSuite.value = true;
  try {
    const now = new Date();
    const pad = function (n) { return String(n).padStart(2, '0'); };
    const stamp = pad(now.getMonth() + 1) + '-' + pad(now.getDate()) + ' ' +
      pad(now.getHours()) + ':' + pad(now.getMinutes());
    const name = t('runner.suiteName', { stamp: stamp });

    const data = await suitesApi.createSuite(projects.currentId, {
      name: name,
      steps: picked.map(function (node) { return { apiId: node.id }; })
    });

    // 侧栏那一栏读的是这个 store：放进去，切过去就能看到
    suites.put(Object.assign({}, data.suite, { data: undefined }));
    message.success(t('runner.suiteSaved', { name: data.suite.name }));
    tabs.openSuite(data.suite.id, data.suite.name);
  } catch (err) {
    message.error(err.message);
  } finally {
    savingSuite.value = false;
  }
}

/* ---------------- 设置 ---------------- */

/** 默认跟当前环境；用户在设置里选过就是那个（`undefined` 表示还没选过） */
const envId = computed({
  get: function () {
    return runner.value.envId === undefined ? envs.selectedId : runner.value.envId;
  },
  set: function (value) {
    runner.value.envId = value;
  }
});

const envOptions = computed(function () {
  const list = [{ label: t('runner.noEnvironment'), value: '' }];
  // 内置 Mock 环境：本机未登录时用不了（mock 服务在云端）
  if (gateway.isGateway) list.push({ label: t('layout.mockLocal'), value: MOCK_LOCAL_ENV_ID });
  list.push({
    label: gateway.isGateway ? t('layout.mockCloud') : t('runner.mockBuiltIn'),
    value: MOCK_ENV_ID,
    disabled: !gateway.mockAvailable
  });
  envs.environments.forEach(function (env) {
    list.push({ label: env.name, value: env.id });
  });
  return list;
});

/* ---------------- 汇总与过滤 ---------------- */

const summary = computed(function () { return runnerSummary(runner.value); });

const filter = ref('all');

const visibleRows = computed(function () {
  const rows = runner.value.results || [];
  if (filter.value === 'failed') {
    return rows.filter(function (row) { return row.failed || row.aborted; });
  }
  return rows;
});

const failedCount = computed(function () {
  return (runner.value.results || []).filter(function (row) {
    return row.failed || row.aborted;
  }).length;
});

/** 运行中每半秒刷新一次「耗时」，不然一个慢请求会让它一直停着不动 */
const now = ref(Date.now());
let clock = null;

onMounted(function () {
  clock = setInterval(function () {
    if (runner.value.running) now.value = Date.now();
  }, 500);
});

onBeforeUnmount(function () {
  if (clock) clearInterval(clock);
});

const elapsedMs = computed(function () {
  const state = runner.value;
  if (!state.startedAt) return 0;
  if (state.running) return now.value - state.startedAt;
  return (state.finishedAt || state.startedAt) - state.startedAt;
});

function formatMs(value) {
  if (value === null || value === undefined) return '—';
  if (value < 1000) return Math.round(value) + ' ms';
  return (value / 1000).toFixed(value < 10000 ? 1 : 0) + ' s';
}

function rowStatusType(row) {
  if (row.pending || row.aborted) return 'default';
  if (!row.status) return 'error';
  if (row.status >= 200 && row.status < 300) return 'success';
  if (row.status >= 400 && row.status < 500) return 'warning';
  if (row.status >= 500) return 'error';
  return 'default';
}

function rowStatusText(row) {
  if (row.pending) return '…';
  if (row.aborted) return t('runner.stopped');
  if (row.status) return String(row.status);
  return t('runner.failed');
}

function rowTestsText(row) {
  if (row.pending) return '…';
  if (!row.total) return '—';
  return row.passed + '/' + row.total;
}

function rowFailed(row) {
  return Boolean(row.failed || row.aborted);
}

function openApiTab(row) {
  tabs.openApi(row.apiId).catch(function () {});
}

/* ---------------- 开始 / 停止 ---------------- */

/**
 * 直接打开云端、云端又不替网页发请求（SERVER_SEND=0）：批量运行要一个个发请求，
 * 在这里一样发不出去，入口灰掉并说明原因，别等点了才报错。
 * 云端开了 SERVER_SEND=1 时照常能用（判断用的是 cloudSendBlocked，不是 isGateway）。
 */
const sendBlocked = computed(function () {
  return gateway.cloudSendBlocked;
});

function onStart() {
  if (sendBlocked.value) {
    message.warning(t('runner.webBlocked'));
    return;
  }
  runnerStore.start(props.tab);
}

function onStop() {
  runnerStore.stop(props.tab);
}
</script>

<template>
  <div class="runner-tab">
    <div class="head">
      <span class="title">{{ tab.title }}</span>
      <span class="spacer" />
      <n-button
        v-if="!runner.running"
        size="small"
        secondary
        :disabled="!checkedCount"
        :loading="savingSuite"
        @click="saveAsSuite"
      >
        <template #icon>
          <n-icon :component="DeviceFloppy" />
        </template>
        {{ t('runner.saveAsSuite') }}
      </n-button>
      <n-button v-if="runner.running" size="small" type="error" secondary @click="onStop">
        <template #icon>
          <n-icon :component="PlayerStop" />
        </template>
        {{ t('runner.stop') }}
      </n-button>
      <!-- 网页版、云端不替网页发请求：外面套一层 span 是因为禁用的按钮不派发鼠标事件，提示挂不上去 -->
      <n-tooltip v-else-if="sendBlocked" trigger="hover">
        <template #trigger>
          <span class="start-wrap">
            <n-button size="small" type="primary" disabled>
              <template #icon>
                <n-icon :component="PlayerPlay" />
              </template>
              {{ t('runner.start') }}
            </n-button>
          </span>
        </template>
        {{ t('runner.webBlockedHint') }}
      </n-tooltip>
      <n-button
        v-else
        size="small"
        type="primary"
        :disabled="!checkedCount"
        @click="onStart"
      >
        <template #icon>
          <n-icon :component="PlayerPlay" />
        </template>
        {{ t('runner.start') }}
      </n-button>
    </div>

    <div class="body">
      <!-- 左边：要跑的请求，按目录树顺序，默认全选 -->
      <aside class="pane-list">
        <div class="pane-title">
          <span>{{ t('runner.requestsTitle', { checked: checkedCount, total: items.length }) }}</span>
          <button v-if="items.length" class="link" @click="toggleAll">
            {{ allChecked ? t('runner.unselectAll') : t('runner.selectAll') }}
          </button>
        </div>
        <div class="list">
          <label
            v-for="node in items"
            :key="node.id"
            class="item"
            :title="node.name"
          >
            <n-checkbox
              :checked="isChecked(node.id)"
              :disabled="runner.running"
              @update:checked="(value) => setChecked(node.id, value)"
            />
            <span
              class="method"
              :style="{ color: methodColor(node.api.method) }"
            >{{ String(node.api.method || 'GET').toUpperCase() }}</span>
            <span class="name">{{ node.name || t('runner.unnamedApi') }}</span>
          </label>

          <div v-if="!items.length" class="list-empty">
            {{ t('runner.emptyList', { scope: tab.folderId ? t('runner.folder') : t('runner.project') }) }}
          </div>
        </div>
      </aside>

      <!-- 右边：设置 + 结果 -->
      <section class="pane-main">
        <div class="settings">
          <div class="field">
            <span class="label">{{ t('runner.environment') }}</span>
            <n-select
              v-model:value="envId"
              size="small"
              :options="envOptions"
              :disabled="runner.running"
              style="width: 160px"
            />
          </div>
          <div class="field">
            <span class="label">{{ t('runner.repeat') }}</span>
            <n-input-number
              v-model:value="runner.repeat"
              size="small"
              :min="1"
              :max="100"
              :disabled="runner.running"
              style="width: 96px"
            />
          </div>
          <div class="field">
            <span class="label">{{ t('runner.interval') }}</span>
            <n-input-number
              v-model:value="runner.intervalMs"
              size="small"
              :min="0"
              :max="60000"
              :step="100"
              :disabled="runner.running"
              style="width: 110px"
            />
            <span class="unit">{{ t('runner.milliseconds') }}</span>
          </div>
          <label class="field switch">
            <n-checkbox v-model:checked="runner.stopOnFail" :disabled="runner.running" />
            <span>{{ t('runner.stopOnFail') }}</span>
          </label>
          <label class="field switch">
            <n-checkbox v-model:checked="runner.recordHistory" :disabled="runner.running" />
            <span>{{ t('runner.recordHistory') }}</span>
          </label>
        </div>

        <div v-if="runner.error" class="notice">{{ runner.error }}</div>

        <div v-if="runner.results.length" class="summary">
          <span>{{ t('runner.progress', { total: runner.total, done: runner.done }) }}</span>
          <span class="dot">·</span>
          <span>
            {{ t('runner.assertions') }}
            <b :class="{ bad: summary.failed > 0 }">{{ summary.passed }}</b>/{{ summary.total }} {{ t('runner.passedWord') }}
          </span>
          <span v-if="summary.failed" class="bad">{{ t('runner.failedLabel', { n: summary.failed }) }}</span>
          <span class="dot">·</span>
          <span>{{ t('runner.elapsed', { time: formatMs(elapsedMs) }) }}</span>
        </div>

        <div v-if="runner.results.length" class="filter">
          <button
            class="filter-item"
            :class="{ active: filter === 'all' }"
            @click="filter = 'all'"
          >{{ t('runner.filterAll', { n: summary.requests }) }}</button>
          <button
            class="filter-item"
            :class="{ active: filter === 'failed' }"
            @click="filter = 'failed'"
          >{{ t('runner.filterFailed', { n: failedCount }) }}</button>
        </div>

        <div class="results">
          <div
            v-for="row in visibleRows"
            :key="row.key"
            class="row"
            :class="{ failed: rowFailed(row) }"
          >
            <div class="row-main" @click="row.open = !row.open">
              <n-icon
                class="caret"
                size="14"
                :component="row.open ? ChevronDown : ChevronRight"
              />
              <span class="round">{{ t('runner.roundNth', { n: row.round }) }}</span>
              <span class="method" :style="{ color: methodColor(row.method) }">{{ row.method }}</span>
              <button class="name link" :title="row.url" @click.stop="openApiTab(row)">{{ row.name }}</button>
              <span class="spacer" />
              <n-tag size="small" :bordered="false" :type="rowStatusType(row)">
                {{ rowStatusText(row) }}
              </n-tag>
              <span class="ms">{{ row.pending ? '' : formatMs(row.ms) }}</span>
              <span class="tests" :class="{ bad: row.total && row.passed !== row.total }">
                {{ rowTestsText(row) }}
              </span>
            </div>

            <div v-if="row.open" class="row-detail">
              <div v-if="row.error" class="detail-error">{{ row.error }}</div>

              <div v-if="row.tests.length" class="tests-list">
                <div v-for="(item, index) in row.tests" :key="index" class="test-line">
                  <span class="test-mark" :class="item.passed ? 'pass' : 'fail'">
                    {{ item.passed ? '✓' : '×' }}
                  </span>
                  <span class="test-name">{{ item.name }}</span>
                  <span v-if="!item.passed && item.error" class="test-reason">{{ item.error }}</span>
                </div>
              </div>
              <div v-else-if="!row.error" class="detail-empty">{{ t('runner.noAssertions') }}</div>

              <div v-if="row.console.length" class="console">
                <div v-for="(line, index) in row.console" :key="index" class="console-line">
                  <span class="console-level" :class="line.level">{{ line.level }}</span>
                  <span class="console-text">{{ line.text }}</span>
                </div>
              </div>
            </div>
          </div>

          <div v-if="!runner.results.length" class="placeholder">
            {{ runner.running ? t('runner.running') : t('runner.idleHint') }}
          </div>

          <div v-else-if="!visibleRows.length" class="placeholder">
            {{ t('runner.noFailedRequests') }}
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.runner-tab {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.16));
}

.title {
  font-size: 14px;
  font-weight: 600;
}

.spacer {
  flex: 1;
}

/* 禁用的按钮不派发鼠标事件，提示要挂在外面的 span 上（和地址栏的发送按钮一个做法） */
.start-wrap {
  display: inline-flex;
  flex: none;
}

.body {
  flex: 1;
  min-height: 0;
  display: flex;
}

/* 左边那一栏：和目录树同宽，跑之前先在这儿确认一遍要跑哪些 */
.pane-list {
  flex: none;
  width: 260px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.16));
}

.pane-title {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px 6px 12px;
  font-size: 12px;
  opacity: 0.7;
}

.list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 0 6px 8px;
}

.item {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 6px;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
}

.item:hover {
  background: rgba(128, 128, 128, 0.12);
}

.item .method {
  flex: none;
  width: 44px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.2px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.item .name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.list-empty {
  padding: 8px 6px;
  font-size: 12px;
  opacity: 0.5;
}

.pane-main {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.settings {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 18px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.12));
  font-size: 12px;
}

.field {
  display: flex;
  align-items: center;
  gap: 6px;
}

.field .label {
  opacity: 0.65;
}

.field .unit {
  opacity: 0.5;
}

.field.switch {
  cursor: pointer;
}

.notice {
  flex: none;
  margin: 10px 16px 0;
  padding: 6px 10px;
  border-radius: 4px;
  background: rgba(208, 48, 80, 0.08);
  color: #d03050;
  font-size: 12px;
}

.summary {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 10px 16px 6px;
  font-size: 12px;
  opacity: 0.85;
}

.summary .dot {
  opacity: 0.4;
}

.bad {
  color: #d03050;
}

.filter {
  flex: none;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 16px 8px;
}

.filter-item {
  padding: 3px 10px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  font-size: 12px;
  cursor: pointer;
  opacity: 0.65;
}

.filter-item:hover {
  background: rgba(128, 128, 128, 0.12);
  opacity: 1;
}

.filter-item.active {
  background: rgba(128, 128, 128, 0.18);
  opacity: 1;
}

.results {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 0 16px 16px;
}

.row {
  border: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.16));
  border-radius: 6px;
  margin-bottom: 4px;
  font-size: 12px;
}

/* 失败的标红：颜色只留给真的要人去看的那几行 */
.row.failed {
  border-color: rgba(208, 48, 80, 0.5);
  background: rgba(208, 48, 80, 0.05);
}

.row-main {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  cursor: pointer;
}

.row-main .caret {
  flex: none;
  opacity: 0.45;
}

.round {
  flex: none;
  opacity: 0.6;
}

.row-main .method {
  flex: none;
  width: 44px;
  font-size: 10px;
  font-weight: 700;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.row-main .ms {
  flex: none;
  width: 68px;
  text-align: right;
  opacity: 0.65;
}

.row-main .tests {
  flex: none;
  width: 44px;
  text-align: right;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.link {
  padding: 0;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
  text-align: left;
}

button.link {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

button.link:hover {
  color: var(--apiloop-primary);
  text-decoration: underline;
}

.row-detail {
  padding: 4px 10px 10px 32px;
  border-top: 1px solid rgba(128, 128, 128, 0.14);
}

.detail-error {
  padding: 6px 0;
  color: #d03050;
}

.detail-empty {
  padding: 6px 0;
  opacity: 0.55;
}

.test-line {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 2px 0;
}

.test-mark {
  flex: none;
  width: 12px;
  font-weight: 700;
}

.test-mark.pass {
  color: #18a058;
}

.test-mark.fail {
  color: #d03050;
}

.test-reason {
  opacity: 0.7;
}

.console {
  margin-top: 6px;
  padding: 6px 8px;
  border-radius: 4px;
  background: rgba(128, 128, 128, 0.08);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.console-line {
  display: flex;
  gap: 8px;
  padding: 1px 0;
}

.console-level {
  flex: none;
  width: 36px;
  opacity: 0.5;
}

.console-level.warn {
  color: #f0a020;
}

.console-level.error {
  color: #d03050;
}

.console-text {
  min-width: 0;
  word-break: break-all;
}

.placeholder {
  padding: 24px 0;
  text-align: center;
  font-size: 12px;
  opacity: 0.5;
}
</style>
