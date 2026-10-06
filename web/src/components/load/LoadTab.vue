<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  NAlert,
  NButton,
  NInput,
  NInputNumber,
  NRadioButton,
  NRadioGroup,
  NSelect,
  NTag,
  NTooltip,
  useMessage
} from 'naive-ui';
import { useLoadStore } from '@/stores/load';
import { useEnvStore, MOCK_ENV_ID } from '@/stores/env';
import { useGatewayStore } from '@/stores/gateway';
import { useDialog } from '@/utils/dialog';
import { copyText } from '@/utils/clipboard';
import { methodColor } from '@/utils/method';
import LoadChart from './LoadChart.vue';
import {
  formatCount,
  formatDuration,
  formatMs,
  formatPercent,
  isProductionEnv,
  limitOf,
  loadPayload,
  summaryText,
  writeSettings
} from '@/utils/load';

/**
 * 「压测」标签页（第八轮第 2 节）。
 *
 * 组件只是视图 —— **跑的那一段在 `stores/load.js`**，状态挂在 `tab.load` 上，
 * 所以运行中切到别的标签页（这个组件被卸载）不会中断，关掉标签页才会。
 *
 * 压测**不存库**：结果只在这个标签页里。设置（并发数、次数……）按接口记在
 * localStorage 里，下次打开沿用。
 */
const props = defineProps({
  tab: { type: Object, required: true }
});

const loadStore = useLoadStore();
const envs = useEnvStore();
const gateway = useGatewayStore();
const message = useMessage();
const dialog = useDialog();
const { t } = useI18n();

/** 未定义变量那条提示里的例子 —— 模板的 `{{ }}` 插值里不能出现 `}}`，所以写在 script 里 */
const varExample = computed(function () { return t('load.varExample'); });

const state = computed(function () { return props.tab.load; });
const running = computed(function () { return Boolean(state.value && state.value.running); });
const settings = computed(function () { return state.value.settings; });

/* ---------------- 环境 ---------------- */

const envId = computed({
  get: function () {
    return state.value.envId === undefined ? envs.selectedId : state.value.envId;
  },
  set: function (value) {
    state.value.envId = value;
  }
});

const envOptions = computed(function () {
  const list = [{ label: t('load.noEnvironment'), value: '' }];
  list.push({ label: t('load.mockBuiltIn'), value: MOCK_ENV_ID, disabled: !gateway.mockAvailable });
  envs.environments.forEach(function (env) {
    list.push({ label: env.name, value: env.id });
  });
  return list;
});

const envName = computed(function () {
  const id = envId.value;
  if (!id) return '';
  if (id === MOCK_ENV_ID) return t('load.mockBuiltIn');
  const env = envs.environments.find(function (item) { return item.id === id; });
  return env ? env.name : '';
});

/* ---------------- 设置 ---------------- */

/** 改了设置就记下来（按接口记），下次打开这个接口的压测页接着用 */
watch(
  function () { return JSON.stringify(settings.value); },
  function () { writeSettings(props.tab.apiId, settings.value); }
);

function range(name) { return limitOf(name); }

/** 网页版（不是从客户端打开的）：压测这条路根本不存在，按钮全灰 */
const blocked = computed(function () {
  return gateway.loaded && !gateway.isGateway;
});

function onStart() {
  const checked = loadPayload(settings.value);
  if (checked.error) {
    message.warning(checked.error);
    return;
  }

  if (isProductionEnv(envName.value)) {
    dialog.error({
      title: t('load.prodTitle'),
      content: t('load.prodConfirm', { env: envName.value }),
      positiveText: t('load.prodContinue'),
      negativeText: t('app.cancel'),
      onPositiveClick: function () { return loadStore.start(props.tab); }
    });
    return;
  }

  loadStore.start(props.tab);
}

function onStop() {
  loadStore.stop(props.tab);
}

/* ---------------- 运行中的数字 ---------------- */

const live = computed(function () { return state.value.live; });

/** 进度：按次数看发了多少，按时长看跑了多久 */
const progress = computed(function () {
  const current = live.value;
  if (settings.value.mode === 'duration') {
    const total = settings.value.durationSec * 1000;
    return total > 0 ? Math.min(100, (current.elapsedMs / total) * 100) : 0;
  }
  const total = settings.value.count;
  return total > 0 ? Math.min(100, (current.sent / total) * 100) : 0;
});

