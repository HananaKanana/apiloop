<script setup>
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { NButton, NIcon, NTag } from 'naive-ui';
import { ChevronDown, ChevronRight, Download } from '@vicons/tabler';
import { dataSummary, downloadReport, formatBytes, formatMs, formatTime } from '@/utils/suiteReport';

/**
 * 测试集的运行报告（第八轮第 1 节）。
 *
 * 运行完自动切过来，也可以从「运行记录」里打开历次报告 —— 两边用的是同一个组件、
 * 同一份数据形状（服务端存的 `result` 和刚跑完拿到的那份一模一样）。
 */
const props = defineProps({
  run: { type: Object, required: true }
});

const { t } = useI18n();

/** 状态文案依赖语言，必须用 computed，切语言才会变 */
const STATUS_LABEL = computed(function () {
  return {
    passed: t('suite.statusPassed'),
    failed: t('suite.statusFailed'),
    stopped: t('suite.statusStopped'),
    error: t('suite.statusError')
  };
});
const STATUS_TYPE = { passed: 'success', failed: 'error', stopped: 'warning', error: 'error' };

const summary = computed(function () { return props.run.summary || {}; });
const iterations = computed(function () { return (props.run.result && props.run.result.iterations) || []; });

/** 轮数：summary 没给就用明细条数（和模板里原来那句三元一个口径） */
const roundCount = computed(function () {
  return summary.value.iterations === undefined ? iterations.value.length : summary.value.iterations;
});

/** 默认展开**失败的轮**（通过的一眼看标题就够了），用户点过的以他点的为准 */
const overrides = ref({});

function isExpanded(index) {
  if (overrides.value[index] !== undefined) return overrides.value[index];
  const item = iterations.value[index];
  return Boolean(item && (item.steps || []).some(function (step) { return step.ok === false; }));
}

function toggle(index) {
  overrides.value = Object.assign({}, overrides.value, { [index]: !isExpanded(index) });
}

const detailOpen = ref({});

function toggleDetail(key) {
  detailOpen.value = Object.assign({}, detailOpen.value, { [key]: !detailOpen.value[key] });
}

function statusType(status) {
  return STATUS_TYPE[status] || 'default';
}

function statusLabel(status) {
  return STATUS_LABEL.value[status] || status || '—';
}

function headerText(headers) {
  return (headers || []).map(function (pair) {
    return Array.isArray(pair) ? pair[0] + ': ' + pair[1] : '';
  }).filter(Boolean).join('\n');
}
</script>

<template>
  <div class="report">
    <div class="summary">
      <div class="line">
        <n-tag size="small" :bordered="false" :type="statusType(run.status)">
          {{ statusLabel(run.status) }}
        </n-tag>
        <span class="when">{{ formatTime(run.finishedAt || run.startedAt) }}</span>
        <span class="env">{{ run.environmentName || t('suite.noEnvironment') }}</span>
        <span v-if="run.label" class="label">{{ t('suite.buildLabel', { label: run.label }) }}</span>
        <span class="spacer" />
        <n-button size="small" secondary @click="downloadReport(run)">
          <template #icon><n-icon :component="Download" /></template>
          {{ t('suite.exportReport') }}
        </n-button>
      </div>

      <div class="stats">
        <span><b>{{ roundCount }}</b> {{ t('suite.unitRounds', roundCount) }}</span>
        <span><b>{{ summary.requests || 0 }}</b> {{ t('suite.unitRequests', summary.requests || 0) }}</span>
        <span class="ok"><b>{{ summary.passed || 0 }}</b> {{ t('suite.statusPassed') }}</span>
        <span :class="{ bad: summary.failed }"><b>{{ summary.failed || 0 }}</b> {{ t('suite.statusFailed') }}</span>
        <span v-if="summary.errors" class="bad"><b>{{ summary.errors }}</b> {{ t('suite.statusError') }}</span>
        <span>{{ t('suite.assertions') }} <b>{{ (summary.assertions && summary.assertions.passed) || 0 }}</b> /
          <b :class="{ bad: summary.assertions && summary.assertions.failed }">{{ (summary.assertions && summary.assertions.failed) || 0 }}</b></span>
        <span>{{ t('suite.statDuration') }} <b>{{ formatMs(summary.durationMs) }}</b></span>
        <span>{{ t('suite.statAverage') }} <b>{{ formatMs(summary.avgMs) }}</b></span>
      </div>

      <p v-if="summary.truncated" class="truncated">
        {{ t('suite.truncatedNote') }}
      </p>
      <p v-if="summary.message" class="truncated">{{ summary.message }}</p>
    </div>

    <div class="iterations">
      <div v-for="(item, index) in iterations" :key="index" class="iteration">
        <button class="iter-head" @click="toggle(index)">
          <n-icon size="14" :component="isExpanded(index) ? ChevronDown : ChevronRight" />
          <span class="iter-title">{{ t('suite.roundN', { n: index + 1 }) }}</span>
          <span v-if="item.data" class="iter-data">{{ dataSummary(item.data) }}</span>
          <span v-if="(item.steps || []).some((s) => s.ok === false)" class="bad-dot">{{ t('suite.hasFailure') }}</span>
        </button>

        <div v-if="isExpanded(index)" class="steps">
          <div
            v-for="(step, stepIndex) in item.steps"
            :key="step.stepId + '-' + stepIndex"
            class="step"
            :class="{ failed: step.ok === false, skipped: step.skipped }"
          >
            <div class="step-head">
              <span class="mark" :class="step.ok === false ? 'bad' : 'ok'">{{ step.ok === false ? '✗' : '✓' }}</span>
              <span class="idx">{{ stepIndex + 1 }}</span>
              <span class="method">{{ step.method }}</span>
              <span class="name">{{ step.name }}</span>
              <n-tag v-if="step.skipped" size="tiny" :bordered="false">{{ t('suite.statusSkipped') }}</n-tag>
              <span class="spacer" />
              <span class="meta">
                {{ step.status ? 'HTTP ' + step.status : '' }}
                · {{ formatMs(step.timeMs) }}
                · {{ formatBytes(step.size) }}
              </span>
              <button
                v-if="step.ok === false && (step.request || step.response)"
                class="detail-toggle"
                @click="toggleDetail(index + '-' + stepIndex)"
              >
                {{ detailOpen[index + '-' + stepIndex] ? t('suite.collapse') : t('suite.viewRequestResponse') }}
              </button>
            </div>

            <p v-if="step.error" class="error">{{ step.error }}</p>

            <ul v-if="(step.tests || []).length" class="tests">
              <li v-for="(test, testIndex) in step.tests" :key="testIndex" :class="test.passed ? 'ok' : 'bad'">
                {{ test.passed ? '✓' : '✗' }} {{ test.name }}
                <span v-if="test.message" class="msg">{{ t('suite.testMessagePrefix') }}{{ test.message }}</span>
              </li>
            </ul>

            <div v-if="detailOpen[index + '-' + stepIndex]" class="payload">
              <template v-if="step.request">
                <p class="k">{{ t('suite.actualRequest') }}</p>
                <pre>{{ step.request.method }} {{ step.request.url }}
{{ headerText(step.request.headers) }}

