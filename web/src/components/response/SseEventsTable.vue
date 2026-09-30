<script setup>
import { computed, nextTick, ref, watch } from 'vue';
import { NAlert, NButton } from 'naive-ui';
import { formatBytes } from '@/utils/bytes';

/**
 * SSE 事件视图：把 `text/event-stream` 的响应按事件列出来。
 *
 * 不用 n-data-table：那个组件体积很大，而这里只有四列，手写反而更轻更可控。
 * 事件是按到达顺序追加的，最多 2000 条（在 store 里截断），所以这里只负责显示。
 */
const props = defineProps({
  events: { type: Array, default: function () { return []; } },
  /** 因为超过 2000 条被丢掉的条数 */
  dropped: { type: Number, default: 0 },
  /** 能不能存成 SSE 示例（editor 及以上 + 绑定了接口 + 响应已经结束） */
  canSave: { type: Boolean, default: false }
});

const emit = defineEmits(['save-example']);

const listEl = ref(null);
const expanded = ref(-1);

/**
 * 跟着最新事件滚动。用户自己往上翻了就别再拽他 —— 用「上一次是不是贴着底」
 * 判断，而不是每来一条就滚一次。
 */
let follow = true;

function onScroll() {
  const el = listEl.value;
  if (!el) return;
  follow = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
}

watch(
  function () { return props.events.length; },
  async function () {
    if (!follow) return;
    await nextTick();
    const el = listEl.value;
    if (el) el.scrollTop = el.scrollHeight;
  }
);

// 重新开始一次请求时列表会换成新数组，把展开状态一起复位
watch(
  function () { return props.events; },
  function () {
    expanded.value = -1;
    follow = true;
  }
);

function pad(value, size) {
  return String(value).padStart(size || 2, '0');
}

function formatTime(ms) {
  const date = new Date(ms);
  return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds()) +
    '.' + pad(date.getMilliseconds(), 3);
}

/** 摘要只取第一行，太长就截断，保证一行放得下 */
function summary(data) {
  const line = String(data || '').split('\n')[0].replace(/\s+/g, ' ');
  return line.length > 160 ? line.slice(0, 160) + '…' : line;
}

/** data 是 JSON 就格式化，不是就原样显示 */
function pretty(data) {
  const text = String(data || '');
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch (err) {
    return text;
  }
}

function toggle(index) {
  expanded.value = expanded.value === index ? -1 : index;
}

const overflowText = computed(function () {
  if (!props.dropped) return '';
  return '只显示最近 2000 条，更早的 ' + props.dropped + ' 条已经丢弃。';
});
</script>

<template>
  <div class="sse-events">
    <n-alert v-if="overflowText" type="info" :show-icon="false" class="notice">
      {{ overflowText }}
    </n-alert>

    <div class="toolbar">
      <span class="count">共 {{ events.length }} 条事件</span>
      <span class="tip">点一行展开看完整 data</span>
      <span class="spacer" />
      <n-button
        v-if="canSave"
        size="tiny"
        secondary
        type="primary"
        title="按每个事件的到达时间算出 delay，存成 sse 类型的示例"
        @click="emit('save-example')"
      >
        保存为 SSE 示例
      </n-button>
    </div>

    <div ref="listEl" class="list" @scroll="onScroll">
      <template v-if="events.length">
        <div class="head row">
          <span>时间</span>
          <span>event</span>
          <span>data</span>
          <span class="right">长度</span>
        </div>

        <div v-for="(item, index) in events" :key="index" class="item">
          <div
            class="row line"
            :class="{ open: expanded === index }"
            @click="toggle(index)"
          >
            <span class="time">{{ formatTime(item.time) }}</span>
            <span class="event">{{ item.event }}</span>
            <span class="data">{{ summary(item.data) }}</span>
            <span class="size">{{ formatBytes(item.size) }}</span>
          </div>

          <div v-if="expanded === index" class="detail">
            <pre class="detail-body">{{ pretty(item.data) }}</pre>
            <div v-if="item.id" class="detail-meta">id: {{ item.id }}</div>
          </div>
        </div>
      </template>

      <p v-else class="empty">还没有收到事件。</p>
    </div>
  </div>
</template>

<style scoped>
.sse-events {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.notice {
  flex: none;
  font-size: 12px;
}

.toolbar {
  flex: none;
  display: flex;
  align-items: baseline;
  gap: 10px;
  font-size: 12px;
}

.count {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.tip {
  opacity: 0.55;
}

.spacer {
  flex: 1;
}

.list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  border: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.24));
  border-radius: 6px;
}

.row {
  display: grid;
  grid-template-columns: 88px 110px minmax(0, 1fr) 72px;
  gap: 8px;
  align-items: center;
  padding: 4px 8px;
  font-size: 12px;
}

.head.row {
  position: sticky;
  top: 0;
  z-index: 1;
  opacity: 0.65;
  border-bottom: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.24));
  background: var(--n-color, #fff);
}

.line {
  cursor: pointer;
  border-bottom: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.12));
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.line:hover {
  background: rgba(128, 128, 128, 0.1);
}

.line.open {
  background: rgba(128, 128, 128, 0.14);
}

.time,
.size {
  opacity: 0.65;
}

.right {
  text-align: right;
}

.event,
.data {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.detail {
  padding: 8px 10px 10px;
  border-bottom: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.12));
  background: rgba(128, 128, 128, 0.06);
}

.detail-body {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: pre-wrap;
  word-break: break-all;
}

.detail-meta {
  margin-top: 6px;
  font-size: 12px;
  opacity: 0.6;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.empty {
  margin: 0;
  padding: 16px;
  font-size: 12px;
  opacity: 0.55;
  text-align: center;
}
</style>
