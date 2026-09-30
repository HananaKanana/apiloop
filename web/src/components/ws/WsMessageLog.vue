<script setup>
import { computed, nextTick, ref, watch } from 'vue';
import { NAlert } from 'naive-ui';
import { formatBytes } from '@/utils/bytes';

/**
 * WebSocket 的消息日志：上游来的事件原样列出来。
 *
 * 和 SSE 事件视图一样手写列表而不是 n-data-table（体积），
 * 也只是显示 —— 截断、上限都在 stores/ws.js 里做完。
 */
const props = defineProps({
  events: { type: Array, default: function () { return []; } },
  dropped: { type: Number, default: 0 }
});

const listEl = ref(null);
const expanded = ref(-1);

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

/** 消息正文：文本用 text，二进制只有 base64 */
function body(item) {
  if (item.text !== undefined && item.text !== null) return String(item.text);
  if (item.base64) return '（二进制内容，' + formatBytes(item.size) + '）';
  return '';
}

function summary(item) {
  const line = body(item).split('\n')[0].replace(/\s+/g, ' ');
  return line.length > 160 ? line.slice(0, 160) + '…' : line;
}

function pretty(item) {
  const text = item.text !== undefined && item.text !== null ? String(item.text) : '';
  if (!text) return body(item);
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch (err) {
    return text;
  }
}

function toggle(index) {
  expanded.value = expanded.value === index ? -1 : index;
}

/** 系统行（连接 / 关闭 / 出错）的文案 */
function systemText(item) {
  if (item.type === 'open') {
    return item.protocol ? '已连接，子协议 ' + item.protocol : '已连接';
  }
  if (item.type === 'close') {
    return '连接已关闭：code ' + item.code + (item.reason ? '，' + item.reason : '');
  }
  if (item.type === 'error') return '出错：' + item.message;
  return item.text || '';
}

const overflowText = computed(function () {
  if (!props.dropped) return '';
  return '只显示最近 2000 条，更早的 ' + props.dropped + ' 条已经丢弃。';
});
</script>

<template>
  <div class="ws-log">
    <n-alert v-if="overflowText" type="info" :show-icon="false" class="notice">
      {{ overflowText }}
    </n-alert>

    <div ref="listEl" class="list" @scroll="onScroll">
      <template v-if="events.length">
        <div v-for="(item, index) in events" :key="index" class="item">
          <div
            v-if="item.type === 'message'"
            class="row line"
            :class="{ open: expanded === index }"
            @click="toggle(index)"
          >
            <span class="dir" :class="item.direction === 'out' ? 'out' : 'in'">
              {{ item.direction === 'out' ? '↑ 发出' : '↓ 收到' }}
            </span>
            <span class="time">{{ formatTime(item.time) }}</span>
            <span class="text">{{ summary(item) }}</span>
            <span class="size">{{ formatBytes(item.size) }}</span>
          </div>

          <div v-else class="row system" :class="'type-' + item.type">
            <span class="time">{{ formatTime(item.time) }}</span>
            <span class="text">{{ systemText(item) }}</span>
          </div>

          <div v-if="expanded === index" class="detail">
            <pre class="detail-body">{{ pretty(item) }}</pre>
            <div v-if="item.truncated" class="detail-meta">
              这条消息超过了 64 KB，服务端只保留了前面一部分，长度显示的是原始大小。
            </div>
          </div>
        </div>
      </template>

      <p v-else class="empty">还没有消息。</p>
    </div>
  </div>
</template>

<style scoped>
.ws-log {
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

.list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  border: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.24));
  border-radius: 6px;
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  font-size: 12px;
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

.system {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  opacity: 0.75;
}

/* 出错那一行才需要有人去看，给它一点颜色；其余一律中性 */
.system.type-error {
  color: #d03050;
  opacity: 1;
}

.dir {
  flex: none;
  width: 56px;
}

.dir.out {
  color: var(--apiloop-primary);
}

.time {
  flex: none;
  width: 88px;
  opacity: 0.65;
}

.text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.size {
  flex: none;
  width: 72px;
  text-align: right;
  opacity: 0.65;
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
}

.empty {
  margin: 0;
  padding: 16px;
  font-size: 12px;
  opacity: 0.55;
  text-align: center;
}
</style>
