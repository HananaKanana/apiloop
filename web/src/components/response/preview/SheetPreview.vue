<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { NAlert, NSpin } from 'naive-ui';
import { TABLE_MAX_COLS, TABLE_MAX_ROWS } from '@/utils/responseFile';
import { parseXlsx } from '@/utils/xlsx';

/**
 * xlsx 预览（T39）：fflate 解开 + 自己扫 XML，每个工作表一个页签，表格显示前 500 行 / 50 列。
 *
 * 解析器在 `utils/xlsx.js` 里（纯函数），这里只负责转圈、切页签、画表。
 */
const props = defineProps({
  bytes: { type: Object, default: null }
});

const { t } = useI18n();
const loading = ref(false);
const failed = ref(false);
const sheets = ref([]);
const active = ref(0);

async function load() {
  if (!props.bytes || !props.bytes.length) {
    failed.value = true;
    return;
  }
  loading.value = true;
  failed.value = false;
  try {
    const parsed = await parseXlsx(props.bytes);
    sheets.value = parsed.sheets;
    active.value = 0;
  } catch (err) {
    failed.value = true;
  } finally {
    loading.value = false;
  }
}

onMounted(load);
watch(function () { return props.bytes; }, load);

const current = computed(function () {
  return sheets.value[active.value] || null;
});

const rows = computed(function () {
  return (current.value && current.value.rows) || [];
});
</script>

<template>
  <div class="sheet-preview">
    <n-spin v-if="loading" size="small" class="spin" />

    <n-alert v-else-if="failed" type="warning" :show-icon="false" class="notice">
      {{ t('response.previewXlsxFailed') }}
    </n-alert>

    <template v-else>
      <div v-if="sheets.length > 1" class="tabs">
        <button
          v-for="(sheet, index) in sheets"
          :key="sheet.name + index"
          class="tab"
          :class="{ active: index === active }"
          @click="active = index"
        >
          {{ sheet.name }}
        </button>
      </div>

      <p v-if="current && current.truncated" class="summary">
        {{ t('response.previewTableTruncated', { rows: TABLE_MAX_ROWS, cols: TABLE_MAX_COLS }) }}
      </p>

      <div class="scroll">
        <table class="grid">
          <tbody>
            <tr v-for="(row, r) in rows" :key="r">
              <th class="row-no">{{ r + 1 }}</th>
              <td v-for="(cell, c) in row" :key="c">{{ cell }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>

<style scoped>
.sheet-preview {
  font-size: 12px;
}

.spin {
  display: block;
  padding: 16px;
}

.tabs {
  display: flex;
  gap: 2px;
  margin-bottom: 6px;
  flex-wrap: wrap;
}

.tab {
  height: 24px;
  padding: 0 10px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  font-size: 12px;
  cursor: pointer;
  opacity: 0.65;
}

.tab:hover {
  background: rgba(128, 128, 128, 0.12);
  opacity: 1;
}

.tab.active {
  background: rgba(128, 128, 128, 0.2);
  opacity: 1;
  font-weight: 500;
}

.summary {
  margin: 0 0 6px;
  opacity: 0.65;
}

.scroll {
  overflow: auto;
  max-height: 70vh;
  border: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.24));
  border-radius: 6px;
}

.grid {
  border-collapse: collapse;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.grid td,
.grid th {
  padding: 2px 8px;
  border-right: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.14));
  border-bottom: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.14));
  white-space: nowrap;
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.row-no {
  position: sticky;
  left: 0;
  opacity: 0.45;
  font-weight: 400;
  text-align: right;
  background: var(--apiloop-surface, #fff);
}

.notice {
  font-size: 12px;
}
</style>
