<script setup>
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
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
const { t } = useI18n();

const draft = ref(null);
const saving = ref(false);
const errorText = ref('');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function reset(source) {
  draft.value = {
    name: source.name || '',
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
    return { label: item.name || t('mock.unnamedExample'), value: item.id };
  });
});

/**
 * 草稿与已保存内容的差异。
 *
 * **刻意不含 `enabled`**：编辑器界面上没有启用开关，启用状态只由左侧列表那个开关负责。
 * 把它放进草稿的话，用户在列表里拨完开关、再回来改一个条件点保存，
 * 就会把这个字段一起写回去，把开关悄悄拨回原样。
 */
const dirty = computed(function () {
  if (!draft.value || !props.expectation) return false;
  const saved = {
    name: props.expectation.name || '',
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
    // 不提交 enabled：PUT 是部分更新，不传它服务端就不会动 ——
    // 这个字段归左侧列表的开关管，见 dirty 上面的说明
    const data = await expectationsApi.updateExpectation(props.expectation.id, {
      name: draft.value.name,
      exampleId: draft.value.exampleId,
      conditions: draft.value.conditions
    });
    emit('saved', data.expectation);
    message.success(t('mock.saved'));
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
      <n-form-item :label="t('mock.name')" :show-feedback="false" class="name">
        <n-input
          v-model:value="draft.name"
          size="small"
          :disabled="readonly"
          :placeholder="t('mock.expectationNamePlaceholder')"
        />
      </n-form-item>

      <n-form-item :label="t('mock.exampleLabel')" :show-feedback="false" class="example">
        <n-select
          v-model:value="draft.exampleId"
          size="small"
          :disabled="readonly"
          :options="exampleOptions"
          :placeholder="t('mock.examplePlaceholder')"
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
        {{ t('mock.save') }}
      </n-button>
    </n-space>

    <p class="label">{{ t('mock.conditionsLabel') }}</p>

    <div class="conditions">
      <div class="row head-row">
        <span class="cell in">{{ t('mock.colSource') }}</span>
        <span class="cell key">key</span>
        <span class="cell op">{{ t('mock.colOperator') }}</span>
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
            :placeholder="t('mock.conditionKeyPlaceholder')"
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
            :placeholder="t('mock.conditionValuePlaceholder')"
          />
          <span v-else class="muted">{{ t('mock.conditionNoValue') }}</span>
        </span>
        <span class="cell action">
          <n-button
            v-if="!readonly"
            size="tiny"
            quaternary
            type="error"
            @click="removeCondition(index)"
          >
            {{ t('app.delete') }}
          </n-button>
        </span>
      </div>

      <p v-if="!draft.conditions.length" class="empty">{{ t('mock.noConditions') }}</p>
    </div>

    <n-button v-if="!readonly" size="small" quaternary type="primary" @click="addCondition">
      {{ t('mock.addCondition') }}
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
