<script setup>
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { NButton, NCheckbox, NDropdown, NIcon, NInput } from 'naive-ui';
import { Dots, Trash } from '@vicons/tabler';
import VarInput from './VarInput.vue';

/**
 * 通用的键值表格：query、路径参数、请求头、表单字段、变量表都用它。
 *
 * 样式照着 Postman 的参数表做：**一整张网格**，行与行、列与列之间都是 1px 细线，
 * 格子里的输入框没有边框和底色，看起来就是直接在表格上打字。
 *
 * 每行有启用勾选、key、value、（可选的）描述和删除；最后永远留一行空行，
 * 在空行里一输入就自动变成真行并再补一行空的。
 *
 * 「值」这一列用 VarInput（带变量高亮和补全），「键」这一列也可以给补全
 * （请求头名字那种），由调用方通过 `keySuggestions` 传进来。
 */
const props = defineProps({
  modelValue: { type: Array, default: function () { return []; } },
  keyPlaceholder: { type: String, default: '' },
  valuePlaceholder: { type: String, default: '' },
  /** 允不允许有描述列（表格右上角可以切换显示） */
  allowDesc: { type: Boolean, default: true },
  /** 只读角色看的时候整表禁用：只展示已有的行，不再补那一行空行 */
  disabled: { type: Boolean, default: false },
  /** resolveScope() 的结果；不传就退化成普通输入框（响应头那种用不上的地方） */
  scope: { type: Map, default: null },
  /** 「键」这一列的补全候选（请求头名字这类） */
  keySuggestions: { type: Array, default: null },
  /** 描述列显示与否按表格类型分开记，这个就是那个类型名 */
  kind: { type: String, default: '' }
});

const emit = defineEmits(['update:modelValue']);

const { t } = useI18n();

/** 表头和格子里的提示：调用方给了就用它的（用户数据不翻译），没给就用通用默认（要跟着语言变） */
const keyPlaceholderText = computed(function () { return props.keyPlaceholder || t('common.paramName'); });
const valuePlaceholderText = computed(function () { return props.valuePlaceholder || t('common.value'); });

/* ---------------- 数据 ---------------- */

function normalize(rows) {
  return (rows || []).map(function (row) {
    return Object.assign({}, row, {
      key: row.key || '',
      value: row.value === undefined || row.value === null ? '' : String(row.value),
      enabled: row.enabled !== false,
      desc: row.desc || ''
    });
  });
}

const rows = computed(function () {
  const list = normalize(props.modelValue);
  if (props.disabled) return list;

  const last = list[list.length - 1];
  if (!last || last.key !== '' || last.value !== '') {
    list.push({ key: '', value: '', enabled: true, desc: '', __draft: true });
  }
  return list;
});

function commit(list) {
  emit('update:modelValue', list.map(function (row) {
    const next = Object.assign({}, row);
    delete next.__draft;
    return next;
  }));
}

function updateRow(index, patch) {
  const list = normalize(props.modelValue);
  if (index >= list.length) {
    list.push({ key: '', value: '', enabled: true, desc: '' });
  }
  Object.assign(list[index], patch);
  commit(list);
}

function removeRow(index) {
  const list = normalize(props.modelValue);
  list.splice(index, 1);
  commit(list);
}

/* ---------------- 描述列 ---------------- */

const DESC_KEY = 'apiloop.kv.desc.';

function readDescPref() {
  if (!props.kind) return null;
  try {
    const value = localStorage.getItem(DESC_KEY + props.kind);
    if (value === '1') return true;
    if (value === '0') return false;
    return null;
  } catch (err) {
    return null;
  }
}

const descPref = ref(readDescPref());

/** 有任意一行填了描述，就默认把这一列显示出来 */
const hasDesc = computed(function () {
  return normalize(props.modelValue).some(function (row) { return Boolean(row.desc); });
});

const showDesc = computed(function () {
  if (!props.allowDesc) return false;
  if (descPref.value !== null) return descPref.value;
  return hasDesc.value;
});

