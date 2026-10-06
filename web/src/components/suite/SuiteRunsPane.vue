<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { NButton, NEmpty, NIcon, NTag, useMessage } from 'naive-ui';
import { Refresh, Trash } from '@vicons/tabler';
import { useGatewayStore } from '@/stores/gateway';
import { useProjectStore } from '@/stores/project';
import * as suitesApi from '@/api/suites';
import { formatMs, formatTime } from '@/utils/suiteReport';

/**
 * 测试集的「运行记录」页签（第八轮第 1 节）。
 *
 * 记录**只在云端**（网关转发）：大家在一处看历次结果，命令行跑的也在里面。
 * 没登录（只用本机）时这一页给一句话，运行照样能跑、只是不留记录。
 */
const props = defineProps({
  suite: { type: Object, required: true }
});

const emit = defineEmits(['open']);

const gateway = useGatewayStore();
const projects = useProjectStore();
const message = useMessage();
const { t } = useI18n();

const runs = ref([]);
const loading = ref(false);
const error = ref('');

const canEdit = computed(function () { return projects.canEdit; });

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

function load() {
  if (!gateway.cloudFeaturesAvailable) {
    runs.value = [];
    return Promise.resolve();
  }

  loading.value = true;
  error.value = '';
  return suitesApi.listRuns(props.suite.id).then(function (data) {
    runs.value = data.runs || [];
  }).catch(function (err) {
    error.value = err.message;
    runs.value = [];
  }).finally(function () {
    loading.value = false;
  });
}

onMounted(load);

watch(function () { return props.suite.id; }, load);
// 跑完一次之后回到这一页要能看到新记录
watch(function () { return gateway.cloudFeaturesAvailable; }, load);

async function remove(run) {
  try {
    await suitesApi.removeRun(run.id);
    runs.value = runs.value.filter(function (item) { return item.id !== run.id; });
    message.success(t('suite.deleted'));
  } catch (err) {
    message.error(err.message);
  }
}

function totals(run) {
  const summary = run.summary || {};
  return (summary.passed || 0) + ' / ' + (summary.requests || 0);
}
</script>

<template>
  <div class="pane">
    <div class="toolbar">
      <span class="hint">{{ t('suite.runsKeepHint') }}</span>
      <span class="spacer" />
      <n-button size="small" quaternary :loading="loading" @click="load">
        <template #icon><n-icon :component="Refresh" /></template>
        {{ t('suite.refresh') }}
      </n-button>
    </div>

    <p v-if="!gateway.cloudFeaturesAvailable" class="note">
      {{ t('suite.runsCloudHint') }}
    </p>

    <n-empty v-else-if="error" class="empty" size="small" :description="error" />

    <p v-else-if="!runs.length" class="note">{{ t('suite.noRuns') }}</p>

    <div v-else class="list">
      <div v-for="run in runs" :key="run.id" class="row" @click="emit('open', run.id)">
        <span class="time">{{ formatTime(run.startedAt) }}</span>
        <n-tag size="tiny" :bordered="false" :type="STATUS_TYPE[run.status] || 'default'">
          {{ STATUS_LABEL[run.status] || run.status }}
        </n-tag>
        <span class="source">{{ run.source === 'cli' ? t('suite.sourceCli') : t('suite.sourceApp') }}</span>
        <span class="env">{{ run.environmentName || '—' }}</span>
        <span v-if="run.label" class="label">{{ run.label }}</span>
        <span class="spacer" />
        <span class="count">{{ totals(run) }}</span>
        <span class="duration">{{ formatMs((run.summary || {}).durationMs) }}</span>
        <n-button
          v-if="canEdit"
          size="tiny"
          quaternary
          :title="t('suite.removeRun')"
          @click.stop="remove(run)"
        >
          <template #icon><n-icon :component="Trash" /></template>
        </n-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pane {
  padding: 10px 14px 16px;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.hint {
  font-size: 12px;
  opacity: 0.55;
}

.spacer {
  flex: 1;
}

.note {
  margin: 10px 0;
  font-size: 12px;
  line-height: 1.8;
  opacity: 0.6;
}

.empty {
  padding: 20px 0;
}

.list {
  display: flex;
  flex-direction: column;
}

.row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 5px 6px;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
}

.row:hover {
  background: rgba(128, 128, 128, 0.1);
}

.time {
  flex: none;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.source,
.env,
.label {
  opacity: 0.6;
}

.count {
  flex: none;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.duration {
  flex: none;
  width: 80px;
  text-align: right;
  opacity: 0.6;
}
</style>
