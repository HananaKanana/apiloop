<script setup>
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { NButton, NCheckbox, NEmpty, NIcon, NInput, NSelect, NTag, useMessage } from 'naive-ui';
import { Trash } from '@vicons/tabler';
import { useProjectStore } from '@/stores/project';
import { depthOf, fieldsFromExample, leafOf, mergeGenerated } from '@/utils/responseFields';

/**
 * 「响应说明」页签（第六轮第 2 节）。
 *
 * 一张树形表格：字段路径（按层级缩进）· 类型 · 说明 · 必有。
 * 说明列直接编辑，改了就算接口有改动（走「保存」，和改地址一样）。
 *
 * 字段从**示例的 JSON 结构**列出来（「从示例生成」）——已经写过说明的字段保留说明，
 * 示例里没有了的字段标灰让用户自己决定要不要清掉。数组元素写成 `list[]`，不按下标展开。
 *
 * 它只动 `tab.spec.responseFields`，保存和 dirty 都由外面的请求标签页管。
 */
const props = defineProps({
  tab: { type: Object, required: true }
});

const { t } = useI18n();
const message = useMessage();
const projects = useProjectStore();

/** viewer 只读：所有编辑控件都禁掉（和别处一个口径） */
const canEdit = computed(function () { return projects.canEdit; });

const spec = computed(function () { return props.tab.spec; });
const fields = computed(function () { return spec.value.responseFields || []; });

/** 这一轮「从示例生成」之后发现「示例里已经没有」的路径 */
const missingPaths = ref([]);

const TYPE_OPTIONS = [
  { label: 'string', value: 'string' },
  { label: 'number', value: 'number' },
  { label: 'boolean', value: 'boolean' },
  { label: 'object', value: 'object' },
  { label: 'array', value: 'array' },
  { label: 'null', value: 'null' }
];

/* ---------------- 从示例生成 ---------------- */

const examples = computed(function () {
  return (props.tab.api && props.tab.api.examples) || [];
});

const exampleOptions = computed(function () {
  return examples.value.map(function (example, index) {
    return {
      label: t('fields.exampleOption', {
        name: example.name || t('fields.unnamedExample', { n: index + 1 }),
        status: example.status
      }),
      value: example.id
    };
  });
});

/** 默认选 Mock 正在用的那个示例，没有就用第一个 */
const exampleId = ref('');

const currentExampleId = computed(function () {
  if (exampleId.value && examples.value.some(function (item) { return item.id === exampleId.value; })) {
    return exampleId.value;
  }
  const mock = props.tab.api && props.tab.api.mock;
  return (mock && mock.exampleId) || (examples.value[0] && examples.value[0].id) || '';
});

const canGenerate = computed(function () {
  return Boolean(props.tab.apiId) && examples.value.length > 0;
});

function generate() {
  const example = examples.value.find(function (item) { return item.id === currentExampleId.value; });
  if (!example) {
    message.warning(t('fields.selectExampleFirst'));
    return;
  }

  const result = fieldsFromExample(example.body);
  if (!result.ok) {
    message.warning(result.error);
    return;
  }

  const merged = mergeGenerated(fields.value, result.fields);
  spec.value.responseFields = merged.fields;
  missingPaths.value = merged.missing;

  if (!result.fields.length) message.warning(t('fields.noFieldsInExample'));
  else message.success(t('fields.generatedCount', { n: result.fields.length }));
}

/* ---------------- 增删改 ---------------- */

function updateField(index, patch) {
  const list = fields.value.slice();
  list[index] = Object.assign({}, list[index], patch);
  spec.value.responseFields = list;
}

function removeField(index) {
  const list = fields.value.slice();
  list.splice(index, 1);
  spec.value.responseFields = list;
}

/** 清掉所有「示例里已经没有」的行 */
function removeMissing() {
  const gone = new Set(missingPaths.value);
  spec.value.responseFields = fields.value.filter(function (field) {
    return !gone.has(field.path);
  });
  missingPaths.value = [];
}

const newPath = ref('');

function addField() {
  const path = newPath.value.trim();
  if (!path) {
    message.warning(t('fields.pathRequired'));
    return;
  }
  if (fields.value.some(function (field) { return field.path === path; })) {
    message.warning(t('fields.pathExists'));
    return;
  }

  spec.value.responseFields = fields.value.concat([{
    path: path,
    type: 'string',
    desc: '',
    required: false
  }]);
  newPath.value = '';
}

function isMissing(path) {
  return missingPaths.value.indexOf(path) > -1;
}
</script>