function toggleDesc() {
  const next = !showDesc.value;
  descPref.value = next;
  if (!props.kind) return;
  try {
    localStorage.setItem(DESC_KEY + props.kind, next ? '1' : '0');
  } catch (err) {
    // 存不下就算了，这次会话内还是好用的
  }
}

/* ---------------- 批量编辑 ---------------- */

const batchMode = ref(false);
const batchText = ref('');

function openBatch() {
  batchText.value = normalize(props.modelValue).map(function (row) {
    return (row.enabled === false ? '// ' : '') + row.key + ': ' + row.value;
  }).join('\n');
  batchMode.value = true;
}

/** 每行 `key: value`，以 `//` 开头表示停用；描述按 key 从原数据里找回来 */
function applyBatch() {
  const source = normalize(props.modelValue);
  const list = [];

  batchText.value.split('\n').forEach(function (line) {
    const text = line.trim();
    if (!text) return;

    const off = text.indexOf('//') === 0;
    const body = off ? text.slice(2).trim() : text;
    const at = body.indexOf(':');
    const key = at === -1 ? body : body.slice(0, at).trim();
    const value = at === -1 ? '' : body.slice(at + 1).trim();
    if (!key && !value) return;

    const old = source.find(function (row) { return row.key === key; });
    list.push({ key: key, value: value, enabled: !off, desc: old ? old.desc : '' });
  });

  commit(list);
  batchMode.value = false;
}

/* ---------------- 菜单 ---------------- */

const menuOptions = computed(function () {
  const list = [{ label: batchMode.value ? t('common.exitBatchEdit') : t('common.batchEdit'), key: 'batch' }];
  if (props.allowDesc) {
    list.push({ label: showDesc.value ? t('common.hideDescColumn') : t('common.showDescColumn'), key: 'desc' });
  }
  return list;
});

function onMenuSelect(key) {
  if (key === 'batch') {
    if (batchMode.value) batchMode.value = false;
    else openBatch();
    return;
  }
  if (key === 'desc') toggleDesc();
}

/* ---------------- 值那一列的补全 ---------------- */

const CONTENT_TYPES = [
  'application/json',
  'application/x-www-form-urlencoded',
  'multipart/form-data',
  'text/plain',
  'application/xml',
  'text/html'
].map(function (value) { return { label: value }; });

/** 选了 Content-Type 之后，值这一列给常见类型的补全 */
function valueSuggestions(row) {
  const key = String(row.key || '').trim().toLowerCase();
  if (key === 'content-type') return CONTENT_TYPES;
  return null;
}
</script>

