<script setup>
import { computed, h } from 'vue';
import { NButton, NSelect, NTooltip } from 'naive-ui';
import VarInput from '@/components/common/VarInput.vue';
import { methodColor } from '@/utils/method';
import { BARE_SELECT_THEME } from '@/utils/bareInput';

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
  scope: { type: Map, default: null },
  /** 直接打开云端、而且云端不发送请求：发送按钮变灰 */
  sendBlocked: { type: Boolean, default: false },
  sendBlockedHint: { type: String, default: '' }
});

const emit = defineEmits(['update:method', 'update:url', 'send', 'cancel', 'paste-curl']);

/**
 * 地址栏里粘贴一段 cURL 时，像 Postman 那样直接把整条请求填满。
 *
 * 两件事必须在这里做：
 * - 判断放在这里而不是 RequestTab —— 只有拦下 paste 事件，内容才不会落进输入框；
 * - 监听要挂在**捕获阶段**。地址栏是 CodeMirror，它在自己的 contentDOM 上也有 paste
 *   处理，冒泡阶段挂的话它已经先把文本插进去了，那时再 preventDefault 就晚了。
 */
function onPaste(event) {
  const clipboard = event.clipboardData || window.clipboardData;
  if (!clipboard) return;

  const text = String(clipboard.getData('text') || '').trim();
  if (!/^curl\s/.test(text)) return; // 普通地址的粘贴照旧

  event.preventDefault();
  event.stopPropagation();
  emit('paste-curl', text);
}

// WS 也是一种接口（契约第 17 节）：存进目录树，打开时是 WebSocket 标签页。
// 放在这里是为了「新建接口」时能直接选它，和选 GET / POST 一样。
// SIO（Socket.IO，第九轮第 4 节）同理，打开时是 Socket.IO 标签页。
const METHOD_OPTIONS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'WS', 'SIO'].map(function (name) {
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

/**
 * 方法下拉：在去边框的基础上，把菜单的最大高度放到 10 行。
 * naive-ui 默认只给 7.6 行，8 个方法（再加一个自定义方法就是 9 个）会出滚动条，
 * 第一项 GET 被切掉一半。
 */
const METHOD_SELECT_THEME = {
  peers: Object.assign({}, BARE_SELECT_THEME.peers, {
    InternalSelectMenu: { height: 'calc(var(--n-option-height) * 10)' }
  })
};
</script>

<template>
  <div class="url-bar">
    <!-- 方法下拉和地址合成一个带边框的整体：下拉自己不要边框，中间一条竖线分开 -->
    <div class="url-box" @paste.capture="onPaste">
      <n-select
        class="method"
        size="small"
        tag
        filterable
        :options="methodOptions"
        :render-label="renderMethodOption"
        :theme-overrides="METHOD_SELECT_THEME"
        :consistent-menu-width="false"
        :menu-props="{ style: { minWidth: '140px' } }"
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
    <!--
      直接打开云端、云端又不发送请求：按钮变灰，悬停说清楚该去哪儿。
      外面套一层 span 是因为禁用的按钮不派发鼠标事件，提示挂不上去。
    -->
    <n-tooltip v-else-if="sendBlocked" trigger="hover">
      <template #trigger>
        <span class="send-wrap">
          <n-button class="send" size="small" disabled :bordered="false">发送</n-button>
        </span>
      </template>
      {{ sendBlockedHint }}
    </n-tooltip>
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

/* 禁用的发送按钮：外面这层只为了让悬停提示有个可挂的元素 */
.send-wrap {
  display: inline-flex;
  flex: none;
}

.method-text {
  font-weight: 700;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
</style>
