<script setup>
import { computed } from 'vue';
import { NButton, NCheckbox, NInput, NTooltip } from 'naive-ui';

/**
 * 变量表格：key、value、启用、secret。
 * secret 的行直接把输入框换成 password 类型，Naive UI 自带「眼睛」开关，
 * 默认就是圆点，点一下才显示明文。
 *
 * 最后永远留一行空行，在空行里一输入就自动变成真行并再补一行空的。
 */
const props = defineProps({
  modelValue: { type: Array, default: function () { return []; } }
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

    <div v-for="(row, index) in rows" :key="index" class="row">
      <div class="cell check">
        <n-checkbox
          :checked="row.enabled"
          @update:checked="(v) => { updateRow(index, { enabled: v }); }"
        />
      </div>

      <div class="cell key">
        <n-input
          size="small"
          :value="row.key"
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
          placeholder="值"
          @update:value="(v) => { updateRow(index, { value: v }); }"
        />
      </div>

      <div class="cell secret">
        <n-tooltip trigger="hover">
          <template #trigger>
            <n-checkbox
              :checked="row.secret"
              @update:checked="(v) => { updateRow(index, { secret: v }); }"
            />
          </template>
          标为敏感值，界面上默认打码显示（第一版仍是明文存库）
        </n-tooltip>
      </div>

      <div class="cell action">
        <n-button
          v-if="row.key || row.value"
          size="tiny"
          quaternary
          type="error"
          @click="removeRow(index)"
        >
          删除
        </n-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.var-table {
  border: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.24));
  border-radius: 6px;
  overflow: hidden;
}

.row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  border-bottom: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.16));
}

.row:last-child {
  border-bottom: none;
}

.row.head {
  font-size: 12px;
  opacity: 0.65;
  padding: 5px 6px;
}

.cell {
  min-width: 0;
}

.cell.check,
.cell.secret {
  flex: none;
  width: 26px;
  display: flex;
  justify-content: center;
}

.cell.action {
  flex: none;
  width: 52px;
  display: flex;
  justify-content: flex-end;
}

.cell.key {
  flex: 0 0 34%;
}

.cell.value {
  flex: 1;
}
</style>
