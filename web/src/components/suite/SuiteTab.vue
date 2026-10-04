<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  NAlert,
  NButton,
  NIcon,
  NProgress,
  NSelect,
  NSpin,
  NTabPane,
  NTabs,
  useMessage
} from 'naive-ui';
import { PlayerPlay, PlayerStop } from '@vicons/tabler';
import SuiteStepsPane from '@/components/suite/SuiteStepsPane.vue';
import SuiteDataPane from '@/components/suite/SuiteDataPane.vue';
import SuiteSettingsPane from '@/components/suite/SuiteSettingsPane.vue';
import SuiteRunsPane from '@/components/suite/SuiteRunsPane.vue';
import SuiteReport from '@/components/suite/SuiteReport.vue';
import InlineRename from '@/components/common/InlineRename.vue';
import { useProjectStore } from '@/stores/project';
import { useEnvStore, MOCK_ENV_ID } from '@/stores/env';
import { useSuitesStore } from '@/stores/suites';
import { useSuiteRunStore } from '@/stores/suiteRun';
import { useGatewayStore } from '@/stores/gateway';
import { useTabsStore } from '@/stores/tabs';
import { mockBaseFor } from '@/utils/mock';
import * as suitesApi from '@/api/suites';

/**
 * 测试集标签页（第八轮第 1 节）。
 *
 * 顶部：名字（双击改名）· 环境下拉 · 运行 / 停止。下面四个页签：步骤 / 数据 / 设置 / 运行记录。
 * **编辑是自动保存的**（防抖 700ms）：测试集不像接口那样有「保存」这一步，
 * 名字是双击就改、步骤是拖着排的，中间插一个保存按钮只会让人忘了点。
 *
 * 运行状态在 `stores/suiteRun.js`（切标签页不能断），跑完自动切到这次的报告。
 */
const props = defineProps({
  tab: { type: Object, required: true }
});

const projects = useProjectStore();
const envs = useEnvStore();
const suites = useSuitesStore();
const runs = useSuiteRunStore();
const gateway = useGatewayStore();
const tabs = useTabsStore();
const message = useMessage();

const suite = ref(null);
const loading = ref(false);
const loadError = ref('');
const activePane = ref('steps');
const view = ref('edit');       // edit | progress | report

const canEdit = computed(function () { return projects.canEdit; });

const suiteId = computed(function () { return props.tab.suiteId || ''; });
const runState = computed(function () { return runs.stateOf(suiteId.value); });
const isRunning = computed(function () { return runState.value.phase === 'running'; });

/** 环境下拉：真实环境 + 内置的 Mock 环境（和「发送」那边一个口径） */
const envOptions = computed(function () {
  const list = envs.environments.map(function (env) {
    return { label: env.name, value: env.id };
  });
  return [{ label: 'Mock（内置）', value: MOCK_ENV_ID }].concat(list);
});

const environmentId = ref('');

function fillEnv() {
  environmentId.value = envs.selectedId || (envs.environments[0] && envs.environments[0].id) || MOCK_ENV_ID;
}

/* ---------------- 加载与自动保存 ---------------- */

async function load() {
  if (!suiteId.value) return;

  loading.value = true;
  loadError.value = '';
  try {
    const data = await suitesApi.getSuite(suiteId.value);
    suite.value = data.suite;
    fillEnv();
  } catch (err) {
    loadError.value = err.message;
  } finally {
    loading.value = false;
  }
}

let saveTimer = null;
const savedAt = ref(0);

/** 改了就排一次保存（防抖 700ms）：步骤拖来拖去不该每动一下就写一次库 */
function patch(changes) {
  if (!suite.value || !canEdit.value) return;
  suite.value = Object.assign({}, suite.value, changes);
  scheduleSave();
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 700);
}

async function save() {
  if (!suite.value || !canEdit.value) return;

  const payload = {
    name: suite.value.name,
    description: suite.value.description,
    steps: suite.value.steps,
    data: suite.value.data,
    settings: suite.value.settings
  };

  try {
    const data = await suitesApi.updateSuite(suiteId.value, payload);
    suite.value = data.suite;
    savedAt.value = Date.now();
    // 侧栏那一行的步骤数 / 名字跟着变
    suites.put(Object.assign({}, data.suite, { data: undefined }));
    tabs.renameSuite(suiteId.value, data.suite.name);
  } catch (err) {
    message.error('保存失败：' + err.message);
  }
}

function rename(name) {
  const text = String(name || '').trim();
  if (!text || !suite.value) return;
  patch({ name: text });
  tabs.renameSuite(suiteId.value, text);
}

