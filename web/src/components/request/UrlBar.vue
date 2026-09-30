<script setup>
import { computed, h } from 'vue';
import { NButton, NSelect } from 'naive-ui';
import VarInput from '@/components/common/VarInput.vue';
import { methodColor } from '@/utils/method';

/**
 * 地址栏：method 下拉（允许输入自定义方法）+ url 输入框 + 发送 / 取消。
 *
 * url 用 VarInput（单行 CodeMirror）：`{{变量}}` 会按「已定义 / 未定义」上色，
 * 输入 `{{` 弹补全，悬停看值和来源。回车发送由 VarInput 的 enter 事件负责 ——
 * 补全列表开着时那一下回车归补全，不会误发。
 *
 * 这里只负责显示和收集输入，url 与路径参数 / query 表格之间的同步放在 RequestTab 里 ——
 * 那件事要同时看 url 和 params 两边，放在这里会把组件搞成双向依赖。
 */
const props = defineProps({
  method: { type: String, default: 'GET' },
  url: { type: String, default: '' },
  sending: { type: Boolean, default: false },
  /** resolveScope() 的结果，给变量高亮和补全用 */
  scope: { type: Map, default: null }
});

const emit = defineEmits(['update:method', 'update:url', 'send', 'cancel']);

// WS 也是一种接口（契约第 17 节）：存进目录树，打开时是 WebSocket 标签页。
// 放在这里是为了「新建接口」时能直接选它，和选 GET / POST 一样。
const METHOD_OPTIONS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'WS'].map(function (name) {
  return { label: name, value: name };
});

const methodOptions = computed(function () {
  const list = METHOD_OPTIONS.slice();
  const current = String(props.method || 'GET').toUpperCase();
  if (!list.some(function (item) { return item.value === current; })) {
    list.unshift({ label: current, value: current });
  }
  return list;
});

/**
 * 方法名按方法上色、加粗。naive-ui 的 `renderLabel` 在下拉项和「已选中那个」
 * 两处都会用到，所以选中状态也是带色的。
 */
function renderMethodOption(option) {
  return h('span', { class: 'method-text', style: { color: methodColor(option.value) } }, option.label);
}
</script>

<template>
  <div class="url-bar">
    <n-select
      class="method"
      size="small"
      tag
      filterable
      :options="methodOptions"
      :render-label="renderMethodOption"
      :value="String(method || 'GET').toUpperCase()"
      @update:value="(v) => emit('update:method', String(v).toUpperCase())"
    />

    <var-input
      class="url"
      :model-value="url"
      :scope="scope"
      placeholder="https://example.com/api/users/:id，支持 {{变量}}"
      @update:model-value="(v) => emit('update:url', v)"
      @enter="emit('send')"
    />

    <n-button
      v-if="sending"
      class="send"
      size="small"
      type="warning"
      secondary
      @click="emit('cancel')"
    >
      取消
    </n-button>
    <n-button v-else class="send" size="small" type="primary" @click="emit('send')">
      发送
    </n-button>
  </div>
</template>

<style scoped>
.url-bar {
  display: flex;
  align-items: center;
  gap: 8px;
}

.method {
  flex: none;
  width: 110px;
}

.url {
  flex: 1;
  min-width: 0;
}

.send {
  flex: none;
  width: 72px;
}

.method-text {
  font-weight: 700;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
</style>
