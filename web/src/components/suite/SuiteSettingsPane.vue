<script setup>
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { NInputNumber } from 'naive-ui';
import { useProjectStore } from '@/stores/project';

/**
 * 测试集的「设置」页签（第八轮第 1 节）。
 *
 * 三样：不用数据时跑几轮、每个请求之间等多久、请求超时（默认跟全局设置）。
 * 底下那段灰字是**运行时的三条事实**，不是装饰 —— 用户第一次跑之前最想知道的就是
 * 「我脚本里设的变量会不会改到环境」。
 */
const props = defineProps({
  suite: { type: Object, required: true },
  disabled: { type: Boolean, default: false }
});

const emit = defineEmits(['change']);

const projects = useProjectStore();
const { t } = useI18n();

const canEdit = computed(function () { return projects.canEdit && !props.disabled; });

const settings = computed(function () { return props.suite.settings || {}; });

function patch(next) {
  emit('change', { settings: Object.assign({}, settings.value, next) });
}

/** 超时留空 = 跟全局设置（服务端有默认值），所以空值要真的传 null 而不是 0 */
function setTimeoutMs(value) {
  if (value === null || value === undefined) {
    const next = Object.assign({}, settings.value);
    delete next.timeoutMs;
    emit('change', { settings: next });
    return;
  }
  patch({ timeoutMs: value });
}
</script>

<template>
  <div class="pane">
    <div class="field">
      <span class="label">{{ t('suite.iterationsLabel') }}</span>
      <n-input-number
        size="small"
        :min="1"
        :max="100"
        :disabled="!canEdit"
        :value="settings.iterations || 1"
        @update:value="(value) => patch({ iterations: value === null ? 1 : value })"
      />
      <span class="unit">1–100</span>
    </div>

    <div class="field">
      <span class="label">{{ t('suite.delayLabel') }}</span>
      <n-input-number
        size="small"
        :min="0"
        :disabled="!canEdit"
        :value="settings.delayMs || 0"
        @update:value="(value) => patch({ delayMs: value === null ? 0 : value })"
      >
        <template #suffix>ms</template>
      </n-input-number>
      <span class="unit">{{ t('suite.delayUnit') }}</span>
    </div>

    <div class="field">
      <span class="label">{{ t('suite.timeoutLabel') }}</span>
      <n-input-number
        size="small"
        :min="1000"
        :disabled="!canEdit"
        :value="settings.timeoutMs === undefined ? null : settings.timeoutMs"
        :placeholder="t('suite.followGlobal')"
        @update:value="setTimeoutMs"
      >
        <template #suffix>ms</template>
      </n-input-number>
      <span class="unit">{{ t('suite.timeoutUnit') }}</span>
    </div>

    <p class="note">
      {{ t('suite.noteLead') }}<b>{{ t('suite.noteStrong') }}</b>{{ t('suite.noteTail') }}
    </p>
  </div>
</template>

<style scoped>
.pane {
  padding: 12px 14px 16px;
}

.field {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
  font-size: 13px;
}

.label {
  flex: none;
  width: 150px;
  opacity: 0.75;
}

.unit {
  font-size: 12px;
  opacity: 0.55;
}

.note {
  margin: 16px 0 0;
  max-width: 620px;
  font-size: 12px;
  line-height: 1.9;
  opacity: 0.6;
}
</style>
