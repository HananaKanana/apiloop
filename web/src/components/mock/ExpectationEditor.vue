<script setup>
import { computed, ref, watch } from 'vue';
import { NAlert, NButton, NFormItem, NInput, NSelect, NSpace, useMessage } from 'naive-ui';
import * as expectationsApi from '@/api/expectations';
import { CONDITION_OPS, CONDITION_SOURCES, opNeedsValue } from '@/utils/expectation';

/**
 * 单条期望的编辑器：名称、返回哪个示例、条件表。
 *
 * 用显式的「保存」按钮而不是自动保存：正则写错、没选示例这类错误由服务端返回，
 * 用户需要看到具体原因再改。自动保存会在他还在敲字的时候反复弹错。
 *
 * 服务端返回的 400 文案原样显示在编辑器顶部，同时通过 `failed` 冒泡给列表，
 * 让错误出现在出错的那一条期望旁边（审阅重点第 4 条）。
 */
const props = defineProps({
  api: { type: Object, required: true },
  expectation: { type: Object, required: true },
  examples: { type: Array, default: function () { return []; } },
  readonly: { type: Boolean, default: false }
});

const emit = defineEmits(['saved', 'failed']);

const message = useMessage();

const draft = ref(null);
const saving = ref(false);
const errorText = ref('');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function reset(source) {
  draft.value = {
    name: source.name || '',
    enabled: source.enabled !== false,
    exampleId: source.exampleId || '',
    conditions: clone(source.conditions || []).map(function (item) {
      return {
        in: item.in || 'query',
        key: item.key || '',
        op: item.op || 'eq',
        value: item.value === undefined || item.value === null ? '' : String(item.value)
      };
    })
  };
  errorText.value = '';
}

watch(
  function () { return props.expectation && props.expectation.id; },
  function () { reset(props.expectation || {}); },
  { immediate: true }
);

const exampleOptions = computed(function () {
  return (props.examples || []).map(function (item) {
    return { label: item.name || '(未命名示例)', value: item.id };
  });
});

const dirty = computed(function () {
  if (!draft.value || !props.expectation) return false;
  const saved = {
    name: props.expectation.name || '',
    enabled: props.expectation.enabled !== false,
    exampleId: props.expectation.exampleId || '',
    conditions: clone(props.expectation.conditions || []).map(function (item) {
      return {
        in: item.in || 'query',
        key: item.key || '',
        op: item.op || 'eq',
        value: item.value === undefined || item.value === null ? '' : String(item.value)
      };
    })
  };
  return JSON.stringify(draft.value) !== JSON.stringify(saved);
});

function addCondition() {
  draft.value.conditions.push({ in: 'query', key: '', op: 'eq', value: '' });
}

function removeCondition(index) {
  draft.value.conditions.splice(index, 1);
}

async function save() {
  if (!draft.value) return;

  saving.value = true;
  errorText.value = '';
  try {
    const data = await expectationsApi.updateExpectation(props.expectation.id, {
      name: draft.value.name,
      enabled: draft.value.enabled,
      exampleId: draft.value.exampleId,
      conditions: draft.value.conditions
    });
    emit('saved', data.expectation);
    message.success('已保存');
  } catch (err) {
    // 400 的原因（正则不合法、示例不属于该接口…）就地显示，不要只弹一句「保存失败」
    errorText.value = err.message;
    emit('failed', { id: props.expectation.id, message: err.message });
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div v-if="draft" class="expectation-editor">
    <n-alert v-if="errorText" type="error" :show-icon="false" class="notice">
      {{ errorText }}
    </n-alert>

    <n-space align="center" :size="10" :wrap="false" class="head">
      <n-form-item label="名称" :show-feedback="false" class="name">
        <n-input
          v-model:value="draft.name"
          size="small"
          :disabled="readonly"
          placeholder="例如：id 为 404 时返回不存在"
        />
      </n-form-item>

      <n-form-item label="返回示例" :show-feedback="false" class="example">
        <n-select
          v-model:value="draft.exampleId"
          size="small"
          :disabled="readonly"
          :options="exampleOptions"
          placeholder="选一个示例"
        />
      </n-form-item>

      <span class="spacer" />

      <n-button
        v-if="!readonly"
        size="small"
        type="primary"
        :disabled="!dirty"
        :loading="saving"
        @click="save"
      >
        保存
      </n-button>
    </n-space>

    <p class="label">条件（同一行的多个条件是「且」的关系）</p>

    <div class="conditions">
      <div class="row head-row">
        <span class="cell in">位置</span>
        <span class="cell key">key</span>
        <span class="cell op">操作</span>
        <span class="cell value">value</span>
        <span class="cell action" />
      </div>

      <div v-for="(condition, index) in draft.conditions" :key="index" class="row">
        <span class="cell in">
          <n-select
            v-model:value="condition.in"
            size="small"
            :disabled="readonly"
            :options="CONDITION_SOURCES"
          />
        </span>
        <span class="cell key">
          <n-input
            v-model:value="condition.key"
            size="small"
            :disabled="readonly"
            placeholder="字段名，body 支持 a.b"
          />
        </span>
        <span class="cell op">
          <n-select
            v-model:value="condition.op"
            size="small"
            :disabled="readonly"
            :options="CONDITION_OPS"
          />
        </span>
        <span class="cell value">
          <n-input
            v-if="opNeedsValue(condition.op)"
            v-model:value="condition.value"
            size="small"
            :disabled="readonly"
            placeholder="要比较的值"
          />
          <span v-else class="muted">（这个操作不看 value）</span>
        </span>
        <span class="cell action">
          <n-button
            v-if="!readonly"
            size="tiny"
            quaternary
            type="error"
            @click="removeCondition(index)"
          >
            删除
          </n-button>
        </span>
      </div>

      <p v-if="!draft.conditions.length" class="empty">还没有条件，这条期望会对所有请求生效。</p>
    </div>

    <n-button v-if="!readonly" size="small" quaternary type="primary" @click="addCondition">
      ＋ 添加条件
    </n-button>
  </div>
</template>

<style scoped>
.expectation-editor {
  display: flex;
  flex-direction: column;
  gap: 10px;
  height: 100%;
  min-height: 0;
  overflow: auto;
}

.notice {
  font-size: 12px;
}

.head {
  width: 100%;
}

.name {
  width: 240px;
}

.example {
  width: 240px;
}

.spacer {
  flex: 1;
}

.label {
  margin: 0;
  font-size: 12px;
  opacity: 0.65;
}

.conditions {
  border: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.24));
  border-radius: 6px;
  overflow: hidden;
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.16));
}

.row:last-child {
  border-bottom: none;
}

.head-row {
  font-size: 12px;
  opacity: 0.65;
  background: rgba(128, 128, 128, 0.08);
}

.cell {
  min-width: 0;
}

.cell.in {
  flex: none;
  width: 110px;
}

.cell.key {
  flex: 1.4;
  min-width: 0;
}

.cell.op {
  flex: none;
  width: 110px;
}

.cell.value {
  flex: 1;
  min-width: 0;
}

.cell.action {
  flex: none;
  width: 52px;
  text-align: right;
}

.muted {
  font-size: 12px;
  opacity: 0.5;
}

.empty {
  margin: 0;
  padding: 8px 10px;
  font-size: 12px;
  opacity: 0.6;
}
</style>
