<script setup>
import { computed, watch } from 'vue';
import { NIcon, NDropdown } from 'naive-ui';
import { ChevronDown } from '@vicons/tabler';
import { useProjectStore } from '@/stores/project';
import { useEnvStore } from '@/stores/env';
import { useUiStore } from '@/stores/ui';
import { useTabsStore } from '@/stores/tabs';

const projects = useProjectStore();
const envs = useEnvStore();
const ui = useUiStore();
const tabs = useTabsStore();

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

// 环境被删掉之后，把它的标签页收掉。放在这里是因为切换器一直挂着（标签行常驻），
// 而侧栏的「环境」页只有停在那页时才在。
watch(
  function () { return envs.environments; },
  function (list) {
    tabs.syncWithEnvs((list || []).map(function (item) { return item.id; }));
  },
  { deep: true }
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
    // 环境管理已经没有弹窗了：切到侧栏的「环境」页，在那里点开某个环境
    ui.setSidebarTab('env');
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
