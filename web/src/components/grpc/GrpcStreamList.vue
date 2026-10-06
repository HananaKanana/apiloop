<script setup>
import { computed, nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { NButton, NEmpty } from 'naive-ui';
import { formatClock, prettyJson } from './grpc-util';

/**
 * 客户端流 / 双向流的消息列表（第十二轮第 2 节）。
 *
 * 发出、收到、系统提示（连接、metadata、结束状态）都作为一行，照 Socket.IO 标签页的体验：
 * 时间 + 方向 + 内容，点一行展开完整 JSON，默认滚到底部跟着最新消息走。
 */
const props = defineProps({
  state: { type: Object, default: null }
});

const { t } = useI18n();

const listRef = ref(null);
const expanded = ref(null);
const follow = ref(true);

const entries = computed(function () {
  return (props.state && props.state.entries) || [];
});

function label(entry) {
  if (entry.kind === 'sent') return t('grpc.entrySent');
  if (entry.kind === 'received') return t('grpc.entryReceived');
  return t('grpc.entrySystem');
}

function preview(entry) {
  if (entry.kind === 'system') return entry.text || '';
  const text = prettyJson(entry.data);
  return text.length > 200 ? text.slice(0, 200) + '…' : text;
}

function toggle(entry) {
  expanded.value = expanded.value === entry.id ? null : entry.id;
}

function clear() {
  if (props.state) props.state.entries = [];
  expanded.value = null;
}

/** 新消息进来时滚到底（用户手动滚上去就暂停跟随） */
function onScroll() {
  const host = listRef.value;
  if (!host) return;
  follow.value = host.scrollHeight - host.scrollTop - host.clientHeight < 40;
}

watch(
  function () { return entries.value.length; },
  async function () {
    if (!follow.value) return;
    await nextTick();
    const host = listRef.value;
    if (host) host.scrollTop = host.scrollHeight;
  }
);
</script>

<template>
  <div class="stream">
    <div class="head">
      <span class="label">{{ t('grpc.messages') }}</span>
      <span v-if="state && state.status" class="status">
        {{ state.status.name }}
        <span v-if="state.durationMs !== null">· {{ state.durationMs }}ms</span>
      </span>
      <n-button size="tiny" quaternary class="clear" @click="clear">{{ t('grpc.clear') }}</n-button>
    </div>

    <div ref="listRef" class="list" @scroll="onScroll">
      <div
        v-for="entry in entries"
        :key="entry.id"
        class="item"
        :class="entry.kind"
      >
        <div class="row" @click="toggle(entry)">
          <span class="time">{{ formatClock(entry.at) }}</span>
          <span class="dir">{{ label(entry) }}</span>
          <span class="text">{{ preview(entry) }}</span>
        </div>
        <pre v-if="expanded === entry.id && entry.kind !== 'system'" class="json">{{ prettyJson(entry.data) }}</pre>
      </div>

      <n-empty
        v-if="!entries.length"
        size="small"
        :description="t('grpc.noMessagesYet')"
        class="empty"
      />
    </div>

    <div v-if="state && state.trailers && Object.keys(state.trailers).length" class="trailers">
      <p class="label">Trailers</p>
      <pre class="json">{{ JSON.stringify(state.trailers, null, 2) }}</pre>
    </div>

    <div v-if="state && state.tests && state.tests.length" class="tests">
      <p class="label">{{ t('grpc.testsLabel') }}</p>
      <div v-for="(item, index) in state.tests" :key="index" class="test" :class="{ bad: !item.passed }">
        {{ item.passed ? t('grpc.passed') : t('grpc.failed') }}：{{ item.name }}
        <span v-if="item.message" class="msg">{{ item.message }}</span>
      </div>
    </div>

    <div v-if="state && state.extracted && state.extracted.length" class="tests">
      <p class="label">{{ t('grpc.extractedVars') }}</p>
      <div v-for="(item, index) in state.extracted" :key="index" class="test">
        {{ item.key }} = {{ item.value }}（{{ item.scope === 'environment' ? t('layout.entityEnvironment') : t('layout.entityProject') }}）
      </div>
    </div>
  </div>
</template>

<style scoped>
.stream {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
}

.head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-bottom: 4px;
}

.head .label {
  font-size: 12px;
  opacity: 0.7;
}

.head .status {
  font-size: 12px;
  opacity: 0.7;
}

.head .clear {
  margin-left: auto;
}

.list {
  flex: 1;
  min-height: 160px;
  overflow: auto;
  border: 1px solid var(--apiloop-divider);
  border-radius: 4px;
  padding: 4px 6px;
}

.item {
  border-bottom: 1px solid var(--apiloop-divider);
}

.item:last-child {
  border-bottom: none;
}

.row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 3px 2px;
  font-size: 12px;
  cursor: pointer;
}

.time {
  flex: none;
  opacity: 0.55;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.dir {
  flex: none;
  width: 34px;
  font-weight: 600;
}

.item.sent .dir {
  color: #2080f0;
}

.item.received .dir {
  color: #18a058;
}

.item.system .dir {
  opacity: 0.5;
  font-weight: 400;
}

.text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.item.system .text {
  font-family: inherit;
  opacity: 0.75;
}

.json {
  margin: 0 0 6px;
  padding: 6px 8px;
  border-radius: 4px;
  background: rgba(128, 128, 128, 0.1);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 240px;
  overflow: auto;
}

.empty {
  padding: 24px 0;
}

.trailers,
.tests {
  margin-top: 6px;
}

.trailers .label,
.tests .label {
  margin: 0 0 2px;
  font-size: 12px;
  opacity: 0.7;
}

.test {
  font-size: 12px;
  line-height: 1.7;
}

.test.bad {
  color: #d03050;
}

.test .msg {
  opacity: 0.7;
}
</style>
