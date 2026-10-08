<script setup>
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { TABLE_MAX_COLS, TABLE_MAX_ROWS } from '@/utils/responseFile';
import { parseCsv } from '@/utils/csv';

/**
 * CSV 的表格视图（T39）。
 *
 * CSV 本来就是文本，代码视图照旧保留，这个只是多给一个「表格」视图。
 * 解析在 `utils/csv.js` 里（纯函数），最多前 500 行 / 50 列。
 */
const props = defineProps({
  text: { type: String, default: '' }
});

const { t } = useI18n();

const parsed = computed(function () {
  return parseCsv(props.text);
});
</script>

<template>
  <div class="csv-preview">
    <p v-if="parsed.truncated" class="summary">
      {{ t('response.previewTableTruncated', { rows: TABLE_MAX_ROWS, cols: TABLE_MAX_COLS }) }}
    </p>

    <div class="scroll">
      <table class="grid">
        <tbody>
          <tr v-for="(row, r) in parsed.rows" :key="r">
            <th class="row-no">{{ r + 1 }}</th>
            <td v-for="(cell, c) in row" :key="c">{{ cell }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <p v-if="!parsed.rows.length" class="empty">{{ t('response.previewEmptyTable') }}</p>
  </div>
</template>

<style scoped>
.csv-preview {
  font-size: 12px;
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

.empty {
  margin: 6px 0 0;
  opacity: 0.6;
}
</style>
