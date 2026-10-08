<script setup>
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

/**
 * PDF 预览（T39）：把 blob URL 丢进 `<iframe>`，填满 Body 区。
 *
 * 浏览器的内置 PDF 阅读器就能翻页、缩放、下载，不用再引 pdf.js。
 */
const props = defineProps({
  blobUrl: { type: String, default: '' }
});

const { t } = useI18n();

const ready = computed(function () {
  return Boolean(props.blobUrl);
});
</script>

<template>
  <div class="pdf-preview">
    <iframe v-if="ready" class="frame" :src="blobUrl" :title="t('response.pdfTitle')" />
    <p v-else class="empty">{{ t('response.previewLoading') }}</p>
  </div>
</template>

<style scoped>
.pdf-preview {
  height: 100%;
  min-height: 320px;
  display: flex;
}

.frame {
  flex: 1;
  width: 100%;
  min-height: 320px;
  border: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.24));
  border-radius: 6px;
  background: #fff;
}

.empty {
  margin: auto;
  font-size: 12px;
  opacity: 0.6;
}
</style>
