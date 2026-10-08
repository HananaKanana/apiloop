<script setup>
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { NButton, NIcon } from 'naive-ui';
import { File } from '@vicons/tabler';
import { formatBytes } from '@/utils/bytes';

/**
 * 「其他类型」的文件卡片（T39）：图标 + 文件名 + 类型 + 大小，下面一个大按钮。
 *
 * 超过 20 MB 不自动预览时也用它，`canPreview` 为真就多给一个「仍然预览」。
 */
const props = defineProps({
  fileName: { type: String, default: '' },
  contentType: { type: String, default: '' },
  size: { type: Number, default: 0 },
  canPreview: { type: Boolean, default: false },
  saving: { type: Boolean, default: false }
});

const emit = defineEmits(['save', 'preview']);

const { t } = useI18n();

const name = computed(function () {
  return props.fileName || t('response.previewUntitledFile');
});

const type = computed(function () {
  return String(props.contentType || '').split(';')[0].trim() || t('response.previewUnknownType');
});
</script>

<template>
  <div class="file-card">
    <n-icon class="icon" size="40" :component="File" />
    <div class="meta">
      <div class="name" :title="name">{{ name }}</div>
      <div class="line">{{ type }} · {{ formatBytes(size) }}</div>
    </div>
    <div class="actions">
      <n-button size="small" @click="emit('preview')" v-if="canPreview">
        {{ t('response.previewAnyway') }}
      </n-button>
      <n-button size="small" type="primary" :loading="saving" @click="emit('save')">
        {{ t('response.saveLocal') }}
      </n-button>
    </div>
  </div>
</template>

<style scoped>
.file-card {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 16px;
  border: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.24));
  border-radius: 8px;
}

.icon {
  flex: none;
  opacity: 0.55;
}

.meta {
  flex: 1;
  min-width: 0;
}

.name {
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.line {
  margin-top: 3px;
  font-size: 12px;
  opacity: 0.6;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.actions {
  flex: none;
  display: flex;
  gap: 8px;
}
</style>
