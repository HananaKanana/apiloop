<script setup>
import { computed, nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { NAlert, NButton, NInput } from 'naive-ui';
import { formatBytes } from '@/utils/bytes';

/**
 * TCP / UDP 的数据列表（第十六轮）。
 *
 * 和 `components/mqtt/MqttMessageLog.vue` 同一套做法（手写列表、只负责显示、
 * 上限和截断在 `stores/socket.js` / `lib/socket-sessions.js` 里做完），差别是：
 * - 消息是**字节**，不是文本 —— 服务端能原样转回 UTF-8 时给 `text`，否则 `text: null`
 *   只给 `base64`。所以这里必须能按字节看：**十六进制视图**（偏移 / 16 字节一行 / 右侧 ASCII）；
 * - UDP 的每一行要显示**来源地址**（一个 socket 会收到很多不同对端的数据）；
 * - 整份列表可以整体在「文本 / 十六进制」之间切换，单条展开时也能看另一种。
 *
 * 两种行：
 * - 数据行（`data` 收到 / `sent` 发出）：一行一条，点开看完整内容；
 * - 系统行（连接 / 打开 / 断开 / 出错）：只有一句说明。
 *
 * 颜色只用在该用的地方：**出错那一行**才上色（和 MqttMessageLog 一个口径），
 * 其余一律中性 —— 一屏几十条全上色只会让人分不清哪条要管。
 */
const props = defineProps({
  events: { type: Array, default: function () { return []; } },
  dropped: { type: Number, default: 0 },
  /** 'TCP' / 'UDP'：系统行里「已连接」和「已打开」的说法不一样 */
  method: { type: String, default: 'TCP' }
});

const emit = defineEmits(['clear']);
const { t } = useI18n();

const listEl = ref(null);
const expanded = ref(-1);
const filter = ref('');
const paused = ref(false);
/** 整体显示方式：text / hex */
const view = ref('text');

/** 用户是不是贴在底部（决定新数据来了要不要自动滚） */
let follow = true;

function onScroll() {
  const el = listEl.value;
  if (!el) return;
  follow = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
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

/* ---------------- 字节 ---------------- */

function pad(value, size) {
  return String(value).padStart(size || 2, '0');
}

function formatTime(ms) {
  if (!ms) return '';
  const date = new Date(ms);
  return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds()) +
    '.' + pad(date.getMilliseconds(), 3);
}

/** base64 → 字节。服务端总是给 base64，文本只是「能转回 UTF-8」时额外给的一份 */
function bytesFromBase64(text) {
  try {
    const binary = atob(String(text));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch (err) {
    return new Uint8Array(0);
  }
}

/** 这一行的原始字节：优先用 base64（一定在），没有才按 text 编一遍 */
function bytesOf(item) {
  if (item && item.base64) return bytesFromBase64(item.base64);
  if (item && item.text !== undefined && item.text !== null) {
    return new TextEncoder().encode(String(item.text));
  }
  return new Uint8Array(0);
}

/**
 * 常见的十六进制查看样式：偏移 + 一行 16 字节 + 右侧 ASCII。
 * 不可打印的字节（含中文这种多字节的）在右边统一显示成 `.`。
 */
function hexDump(bytes) {
  const lines = [];
  for (let offset = 0; offset < bytes.length; offset += 16) {
    const chunk = bytes.subarray(offset, offset + 16);
    const hex = [];
    let ascii = '';

    for (let i = 0; i < 16; i++) {
      if (i < chunk.length) {
        hex.push(pad(chunk[i].toString(16), 2));
        ascii += chunk[i] >= 32 && chunk[i] < 127 ? String.fromCharCode(chunk[i]) : '.';
      } else {
        hex.push('  ');
      }
    }

    lines.push(pad(offset.toString(16), 8) + '  ' + hex.join(' ') + '  ' + ascii);
  }
  return lines.join('\n');
}

/** 十六进制视图里的第一行，给列表里的预览用 */
function hexPreview(item) {
  const dump = hexDump(bytesOf(item).subarray(0, 16));
  return dump.split('\n')[0] || '';
}

/* ---------------- 行 ---------------- */

/** 这一行是「收到」还是「发出」 */
function direction(item) {
  if (item.type === 'sent') return 'out';
  if (item.type === 'data') return 'in';
  return 'system';
}

/** 这一行的字节数。收到的（`data`）服务端给了截断前的原始大小；发出的（`sent`）也有 */
function sizeOf(item) {
  if (item.size !== undefined && item.size !== null) return item.size;
  return bytesOf(item).length;
}

/** 这一行有没有可看的正文 */
function hasBody(item) {
  return direction(item) !== 'system';
}

/** 文本视图下的预览：能转成文本就给文本，二进制给一句「二进制 N 字节」 */
function textSummary(item) {
  if (item.text === undefined || item.text === null) return t('socket.logBinarySummary', { size: formatBytes(sizeOf(item)) });
  const line = String(item.text).split('\n')[0].replace(/\s+/g, ' ');
  return line.length > 200 ? line.slice(0, 200) + '…' : line;
}

function summary(item) {
  if (view.value === 'hex') return hexPreview(item);
  return textSummary(item);
}

/** 展开时的正文（按当前显示方式） */
function pretty(item) {
  const bytes = bytesOf(item);
  if (view.value === 'hex') return hexDump(bytes);
  if (item.text === undefined || item.text === null) {
    return t('socket.logBinaryPretty', { size: formatBytes(sizeOf(item)) }) + '\n' + hexDump(bytes);
  }
  const text = String(item.text);
  if (!text) return t('socket.logEmptyBody');
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch (err) {
    return text;
  }
}

function toggle(index) {
  expanded.value = expanded.value === index ? -1 : index;
}

/** 系统行的一句说明 */
function systemText(item) {
  if (item.type === 'connecting') {
    const target = item.host ? item.host + ':' + item.port : '';
    return t('socket.logConnecting', { target: target }) +
      (item.note ? t('socket.logConnectingNote', { note: item.note }) : '');
  }
  if (item.type === 'connected') {
    const local = item.local ? item.local.address + ':' + item.local.port : '';
    if (props.method === 'UDP') return t('socket.logConnectedUdp', { local: local });
    const remote = item.remote ? item.remote.address + ':' + item.remote.port : '';
    return t('socket.logConnectedTcp', { local: local, remote: remote });
  }
  if (item.type === 'closed') {
    if (item.reason === 'remote') return t('socket.logClosed') + t('socket.logClosedRemote');
    if (item.reason === 'local') return t('socket.logClosed') + t('socket.logClosedLocal');
    if (item.reason === 'error') return t('socket.logClosed') + t('socket.logClosedError');
    return t('socket.logClosed');
  }
  if (item.type === 'error') return t('socket.logError', { error: item.error });
  return item.text || '';
}

/** 系统行里需要人管的那一种（出错）才上色 */
function systemClass(item) {
  return item.type === 'error' ? 'type-error' : '';
}

/** 这一行的来源（UDP 才有），列表里单独一列 */
function fromText(item) {
  if (!item.from) return '';
  return item.from.address + ':' + item.from.port;
}

/** 筛选：数据行按内容（文本或十六进制）过滤，系统行一律留着（不然「为什么没数据」看不出来） */
const visible = computed(function () {
  const keyword = filter.value.trim().toLowerCase();
  const list = [];
  props.events.forEach(function (item, index) {
    if (keyword && direction(item) !== 'system') {
      const haystack = (textSummary(item) + ' ' + hexPreview(item)).toLowerCase();
      if (haystack.indexOf(keyword) === -1) return;
    }
    list.push({ item: item, index: index });
  });
  return list;
});

const overflowText = computed(function () {
  if (!props.dropped) return '';
  return t('socket.logOverflow', props.dropped);
});
</script>

<template>
  <div class="socket-log">
    <div class="log-head">
      <n-input
        v-model:value="filter"
        size="tiny"
        clearable
        class="filter"
        :placeholder="t('socket.filterPlaceholder')"
      />
      <n-button
        size="tiny"
        quaternary
        :type="view === 'hex' ? 'primary' : 'default'"
        @click="view = view === 'hex' ? 'text' : 'hex'"
      >
        {{ view === 'hex' ? t('socket.viewHex') : t('socket.viewText') }}
      </n-button>
      <n-button size="tiny" quaternary :type="paused ? 'primary' : 'default'" @click="togglePause">
        {{ paused ? t('socket.resumeScroll') : t('socket.pauseScroll') }}
      </n-button>
      <n-button size="tiny" quaternary @click="emit('clear')">{{ t('socket.clear') }}</n-button>
    </div>

    <n-alert v-if="overflowText" type="info" :show-icon="false" class="notice">
      {{ overflowText }}
    </n-alert>

    <div ref="listEl" class="list" @scroll="onScroll">
      <template v-if="visible.length">
        <div v-for="row in visible" :key="row.index" class="item">
          <template v-if="hasBody(row.item)">
            <div
              class="row line"
              :class="{ open: expanded === row.index }"
              @click="toggle(row.index)"
            >
              <span class="dir" :class="direction(row.item)">
                {{ direction(row.item) === 'out' ? t('socket.directionOut') : t('socket.directionIn') }}
              </span>
              <span class="time">{{ formatTime(row.item.time) }}</span>
              <span class="text">{{ summary(row.item) }}</span>
              <span v-if="row.item.truncated" class="mark">{{ t('socket.truncatedMark') }}</span>
              <span v-if="fromText(row.item)" class="from" :title="fromText(row.item)">
                {{ t('socket.colFrom') }} {{ fromText(row.item) }}
              </span>
              <span class="size">{{ formatBytes(sizeOf(row.item)) }}</span>
            </div>

            <div v-if="expanded === row.index" class="detail">
              <pre class="detail-body">{{ pretty(row.item) }}</pre>
              <div v-if="row.item.truncated" class="detail-meta">
                {{ t('socket.truncatedNote') }}
              </div>
            </div>
          </template>

          <div v-else class="row system" :class="systemClass(row.item)">
            <span class="time">{{ formatTime(row.item.time) }}</span>
            <span class="text">{{ systemText(row.item) }}</span>
          </div>
        </div>
      </template>

      <p v-else class="empty">{{ filter.trim() ? t('socket.noMatch') : t('socket.empty') }}</p>
    </div>
  </div>
</template>

<style scoped>
.socket-log {
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

.text {
  flex: 2 1 160px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* UDP 的来源地址：只在有来源时出现（TCP 永远是同一个对端，没必要每行都写） */
.from {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--apiloop-primary, #0ea5a4);
  opacity: 0.85;
}

/* 被截断的那一条：列表里就要看得出来，不用点开才知道 */
.mark {
  flex: none;
  padding: 0 5px;
  border-radius: 3px;
  font-size: 10px;
  color: #d97706;
  background: rgba(217, 119, 6, 0.12);
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
  white-space: pre;
  word-break: normal;
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