/* ---------------- 汇总 ---------------- */

const summary = computed(function () { return state.value.summary; });
const previous = computed(function () { return state.value.previous; });

const meta = computed(function () {
  const request = state.value.request || {};
  return { method: request.method || '', url: request.url || '', envName: envName.value };
});

const statusLabels = computed(function () {
  return {
    finished: t('load.statusFinished'),
    stopped: t('load.statusStopped'),
    error: t('load.statusError')
  };
});

function statusType(status) {
  if (status === 'finished') return 'success';
  if (status === 'stopped') return 'warning';
  return 'error';
}

async function copySummary() {
  if (!summary.value) return;
  try {
    await copyText(summaryText(summary.value, meta.value));
    message.success(t('load.resultCopied'));
  } catch (err) {
    message.warning(t('app.copyFailed'));
  }
}

/* ---------------- 运行中每半秒刷新一下耗时 ---------------- */

const now = ref(Date.now());
let timer = null;

function tickClock() { now.value = Date.now(); }

watch(running, function (value) {
  if (timer) { clearInterval(timer); timer = null; }
  if (!value) return;
  now.value = Date.now();
  timer = setInterval(tickClock, 500);
});

onBeforeUnmount(function () {
  if (timer) clearInterval(timer);
});

/** 运行中显示的已用时间（tick 一秒才来一次，中间靠本地时钟补上） */
const elapsedText = computed(function () {
  if (running.value && state.value.startedAt) {
    return formatDuration(now.value - state.value.startedAt);
  }
  return summary.value ? formatDuration(summary.value.durationMs) : '—';
});
</script>

