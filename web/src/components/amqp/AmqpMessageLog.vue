<script setup>
import { computed, nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { NAlert, NButton, NCheckbox, NInput, NTag } from 'naive-ui';
import { formatBytes, byteLength } from '@/utils/bytes';

/**
 * RabbitMQ 的消息日志（第十六轮 T41）。
 *
 * 和 `components/mqtt/MqttMessageLog.vue` 同一套做法（手写列表、只负责显示、
 * 上限和截断在 `stores/amqp.js` / `lib/amqp-sessions.js` 里做完），差别是这里多了
 * RabbitMQ 自己的几样东西：**交换机 + routing key**、**redelivered 标记**、
 * **手动确认（ack / nack / reject，nack 和 reject 可以勾 requeue）**，
 * 以及 `returned`（mandatory 的消息路由不到任何队列）这一种系统行。
 *
 * 三种行：
 * - `message`（收到）/ `published`（发出）：一行一条，点开看全部 properties 和 headers；
 * - 系统行（连接 / 起停消费 / 回确认 / returned / 断开 / 出错）：只有一句说明；
 * - 手动确认的消息，行上有三个按钮；确认过之后这一行显示「已确认」。
 *
 * 「这一行确认过没有」是**从事件流里算出来的**（这条消息之后有没有一条 deliveryTag
 * 相同的 `acked` 事件），不另存状态 —— 组件会被卸载重建（切标签页），存本地等于一换标签页就丢。
 * deliveryTag 是 **channel 级**的、两个 consumer 会重叠，所以只认「往后第一条同号的」，
 * 这在顺序事件的流里够用。
 *
 * 颜色只用在该用的地方：**出错那一行**和 **returned** 才上色（和 MqttMessageLog 一个口径），
 * 其余一律中性 —— 一屏几十条全上色只会让人分不清哪条要管。
 */
const props = defineProps({
  events: { type: Array, default: function () { return []; } },
  dropped: { type: Number, default: 0 }
});

const emit = defineEmits(['clear', 'ack']);
const { t } = useI18n();

const listEl = ref(null);
const expanded = ref(-1);
const filter = ref('');
const paused = ref(false);

/** 每一行的 requeue 勾选（按事件的 seq 记，唯一的，行序变了也不会串） */
const requeueOn = ref({});

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
    requeueOn.value = {};
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

/** 这一行是「收到」「发出」还是系统行 */
function direction(item) {
  if (item.type === 'published') return 'out';
  if (item.type === 'message') return 'in';
  return 'system';
}

/** 消息正文：文本给 payload，二进制只有 base64 */
function body(item) {
  if (item.payload !== undefined && item.payload !== null) return String(item.payload);
  return '';
}

/** 内容是 JSON 吗（能解析出来才算） */
function isJson(item) {
  const text = body(item).trim();
  if (!text || (text[0] !== '{' && text[0] !== '[')) return false;
  try {
    JSON.parse(text);
    return true;
  } catch (err) {
    return false;
  }
}

function summary(item) {
  if (item.payloadBase64) return t('amqp.logBinarySummary', { size: formatBytes(item.size) });
  const line = body(item).split('\n')[0].replace(/\s+/g, ' ');
  return line.length > 200 ? line.slice(0, 200) + '…' : line;
}

/** 这一行的字节数（收到的和发出的服务端都给了 `size`），没给就按 payload 的 UTF-8 算 */
function sizeOf(item) {
  if (item.size !== undefined && item.size !== null) return item.size;
  if (item.payload !== undefined && item.payload !== null) return byteLength(String(item.payload));
  return null;
}

/** 展开时的正文：JSON 美化，其余原样；二进制给 base64 */
function pretty(item) {
  if (item.payloadBase64) {
    return t('amqp.logBinaryPretty', { size: formatBytes(item.size) }) + '\n' + item.payloadBase64;
  }
  const text = body(item);
  if (!text) return t('amqp.logEmptyBody');
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch (err) {
    return text;
  }
}

/** 展开时的 properties（headers 单独一栏，所以先摘掉） */
function propertiesText(item) {
  const props_ = Object.assign({}, item.properties || {});
  delete props_.headers;
  if (!Object.keys(props_).length) return t('amqp.propsNone');
  return JSON.stringify(props_, null, 2);
}

function headersText(item) {
  const headers = (item.properties && item.properties.headers) || null;
  if (!headers || !Object.keys(headers).length) return t('amqp.propsNone');
  return JSON.stringify(headers, null, 2);
}

function toggle(index) {
  expanded.value = expanded.value === index ? -1 : index;
}

/* ---------------- 手动确认 ---------------- */

/** 这条消息是不是还在等确认（服务端在 manual ack 下才带 `pendingAck`） */
function pending(item) {
  return item.type === 'message' && item.pendingAck === true &&
    item.deliveryTag !== null && item.deliveryTag !== undefined;
}

/** 这一行确认过了吗：往后找第一条同 deliveryTag 的 `acked` */
function ackedAt(index, item) {
  if (item.type !== 'message') return null;
  for (let i = index + 1; i < props.events.length; i++) {
    const event = props.events[i];
    if (event && event.type === 'acked' && event.deliveryTag === item.deliveryTag) return event;
  }
  return null;
}

function ackedText(index, item) {
  const hit = ackedAt(index, item);
  if (!hit) return '';
  return t('amqp.ackedTag', {
    action: hit.action || 'ack',
    requeue: hit.requeue ? t('amqp.requeueSuffix') : ''
  });
}

function isRequeue(item) {
  return requeueOn.value[item.seq] === true;
}

function toggleRequeue(item) {
  requeueOn.value = Object.assign({}, requeueOn.value, { [item.seq]: !isRequeue(item) });
}

/** 回确认；requeue 只对 nack / reject 有意义 */
function doAck(item, action) {
  emit('ack', {
    deliveryTag: item.deliveryTag,
    action: action,
    requeue: action === 'ack' ? false : isRequeue(item)
  });
}

/** 系统行的一句说明 */
function systemText(item) {
  if (item.type === 'connecting') return t('amqp.logConnecting', { url: item.url || '' });
  if (item.type === 'connected') return t('amqp.logConnected');
  if (item.type === 'consuming') {
    const resumed = item.resumed ? t('amqp.logResumed') : '';
    if (item.mode === 'exchange') {
      return t('amqp.logConsumingExchange', {
        exchange: item.exchange || '',
        routingKey: item.routingKey || '',
        queue: item.queue || ''
      }) + resumed;
    }
    return t('amqp.logConsuming', { queue: item.queue || '' }) + resumed;
  }
  if (item.type === 'cancelled') {
    if (item.byServer) {
      return t('amqp.logCancelledServer') +
        (item.queue ? t('amqp.logCancelledQueue', { queue: item.queue }) : '');
    }
    return t('amqp.logCancelled', { queue: item.queue || '' });
  }
  if (item.type === 'acked') {
    return t('amqp.logAcked', {
      action: item.action || 'ack',
      tag: item.deliveryTag,
      requeue: item.requeue ? t('amqp.logAckedRequeue') : ''
    });
  }
  if (item.type === 'returned') {
    return t('amqp.logReturned', {
      exchange: item.exchange || t('amqp.exchangeDefault'),
      routingKey: item.routingKey || '',
      replyText: item.replyText || ''
    });
  }
  if (item.type === 'closed') {
    return t('amqp.logClosed') + (item.reason ? t('amqp.logClosedReason', { reason: item.reason }) : '');
  }
  if (item.type === 'error') return t('amqp.logError', { error: item.error });
  return item.text || '';
}

/** 系统行里需要人管的那几种（出错、消息路由不到）才上色 */
function systemClass(item) {
  if (item.type === 'error') return 'type-error';
  if (item.type === 'returned') return 'type-warn';
  return '';
}

/**
 * 筛选：有交换机 / routing key 的行按「routing key + 内容」过滤，
 * 系统行一律留着（不然「为什么没消息」看不出来）。
 */
const visible = computed(function () {
  const keyword = filter.value.trim().toLowerCase();
  const list = [];
  props.events.forEach(function (item, index) {
    if (keyword && direction(item) !== 'system') {
      const haystack = (String(item.routingKey || '') + '\n' + String(item.exchange || '') +
        '\n' + body(item)).toLowerCase();
      if (haystack.indexOf(keyword) === -1) return;
    }
    list.push({ item: item, index: index });
  });
  return list;
});

const overflowText = computed(function () {
  if (!props.dropped) return '';
  return t('amqp.logOverflow', props.dropped);
});
</script>

<template>
  <div class="amqp-log">
    <div class="log-head">
      <n-input
        v-model:value="filter"
        size="tiny"
        clearable
        class="filter"
        :placeholder="t('amqp.filterPlaceholder')"
      />
      <n-button size="tiny" quaternary :type="paused ? 'primary' : 'default'" @click="togglePause">
        {{ paused ? t('amqp.resumeScroll') : t('amqp.pauseScroll') }}
      </n-button>
      <n-button size="tiny" quaternary @click="emit('clear')">{{ t('amqp.clear') }}</n-button>
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
                {{ direction(row.item) === 'out' ? t('amqp.directionOut') : t('amqp.directionIn') }}
              </span>
              <span class="time">{{ formatTime(row.item.time) }}</span>
              <span class="exchange" :title="row.item.exchange">{{ row.item.exchange || t('amqp.exchangeDefault') }}</span>
              <span class="routing" :title="row.item.routingKey">{{ row.item.routingKey }}</span>
              <span class="redelivered">{{ row.item.redelivered ? 'redelivered' : '' }}</span>
              <n-tag v-if="isJson(row.item)" size="tiny" :bordered="false" class="tag-json">JSON</n-tag>
              <span class="text">{{ summary(row.item) }}</span>
              <span v-if="row.item.truncated" class="truncated">…</span>
              <span class="size">{{ formatBytes(sizeOf(row.item)) }}</span>
              <span v-if="ackedAt(row.index, row.item)" class="acked">
                {{ ackedText(row.index, row.item) }}
              </span>
              <span v-else-if="pending(row.item)" class="ack-box" @click.stop>
                <n-checkbox
                  size="small"
                  :checked="isRequeue(row.item)"
                  @update:checked="() => toggleRequeue(row.item)"
                >
                  requeue
                </n-checkbox>
                <n-button size="tiny" quaternary type="primary" @click="doAck(row.item, 'ack')">ack</n-button>
                <n-button size="tiny" quaternary type="warning" @click="doAck(row.item, 'nack')">nack</n-button>
                <n-button size="tiny" quaternary type="error" @click="doAck(row.item, 'reject')">reject</n-button>
              </span>
            </div>

            <div v-if="expanded === row.index" class="detail">
              <pre class="detail-body">{{ pretty(row.item) }}</pre>

              <div class="detail-label">{{ t('amqp.detailProperties') }}</div>
              <pre class="detail-body">{{ propertiesText(row.item) }}</pre>

              <div class="detail-label">{{ t('amqp.detailHeaders') }}</div>
              <pre class="detail-body">{{ headersText(row.item) }}</pre>

              <div v-if="row.item.truncated" class="detail-meta">
                {{ t('amqp.truncatedNote') }}
              </div>
            </div>
          </template>

          <div v-else class="row system" :class="systemClass(row.item)">
            <span class="time">{{ formatTime(row.item.time) }}</span>
            <span class="text">{{ systemText(row.item) }}</span>
          </div>
        </div>
      </template>

      <p v-else class="empty">{{ filter.trim() ? t('amqp.noMatch') : t('amqp.empty') }}</p>
    </div>
  </div>
</template>

<style scoped>
.amqp-log {
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
  max-width: 300px;
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

/* 只有出错和「消息路由不到」需要人去看，给它们一点颜色；其余一律中性 */
.system.type-error {
  color: #d03050;
  opacity: 1;
}

.system.type-warn {
  color: #d97706;
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

.exchange {
  flex: none;
  width: 110px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.8;
}

.routing {
  flex: 1 1 120px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--apiloop-primary, #0ea5a4);
}

/* redelivered 只在真的是重复投递时才有字，常态留空 */
.redelivered {
  flex: none;
  width: 60px;
  color: #d97706;
}

.tag-json {
  flex: none;
  opacity: 0.6;
}

.text {
  flex: 2 1 140px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.truncated {
  flex: none;
  color: #d97706;
}

.size {
  flex: none;
  width: 64px;
  text-align: right;
  opacity: 0.65;
}

/* 待确认的三颗按钮：行上有它们的时候不需要再点开 */
.ack-box {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 2px;
}

.acked {
  flex: none;
  color: #0cbb52;
}

.detail {
  padding: 8px 10px 10px;
  border-bottom: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.12));
  background: rgba(128, 128, 128, 0.06);
}

.detail-body {
  margin: 0;
  max-height: 280px;
  overflow: auto;
  font-size: 12px;
  line-height: 1.6;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: pre-wrap;
  word-break: break-all;
}

.detail-label {
  margin: 8px 0 4px;
  font-size: 12px;
  font-weight: 600;
  opacity: 0.7;
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
