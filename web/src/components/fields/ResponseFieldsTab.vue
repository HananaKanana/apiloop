<script setup>
import { computed, ref } from 'vue';
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
      label: (example.name || '示例 ' + (index + 1)) + '（' + example.status + '）',
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
    message.warning('先选一个示例');
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

  if (!result.fields.length) message.warning('这个示例里没有可列的字段');
  else message.success('列出了 ' + result.fields.length + ' 个字段');
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
    message.warning('填一个字段路径，比如 data.list[].id');
    return;
  }
  if (fields.value.some(function (field) { return field.path === path; })) {
    message.warning('这个路径已经有了');
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
      <span class="label">响应字段说明</span>
      <n-select
        v-if="canGenerate"
        class="example-select"
        size="small"
        :options="exampleOptions"
        :value="currentExampleId"
        @update:value="(value) => { exampleId = value; }"
      />
      <n-button size="small" secondary :disabled="!canGenerate || !canEdit" @click="generate">
        从示例生成
      </n-button>
      <n-button v-if="missingPaths.length && canEdit" size="small" quaternary @click="removeMissing">
        清掉示例里没有的（{{ missingPaths.length }}）
      </n-button>
      <span v-if="!tab.apiId" class="hint">先保存成接口，才能从示例生成</span>
      <span v-else-if="!examples.length" class="hint">这个接口还没有示例</span>
    </div>

    <p class="tip">
      给前端和对接方看的：这个字段是什么意思。说明会出现在分享出去的接口文档里，
      也会带进导出的 OpenAPI。
    </p>

    <div v-if="fields.length" class="grid">
      <div class="grid-head">
        <span class="col-path">字段</span>
        <span class="col-type">类型</span>
        <span class="col-desc">说明</span>
        <span class="col-required">必有</span>
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
          <n-tag v-if="isMissing(field.path)" size="tiny" :bordered="false">示例里已经没有</n-tag>
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
            placeholder="这个字段是什么意思"
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
          <n-button size="tiny" quaternary title="删除这一行" :disabled="!canEdit" @click="removeField(index)">
            <template #icon>
              <n-icon :component="Trash" />
            </template>
          </n-button>
        </span>
      </div>
    </div>

    <n-empty v-else class="empty" size="small" description="还没有字段。可以从示例生成，或者手动加一行。" />

    <div class="add-row">
      <n-input
        v-model:value="newPath"
        size="small"
        placeholder="手动加一行：字段路径，比如 data.list[].id"
        :disabled="!canEdit"
        @keyup.enter="addField"
      />
      <n-button size="small" :disabled="!canEdit" @click="addField">添加</n-button>
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