onMounted(function () {
  load();
  if (!envs.environments.length) envs.load(projects.currentId).catch(function () {});
});

onBeforeUnmount(function () {
  if (saveTimer) {
    clearTimeout(saveTimer);
    // 关标签页前把没保存的改动落下去（防抖窗口里关掉就丢了）
    save();
  }
});

watch(suiteId, function () { load(); });

/* ---------------- 运行 ---------------- */

// 跑起来了 / 跑完了：自动切进度和报告（用户手动切过就听他的，不再抢）
let autoSwitch = true;

watch(
  function () { return runState.value.phase; },
  function (phase) {
    if (!autoSwitch) return;
    if (phase === 'running') view.value = 'progress';
    else if (phase === 'done') view.value = 'report';
    else if (phase === 'error') view.value = 'progress';
  }
);

function run() {
  if (gateway.cloudSendBlocked) {
    // 网页版、云端不替网页发请求（SERVER_SEND=0）。开了 SERVER_SEND=1 的云端照样能跑
    message.warning('网页版不能运行测试集，请在客户端里运行');
    return;
  }
  if (!suite.value) return;

  autoSwitch = true;
  view.value = 'progress';
  runs.start(suiteId.value, {
    environmentId: environmentId.value || undefined,
    mockBase: mockBaseFor(environmentId.value, projects.current)
  });
}

function stop() {
  runs.stop(suiteId.value);
}

/** 进度：第几轮第几步（服务端一条条推 step 事件） */
const progress = computed(function () {
  const state = runState.value;
  const last = state.steps[state.steps.length - 1];
  const iteration = last ? Number(last.iteration) || 0 : 0;
  const index = last ? Number(last.index) || 0 : 0;

  return {
    label: state.iterations
      ? '第 ' + (iteration + 1) + '/' + state.iterations + ' 轮 · 第 ' + (index + 1) + '/' + state.stepCount + ' 步'
      : '准备中…',
    percent: state.stepCount && state.iterations
      ? Math.min(100, Math.round((state.steps.filter(function (s) { return !s.skipped; }).length /
        (state.stepCount * state.iterations)) * 100))
      : 0
  };
});

const onlyFailed = ref(false);

const visibleSteps = computed(function () {
  const list = runState.value.steps;
  return onlyFailed.value ? list.filter(function (step) { return step.ok === false; }) : list;
});

const failedCount = computed(function () {
  return runState.value.steps.filter(function (step) { return step.ok === false; }).length;
});

/** 这次的报告：跑完拿到的 runId 对不上云端记录时，直接用本地这份结果渲染 */
const reportRun = computed(function () {
  const state = runState.value;
  return {
    suiteName: suite.value ? suite.value.name : props.tab.title,
    status: state.status,
    environmentName: (envs.environments.find(function (env) { return env.id === environmentId.value; }) || {}).name || '',
    source: 'app',
    label: '',
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    summary: state.summary || {},
    result: state.result || { iterations: groupByIteration(state.steps) }
  };
});

function groupByIteration(steps) {
  const map = {};
  const order = [];

  steps.forEach(function (step) {
    const index = Number(step.iteration) || 0;
    if (!map[index]) {
      map[index] = { index: index, data: null, steps: [] };
      order.push(index);
    }
    map[index].steps.push(step);
  });

  return order.map(function (index) { return map[index]; });
}

/** 从运行记录里打开一份历次报告 */
const historyRun = ref(null);

async function openRun(runId) {
  try {
    const data = await suitesApi.getRun(runId);
    historyRun.value = Object.assign({ suiteName: suite.value ? suite.value.name : '' }, data.run);
    view.value = 'report';
  } catch (err) {
    message.error(err.message);
  }
}

function backToEdit() {
  autoSwitch = false;
  historyRun.value = null;
  view.value = 'edit';
}
</script>

