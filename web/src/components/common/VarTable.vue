<script setup>
import { computed } from 'vue';
import { NCheckbox, NIcon, NInput, NTooltip } from 'naive-ui';
import { Trash } from '@vicons/tabler';
import { BARE_INPUT_THEME } from '@/utils/bareInput';

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
  disabled: { type: Boolean, default: false }
});

const emit = defineEmits(['update:modelValue']);

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
  <div class="var-table">
    <div class="row head">
      <div class="cell check" />
      <div class="cell key">变量名</div>
      <div class="cell value">值</div>
      <div class="cell secret">secret</div>
      <div class="cell action" />
    </div>

    <div v-for="(row, index) in rows" :key="index" class="row" :class="{ off: row.enabled === false }">
      <div class="cell check">
        <!-- 末尾的空行只是占位，不给复选框（和 KeyValueTable 一致） -->
        <n-checkbox
          v-if="!row.__draft"
          :checked="row.enabled"
          :disabled="disabled"
          @update:checked="(v) => { updateRow(index, { enabled: v }); }"
        />
      </div>

      <div class="cell key">
        <n-input
          size="small"
          :value="row.key"
          :disabled="disabled"
          :theme-overrides="BARE_INPUT_THEME"
          placeholder="变量名"
          @update:value="(v) => { updateRow(index, { key: v }); }"
        />
      </div>

      <div class="cell value">
        <n-input
          size="small"
          :value="row.value"
          :type="row.secret ? 'password' : 'text'"
          :show-password-on="row.secret ? 'click' : undefined"
          :disabled="disabled"
          :theme-overrides="BARE_INPUT_THEME"
          placeholder="值"
          @update:value="(v) => { updateRow(index, { value: v }); }"
        />
      </div>

      <div class="cell secret">
        <n-tooltip trigger="hover">
          <template #trigger>
            <n-checkbox
              v-if="!row.__draft"
              :checked="row.secret"
              :disabled="disabled"
              @update:checked="(v) => { updateRow(index, { secret: v }); }"
            />
          </template>
          标为敏感值，界面上默认打码显示（第一版仍是明文存库）
        </n-tooltip>
      </div>

      <div class="cell action">
        <button
          v-if="!disabled && (row.key || row.value)"
          class="delete-button"
          title="删除这一行"
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
 * 和 KeyValueTable 同一套网格样式：整张表 1px 外框 + 行列细线，
 * 格子里的输入框没有边框和底色。列宽写在一个变量里，改列只改一处。
 */
.var-table {
  --var-cols: 32px minmax(0, 32%) minmax(0, 1fr) 48px 40px;
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
.cell.secret,
.cell.action {
  justify-content: center;
  padding: 0;
}

/* 停用的行：文字半透明（勾选框保持清楚） */
.row.off .cell.key,
.row.off .cell.value {
  opacity: 0.5;
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
