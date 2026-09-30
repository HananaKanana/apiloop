<script setup>
import { computed } from 'vue';
import { NButton, NCheckbox, NInput } from 'naive-ui';

/**
 * 通用的键值表格：query、请求头、路径参数、表单字段都用它。
 * 每行有启用勾选、key、value、描述和删除按钮；最后永远留一行空行，
 * 在空行里一输入就自动变成真行并再补一行空的。
 */
const props = defineProps({
  modelValue: { type: Array, default: function () { return []; } },
  keyPlaceholder: { type: String, default: '名称' },
  valuePlaceholder: { type: String, default: '值' },
  /** 是否显示描述列，表单字段那种窄地方可以关掉 */
  showDesc: { type: Boolean, default: true },
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
</script>

<template>
  <div class="kv-table">
    <div class="row head">
      <div class="cell check" />
      <div class="cell key">{{ keyPlaceholder }}</div>
      <div class="cell value">{{ valuePlaceholder }}</div>
      <div v-if="showDesc" class="cell desc">描述</div>
      <div class="cell action" />
    </div>

    <div v-for="(row, index) in rows" :key="index" class="row">
      <div class="cell check">
        <n-checkbox
          :checked="row.enabled"
          :disabled="disabled"
          @update:checked="(v) => { updateRow(index, { enabled: v }); }"
        />
      </div>

      <div class="cell key">
        <n-input
          size="small"
          :value="row.key"
          :placeholder="keyPlaceholder"
          :disabled="disabled"
          @update:value="(v) => { updateRow(index, { key: v }); }"
        />
      </div>

      <div class="cell value">
        <n-input
          size="small"
          :value="row.value"
          :placeholder="valuePlaceholder"
          :disabled="disabled"
          @update:value="(v) => { updateRow(index, { value: v }); }"
        />
      </div>

      <div v-if="showDesc" class="cell desc">
        <n-input
          size="small"
          :value="row.desc"
          placeholder="描述"
          :disabled="disabled"
          @update:value="(v) => { updateRow(index, { desc: v }); }"
        />
      </div>

      <div class="cell action">
        <n-button
          v-if="!disabled && (row.key || row.value)"
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
.kv-table {
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

.cell.check {
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
  flex: 0 0 26%;
}

.cell.value {
  flex: 1;
}

.cell.desc {
  flex: 0 0 24%;
}
</style>
