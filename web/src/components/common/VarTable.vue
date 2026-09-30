<script setup>
import { computed, onBeforeUnmount, ref } from 'vue';
import { NCheckbox, NIcon, NInput, NSelect } from 'naive-ui';
import { Trash } from '@vicons/tabler';
import { BARE_INPUT_THEME, BARE_SELECT_THEME } from '@/utils/bareInput';

/**
 * 变量表格：key、value、启用、secret。
 * secret 的行直接把输入框换成 password 类型，Naive UI 自带「眼睛」开关，
 * 默认就是圆点，点一下才显示明文。
 *
 * 最后永远留一行空行，在空行里一输入就自动变成真行并再补一行空的。
 */
const props = defineProps({
  modelValue: { type: Array, default: function () { return []; } },
  /** 只读角色看的时候整表禁用：只展示已有的行，不再补那一行空行 */
  disabled: { type: Boolean, default: false },
  /**
   * 变量名过滤词。过滤在表内做，为的是把每一行都带着**原始下标**一起渲染 ——
   * 不然 `updateRow` 会拿过滤后的子集去覆盖整份数据。
   */
  filter: { type: String, default: '' }
});

const emit = defineEmits(['update:modelValue']);

/* ---------------- 变量名那一列的宽度，可以拖 ---------------- */

/**
 * 表头「变量名」右边缘可以左右拖，宽度记进 localStorage（所有变量表共用一份）。
 * 没拖过就是 28%。
 */
const KEY_WIDTH_KEY = 'apiloop.varTable.keyWidth';
const MIN_KEY = 80;
/** 其余几列的固定宽度（勾选 32 + 类型 92 + 删除 40），再给「值」至少留 120 */
const FIXED_COLS = 32 + 92 + 40;
const MIN_VALUE = 120;

function readKeyWidth() {
  try {
    const value = Number(localStorage.getItem(KEY_WIDTH_KEY));
    if (value >= MIN_KEY) return value;
  } catch (err) {
    // 读不到就用默认的百分比
  }
  return 0;
}

const tableRef = ref(null);
const keyWidth = ref(readKeyWidth());
let resizeStart = null;

const tableStyle = computed(function () {
  return { '--var-key': keyWidth.value ? keyWidth.value + 'px' : '28%' };
});

function startResize(event) {
  const cell = event.target.parentElement;
  resizeStart = { x: event.clientX, width: cell.getBoundingClientRect().width };
  document.body.style.userSelect = 'none';
  document.body.style.cursor = 'col-resize';
  window.addEventListener('mousemove', onResize);
  window.addEventListener('mouseup', stopResize);
}

function onResize(event) {
  if (!resizeStart || !tableRef.value) return;
  const max = tableRef.value.clientWidth - FIXED_COLS - MIN_VALUE;
  const next = resizeStart.width + event.clientX - resizeStart.x;
  keyWidth.value = Math.round(Math.max(MIN_KEY, Math.min(next, max)));
}

function stopResize() {
  if (!resizeStart) return;
  resizeStart = null;
  document.body.style.userSelect = '';
  document.body.style.cursor = '';
  window.removeEventListener('mousemove', onResize);
  window.removeEventListener('mouseup', stopResize);
  try {
    localStorage.setItem(KEY_WIDTH_KEY, String(keyWidth.value));
  } catch (err) {
    // 存不下就算了，这次还是好用的
  }
}

onBeforeUnmount(stopResize);

/** 「类型」那一列：和 Postman 的 default / secret 对应 */
const TYPE_OPTIONS = [
  { label: '默认', value: 'default' },
  { label: '保密', value: 'secret' }
];

function normalize(rows) {
  return (rows || []).map(function (row) {
    return Object.assign({}, row, {
      key: row.key || '',
      value: row.value === undefined || row.value === null ? '' : String(row.value),
      enabled: row.enabled !== false,
      secret: row.secret === true
    });
  });
}

const rows = computed(function () {
  const list = normalize(props.modelValue);
  if (props.disabled) return list;

  const last = list[list.length - 1];
  if (!last || last.key !== '' || last.value !== '') {
    list.push({ key: '', value: '', enabled: true, secret: false, __draft: true });
  }
  return list;
});

/**
 * 渲染用的行：带原始下标。过滤时隐藏末尾的空行（那行本来也填不了东西）。
 */
