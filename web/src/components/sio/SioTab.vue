<script setup>
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  NButton,
  NCheckbox,
  NInput,
  NSelect,
  NTabPane,
  NTabs,
  NTag,
  NTooltip,
  useMessage
} from 'naive-ui';
import { useProjectStore } from '@/stores/project';
import { useEnvStore } from '@/stores/env';
import { useSioStore } from '@/stores/sio';
import { useTabsStore } from '@/stores/tabs';
import { useGatewayStore } from '@/stores/gateway';
import * as apisApi from '@/api/apis';
import KeyValueTable from '@/components/common/KeyValueTable.vue';
import VarInput from '@/components/common/VarInput.vue';
import InlineRename from '@/components/common/InlineRename.vue';
import AuthEditor from '@/components/request/AuthEditor.vue';
import WsMessageLog from '@/components/ws/WsMessageLog.vue';

/**
 * Socket.IO 标签页（第九轮第 4 节）。
 *
 * 和 WebSocket 标签页一个形态：**临时**（`apiId` 为空，不进目录树）和
 * **绑定接口**（`apiId` 有值，改动可以存回接口，还记「常用发送」）。
 *
 * 连接由服务端建立（`lib/sio-sessions.js`），会话状态放在 `stores/sio.js` 里 ——
 * 组件会随标签页切换被卸载重建，状态放这里等于一切走就断线。
 */
const props = defineProps({
  tab: { type: Object, required: true }
});

const projects = useProjectStore();
const envs = useEnvStore();
const sio = useSioStore();
const tabs = useTabsStore();
const gateway = useGatewayStore();
const message = useMessage();
const { t } = useI18n();

const activePane = ref('connect');
const state = computed(function () { return sio.stateOf(props.tab.key); });

const spec = computed(function () { return props.tab.spec; });
const sioCfg = computed(function () {
  if (!spec.value.sio) spec.value.sio = emptySio();
  return spec.value.sio;
});

const editable = computed(function () { return projects.canEdit; });
const connected = computed(function () {
  const current = state.value;
  return Boolean(current && current.status === 'open' && current.sessionId);
});

/**
 * 直接打开云端、云端又不替网页建连接（SERVER_SEND=0）：Socket.IO 的「连接」要灰掉并说明原因。
 * 云端开了 SERVER_SEND=1 时照常能用 —— 所以用 cloudSendBlocked 判断，不是 isGateway。
 */
const connectBlocked = computed(function () {
  return gateway.cloudSendBlocked;
});

const statusText = computed(function () {
  const current = state.value;
  if (!current) return t('sio.statusIdle');
  if (current.status === 'open') return t('sio.statusOpen');
  if (current.status === 'connecting') return t('sio.statusConnecting');
  if (current.status === 'error') return t('sio.statusError');
  if (current.status === 'closed') return t('sio.statusClosed');
  return t('sio.statusIdle');
});

const statusType = computed(function () {
  const current = state.value;
  if (!current) return 'default';
  if (current.status === 'open') return 'success';
  if (current.status === 'error') return 'error';
  if (current.status === 'connecting') return 'warning';
  return 'default';
});

/* ---------------- 连接 ---------------- */

function emptySio() {
  return { path: '/socket.io', namespace: '/', transports: 'polling', listenEvents: [], sends: [] };
}

const TRANSPORT_OPTIONS = computed(function () {
  return [
    { label: t('sio.transportPolling'), value: 'polling' },
    { label: t('sio.transportWebsocket'), value: 'websocket' }
  ];
});

/** 监听名单在界面上是一行一个事件名 */
const listenText = computed({
  get: function () { return (sioCfg.value.listenEvents || []).join('\n'); },
  set: function (value) {
    sioCfg.value.listenEvents = String(value || '')
      .split('\n')
      .map(function (line) { return line.trim(); })
      .filter(Boolean);
    touch();
  }
});

const authText = computed({
  get: function () {
    const auth = sioCfg.value.auth;
    if (!auth) return '';
    try { return JSON.stringify(auth, null, 2); } catch (err) { return ''; }
  },
  set: function (value) {
    const text = String(value || '').trim();
    if (!text) { sioCfg.value.auth = null; touch(); return; }
    try {
      const parsed = JSON.parse(text);
      sioCfg.value.auth = parsed && typeof parsed === 'object' ? parsed : null;
      touch();
    } catch (err) {
      // 还在打字：不写进配置（不然会把半截 JSON 存下去），只在离开输入框时提示
    }
  }
});

