<script setup>
import { computed, ref, watch } from 'vue';
import { NButton, NDropdown } from 'naive-ui';
import { useProjectStore } from '@/stores/project';
import { useEnvStore } from '@/stores/env';
import EnvManagerModal from './EnvManagerModal.vue';

const projects = useProjectStore();
const envs = useEnvStore();

const showManager = ref(false);

// 项目一换，这个项目的环境就重新拉一遍（每个项目各自记着自己上次选的那个）
watch(
  function () { return projects.currentId; },
  async function (pid) {
    try {
      await envs.load(pid);
    } catch (err) {
      // 环境拉不到不该挡住主流程，切项目时静默失败即可
    }
  },
  { immediate: true }
);

const options = computed(function () {
  const items = [{ key: '__none', label: '无环境' }];
  envs.environments.forEach(function (env) {
    items.push({ key: env.id, label: env.name });
  });
  items.push({ type: 'divider', key: '__divider' });
  items.push({ key: '__manage', label: '管理环境…' });
  return items;
});

function onSelect(key) {
  if (key === '__manage') {
    showManager.value = true;
    return;
  }
  envs.select(key === '__none' ? '' : key);
}
</script>

<template>
  <n-dropdown :options="options" trigger="click" @select="onSelect">
    <n-button size="small" quaternary>
      {{ envs.selected ? envs.selected.name : '无环境' }}
    </n-button>
  </n-dropdown>

  <env-manager-modal v-model:show="showManager" />
</template>
