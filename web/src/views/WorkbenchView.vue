<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { NButton, NEmpty } from 'naive-ui';
import TopBar from '@/components/layout/TopBar.vue';

const MIN_WIDTH = 180;
const MAX_WIDTH = 640;
const COLLAPSE_BREAKPOINT = 1024;

const leftWidth = ref(Number(localStorage.getItem('apiloop.treeWidth')) || 280);
const collapsed = ref(false);
const dragging = ref(false);

function clamp(value) {
  return Math.min(Math.max(value, MIN_WIDTH), MAX_WIDTH);
}

function startDrag() {
  dragging.value = true;
  document.body.style.userSelect = 'none';
  document.body.style.cursor = 'col-resize';
}

function onMove(event) {
  if (!dragging.value) return;
  leftWidth.value = clamp(event.clientX);
}

function stopDrag() {
  if (!dragging.value) return;
  dragging.value = false;
  document.body.style.userSelect = '';
  document.body.style.cursor = '';
  localStorage.setItem('apiloop.treeWidth', String(leftWidth.value));
}

/** 窄屏自动收起来；变宽时不自动展开，免得跟用户的手动选择打架 */
function onResize() {
  if (window.innerWidth < COLLAPSE_BREAKPOINT) collapsed.value = true;
}

onMounted(function () {
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', stopDrag);
  window.addEventListener('resize', onResize);
  onResize();
});

onBeforeUnmount(function () {
  window.removeEventListener('mousemove', onMove);
  window.removeEventListener('mouseup', stopDrag);
  window.removeEventListener('resize', onResize);
  stopDrag();
});
</script>

<template>
  <div class="shell">
    <top-bar>
      <template #actions>
        <n-button quaternary size="small" @click="collapsed = !collapsed">
          {{ collapsed ? '显示目录' : '隐藏目录' }}
        </n-button>
      </template>
    </top-bar>

    <div class="body">
      <aside v-show="!collapsed" class="left" :style="{ width: leftWidth + 'px' }">
        <div class="pane-placeholder">
          <n-empty description="目录树" size="small" />
        </div>
      </aside>

      <div
        v-show="!collapsed"
        class="splitter"
        :class="{ active: dragging }"
        @mousedown.prevent="startDrag"
      />

      <main class="right">
        <div class="pane-placeholder">
          <n-empty description="请求编辑器" size="small" />
        </div>
      </main>
    </div>
  </div>
</template>

<style scoped>
.shell {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.body {
  flex: 1;
  min-height: 0;
  display: flex;
}

.left {
  flex: none;
  min-width: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.24));
}

.splitter {
  flex: none;
  width: 5px;
  cursor: col-resize;
  margin-left: -3px;
  margin-right: -2px;
  z-index: 2;
  background: transparent;
  transition: background 0.15s;
}

.splitter:hover,
.splitter.active {
  background: var(--n-primary-color, #2080f0);
}

.right {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.pane-placeholder {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0.5;
}
</style>