<template>
  <div class="load-tab">
    <!-- 网页版（不是客户端）：压测这条路不存在 -->
    <n-alert v-if="blocked" type="warning" :show-icon="false" class="notice">
      {{ t('load.blockedNotice') }}
    </n-alert>

    <!-- ============================ 设置 ============================ -->
    <div class="card">
      <div class="settings">
        <label class="field">
          <span>{{ t('load.environment') }}</span>
          <n-select
            size="small"
            :value="envId"
            :options="envOptions"
            :disabled="running"
            @update:value="(v) => { envId = v; }"
          />
        </label>

        <label class="field">
          <span>{{ t('load.concurrency') }}</span>
          <n-input-number
            v-model:value="settings.concurrency"
            size="small"
            :min="range('concurrency').min"
            :max="range('concurrency').max"
            :disabled="running"
          />
        </label>

        <label class="field wide">
          <span>{{ t('load.stopCondition') }}</span>
          <n-radio-group v-model:value="settings.mode" size="small" :disabled="running">
            <n-radio-button value="count">{{ t('load.byCount') }}</n-radio-button>
            <n-radio-button value="duration">{{ t('load.byDuration') }}</n-radio-button>
          </n-radio-group>
          <n-input-number
            v-if="settings.mode === 'count'"
            v-model:value="settings.count"
            size="small"
            :min="range('count').min"
            :max="range('count').max"
            :disabled="running"
            class="small-input"
          />
          <template v-else>
            <n-input-number
              v-model:value="settings.durationSec"
              size="small"
              :min="range('durationSec').min"
              :max="range('durationSec').max"
              :disabled="running"
              class="small-input"
            />
            <span class="unit">{{ t('load.seconds') }}</span>
          </template>
        </label>

        <label class="field">
          <span>{{ t('load.rampUp') }}</span>
          <n-input-number
            v-model:value="settings.rampUpSec"
            size="small"
            :min="range('rampUpSec').min"
            :max="range('rampUpSec').max"
            :disabled="running"
          />
          <span class="unit">{{ t('load.seconds') }}</span>
        </label>

        <label class="field">
          <span>{{ t('load.timeout') }}</span>
          <n-input-number
            v-model:value="settings.timeoutMs"
            size="small"
            :min="range('timeoutMs').min"
            :max="range('timeoutMs').max"
            :disabled="running"
          />
          <span class="unit">{{ t('load.milliseconds') }}</span>
        </label>

        <label class="field wide">
          <span>{{ t('load.countAsSuccess') }}</span>
          <n-input
            v-model:value="settings.okStatusText"
            size="small"
            :disabled="running"
            :placeholder="t('load.okStatusPlaceholder')"
          />
        </label>
      </div>

      <p class="hint">
        {{ t('load.hint') }}
      </p>

      <div class="actions">
        <n-button v-if="running" type="warning" secondary size="small" @click="onStop">{{ t('load.stop') }}</n-button>
        <n-tooltip v-else-if="blocked" trigger="hover">
          <template #trigger>
            <span><n-button size="small" type="primary" disabled>{{ t('load.start') }}</n-button></span>
          </template>
          {{ t('load.blockedHint') }}
        </n-tooltip>
        <n-button v-else size="small" type="primary" @click="onStart">{{ t('load.start') }}</n-button>

        <span class="warn">{{ t('load.pressureWarning') }}</span>
      </div>

      <n-alert
        v-if="state.error"
        type="error"
        :show-icon="false"
        class="notice inline"
      >
        {{ state.error }}
      </n-alert>

      <n-alert
        v-if="state.missingVariables && state.missingVariables.length"
        type="warning"
        :show-icon="false"
        class="notice inline"
      >
        {{ t('load.missingVariables', { example: varExample, vars: state.missingVariables.join(t('load.listSeparator')) }) }}
      </n-alert>
    </div>

    <!-- ============================ 运行中 / 结果 ============================ -->

    <div v-if="running || summary || state.ticks.length" class="card">
      <div class="nums">
        <div class="num"><b>{{ formatCount(live.sent) }}</b><span>{{ t('load.sent') }}</span></div>
        <div class="num ok"><b>{{ formatCount(live.ok) }}</b><span>{{ t('load.success') }}</span></div>
        <div class="num fail"><b>{{ formatCount(live.failed) }}</b><span>{{ t('load.failed') }}</span></div>
        <div class="num"><b>{{ live.qps }}</b><span>{{ t('load.currentQps') }}</span></div>
        <div class="num"><b>{{ formatMs(live.avgMs) }}</b><span>{{ t('load.avgResponse') }}</span></div>
        <div class="num"><b>{{ formatMs(live.p95Ms) }}</b><span>P95</span></div>
        <div class="num"><b>{{ formatCount(live.active) }}</b><span>{{ t('load.active') }}</span></div>
        <div class="num"><b>{{ elapsedText }}</b><span>{{ t('load.elapsedTime') }}</span></div>
      </div>

      <div class="progress">
        <div class="bar" :style="{ width: progress.toFixed(1) + '%' }" />
      </div>

      <load-chart :rows="state.ticks" />

      <!-- 跑完的汇总 -->
      <template v-if="summary">
        <div class="summary-head">
          <n-tag :type="statusType(state.status)" size="small" :bordered="false">
            {{ statusLabels[state.status] || state.status }}
          </n-tag>
          <span v-if="meta.method" class="method" :style="{ color: methodColor(meta.method) }">{{ meta.method }}</span>
          <span class="url">{{ meta.url }}</span>
          <span class="spacer" />
          <n-button size="tiny" @click="copySummary">{{ t('load.copyResult') }}</n-button>
        </div>

        <div class="cards">
          <div class="mini"><span>{{ t('load.totalRequests') }}</span><b>{{ formatCount(summary.sent) }}</b></div>
          <div class="mini"><span>{{ t('load.success') }}</span><b>{{ formatCount(summary.ok) }}</b></div>
          <div class="mini"><span>{{ t('load.failed') }}</span><b>{{ formatCount(summary.failed) }}</b></div>
          <div class="mini"><span>{{ t('load.errorRate') }}</span><b>{{ formatPercent(summary.errorRate) }}</b></div>
          <div class="mini"><span>{{ t('load.totalDuration') }}</span><b>{{ formatDuration(summary.durationMs) }}</b></div>
          <div class="mini"><span>{{ t('load.avgQps') }}</span><b>{{ summary.qps }}</b></div>
        </div>

        <div class="cards">
          <div class="mini"><span>{{ t('load.min') }}</span><b>{{ formatMs(summary.minMs) }}</b></div>
          <div class="mini"><span>{{ t('load.avg') }}</span><b>{{ formatMs(summary.avgMs) }}</b></div>
          <div class="mini"><span>{{ t('load.max') }}</span><b>{{ formatMs(summary.maxMs) }}</b></div>
          <div class="mini"><span>P50</span><b>{{ formatMs(summary.p50Ms) }}</b></div>
          <div class="mini"><span>P90</span><b>{{ formatMs(summary.p90Ms) }}</b></div>
          <div class="mini"><span>P95</span><b>{{ formatMs(summary.p95Ms) }}</b></div>
          <div class="mini"><span>P99</span><b>{{ formatMs(summary.p99Ms) }}</b></div>
        </div>

        <div class="groups">
          <div class="group">
            <p class="group-title">{{ t('load.statusCodesTitle') }}</p>
            <p v-if="!(summary.statusCodes || []).length" class="group-empty">{{ t('load.noResponses') }}</p>
            <p v-for="item in summary.statusCodes" :key="item.status" class="group-row">
              <span class="code">{{ item.status }}</span>
              <span class="count">× {{ formatCount(item.count) }}</span>
            </p>
          </div>

          <div class="group">
            <p class="group-title">{{ t('load.errorsTitle') }}</p>
            <p v-if="!(summary.errors || []).length" class="group-empty">
              {{ t('load.noNetworkErrors') }}
            </p>
            <p v-for="item in summary.errors" :key="item.group" class="group-row">
              <span class="code">{{ item.group }}</span>
              <span class="count">× {{ formatCount(item.count) }}</span>
              <span class="sample" :title="item.sample">{{ item.sample }}</span>
            </p>
          </div>
        </div>

        <p v-if="summary.aborted" class="hint">
          {{ t('load.aborted', { n: summary.aborted }) }}
        </p>
      </template>

      <!-- 上一次的结果：留在下面方便对比 -->
      <template v-if="previous">
        <p class="previous-title">{{ t('load.previousTitle') }}</p>
        <p class="previous">
          {{ t('load.previousSummary', {
            sent: formatCount(previous.sent),
            ok: formatCount(previous.ok),
            failed: formatCount(previous.failed),
            rate: formatPercent(previous.errorRate),
            avg: formatMs(previous.avgMs),
            p95: formatMs(previous.p95Ms),
            qps: previous.qps,
            duration: formatDuration(previous.durationMs)
          }) }}
        </p>
      </template>
    </div>
  </div>
