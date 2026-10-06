<script setup>
import { computed, nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { NButton, NCheckbox, NInput, NSelect } from 'naive-ui';
import {
  EXTRACT_PATH_PLACEHOLDER,
  EXTRACT_SOURCE_OPTIONS,
  NO_VALUE_OPS,
  PATH_PLACEHOLDER,
  PRESETS,
  SCOPE_OPTIONS,
  SOURCE_OPTIONS,
  TYPE_OPTIONS,
  newAssertion,
  newExtract,
  opOptions,
  withSource
} from '@/utils/assertions';

/**
 * 「断言」页签（第六轮第 1 节）：上下两张表 —— 断言、提取变量。
 *
 * 这两张表都住在 `spec` 上（和 scripts 一样），所以：
 *  - 改了就算接口「有未保存的修改」，按「保存」落库（viewer 只读）；
 *  - **没保存的改动发送时同样生效**（服务端从请求体里读，见 `lib/api/send.js`）。
 *
 * 组件本身不碰 store：改哪一份由父组件决定（它持有 `spec`）。
 */
const props = defineProps({
  assertions: { type: Array, default: function () { return []; } },
  extracts: { type: Array, default: function () { return []; } },
  /** 只读角色（viewer）：一个都不能改 */
  disabled: { type: Boolean, default: false },
  /** 当前选了环境没有 —— 没选时「存到环境」的提取不会保存，这里先把话说在前面 */
  hasEnvironment: { type: Boolean, default: true },
  /** 刚加的那一行：滚过去并闪一下 */
  highlightId: { type: String, default: '' }
});

const emit = defineEmits(['update:assertions', 'update:extracts']);

const { t } = useI18n();

const rootRef = ref(null);

const assertions = computed(function () { return props.assertions || []; });
const extracts = computed(function () { return props.extracts || []; });

/* ---------------- 断言 ---------------- */

function patchAssertion(id, changes) {
  emit('update:assertions', assertions.value.map(function (row) {
    return row.id === id ? Object.assign({}, row, changes) : row;
  }));
}

function removeAssertion(id) {
  emit('update:assertions', assertions.value.filter(function (row) { return row.id !== id; }));
}

function addAssertion(row) {
  emit('update:assertions', assertions.value.concat([row || newAssertion()]));
}

/* ---------------- 提取变量 ---------------- */

function patchExtract(id, changes) {
  emit('update:extracts', extracts.value.map(function (row) {
    return row.id === id ? Object.assign({}, row, changes) : row;
  }));
}

function removeExtract(id) {
  emit('update:extracts', extracts.value.filter(function (row) { return row.id !== id; }));
}

function addExtract() {
  emit('update:extracts', extracts.value.concat([newExtract()]));
}

/** 换来源时把路径 / 头名 / 正则的输入框提示跟着换 */
function extractPlaceholder(row) {
  return EXTRACT_PATH_PLACEHOLDER[row.source] || '';
}

function assertionPlaceholder(row) {
  return PATH_PLACEHOLDER[row.source] || '';
}

/** 状态码、响应时间、响应文本不用填字段名（那一格灰掉） */
function needsPath(row) {
  return row.source === 'header' || row.source === 'json';
}

/* ---------------- 高亮新加的那一行 ---------------- */

watch(function () { return props.highlightId; }, function (id) {
  if (!id) return;
  nextTick(function () {
    const node = rootRef.value && rootRef.value.querySelector('[data-row-id="' + id + '"]');
    if (node && node.scrollIntoView) node.scrollIntoView({ block: 'center' });
  });
});
</script>

<template>
  <div ref="rootRef" class="pane">
    <p class="label">
      {{ t('assertions.title') }}
      <span class="note">{{ t('assertions.note') }}</span>
    </p>

    <div class="table">
      <div class="row head in-assert">
        <div class="cell" />
        <div class="cell">{{ t('assertions.checkWhat') }}</div>
        <div class="cell">{{ t('assertions.fieldOrName') }}</div>
        <div class="cell">{{ t('assertions.compareBy') }}</div>
        <div class="cell">{{ t('assertions.expectedValue') }}</div>
        <div class="cell" />
      </div>

      <div
        v-for="row in assertions"
        :key="row.id"
        class="row in-assert"
        :class="{ off: row.enabled === false, flash: row.id === props.highlightId }"
        :data-row-id="row.id"
      >
        <div class="cell">
          <n-checkbox
            :checked="row.enabled !== false"
            :disabled="disabled"
            @update:checked="(v) => patchAssertion(row.id, { enabled: v })"
          />
        </div>

        <div class="cell">
          <n-select
            size="small"
            :value="row.source"
            :options="SOURCE_OPTIONS"
            :disabled="disabled"
            @update:value="(v) => patchAssertion(row.id, withSource(row, v))"
          />
        </div>

        <div class="cell">
          <n-input
            size="small"
            :value="row.path"
            :disabled="disabled || !needsPath(row)"
            :placeholder="assertionPlaceholder(row)"
            @update:value="(v) => patchAssertion(row.id, { path: v })"
          />
        </div>

        <div class="cell">
          <n-select
            size="small"
            :value="row.op"
            :options="opOptions(row.source)"
            :disabled="disabled"
            @update:value="(v) => patchAssertion(row.id, { op: v })"
          />
        </div>

        <div class="cell">
          <n-select
            v-if="row.op === 'type'"
            size="small"
            :value="row.value || 'string'"
            :options="TYPE_OPTIONS"
            :disabled="disabled"
            @update:value="(v) => patchAssertion(row.id, { value: v })"
          />
          <n-input
            v-else
            size="small"
            :value="row.value"
            :disabled="disabled || NO_VALUE_OPS[row.op] === true"
            :placeholder="NO_VALUE_OPS[row.op] ? t('assertions.noValueNeeded') : t('assertions.valuePlaceholder')"
            @update:value="(v) => patchAssertion(row.id, { value: v })"
          />
        </div>

        <div class="cell action">
          <n-button v-if="!disabled" size="tiny" quaternary type="error" @click="removeAssertion(row.id)">
            {{ t('app.delete') }}
          </n-button>
        </div>
      </div>

      <div v-if="!assertions.length" class="empty">{{ t('assertions.emptyAssertions') }}</div>
    </div>

    <div class="tools">
      <n-button v-if="!disabled" size="small" @click="addAssertion(null)">{{ t('assertions.addAssertion') }}</n-button>
      <template v-if="!disabled">
        <span class="preset-label">{{ t('assertions.commonPresets') }}</span>
        <n-button
          v-for="preset in PRESETS"
          :key="preset.label"
          size="small"
          quaternary
          @click="addAssertion(newAssertion(preset.row))"
        >
          {{ preset.label }}
        </n-button>
      </template>
    </div>

    <p class="label extracts-label">
      {{ t('assertions.extracts') }}
      <span class="note">{{ t('assertions.extractNote') }}</span>
    </p>

    <div v-if="!hasEnvironment" class="env-hint">
      {{ t('assertions.envHint') }}
    </div>

    <div class="table">
      <div class="row head in-extract">
        <div class="cell" />
        <div class="cell">{{ t('assertions.extractFrom') }}</div>
        <div class="cell">{{ t('assertions.pathHeader') }}</div>
        <div class="cell">{{ t('assertions.storeTo') }}</div>
        <div class="cell">{{ t('assertions.varName') }}</div>
        <div class="cell" />
      </div>

      <div
        v-for="row in extracts"
        :key="row.id"
        class="row in-extract"
        :class="{ off: row.enabled === false, flash: row.id === props.highlightId }"
        :data-row-id="row.id"
      >
        <div class="cell">
          <n-checkbox
            :checked="row.enabled !== false"
            :disabled="disabled"
            @update:checked="(v) => patchExtract(row.id, { enabled: v })"
          />
        </div>

        <div class="cell">
          <n-select
            size="small"
            :value="row.source"
            :options="EXTRACT_SOURCE_OPTIONS"
            :disabled="disabled"
            @update:value="(v) => patchExtract(row.id, { source: v })"
          />
        </div>

        <div class="cell">
          <n-input
            size="small"
            :value="row.path"
            :disabled="disabled"
            :placeholder="extractPlaceholder(row)"
            @update:value="(v) => patchExtract(row.id, { path: v })"
          />
        </div>

        <div class="cell">
          <n-select
            size="small"
            :value="row.scope"
            :options="SCOPE_OPTIONS"
            :disabled="disabled"
            @update:value="(v) => patchExtract(row.id, { scope: v })"
          />
        </div>

        <div class="cell">
          <n-input
            size="small"
            :value="row.name"
            :disabled="disabled"
            :placeholder="t('assertions.varName')"
            @update:value="(v) => patchExtract(row.id, { name: v })"
          />
        </div>

        <div class="cell action">
          <n-button v-if="!disabled" size="tiny" quaternary type="error" @click="removeExtract(row.id)">
            {{ t('app.delete') }}
          </n-button>
        </div>
      </div>

      <div v-if="!extracts.length" class="empty">{{ t('assertions.emptyExtracts') }}</div>
    </div>

    <div v-if="!disabled" class="tools">
      <n-button size="small" @click="addExtract">{{ t('assertions.addExtract') }}</n-button>
    </div>
  </div>
</template>

<style scoped>
.pane {
  padding: 12px 16px;
}

.label {
  margin: 0 0 6px;
  font-size: 13px;
  font-weight: 600;
  opacity: 0.85;
}

.note {
  margin-left: 6px;
  font-weight: 400;
  font-size: 12px;
  opacity: 0.55;
}

.extracts-label {
  margin-top: 18px;
}

.env-hint {
  margin: 6px 0 8px;
  padding: 4px 10px;
  border-radius: 4px;
  font-size: 12px;
  color: #f0a020;
  background: rgba(240, 160, 32, 0.12);
}

.table {
  border: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.24));
  border-radius: 4px;
  overflow: hidden;
}

