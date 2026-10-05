<script setup>
import { computed, nextTick, ref, watch } from 'vue';
import { NAlert, NButton, NInput } from 'naive-ui';
import { formatBytes, byteLength } from '@/utils/bytes';

/**
 * MQTT 的消息日志（第十三轮）。
 *
 * 和 `components/ws/WsMessageLog.vue` 同一套做法（手写列表、只负责显示、
 * 上限和截断在 `stores/mqtt.js` / `lib/mqtt-sessions.js` 里做完），差别是这里多了
 * MQTT 自己的四样东西：**主题**、**QoS**、**retain 标记**、**二进制看 base64**，
 * 以及一个**按主题筛选**的输入框。
 *
 * 两种行：
 * - 有主题的（`message` 收到 / `published` 发出）：一行一条，点开看完整内容；
 * - 系统行（连接 / 订阅 / 断开 / 出错）：只有一句中文说明。
 *
 * 颜色只用在该用的地方：**出错那一行**才上色（和 WsMessageLog 一个口径），
 * 其余一律中性 —— 一屏几十条全上色只会让人分不清哪条要管。
 */
const props = defineProps({
  events: { type: Array, default: function () { return []; } },
  dropped: { type: Number, default: 0 }
});

const emit = defineEmits(['clear']);

const listEl = ref(null);
const expanded = ref(-1);
const filter = ref('');
const paused = ref(false);

/** 用户是不是贴在底部（决定新消息来了要不要自动滚） */
let follow = true;

function onScroll() {
  const el = listEl.value;
  if (!el) return;
  follow = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  // 手动滚上去就是「先别滚」；滚回底部自动恢复
  paused.value = !follow;
}

function togglePause() {
  paused.value = !paused.value;
  if (!paused.value) {
    follow = true;
    scrollToBottom();
  }
}

async function scrollToBottom() {
  await nextTick();
  const el = listEl.value;
  if (el) el.scrollTop = el.scrollHeight;
}

watch(
  function () { return props.events.length; },
  function () {
    if (paused.value || !follow) return;
    scrollToBottom();
  }
);

// 换了一次会话（清空重连 / 切标签页）就把展开和筛选复位
watch(
  function () { return props.events; },
  function () {
    expanded.value = -1;
    follow = true;
    paused.value = false;
  }
);

function pad(value, size) {
  return String(value).padStart(size || 2, '0');
}

function formatTime(ms) {
  if (!ms) return '';
  const date = new Date(ms);
  return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds()) +
    '.' + pad(date.getMilliseconds(), 3);
}

/** 这一行是「收到」还是「发出」 */
function direction(item) {
  if (item.type === 'published') return 'out';
  if (item.type === 'message') return 'in';
  return 'system';
}

/** 消息正文：文本给 payload，二进制只有 base64 */
function body(item) {
  if (item.payload !== undefined && item.payload !== null) return String(item.payload);
  if (item.payloadBase64) return '';
  return '';
}

function summary(item) {
  if (item.payloadBase64) return '（二进制内容，' + formatBytes(item.size) + '）';
  const line = body(item).split('\n')[0].replace(/\s+/g, ' ');
  return line.length > 200 ? line.slice(0, 200) + '…' : line;
}

/**
 * 这一行的字节数。收到的消息服务端给了 `size`（截断前的原始大小）；
 * **自己发出的（`published`）没有这个字段**，按 payload 的 UTF-8 字节数算一个。
 */
function sizeOf(item) {
  if (item.size !== undefined && item.size !== null) return item.size;
  if (item.payload !== undefined && item.payload !== null) return byteLength(String(item.payload));
  return null;
}

/** 展开时的正文：JSON 美化，其余原样；二进制给 base64 */
function pretty(item) {
  if (item.payloadBase64) {
    return '（二进制 ' + formatBytes(item.size) + '，下面是 base64）\n' + item.payloadBase64;
  }
  const text = body(item);
  if (!text) return '（空）';
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch (err) {
    return text;
  }
}

function toggle(index) {
  expanded.value = expanded.value === index ? -1 : index;
}

/** 系统行的一句中文 */
function systemText(item) {
  if (item.type === 'connecting') {
    return '正在连接 ' + (item.url || '') + (item.clientId ? '，clientId ' + item.clientId : '') +
      (item.note ? '（' + item.note + '）' : '');
  }
  if (item.type === 'connected') {
    return item.sessionPresent ? '已连接（broker 上有旧会话）' : '已连接';
  }
  if (item.type === 'reconnecting') return '连接断了，正在重连…';
  if (item.type === 'subscribed') {
    const granted = item.granted === undefined || item.granted === null ? '' : '，授予 QoS ' + item.granted;
    return item.error
      ? '订阅 ' + item.topic + ' 失败：' + item.error
      : '已订阅 ' + item.topic + '（QoS ' + item.qos + granted + '）';
  }
  if (item.type === 'unsubscribed') return '已取消订阅 ' + item.topic;
  if (item.type === 'closed') return '连接已断开' + (item.reason ? '：' + item.reason : '');
  if (item.type === 'error') return '出错：' + item.error;
  return item.text || '';
}