function onAuthBlur() {
  const text = String(authText.value || '').trim();
  if (!text) return;
  try {
    JSON.parse(text);
  } catch (err) {
    message.warning(t('sio.authInvalid'));
  }
}

function touch() {
  tabs.touch(props.tab);
}

async function connect() {
  // 网页版、云端不替网页建连接：按钮已经灰了，这里兜一次（重连、常用发送也走这儿）
  if (connectBlocked.value) {
    message.warning(t('sio.connectBlocked'));
    return;
  }

  const payload = {
    projectId: projects.currentId,
    environmentId: envs.selectedId || undefined,
    spec: JSON.parse(JSON.stringify(spec.value)),
    options: { cookies: true }
  };
  const ok = await sio.connect(props.tab.key, payload);
  if (!ok) {
    const current = state.value;
    message.error((current && current.error) || t('sio.connectFailed'));
  }
}

async function disconnect() {
  await sio.disconnect(props.tab.key);
}

function reconnect() {
  return connect();
}

/* ---------------- 发送 ---------------- */

const draftEvent = ref('message');
const draftArgs = ref('[]');
const draftAck = ref(false);

/** 参数必须是 JSON 数组（多个参数）；也收单个值，自动包成一项 */
function parseArgs(text) {
  const source = String(text || '').trim();
  if (!source) return [];
  const parsed = JSON.parse(source);
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function sendNow(eventName, argsText, ack) {
  if (!connected.value) {
    message.warning(t('sio.notConnected'));
    return;
  }
  const event = String(eventName || '').trim();
  if (!event) {
    message.warning(t('sio.eventNameRequired'));
    return;
  }

  let args;
  try {
    args = parseArgs(argsText);
  } catch (err) {
    message.error(t('sio.argsInvalid'));
    return;
  }

  const ok = await sio.emit(props.tab.key, { event: event, args: args, ack: ack === true });
  if (!ok) {
    const current = state.value;
    message.error((current && current.error) || t('sio.sendFailed'));
  }
}

function sendDraft() {
  return sendNow(draftEvent.value, draftArgs.value, draftAck.value);
}

/* ---------------- 常用发送 ---------------- */

const sends = computed(function () { return sioCfg.value.sends || []; });

/**
 * 把这次改的连接参数存回接口。
 *
 * 返回服务端给的 api —— `markSaved` 会用它重算 spec（SIO 的 spec 形状和普通接口不一样，
 * 让 markSaved 走 SIO 那条分支，别在这里自己拼）。
 */
async function persist() {
  if (!props.tab.apiId) return null;
  const data = await apisApi.updateApi(props.tab.apiId, {
    url: spec.value.url,
    params: spec.value.params,
    auth: spec.value.auth,
    sio: spec.value.sio
  });
  return data.api;
}

async function addCurrentAsSend() {
  const event = String(draftEvent.value || '').trim();
  if (!event) {
    message.warning(t('sio.eventNameRequired'));
    return;
  }
  const list = (sioCfg.value.sends || []).slice();
  list.push({
    id: 's' + Date.now().toString(36),
    event: event,
    args: String(draftArgs.value || ''),
    ack: draftAck.value === true
  });
  sioCfg.value.sends = list;
  touch();

  if (props.tab.apiId) {
    try {
      await persist();
      message.success(t('sio.commonSaved'));
    } catch (err) {
      message.error(err.message);
    }
  }
}

async function useSend(item) {
  draftEvent.value = item.event;
  draftArgs.value = item.args || '[]';
  draftAck.value = item.ack === true;
  await sendNow(item.event, item.args, item.ack);
}

async function removeSend(id) {
  sioCfg.value.sends = (sioCfg.value.sends || []).filter(function (item) { return item.id !== id; });
  touch();
  if (props.tab.apiId) {
    try { await persist(); } catch (err) { message.error(err.message); }
  }
}

/* ---------------- 保存 ---------------- */

const saving = ref(false);

async function save() {
  if (!props.tab.apiId) return;
  saving.value = true;
  try {
    const api = await persist();
    if (api) tabs.markSaved(props.tab, api);
    message.success(t('sio.saved'));
  } catch (err) {
    message.error(err.message);
  } finally {
    saving.value = false;
  }
}

onMounted(function () {
  if (!props.tab.spec.sio) props.tab.spec.sio = emptySio();
});
</script>

<template>
  <div class="sio-tab">
    <div class="bar">
      <inline-rename
        :value="tab.title"
        :editable="editable && Boolean(tab.apiId)"
        :placeholder="t('sio.titlePlaceholder')"
        class="title"
        @commit="(name) => tabs.applyRename('api', tab.apiId, name)"
      />
      <n-tag size="small" :type="statusType">{{ statusText }}</n-tag>

      <div class="bar-tools">
        <!-- 网页版、云端不替网页建连接：灰掉并说明原因（禁用的按钮不派发鼠标事件，提示挂在外层 span 上） -->
        <n-tooltip v-if="!connected && connectBlocked" trigger="hover">
          <template #trigger>
            <span class="connect-wrap">
              <n-button size="small" type="primary" disabled>{{ t('sio.connect') }}</n-button>
            </span>
          </template>
          {{ t('sio.connectBlockedTooltip') }}
        </n-tooltip>
        <n-button v-else-if="!connected" size="small" type="primary" :disabled="!editable" @click="connect">
          {{ t('sio.connect') }}
        </n-button>
        <template v-else>
          <n-button size="small" @click="reconnect">{{ t('sio.reconnect') }}</n-button>
          <n-button size="small" type="error" ghost @click="disconnect">{{ t('sio.disconnect') }}</n-button>
        </template>
        <n-button v-if="tab.apiId && editable" size="small" :loading="saving" @click="save">{{ t('sio.save') }}</n-button>
      </div>
    </div>

    <div v-if="!editable" class="notice">{{ t('sio.readonlyNotice') }}</div>

    <div class="addr">
      <var-input
        :model-value="spec.url"
        :readonly="!editable"
        placeholder="http://host:port"
        class="url"
        @update:model-value="(v) => { spec.url = v; touch(); }"
      />
      <n-input
        :value="sioCfg.path"
        :disabled="!editable"
        class="path"
        placeholder="/socket.io"
        @update:value="(v) => { sioCfg.path = v; touch(); }"
      />
      <n-input
        :value="sioCfg.namespace"
        :disabled="!editable"
        class="ns"
        placeholder="/"
        @update:value="(v) => { sioCfg.namespace = v; touch(); }"
      />
    </div>

    <n-tabs v-model:value="activePane" type="line" size="small" class="panes">
      <n-tab-pane name="connect" :tab="t('sio.tabConnect')">
        <div class="field">
          <span class="label">{{ t('sio.transportLabel') }}</span>
          <n-select
            :value="sioCfg.transports"
            :options="TRANSPORT_OPTIONS"
            :disabled="!editable"
            size="small"
            class="w180"
            @update:value="(v) => { sioCfg.transports = v; touch(); }"
          />
        </div>

        <p class="label">{{ t('sio.headerLabel') }}</p>
        <key-value-table
          :model-value="spec.params.headers"
          :disabled="!editable"
          :key-placeholder="t('sio.headerPlaceholder')"
          :value-placeholder="t('sio.valuePlaceholder')"
          @update:model-value="(v) => { spec.params.headers = v; touch(); }"
        />

        <p class="label">{{ t('sio.queryLabel') }}</p>
        <key-value-table
          :model-value="spec.params.query"
          :disabled="!editable"
          :key-placeholder="t('sio.paramName')"
          :value-placeholder="t('sio.valuePlaceholder')"
          @update:model-value="(v) => { spec.params.query = v; touch(); }"
        />

        <p class="label">{{ t('sio.authLabel') }}</p>
        <auth-editor
          :model-value="spec.auth"
          :disabled="!editable"
          @update:model-value="(v) => { spec.auth = v; touch(); }"
        />

        <p class="label">
          {{ t('sio.handshakeAuthLabel') }}
          <span class="note">{{ t('sio.handshakeAuthNote') }}</span>
        </p>
        <n-input
          type="textarea"
          size="small"
          :value="authText"
          :disabled="!editable"
          :autosize="{ minRows: 2, maxRows: 6 }"
          placeholder='{"token":"{{token}}"}'
          @update:value="(v) => { authText = v; }"
          @blur="onAuthBlur"
        />

        <p class="label">
          {{ t('sio.listenEventsLabel') }}
          <span class="note">{{ t('sio.listenEventsNote') }}</span>
        </p>
        <n-input
          type="textarea"
          size="small"
          :value="listenText"
          :disabled="!editable"
          :autosize="{ minRows: 2, maxRows: 6 }"
          placeholder="message"
          @update:value="(v) => { listenText = v; }"
        />
      </n-tab-pane>

      <n-tab-pane name="send" :tab="t('sio.tabSend')">
        <div class="send-row">
          <n-input
            v-model:value="draftEvent"
            :disabled="!editable"
            size="small"
            class="event"
            :placeholder="t('sio.eventNamePlaceholder')"
          />
          <n-checkbox v-model:checked="draftAck" :disabled="!editable">{{ t('sio.waitAck') }}</n-checkbox>
          <n-button size="small" type="primary" :disabled="!editable || !connected" @click="sendDraft">
            {{ t('sio.send') }}
          </n-button>
          <n-button size="small" :disabled="!editable" @click="addCurrentAsSend">{{ t('sio.saveAsCommon') }}</n-button>
        </div>

        <n-input
          v-model:value="draftArgs"
          type="textarea"
          size="small"
          :disabled="!editable"
          :autosize="{ minRows: 3, maxRows: 8 }"
          :placeholder="t('sio.argsPlaceholder')"
        />

        <p class="label" style="margin-top: 14px">{{ t('sio.commonSends') }}</p>
        <div v-if="sends.length" class="sends">
          <div v-for="item in sends" :key="item.id" class="send-item">
            <n-button size="tiny" quaternary @click="useSend(item)">{{ item.event }}</n-button>
            <span class="args">{{ item.args }}</span>
            <n-tag v-if="item.ack" size="tiny">ack</n-tag>
            <n-button v-if="editable" size="tiny" quaternary type="error" @click="removeSend(item.id)">
              {{ t('app.delete') }}
            </n-button>
          </div>
        </div>
        <p v-else class="empty">{{ t('sio.noSends') }}</p>
      </n-tab-pane>

      <n-tab-pane name="log" :tab="t('sio.tabLog')">
        <ws-message-log :events="(state && state.events) || []" :dropped="(state && state.dropped) || 0" />
      </n-tab-pane>
    </n-tabs>
  </div>
</template>

<style scoped>
.sio-tab {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
}

.bar {
  display: flex;
  align-items: center;
  gap: 8px;
}

.title {
  font-weight: 600;
}

.bar-tools {
  margin-left: auto;
  display: flex;
  gap: 6px;
}

/* 禁用的按钮不派发鼠标事件，提示要挂在外面的 span 上 */
.connect-wrap {
  display: inline-flex;
  flex: none;
}

.notice {
  padding: 5px 10px;
  border-radius: 4px;
  font-size: 12px;
  background: rgba(128, 128, 128, 0.12);
}

.addr {
  display: flex;
  gap: 6px;
}

.url {
  flex: 1;
  min-width: 0;
}

.path,
.ns {
  width: 160px;
  flex: none;
}

.panes {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.panes :deep(.n-tab-pane) {
  height: 100%;
  min-height: 0;
  overflow: auto;
  padding-top: 8px;
}

.label {
  margin: 12px 0 6px;
  font-size: 12px;
  font-weight: 600;
  opacity: 0.8;
}

.note {
  margin-left: 6px;
  font-weight: 400;
  opacity: 0.6;
}

.field {
  display: flex;
  align-items: center;
  gap: 8px;
}

.w180 {
  width: 200px;
}

.send-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.event {
  width: 240px;
  flex: none;
}

.sends {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.send-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  padding: 3px 6px;
  border-radius: 4px;
  background: rgba(128, 128, 128, 0.08);
}

.args {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.7;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.empty {
  margin: 0;
  font-size: 12px;
  opacity: 0.55;
}
</style>