<template>
  <!-- 批量编辑：每行一条 `key: value`，以 `//` 开头表示停用 -->
  <div v-if="batchMode" class="kv-batch">
    <n-input
      v-model:value="batchText"
      type="textarea"
      size="small"
      :autosize="{ minRows: 4, maxRows: 14 }"
      :placeholder="t('common.batchPlaceholder')"
    />
    <div class="kv-batch-foot">
      <n-button size="tiny" @click="batchMode = false">{{ t('app.cancel') }}</n-button>
      <n-button size="tiny" type="primary" @click="applyBatch">{{ t('common.apply') }}</n-button>
    </div>
  </div>

  <div v-else class="kv-table" :class="{ 'with-desc': showDesc }">
    <div class="row head">
      <div class="cell check" />
      <div class="cell key">{{ keyPlaceholderText }}</div>
      <div class="cell value">{{ valuePlaceholderText }}</div>
      <div v-if="showDesc" class="cell desc">{{ t('common.description') }}</div>
      <div class="cell action">
        <n-dropdown trigger="click" :options="menuOptions" @select="onMenuSelect">
          <button class="menu-button" :title="t('common.tableOptions')">
            <n-icon size="14" :component="Dots" />
          </button>
        </n-dropdown>
      </div>
    </div>

    <div v-for="(row, index) in rows" :key="index" class="row" :class="{ off: row.enabled === false }">
      <div class="cell check">
        <!--
          末尾那行空行只是占位，不给复选框：勾着的空行看起来像一条已经启用的空参数。
          往里填了内容它就变成真行（默认启用），复选框这时候才出现。
        -->
        <n-checkbox
          v-if="!row.__draft"
          :checked="row.enabled"
          :disabled="disabled"
          @update:checked="(v) => { updateRow(index, { enabled: v }); }"
        />
      </div>

      <div class="cell key">
        <var-input
          bare
          :model-value="row.key"
          :placeholder="keyPlaceholderText"
          :readonly="disabled"
          :suggest="keySuggestions"
          @update:model-value="(v) => { updateRow(index, { key: v }); }"
        />
      </div>

      <div class="cell value">
        <var-input
          bare
          :model-value="row.value"
          :placeholder="valuePlaceholderText"
          :readonly="disabled"
          :scope="scope"
          :suggest="valueSuggestions(row)"
          @update:model-value="(v) => { updateRow(index, { value: v }); }"
        />
      </div>

      <div v-if="showDesc" class="cell desc">
        <var-input
          bare
          :model-value="row.desc"
          :placeholder="t('common.description')"
          :readonly="disabled"
          @update:model-value="(v) => { updateRow(index, { desc: v }); }"
        />
      </div>

      <!-- 删除：位置固定，悬停才出现，不挤压别的列 -->
      <div class="cell action">
        <button
          v-if="!disabled && (row.key || row.value)"
          class="delete-button"
          :title="t('common.deleteRow')"
          @click="removeRow(index)"
        >
          <n-icon size="15" :component="Trash" />
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/*
 * 一整张网格：行是独立的 grid 容器，但列宽定义完全一样，所以纵向是对齐的。
 * 列宽放在 --kv-cols 里，带不带描述列只改这一个变量。
 */
.kv-table {
  --kv-cols: 32px minmax(0, 26%) minmax(0, 1fr) 40px;
  border: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.24));
  border-radius: 4px;
  overflow: hidden;
}

.kv-table.with-desc {
  --kv-cols: 32px minmax(0, 22%) minmax(0, 1fr) minmax(0, 22%) 40px;
}

.row {
  display: grid;
  grid-template-columns: var(--kv-cols);
  border-bottom: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.16));
}

.row:last-child {
  border-bottom: none;
}

.row:hover {
  background: rgba(128, 128, 128, 0.06);
}

/* 表头：12px 灰字，底色略深一点 */
.row.head {
  background: rgba(128, 128, 128, 0.08);
  font-size: 12px;
  color: inherit;
}

.cell {
  min-width: 0;
  display: flex;
  align-items: center;
  min-height: 32px;
  padding: 0 8px;
  border-right: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.16));
}

.cell:last-child {
  border-right: none;
}

.row.head .cell {
  opacity: 0.6;
}

/* 格子里的输入框没有边框和底色；聚焦时只给这一个格子一层很浅的主色底 */
.cell:focus-within {
  background: rgba(var(--apiloop-primary-rgb), 0.08);
}

.row.head .cell:focus-within {
  background: transparent;
}

.cell.check {
  justify-content: center;
  padding: 0;
}

.cell.action {
  justify-content: center;
  padding: 0;
}

/* 停用的行：文字半透明（勾选框保持清楚） */
.row.off .cell.key,
.row.off .cell.value,
.row.off .cell.desc {
  opacity: 0.5;
}

.menu-button,
.delete-button {
  width: 26px;
  height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  opacity: 0.5;
}

.menu-button:hover {
  background: rgba(128, 128, 128, 0.16);
  opacity: 1;
}

/* 删除按钮平时不显示，鼠标到这一行才出来 */
.delete-button {
  opacity: 0;
}

.row:hover .delete-button {
  opacity: 0.6;
}

.delete-button:hover {
  background: rgba(235, 32, 19, 0.12);
  color: #eb2013;
  opacity: 1;
}

.kv-batch-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 6px;
}
</style>
