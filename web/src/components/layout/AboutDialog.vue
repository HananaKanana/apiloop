<script setup>
import { computed } from 'vue';
import { NButton, NModal, NSpace, useMessage } from 'naive-ui';
import { useSessionStore } from '@/stores/session';

/** 关于：产品名、版本号、数据库路径。数据全部来自 /meta。 */
const props = defineProps({
  show: { type: Boolean, default: false }
});

const emit = defineEmits(['update:show']);

const session = useSessionStore();
const message = useMessage();

const meta = computed(function () {
  return session.meta || {};
});

/**
 * mock 前缀。服务端的 `mockBase` 现在是 `/mock-`，光显示它用户看不懂 ——
 * 补上 `<项目ID>/` 把完整格式说清楚（根项目仍然挂在根路径，不带这个前缀）。
 */
const mockPrefixHint = computed(function () {
  return (meta.value.mockBase || '/mock-') + '<项目ID>/';
});

async function copyPath() {
  try {
    await navigator.clipboard.writeText(meta.value.configPath || '');
    message.success('已复制');
  } catch (err) {
    message.warning('复制失败，请手动选中复制');
  }
}
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    title="关于"
    style="width: 520px; max-width: 92vw"
    @update:show="emit('update:show', $event)"
  >
    <div class="about">
      <div class="line">
        <span class="label">产品</span>
        <span class="value">{{ session.appName }}</span>
      </div>
      <div class="line">
        <span class="label">版本</span>
        <span class="value">{{ meta.version ? 'v' + meta.version : '—' }}</span>
      </div>
      <div class="line">
        <span class="label">数据库</span>
        <span class="value path">{{ meta.configPath || '—' }}</span>
      </div>
      <div class="line">
        <span class="label">mock 前缀</span>
        <span class="value path">{{ mockPrefixHint }}</span>
      </div>
    </div>

    <template #footer>
      <n-space justify="end">
        <n-button size="small" @click="copyPath">复制数据库路径</n-button>
        <n-button size="small" type="primary" @click="emit('update:show', false)">关闭</n-button>
      </n-space>
    </template>
  </n-modal>
</template>

<style scoped>
.about {
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 13px;
}

.line {
  display: flex;
  gap: 12px;
  align-items: baseline;
}

.label {
  flex: none;
  width: 76px;
  opacity: 0.6;
  font-size: 12px;
}

.value {
  flex: 1;
  min-width: 0;
  word-break: break-all;
}

.path {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}
</style>
