<script setup>
import { NButton, NLayoutHeader } from 'naive-ui';
import { useSessionStore } from '@/stores/session';
import UserMenu from './UserMenu.vue';

const emit = defineEmits(['about']);

const session = useSessionStore();
</script>

<template>
  <n-layout-header bordered class="topbar">
    <div class="side">
      <span class="brand">{{ session.appName }}</span>

      <!-- 项目切换与环境切换由外层通过插槽填进来，Task 1 里先是占位 -->
      <slot name="project">
        <n-button size="small" quaternary disabled>项目</n-button>
      </slot>
      <slot name="env">
        <n-button size="small" quaternary disabled>环境</n-button>
      </slot>
    </div>

    <div class="side">
      <slot name="actions" />
      <user-menu @about="emit('about')" />
    </div>
  </n-layout-header>
</template>

<style scoped>
.topbar {
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px;
  box-sizing: border-box;
  gap: 12px;
}

.side {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.brand {
  font-size: 15px;
  font-weight: 600;
  margin-right: 4px;
  white-space: nowrap;
}
</style>