{{ step.request.bodyPreview }}</pre>
              </template>
              <template v-if="step.response">
                <p class="k">{{ t('suite.responseWithStatus', { status: step.response.status }) }}</p>
                <pre>{{ headerText(step.response.headers) }}

{{ step.response.body }}</pre>
              </template>
            </div>
          </div>
        </div>
      </div>

      <p v-if="!iterations.length" class="empty">{{ t('suite.noStepsInRun') }}</p>
    </div>
  </div>
</template>

<style scoped>
.report {
  padding: 12px 16px 20px;
}

.summary {
  padding: 10px 12px;
  border-radius: 6px;
  background: rgba(128, 128, 128, 0.07);
}

.line {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
}

.when,
.env,
.label {
  opacity: 0.65;
}

.spacer {
  flex: 1;
}

.stats {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  margin-top: 8px;
  font-size: 12px;
  opacity: 0.8;
}

.stats b {
  font-weight: 600;
}

.stats .ok b,
.mark.ok,
.tests .ok {
  color: #18a058;
}

.stats .bad b,
.bad-dot,
.mark.bad,
.tests .bad,
.error {
  color: #d03050;
}

.truncated {
  margin: 8px 0 0;
  font-size: 12px;
  color: #d03050;
}

.iterations {
  margin-top: 10px;
}

.iteration {
  border-bottom: 1px solid rgba(128, 128, 128, 0.12);
}

.iter-head {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 2px;
  border: none;
  background: transparent;
  color: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.iter-head:hover {
  background: rgba(128, 128, 128, 0.07);
}

.iter-title {
  font-weight: 600;
}

.iter-data {
  max-width: 420px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.6;
}

.bad-dot {
  font-size: 11px;
}

.steps {
  padding: 0 0 8px 18px;
}

.step {
  padding: 4px 8px;
  margin-bottom: 4px;
  border: 1px solid rgba(128, 128, 128, 0.16);
  border-radius: 5px;
  font-size: 12px;
}

.step.failed {
  border-color: rgba(208, 48, 80, 0.35);
  background: rgba(208, 48, 80, 0.04);
}

.step.skipped {
  opacity: 0.6;
}

.step-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.idx {
  width: 16px;
  text-align: right;
  opacity: 0.45;
}

.method {
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

.detail-toggle {
  flex: none;
  padding: 0 4px;
  border: none;
  background: transparent;
  color: var(--apiloop-primary);
  font-size: 12px;
  cursor: pointer;
}

.error {
  margin: 4px 0 0;
}

.tests {
  margin: 4px 0 0;
  padding-left: 18px;
}

.msg {
  opacity: 0.7;
}

.payload {
  margin-top: 6px;
}

.k {
  margin: 6px 0 2px;
  opacity: 0.6;
}

pre {
  margin: 0;
  padding: 8px;
  max-height: 260px;
  overflow: auto;
  border-radius: 4px;
  background: rgba(128, 128, 128, 0.08);
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
}

.empty {
  padding: 12px 0;
  font-size: 12px;
  opacity: 0.55;
}
</style>