/** 系统行里需要人管的那一种（出错）才上色 */
function systemClass(item) {
  if (item.type === 'error') return 'type-error';
  if (item.type === 'subscribed' && item.error) return 'type-error';
  return '';
}

/** 筛选：有主题的行按主题过滤，系统行一律留着（不然「为什么没消息」看不出来） */
const visible = computed(function () {
  const keyword = filter.value.trim().toLowerCase();
  const list = [];
  props.events.forEach(function (item, index) {
    const dir = direction(item);
    if (keyword && dir !== 'system') {
      if (String(item.topic || '').toLowerCase().indexOf(keyword) === -1) return;
    }
    list.push({ item: item, index: index });
  });
  return list;
});

const overflowText = computed(function () {
  if (!props.dropped) return '';
  return '只显示最近 2000 条，更早的 ' + props.dropped + ' 条已经丢弃。';
});
</script>

<template>
  <div class="mqtt-log">
    <div class="log-head">
      <n-input
        v-model:value="filter"
        size="tiny"
        clearable
        class="filter"
        placeholder="按主题筛选"
      />
      <n-button size="tiny" quaternary :type="paused ? 'primary' : 'default'" @click="togglePause">
        {{ paused ? '继续滚动' : '暂停滚动' }}
      </n-button>
      <n-button size="tiny" quaternary @click="emit('clear')">清空</n-button>
    </div>

    <n-alert v-if="overflowText" type="info" :show-icon="false" class="notice">
      {{ overflowText }}
    </n-alert>

    <div ref="listEl" class="list" @scroll="onScroll">
      <template v-if="visible.length">
        <div v-for="row in visible" :key="row.index" class="item">
          <template v-if="direction(row.item) !== 'system'">
            <div
              class="row line"
              :class="{ open: expanded === row.index }"
              @click="toggle(row.index)"
            >
              <span class="dir" :class="direction(row.item)">
                {{ direction(row.item) === 'out' ? '↑ 发出' : '↓ 收到' }}
              </span>
              <span class="time">{{ formatTime(row.item.time) }}</span>
              <span class="topic" :title="row.item.topic">{{ row.item.topic }}</span>
              <span class="qos">QoS {{ row.item.qos }}</span>
              <span class="retain">{{ row.item.retain ? 'retain' : '' }}</span>
              <span class="text">{{ summary(row.item) }}</span>
              <span class="size">{{ formatBytes(sizeOf(row.item)) }}</span>
            </div>

            <div v-if="expanded === row.index" class="detail">
              <pre class="detail-body">{{ pretty(row.item) }}</pre>
              <div v-if="row.item.truncated" class="detail-meta">
                这条消息超过了 64 KB，服务端只保留了前面一部分，长度显示的是原始大小。
              </div>
            </div>
          </template>

          <div v-else class="row system" :class="systemClass(row.item)">
            <span class="time">{{ formatTime(row.item.time) }}</span>
            <span class="text">{{ systemText(row.item) }}</span>
          </div>
        </div>
      </template>

      <p v-else class="empty">{{ filter.trim() ? '没有匹配这个主题的消息。' : '还没有消息。' }}</p>
    </div>
  </div>
</template>

<style scoped>
.mqtt-log {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.log-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
}

.filter {
  flex: 1;
  min-width: 0;
  max-width: 280px;
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

/* 只有出错那一行需要人去看，给它一点颜色；其余一律中性 */
.system.type-error {
  color: #d03050;
  opacity: 1;
}

.dir {
  flex: none;
  width: 52px;
}

.dir.out {
  color: var(--apiloop-primary);
}

.time {
  flex: none;
  width: 84px;
  opacity: 0.65;
}

.topic {
  flex: 1 1 120px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--apiloop-primary, #0ea5a4);
}

.qos {
  flex: none;
  width: 52px;
  opacity: 0.65;
}

/* retain 只在真的是 retain 时才有字，常态留空 */
.retain {
  flex: none;
  width: 46px;
  color: #d97706;
}

.text {
  flex: 2 1 160px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.size {
  flex: none;
  width: 64px;
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
  max-height: 320px;
  overflow: auto;
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
