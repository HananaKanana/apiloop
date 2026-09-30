<script setup>
import { computed } from 'vue';
import { NButton, NInput, NSelect } from 'naive-ui';

/**
 * 地址栏：method 下拉（允许输入自定义方法）+ url 输入框 + 发送 / 取消。
 *
 * 这里只负责显示和收集输入，url 与路径参数 / query 表格之间的同步放在 RequestTab 里 ——
 * 那件事要同时看 url 和 params 两边，放在这里会把组件搞成双向依赖。
 */
const props = defineProps({
  method: { type: String, default: 'GET' },
  url: { type: String, default: '' },
  sending: { type: Boolean, default: false }
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
</script>

<template>
  <div class="url-bar">
    <n-select
      class="method"
      size="small"
      tag
      filterable
      :options="methodOptions"
      :value="String(method || 'GET').toUpperCase()"
      @update:value="(v) => emit('update:method', String(v).toUpperCase())"
    />

    <n-input
      class="url"
      size="small"
      :value="url"
      placeholder="https://example.com/api/users/:id，支持 {{变量}}"
      @update:value="(v) => emit('update:url', v)"
      @keyup.enter="emit('send')"
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
</style>
