<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { NAlert, NSpin } from 'naive-ui';
import { formatBytes } from '@/utils/bytes';
import { listZip } from '@/utils/zip';

/**
 * zip 的目录列表（T39）。只列不解压 —— 需求里说了不支持解开单个文件预览。
 *
 * 解析要 `import('fflate')`（按需加载），所以是异步的：先转圈，好了再画表。
 */
const props = defineProps({
  bytes: { type: Object, default: null }
});

const { t } = useI18n();
const loading = ref(false);
const failed = ref(false);
const data = ref(null);

async function load() {
  if (!props.bytes || !props.bytes.length) {
    failed.value = true;
    return;
  }
  loading.value = true;
  failed.value = false;
  try {
    data.value = await listZip(props.bytes);
  } catch (err) {
    failed.value = true;
  } finally {
    loading.value = false;
  }
}

onMounted(load);
watch(function () { return props.bytes; }, load);

const entries = computed(function () {
  return (data.value && data.value.entries) || [];
});
</script>

<template>
  <div class="zip-preview">
    <n-spin v-if="loading" size="small" class="spin" />

    <n-alert v-else-if="failed" type="warning" :show-icon="false" class="notice">
      {{ t('response.previewZipFailed') }}
    </n-alert>

    <template v-else>
      <p class="summary">
        {{ t('response.previewZipSummary', { n: entries.length, size: formatBytes(data ? data.totalSize : 0) }) }}
      </p>
      <table class="grid">
        <thead>
          <tr>
            <th>{{ t('response.previewColName') }}</th>
            <th class="num">{{ t('response.previewColSize') }}</th>
            <th class="num">{{ t('response.previewColCompressed') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in entries" :key="item.name">
            <td class="name" :title="item.name">{{ item.name }}</td>
            <td class="num">{{ formatBytes(item.size) }}</td>
            <td class="num">{{ formatBytes(item.compressedSize) }}</td>
          </tr>
        </tbody>
      </table>
      <p class="note">{{ t('response.previewZipNoExtract') }}</p>
    </template>
  </div>
</template>

<style scoped>
.zip-preview {
  font-size: 12px;
}

.spin {
  display: block;
  padding: 16px;
}

.summary,
.note {
  margin: 0 0 6px;
  opacity: 0.65;
}

.grid {
  width: 100%;
  border-collapse: collapse;
}

.grid th,
.grid td {
  padding: 3px 8px;
  text-align: left;
  border-bottom: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.14));
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.grid th {
  opacity: 0.65;
  font-weight: 500;
  position: sticky;
  top: 0;
  background: var(--apiloop-surface, #fff);
}

.num {
  text-align: right;
  white-space: nowrap;
}

.name {
  word-break: break-all;
}

.notice {
  font-size: 12px;
}
</style>
