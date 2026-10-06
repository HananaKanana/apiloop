<script setup>
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { NAlert, NButton, NModal, NSpace } from 'naive-ui';

/**
 * 「保存为 mock」的预览弹窗（契约第 17 节）。
 *
 * 先把从消息日志整理出来的场景摆出来让用户确认，再落库 —— 场景是按日志推出来的，
 * 用户得有机会看一眼「推出来的是什么」。
 */
const props = defineProps({
  show: { type: Boolean, default: false },
  scenario: { type: Object, default: null },
  stats: {
    type: Object,
    default: function () {
      return { pushed: 0, ruleCount: 0, skipped: 0, cappedDelays: 0, truncated: 0, duplicates: 0 };
    }
  },
  saving: { type: Boolean, default: false }
});

const emit = defineEmits(['update:show', 'confirm']);
const { t } = useI18n();

const body = computed(function () {
  if (!props.scenario) return '';
  return JSON.stringify(props.scenario, null, 2);
});
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    :title="t('ws.scenarioTitle')"
    style="width: 720px; max-width: 94vw"
    @update:show="(v) => emit('update:show', v)"
  >
    <n-alert type="info" :show-icon="false" class="notice">
      {{ t('ws.scenarioPushLead') }}<strong>{{ stats.pushed }}</strong>{{ t('ws.scenarioPushMid') }}<strong>{{ stats.ruleCount }}</strong>{{ t('ws.scenarioRuleTail') }}<template v-if="stats.skipped">{{ t('ws.scenarioSkipLead') }}<strong>{{ stats.skipped }}</strong>{{ t('ws.scenarioSkipTail') }}</template>{{ t('ws.scenarioPeriod') }}
    </n-alert>

    <n-alert v-if="stats.skipped" type="warning" :show-icon="false" class="notice">
      {{ t('ws.scenarioBinaryNote') }}
    </n-alert>

    <n-alert v-if="stats.cappedDelays" type="warning" :show-icon="false" class="notice">
      {{ t('ws.scenarioCappedDelays', stats.cappedDelays) }}
    </n-alert>

    <n-alert v-if="stats.truncated" type="warning" :show-icon="false" class="notice">
      {{ t('ws.scenarioTruncated', stats.truncated) }}
    </n-alert>

    <n-alert v-if="stats.duplicates" type="info" :show-icon="false" class="notice">
      {{ t('ws.scenarioDuplicates', stats.duplicates) }}
    </n-alert>

    <p class="label">{{ t('ws.scenarioGenerated') }}</p>
    <pre class="preview">{{ body }}</pre>

    <template #footer>
      <n-space justify="end">
        <n-button @click="emit('update:show', false)">{{ t('app.cancel') }}</n-button>
        <n-button type="primary" :loading="saving" @click="emit('confirm')">{{ t('ws.save') }}</n-button>
      </n-space>
    </template>
  </n-modal>
</template>

<style scoped>
.notice {
  margin-bottom: 10px;
  font-size: 12px;
}

.label {
  margin: 0 0 6px;
  font-size: 12px;
  opacity: 0.65;
}

.preview {
  margin: 0;
  padding: 10px;
  max-height: 46vh;
  overflow: auto;
  border: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.24));
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
</style>