</template>

<style scoped>
.load-tab {
  padding: 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.card {
  border: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.24));
  border-radius: 6px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.settings {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 16px;
}

.field {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}

.field > span:first-child {
  opacity: 0.7;
  white-space: nowrap;
}

.field.wide {
  flex: 1 1 320px;
}

.field .unit {
  opacity: 0.6;
  font-size: 12px;
}

.small-input {
  width: 110px;
}

.hint {
  margin: 0;
  font-size: 12px;
  opacity: 0.6;
}

.actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.warn {
  font-size: 12px;
  color: #f0a020;
}

.notice {
  margin: 0;
}

.notice.inline {
  font-size: 12px;
}

.nums {
  display: flex;
  flex-wrap: wrap;
  gap: 18px;
}

.num {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 62px;
}

.num b {
  font-size: 16px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.num span {
  font-size: 11px;
  opacity: 0.6;
}

.num.ok b { color: #18a058; }
.num.fail b { color: #d03050; }

.progress {
  height: 6px;
  border-radius: 3px;
  background: rgba(128, 128, 128, 0.18);
  overflow: hidden;
}

.bar {
  height: 100%;
  background: #2080f0;
  transition: width 0.3s linear;
}

.summary-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.summary-head .method {
  font-weight: 700;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.summary-head .url {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.8;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.spacer {
  flex: 1;
}

.cards {
  display: flex;
  flex-wrap: wrap;
  gap: 18px;
}

.mini {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.mini span {
  font-size: 11px;
  opacity: 0.6;
}

.mini b {
  font-size: 14px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.groups {
  display: flex;
  flex-wrap: wrap;
  gap: 28px;
}

.group {
  min-width: 220px;
}

.group-title {
  margin: 0 0 4px;
  font-size: 12px;
  opacity: 0.6;
}

.group-empty {
  margin: 0;
  font-size: 12px;
  opacity: 0.45;
}

.group-row {
  margin: 0;
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 12px;
}

.group-row .code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-weight: 600;
}

.group-row .count {
  opacity: 0.7;
}

.group-row .sample {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.5;
}

.previous-title {
  margin: 0 0 4px;
  font-size: 12px;
  opacity: 0.6;
}

.previous {
  margin: 0;
  font-size: 12px;
  opacity: 0.75;
}
</style>
