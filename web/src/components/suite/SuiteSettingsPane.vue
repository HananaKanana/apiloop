<script setup>
import { computed } from 'vue';
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
      <span class="label">不用数据时跑几轮</span>
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
      <span class="label">每个请求之间等多久</span>
      <n-input-number
        size="small"
        :min="0"
        :disabled="!canEdit"
        :value="settings.delayMs || 0"
        @update:value="(value) => patch({ delayMs: value === null ? 0 : value })"
      >
        <template #suffix>ms</template>
      </n-input-number>
      <span class="unit">步骤上单独设的等待在这个之外</span>
    </div>

    <div class="field">
      <span class="label">请求超时</span>
      <n-input-number
        size="small"
        :min="1000"
        :disabled="!canEdit"
        :value="settings.timeoutMs === undefined ? null : settings.timeoutMs"
        placeholder="跟全局设置"
        @update:value="setTimeoutMs"
      >
        <template #suffix>ms</template>
      </n-input-number>
      <span class="unit">留空就跟全局设置</span>
    </div>

    <p class="note">
      运行时提取、脚本设置的变量<b>只在这次运行里有效</b>，不会改环境里保存的值；
      Cookie 每次运行从空开始、步骤之间共用；不记历史。
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
