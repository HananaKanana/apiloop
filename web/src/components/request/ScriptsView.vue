<script setup>
import { NAlert, NEmpty, NTag } from 'naive-ui';
import CodeEditor from '@/components/common/CodeEditor.vue';

/**
 * 脚本只读展示。第一版不执行任何脚本（导入时原样保存，见调研文档 D6），
 * 所以这里明确写一句「不会执行」，免得用户以为写了就能生效。
 */
defineProps({
  scripts: { type: Array, default: function () { return []; } }
});
</script>

<template>
  <div class="scripts-view">
    <n-alert type="info" :show-icon="false" class="notice">
      脚本已原样保存，但<strong>不会执行</strong>。
    </n-alert>

    <n-empty v-if="!scripts.length" size="small" description="这个接口没有脚本" />

    <div v-for="(script, index) in scripts" :key="index" class="script">
      <div class="head">
        <n-tag size="small" :bordered="false">
          {{ script.listen === 'prerequest' ? '前置脚本' : '测试脚本' }}
        </n-tag>
      </div>
      <code-editor :model-value="script.exec || ''" language="javascript" readonly min-height="120px" />
    </div>
  </div>
</template>

<style scoped>
.scripts-view {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.notice {
  font-size: 13px;
}

.script {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.head {
  display: flex;
  align-items: center;
  gap: 6px;
}
</style>
