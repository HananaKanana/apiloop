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
    <!-- 方法下拉和地址合成一个带边框的整体：下拉自己不要边框，中间一条竖线分开 -->
    <div class="url-box">
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

      <span class="divider" />

      <var-input
        class="url"
        borderless
        :model-value="url"
        :scope="scope"
        placeholder="https://example.com/api/users/:id，支持 {{变量}}"
        @update:model-value="(v) => emit('update:url', v)"
        @enter="emit('send')"
      />
    </div>

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
    <!-- Postman 的 Send 一直是蓝色，和主色无关，用户看惯了 -->
    <n-button
      v-else
      class="send"
      size="small"
      color="#097bed"
      text-color="#fff"
      :bordered="false"
      @click="emit('send')"
    >
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

.url-box {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  height: 32px;
  padding-right: 8px;
  border: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.4));
  border-radius: 5px;
  transition: border-color 0.3s;
}

.url-box:focus-within {
  border-color: var(--apiloop-primary);
}

/* 方法下拉去掉自己的边框和底色，融进外面那个框 */
.url-box :deep(.n-base-selection) {
  --n-border: none;
  --n-border-hover: none;
  --n-border-focus: none;
  --n-border-active: none;
  --n-box-shadow-focus: none;
  --n-box-shadow-hover: none;
  --n-color: transparent;
  --n-color-active: transparent;
  background-color: transparent;
}

.method {
  flex: none;
  width: 100px;
}

.divider {
  flex: none;
  width: 1px;
  height: 16px;
  margin-right: 8px;
  background: var(--n-border-color, rgba(128, 128, 128, 0.4));
}

.url {
  flex: 1;
  min-width: 0;
}

.send {
  flex: none;
  width: 72px;
  height: 32px;
}

.method-text {
  font-weight: 700;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
</style>