<template>
  <div class="pane">
    <div class="toolbar">
      <span class="label">{{ t('fields.title') }}</span>
      <n-select
        v-if="canGenerate"
        class="example-select"
        size="small"
        :options="exampleOptions"
        :value="currentExampleId"
        @update:value="(value) => { exampleId = value; }"
      />
      <n-button size="small" secondary :disabled="!canGenerate || !canEdit" @click="generate">
        {{ t('fields.generateFromExample') }}
      </n-button>
      <n-button v-if="missingPaths.length && canEdit" size="small" quaternary @click="removeMissing">
        {{ t('fields.clearMissing', { n: missingPaths.length }) }}
      </n-button>
      <span v-if="!tab.apiId" class="hint">{{ t('fields.saveFirstHint') }}</span>
      <span v-else-if="!examples.length" class="hint">{{ t('fields.noExamplesHint') }}</span>
    </div>

    <p class="tip">
      {{ t('fields.tip') }}
    </p>

    <div v-if="fields.length" class="grid">
      <div class="grid-head">
        <span class="col-path">{{ t('fields.colField') }}</span>
        <span class="col-type">{{ t('fields.colType') }}</span>
        <span class="col-desc">{{ t('fields.colDesc') }}</span>
        <span class="col-required">{{ t('fields.colRequired') }}</span>
        <span class="col-actions" />
      </div>

      <div
        v-for="(field, index) in fields"
        :key="field.path"
        class="grid-row"
        :class="{ missing: isMissing(field.path) }"
      >
        <span class="col-path" :style="{ paddingLeft: (10 + depthOf(field.path) * 14) + 'px' }">
          <span class="leaf">{{ leafOf(field.path) }}</span>
          <span class="full-path" :title="field.path">{{ field.path }}</span>
          <n-tag v-if="isMissing(field.path)" size="tiny" :bordered="false">{{ t('fields.missingTag') }}</n-tag>
        </span>

        <span class="col-type">
          <n-select
            size="tiny"
            :options="TYPE_OPTIONS"
            :value="field.type"
            :disabled="!canEdit"
            @update:value="(value) => updateField(index, { type: value })"
          />
        </span>

        <span class="col-desc">
          <n-input
            size="tiny"
            :value="field.desc"
            :disabled="!canEdit"
            :placeholder="t('fields.descPlaceholder')"
            @update:value="(value) => updateField(index, { desc: value })"
          />
        </span>

        <span class="col-required">
          <n-checkbox
            :checked="field.required === true"
            :disabled="!canEdit"
            @update:checked="(value) => updateField(index, { required: value })"
          />
        </span>

        <span class="col-actions">
          <n-button size="tiny" quaternary :title="t('fields.deleteRow')" :disabled="!canEdit" @click="removeField(index)">
            <template #icon>
              <n-icon :component="Trash" />
            </template>
          </n-button>
        </span>
      </div>
    </div>

    <n-empty v-else class="empty" size="small" :description="t('fields.empty')" />

    <div class="add-row">
      <n-input
        v-model:value="newPath"
        size="small"
        :placeholder="t('fields.addPathPlaceholder')"
        :disabled="!canEdit"
        @keyup.enter="addField"
      />
      <n-button size="small" :disabled="!canEdit" @click="addField">{{ t('fields.add') }}</n-button>
    </div>
  </div>
</template>

<style scoped>
.pane {
  padding: 4px 2px 12px;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.toolbar .label {
  font-size: 12px;
  font-weight: 600;
  opacity: 0.75;
}

.example-select {
  width: 220px;
}

.hint {
  font-size: 12px;
  opacity: 0.55;
}

.tip {
  margin: 0 0 10px;
  font-size: 12px;
  line-height: 1.6;
  opacity: 0.6;
}

.grid {
  border: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.18));
  border-radius: 6px;
  overflow: hidden;
}

.grid-head,
.grid-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px;
}

.grid-head {
  height: 30px;
  font-size: 12px;
  opacity: 0.6;
  background: rgba(128, 128, 128, 0.06);
  border-bottom: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.18));
}

.grid-row {
  min-height: 34px;
  border-bottom: 1px solid rgba(128, 128, 128, 0.1);
}

.grid-row:last-child {
  border-bottom: none;
}

/* 示例里已经没有的字段：整行淡掉，右边挂一个标签 */
.grid-row.missing {
  opacity: 0.6;
  background: rgba(128, 128, 128, 0.05);
}

.col-path {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}

.col-path .leaf {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: nowrap;
}

.col-path .full-path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.4;
  font-size: 11px;
}

.col-type {
  flex: none;
  width: 108px;
}

.col-desc {
  flex: 1.4;
  min-width: 0;
}

.col-required {
  flex: none;
  width: 42px;
  display: flex;
  justify-content: center;
}

.col-actions {
  flex: none;
  width: 30px;
  display: flex;
  justify-content: flex-end;
}

.empty {
  padding: 20px 0;
}

.add-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
}
</style>
