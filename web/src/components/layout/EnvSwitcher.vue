<script setup>
import { computed, watch } from 'vue';
import { NIcon, NDropdown } from 'naive-ui';
import { ChevronDown } from '@vicons/tabler';
import { useProjectStore } from '@/stores/project';
import { useEnvStore } from '@/stores/env';
import { useUiStore } from '@/stores/ui';
import EnvManagerModal from './EnvManagerModal.vue';

const projects = useProjectStore();
const envs = useEnvStore();
const ui = useUiStore();

// 响应面板里「变量未定义 → 去环境管理」也走这个开关
const showManager = computed({
  get: function () { return ui.envManagerVisible; },
  set: function (value) { ui.envManagerVisible = value; }
});

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
    <button class="switcher">
      <span class="name">{{ envs.selected ? envs.selected.name : '无环境' }}</span>
      <n-icon size="14" :component="ChevronDown" />
    </button>
  </n-dropdown>

  <env-manager-modal v-model:show="showManager" />
</template>

<style scoped>
.switcher {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 26px;
  padding: 0 8px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: inherit;
  font-size: 12px;
  cursor: pointer;
}

.switcher:hover {
  background: rgba(128, 128, 128, 0.14);
}

.switcher .name {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
