<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';

/**
 * 图片预览（T39）。
 *
 * 优先用 `blobUrl`（从完整文件取回来的那份）—— 被截断的响应只有前几个字节，
 * 画出来是一张破图；没有 blob 时才退回内存里的 base64（`dataUrl`）。
 */
const props = defineProps({
  dataUrl: { type: String, default: '' },
  blobUrl: { type: String, default: '' },
  alt: { type: String, default: '' }
});

const { t } = useI18n();
const failed = ref(false);

const src = computed(function () {
  return props.blobUrl || props.dataUrl;
});

watch(src, function () { failed.value = false; });

// 组件卸载时不用管 blobUrl —— 它由 BodyViewer 统一 revoke（同一个 blob 可能被别的预览用着）
onBeforeUnmount(function () {});
</script>

<template>
  <div class="image-preview">
    <img v-if="src && !failed" class="image" :src="src" :alt="alt || t('response.imageAlt')" @error="failed = true" />
    <p v-else class="empty">{{ t('response.previewBrokenImage') }}</p>
  </div>
</template>

<style scoped>
.image-preview {
  display: flex;
  justify-content: center;
  padding: 12px;
  min-height: 120px;
}

.image {
  max-width: 100%;
  image-rendering: pixelated;
}

.empty {
  margin: 0;
  font-size: 12px;
  opacity: 0.6;
}
</style>
