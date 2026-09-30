<script setup>
import { computed } from 'vue';
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
  stats: { type: Object, default: function () { return { pushed: 0, ruleCount: 0, skipped: 0 }; } },
  saving: { type: Boolean, default: false }
});

const emit = defineEmits(['update:show', 'confirm']);

const body = computed(function () {
  if (!props.scenario) return '';
  return JSON.stringify(props.scenario, null, 2);
});
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    title="保存为 mock"
    style="width: 720px; max-width: 94vw"
    @update:show="(v) => emit('update:show', v)"
  >
    <n-alert type="info" :show-icon="false" class="notice">
      连接后会推送 <strong>{{ stats.pushed }}</strong> 条，
      生成 <strong>{{ stats.ruleCount }}</strong> 条规则<template v-if="stats.skipped">，
      跳过 <strong>{{ stats.skipped }}</strong> 条二进制消息</template>。
    </n-alert>

    <n-alert v-if="stats.skipped" type="warning" :show-icon="false" class="notice">
      二进制消息没法按文本匹配，回放时不会出现。
    </n-alert>

    <p class="label">生成的场景</p>
    <pre class="preview">{{ body }}</pre>

    <template #footer>
      <n-space justify="end">
        <n-button @click="emit('update:show', false)">取消</n-button>
        <n-button type="primary" :loading="saving" @click="emit('confirm')">保存</n-button>
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
