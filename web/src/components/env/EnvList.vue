<script setup>
import { computed } from 'vue';
import { NButton, NEmpty, NIcon } from 'naive-ui';
import { Plus } from '@vicons/tabler';
import { useEnvStore } from '@/stores/env';
import { useProjectStore } from '@/stores/project';
import { useUiStore } from '@/stores/ui';

/**
 * 侧栏「环境」页：列出当前项目的环境。
 * 点某一条打开环境管理弹窗并定位到它；「新建」直接开弹窗（新环境在弹窗里建）。
 */
const envs = useEnvStore();
const projects = useProjectStore();
const ui = useUiStore();

const list = computed(function () {
  return envs.environments || [];
});

function openEnv(env) {
  ui.openEnvManager(env.id);
}

function openManager() {
  ui.openEnvManager('');
}
</script>

<template>
  <div class="env-list">
    <div class="head">
      <span class="group-title">环境</span>
      <n-button v-if="projects.canEdit" size="tiny" quaternary @click="openManager">
        <template #icon>
          <n-icon :component="Plus" />
        </template>
        新建
      </n-button>
    </div>

    <div class="list">
      <div
        v-for="env in list"
        :key="env.id"
        class="item"
        :class="{ active: env.id === envs.selectedId }"
        @click="openEnv(env)"
      >
        <span class="name">{{ env.name }}</span>
        <span class="count">{{ (env.variables || []).length }} 个变量</span>
      </div>

      <n-empty
        v-if="!list.length"
        size="small"
        description="还没有环境，点右上角「新建」"
      />
    </div>
  </div>
</template>

<style scoped>
.env-list {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.head {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 10px 6px 12px;
}

/* 和目录页的分组标题一个样式（对应 Postman 的 COLLECTIONS） */
.group-title {
  font-size: 12px;
  letter-spacing: 0.6px;
  opacity: 0.6;
  text-transform: uppercase;
}

.list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 0 6px 8px;
}

.item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
}

.item:hover {
  background: rgba(128, 128, 128, 0.12);
}

.item.active {
  background: rgba(128, 128, 128, 0.18);
}

.name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.count {
  flex: none;
  font-size: 11px;
  opacity: 0.55;
}
</style>