.row {
  display: grid;
  gap: 0;
  border-bottom: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.14));
}

.row:last-child {
  border-bottom: none;
}

.row.in-assert {
  grid-template-columns: 34px minmax(0, 20%) minmax(0, 1fr) minmax(0, 15%) minmax(0, 1fr) 56px;
}

.row.in-extract {
  grid-template-columns: 34px minmax(0, 22%) minmax(0, 1fr) minmax(0, 12%) minmax(0, 22%) 56px;
}

.row.head {
  background: rgba(128, 128, 128, 0.07);
  font-size: 12px;
}

.row.head .cell {
  height: 28px;
  opacity: 0.65;
}

.row.off {
  opacity: 0.5;
}

/* 刚加的那一行闪一下（父组件过一会儿把 highlightId 清掉） */
.row.flash {
  animation: apiloop-row-flash 1.4s ease-out;
}

@keyframes apiloop-row-flash {
  from { background: rgba(255, 108, 55, 0.28); }
  to { background: transparent; }
}

.cell {
  min-width: 0;
  display: flex;
  align-items: center;
  padding: 4px 6px;
  border-right: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.14));
}

.cell:last-child {
  border-right: none;
}

.cell.action {
  justify-content: center;
  padding: 0;
}

.empty {
  padding: 10px 12px;
  font-size: 12px;
  opacity: 0.55;
}

.tools {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
}

.preset-label {
  margin-left: 6px;
  font-size: 12px;
  opacity: 0.55;
}
</style>
