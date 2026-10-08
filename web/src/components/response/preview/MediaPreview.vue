<script setup>
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

/**
 * 音频 / 视频预览（T39）。`kind` 决定用 `<audio>` 还是 `<video controls>`。
 */
const props = defineProps({
  kind: { type: String, default: 'audio' },
  blobUrl: { type: String, default: '' },
  mime: { type: String, default: '' }
});

const { t } = useI18n();

const ready = computed(function () {
  return Boolean(props.blobUrl);
});

const isVideo = computed(function () {
  return props.kind === 'video';
});
</script>

<template>
  <div class="media-preview">
    <template v-if="ready">
      <video v-if="isVideo" class="player" :src="blobUrl" :type="mime" controls />
      <audio v-else class="player" :src="blobUrl" :type="mime" controls />
    </template>
    <p v-else class="empty">{{ t('response.previewLoading') }}</p>
  </div>
</template>

<style scoped>
.media-preview {
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 16px;
  min-height: 160px;
}

.player {
  max-width: 100%;
  max-height: 70vh;
}

.empty {
  margin: 0;
  font-size: 12px;
  opacity: 0.6;
}
</style>