<template>
  <div class="suite-tab">
    <div class="head">
      <inline-rename
        class="title"
        :value="suite ? suite.name : tab.title"
        :disabled="!canEdit"
        @rename="rename"
      />
      <span v-if="suite" class="meta">{{ suite.stepCount }} 步</span>

      <span class="spacer" />

      <n-select
        class="env"
        size="small"
        :options="envOptions"
        :value="environmentId"
        :disabled="isRunning"
        @update:value="(value) => { environmentId = value; }"
      />

      <n-button v-if="isRunning" size="small" type="warning" @click="stop">
        <template #icon><n-icon :component="PlayerStop" /></template>
        停止
      </n-button>
      <n-button v-else size="small" type="primary" :disabled="!suite" @click="run">
        <template #icon><n-icon :component="PlayerPlay" /></template>
        运行
      </n-button>

      <n-button v-if="view !== 'edit'" size="small" quaternary @click="backToEdit">返回编辑</n-button>
    </div>

    <div class="body">
      <n-spin :show="loading">
        <n-alert v-if="loadError" type="error" :show-icon="false">{{ loadError }}</n-alert>

        <template v-else-if="suite">
          <!-- 运行中：进度视图 -->
          <div v-if="view === 'progress'" class="progress-view">
            <div class="progress-head">
              <span class="progress-label">{{ progress.label }}</span>
              <span class="spacer" />
              <span class="failed-count" :class="{ bad: failedCount }">失败 {{ failedCount }}</span>
              <n-button size="tiny" quaternary @click="onlyFailed = !onlyFailed">
                {{ onlyFailed ? '看全部' : '只看失败' }}
              </n-button>
            </div>

            <n-progress type="line" :percentage="progress.percent" :show-indicator="false" />

            <div class="progress-list">
              <div
                v-for="(step, index) in visibleSteps"
                :key="index"
                class="prow"
                :class="{ failed: step.ok === false, skipped: step.skipped }"
              >
                <span class="mark">{{ step.ok === false ? '✗' : '✓' }}</span>
                <span class="iter">第 {{ (Number(step.iteration) || 0) + 1 }} 轮</span>
                <span class="method">{{ step.method }}</span>
                <span class="name">{{ step.name }}</span>
                <span class="spacer" />
                <span class="meta">{{ step.status ? 'HTTP ' + step.status : '' }} {{ step.timeMs }} ms</span>
              </div>
            </div>

            <n-alert v-if="runState.phase === 'error'" type="error" :show-icon="false" class="alert">
              {{ runState.error }}
            </n-alert>
          </div>

          <!-- 报告（刚跑完 / 从运行记录里打开） -->
          <suite-report v-else-if="view === 'report'" :run="historyRun || reportRun" />

          <!-- 编辑：四个页签 -->
          <!-- tabs-padding 和上面标题行的左右边距（16px）对齐，不设的话「步骤」贴着左边的分隔线 -->
          <n-tabs v-else v-model:value="activePane" type="line" size="small" animated :tabs-padding="16">
            <n-tab-pane name="steps" tab="步骤">
              <suite-steps-pane :suite="suite" :disabled="isRunning" @change="patch" />
            </n-tab-pane>
            <n-tab-pane name="data" tab="数据">
              <suite-data-pane :suite="suite" :disabled="isRunning" @change="patch" />
            </n-tab-pane>
            <n-tab-pane name="settings" tab="设置">
              <suite-settings-pane :suite="suite" :disabled="isRunning" @change="patch" />
            </n-tab-pane>
            <n-tab-pane name="runs" tab="运行记录">
              <suite-runs-pane :suite="suite" @open="openRun" />
            </n-tab-pane>
          </n-tabs>
        </template>
      </n-spin>
    </div>

    <p v-if="runState.warning" class="warning">{{ runState.warning }}</p>
  </div>
</template>

<style scoped>
.suite-tab {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.16));
}

.title {
  font-size: 14px;
  font-weight: 600;
}

.meta {
  font-size: 12px;
  opacity: 0.55;
}

.spacer {
  flex: 1;
}

.env {
  width: 180px;
}

.body {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.progress-view {
  padding: 14px 16px;
}

.progress-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
  font-size: 12px;
}

.progress-label {
  font-weight: 600;
}

.failed-count {
  opacity: 0.7;
}

.failed-count.bad {
  color: #d03050;
}

.progress-list {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.prow {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 6px;
  border-radius: 4px;
  font-size: 12px;
}

.prow.failed {
  background: rgba(208, 48, 80, 0.08);
}

.prow.skipped {
  opacity: 0.55;
}

.mark {
  flex: none;
  width: 14px;
  color: #18a058;
}

.prow.failed .mark {
  color: #d03050;
}

.iter {
  flex: none;
  opacity: 0.5;
}

.method {
  flex: none;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-weight: 600;
}

.name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.meta {
  flex: none;
  opacity: 0.6;
}

.alert {
  margin-top: 12px;
}

.warning {
  flex: none;
  margin: 0;
  padding: 6px 16px;
  font-size: 12px;
  color: #d03050;
  border-top: 1px solid rgba(128, 128, 128, 0.16);
}
</style>
