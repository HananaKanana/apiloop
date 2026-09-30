<script setup>
import { NDropdown } from 'naive-ui';

/**
 * 右键菜单（目录树、标签页、环境列表共用）。
 * 用 trigger="manual" + x/y 定位到鼠标位置；Naive UI 在这种模式下按 x/y 摆，
 * 但仍然需要一个 trigger 元素，所以放一个贴着光标的零尺寸锚点。
 */
defineProps({
  show: { type: Boolean, default: false },
  x: { type: Number, default: 0 },
  y: { type: Number, default: 0 },
  options: { type: Array, default: function () { return []; } }
});

const emit = defineEmits(['update:show', 'select']);
</script>

<template>
  <n-dropdown
    :show="show"
    :x="x"
    :y="y"
    :options="options"
    trigger="manual"
    placement="bottom-start"
    @select="(key) => { emit('select', key); }"
    @clickoutside="emit('update:show', false)"
  >
    <span class="ctx-anchor" :style="{ left: x + 'px', top: y + 'px' }" />
  </n-dropdown>
</template>

<style scoped>
.ctx-anchor {
  position: fixed;
  width: 1px;
  height: 1px;
  pointer-events: none;
}
</style>