const visibleRows = computed(function () {
  const all = rows.value;
  const keyword = String(props.filter || '').trim().toLowerCase();
  const indexed = all.map(function (row, index) {
    return { row: row, index: index };
  });
  if (!keyword) return indexed;
  return indexed.filter(function (item) {
    return !item.row.__draft && String(item.row.key || '').toLowerCase().indexOf(keyword) !== -1;
  });
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
    list.push({ key: '', value: '', enabled: true, secret: false });
  }
  Object.assign(list[index], patch);
  commit(list);
}

function removeRow(index) {
  const list = normalize(props.modelValue);
  list.splice(index, 1);
  commit(list);
}
</script>

<template>
  <div ref="tableRef" class="var-table" :style="tableStyle">
    <div class="row head">
      <div class="cell check" />
      <div class="cell key">
        变量名
        <!-- 拖这条竖线调「变量名」这一列的宽度 -->
        <span class="col-resizer" title="拖动调整列宽" @mousedown.prevent="startResize" />
      </div>
      <div class="cell type">类型</div>
      <div class="cell value">值</div>
      <div class="cell action" />
    </div>

    <div
      v-for="item in visibleRows"
      :key="item.index"
      class="row"
      :class="{ off: item.row.enabled === false }"
    >
      <div class="cell check">
        <!-- 末尾的空行只是占位，不给复选框（和 KeyValueTable 一致） -->
        <n-checkbox
          v-if="!item.row.__draft"
          :checked="item.row.enabled"
          :disabled="disabled"
          @update:checked="(v) => { updateRow(item.index, { enabled: v }); }"
        />
      </div>

      <div class="cell key">
        <n-input
          size="small"
          :value="item.row.key"
          :disabled="disabled"
          :theme-overrides="BARE_INPUT_THEME"
          placeholder="变量名"
          @update:value="(v) => { updateRow(item.index, { key: v }); }"
        />
      </div>

      <div class="cell type">
        <n-select
          size="small"
          :value="item.row.secret ? 'secret' : 'default'"
          :options="TYPE_OPTIONS"
          :disabled="disabled"
          :theme-overrides="BARE_SELECT_THEME"
          @update:value="(v) => { updateRow(item.index, { secret: v === 'secret' }); }"
        />
      </div>

      <div class="cell value">
        <n-input
          size="small"
          :value="item.row.value"
          :type="item.row.secret ? 'password' : 'text'"
          :show-password-on="item.row.secret ? 'click' : undefined"
          :disabled="disabled"
          :theme-overrides="BARE_INPUT_THEME"
          placeholder="值"
          @update:value="(v) => { updateRow(item.index, { value: v }); }"
        />
      </div>

      <div class="cell action">
        <button
          v-if="!disabled && (item.row.key || item.row.value)"
          class="delete-button"
          title="删除这一行"
          @click="removeRow(item.index)"
        >
          <n-icon size="15" :component="Trash" />
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/*
 * 和 KeyValueTable 同一套网格样式：整张表 1px 外框 + 行列细线，
 * 格子里的输入框没有边框和底色。列宽写在一个变量里，改列只改一处。
 */
.var-table {
  /* 列顺序：勾选 | 变量名 | 类型 | 值 | 删除。表头和每一行都必须按这个顺序排格子 */
  --var-cols: 32px minmax(0, var(--var-key, 28%)) 92px minmax(0, 1fr) 40px;
  border: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.24));
  border-radius: 4px;
  overflow: hidden;
}

.row {
  display: grid;
  grid-template-columns: var(--var-cols);
  border-bottom: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.16));
}

.row:last-child {
  border-bottom: none;
}

.row:hover {
  background: rgba(128, 128, 128, 0.06);
}

.row.head {
  background: rgba(128, 128, 128, 0.08);
  font-size: 12px;
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

.cell:focus-within {
  background: rgba(255, 108, 55, 0.08);
}

.row.head .cell:focus-within {
  background: transparent;
}

.cell.check,
.cell.action {
  justify-content: center;
  padding: 0;
}

/* 停用的行：文字半透明（勾选框保持清楚） */
.row.off .cell.key,
.row.off .cell.value {
  opacity: 0.5;
}

.row.head .cell.key {
  position: relative;
}

/* 表头「变量名」右边缘那条拖动线：平时看不见，鼠标上去才显色 */
.col-resizer {
  position: absolute;
  top: 0;
  right: -3px;
  bottom: 0;
  width: 6px;
  z-index: 1;
  cursor: col-resize;
}

.col-resizer:hover {
  background: var(--apiloop-primary);
}

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
</style>
