<script setup>
import { computed, ref } from 'vue';
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

const STATUS_LABEL = { passed: '通过', failed: '失败', stopped: '停止', error: '出错' };
const STATUS_TYPE = { passed: 'success', failed: 'error', stopped: 'warning', error: 'error' };

const summary = computed(function () { return props.run.summary || {}; });
const iterations = computed(function () { return (props.run.result && props.run.result.iterations) || []; });

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
  return STATUS_LABEL[status] || status || '—';
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
        <span class="env">{{ run.environmentName || '（没选环境）' }}</span>
        <span v-if="run.label" class="label">构建号 {{ run.label }}</span>
        <span class="spacer" />
        <n-button size="small" secondary @click="downloadReport(run)">
          <template #icon><n-icon :component="Download" /></template>
          导出报告
        </n-button>
      </div>

      <div class="stats">
        <span><b>{{ summary.iterations === undefined ? iterations.length : summary.iterations }}</b> 轮</span>
        <span><b>{{ summary.requests || 0 }}</b> 个请求</span>
        <span class="ok"><b>{{ summary.passed || 0 }}</b> 通过</span>
        <span :class="{ bad: summary.failed }"><b>{{ summary.failed || 0 }}</b> 失败</span>
        <span v-if="summary.errors" class="bad"><b>{{ summary.errors }}</b> 出错</span>
        <span>断言 <b>{{ (summary.assertions && summary.assertions.passed) || 0 }}</b> /
          <b :class="{ bad: summary.assertions && summary.assertions.failed }">{{ (summary.assertions && summary.assertions.failed) || 0 }}</b></span>
        <span>总用时 <b>{{ formatMs(summary.durationMs) }}</b></span>
        <span>平均 <b>{{ formatMs(summary.avgMs) }}</b></span>
      </div>

      <p v-if="summary.truncated" class="truncated">
        这次运行的结果太大，请求 / 响应的明细没有存进记录（只留了每一步的结论）。
      </p>
      <p v-if="summary.message" class="truncated">{{ summary.message }}</p>
    </div>

    <div class="iterations">
      <div v-for="(item, index) in iterations" :key="index" class="iteration">
        <button class="iter-head" @click="toggle(index)">
          <n-icon size="14" :component="isExpanded(index) ? ChevronDown : ChevronRight" />
          <span class="iter-title">第 {{ index + 1 }} 轮</span>
          <span v-if="item.data" class="iter-data">{{ dataSummary(item.data) }}</span>
          <span v-if="(item.steps || []).some((s) => s.ok === false)" class="bad-dot">有失败</span>
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
              <n-tag v-if="step.skipped" size="tiny" :bordered="false">跳过</n-tag>
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
                {{ detailOpen[index + '-' + stepIndex] ? '收起' : '看请求 / 响应' }}
              </button>
            </div>

            <p v-if="step.error" class="error">{{ step.error }}</p>

            <ul v-if="(step.tests || []).length" class="tests">
              <li v-for="(test, testIndex) in step.tests" :key="testIndex" :class="test.passed ? 'ok' : 'bad'">
                {{ test.passed ? '✓' : '✗' }} {{ test.name }}
                <span v-if="test.message" class="msg">：{{ test.message }}</span>
              </li>
            </ul>

            <div v-if="detailOpen[index + '-' + stepIndex]" class="payload">
              <template v-if="step.request">
                <p class="k">实际发出的请求</p>
                <pre>{{ step.request.method }} {{ step.request.url }}
{{ headerText(step.request.headers) }}

{{ step.request.bodyPreview }}</pre>
              </template>
              <template v-if="step.response">
                <p class="k">响应（HTTP {{ step.response.status }}）</p>
                <pre>{{ headerText(step.response.headers) }}

{{ step.response.body }}</pre>
              </template>
            </div>
          </div>
        </div>
      </div>

      <p v-if="!iterations.length" class="empty">这次运行没有步骤（或者明细被截断了）。</p>
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
