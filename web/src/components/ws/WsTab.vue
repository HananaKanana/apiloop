<script setup>
import { computed, onMounted, ref } from 'vue';
import {
  NAlert,
  NButton,
  NDropdown,
  NInput,
  NTabPane,
  NTabs,
  NTag,
  NSwitch,
  useMessage
} from 'naive-ui';
import { useProjectStore } from '@/stores/project';
import { useEnvStore } from '@/stores/env';
import { useWsStore } from '@/stores/ws';
import KeyValueTable from '@/components/common/KeyValueTable.vue';
import AuthEditor from '@/components/request/AuthEditor.vue';
import WsMessageLog from './WsMessageLog.vue';

/**
 * WebSocket 调试标签页（契约第 15 节）。
 *
 * 标签页本身**不进目录树、不记历史**，就是个临时调试窗口。真正的连接由服务端建立，
 * 会话状态放在 stores/ws.js 里 —— 组件会随着切换标签页被卸载重建，
 * 状态放这里等于一切走就断线。
 */
const props = defineProps({
  tab: { type: Object, required: true }
});

const projects = useProjectStore();
const envs = useEnvStore();
const ws = useWsStore();
const message = useMessage();

const activePane = ref('headers');
const sending = ref(false);
const draft = ref('');

const EMPTY_STATE = {
  status: 'idle',
  channel: 'idle',
  sessionId: '',
  url: '',
  protocol: '',
  note: '',
  error: '',
  events: [],
  dropped: 0,
  lastSeq: 0
};

const STATUS_TEXT = {
  idle: '未连接',
  connecting: '连接中…',
  open: '已连接',
  closed: '已断开',
  ended: '会话已结束',
  error: '出错'
};

/** 状态标签只在「需要有人管」的时候上色，其余保持中性 */
const STATUS_TYPE = {
  open: 'success',
  connecting: 'info',
  ended: 'error',
  error: 'error'
};

const state = computed(function () {
  return ws.stateOf(props.tab.key) || EMPTY_STATE;
});

const spec = computed(function () {
  return props.tab.spec;
});

const options = computed(function () {
  return props.tab.options || { cookies: true };
});

const connected = computed(function () {
  return state.value.status === 'open';
});

const busy = computed(function () {
  return state.value.status === 'connecting';
});

const statusText = computed(function () {
  return STATUS_TEXT[state.value.status] || state.value.status;
});

const statusType = computed(function () {
  return STATUS_TYPE[state.value.status] || 'default';
});

/**
 * 事件流自己的状态。和 socket 的状态分开显示：上游关了之后 socket 是「已断开」，
 * 但事件流还在（还能看到 close 事件），反过来也一样。
 */
const channelHint = computed(function () {
  if (state.value.channel === 'retrying') return '事件流断了，正在重连…';
  if (state.value.channel === 'ended') return '会话已被服务端回收';
  return '';
});

/* ---------------- 最近用过的地址（按项目存 localStorage） ---------------- */

const RECENT_KEY = 'apiloop.ws.';

/** localStorage 不是响应式的，存完手动戳一下，让「最近」那个下拉跟着刷新 */
const recentVersion = ref(0);

function loadRecent(pid) {
  try {
    const raw = localStorage.getItem(RECENT_KEY + pid);
    if (!raw) return [];
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return list.filter(function (item) { return typeof item === 'string' && item; });
  } catch (err) {
    // 存的东西坏了或者 localStorage 不可用，就当没有 —— 不能因此打不开页面
    return [];
  }
}

function saveRecent(pid, url) {
  if (!pid || !url) return;
  try {
    const list = loadRecent(pid).filter(function (item) { return item !== url; });
    list.unshift(url);
    localStorage.setItem(RECENT_KEY + pid, JSON.stringify(list.slice(0, 10)));
    recentVersion.value += 1;
  } catch (err) {
    // 存不下就算了，不影响用
  }
}

const recentOptions = computed(function () {
  recentVersion.value;
  return loadRecent(projects.currentId).map(function (url) {
    return { label: url, key: url };
  });
});

function onPickRecent(url) {
  props.tab.spec.url = url;
}

/* ---------------- 连接 ---------------- */

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/** 标签页标题用地址的主机名，光写「WebSocket」的话几个标签页分不出来 */
function titleFromUrl(url) {
  const text = String(url || '').replace(/^wss?:\/\//i, '').split('/')[0];
  return text || 'WebSocket';
}

function setOption(key, value) {
  props.tab.options = Object.assign({}, options.value, { [key]: value });
}

async function onConnect() {
  // 连接中再点一次会建出两个会话，前一个就漏在服务端了
  if (busy.value) return;

  const url = String(props.tab.spec.url || '').trim();
  if (!url) {
    message.warning('请先填写 WebSocket 地址');
    return;
  }
  // 地址以 {{变量}} 开头时（比如 {{baseUrl}}/socket）本机判不了，交给服务端在
  // 变量替换之后再判，它返回的是同一个中文错误
  if (url.indexOf('{{') !== 0 && !/^wss?:\/\//i.test(url)) {
    message.warning('地址必须以 ws:// 或 wss:// 开头');
    return;
  }
  if (!projects.currentId) {
    message.warning('还没有选中项目');
    return;
  }

  props.tab.spec.url = url;
  const ok = await ws.connect(props.tab.key, {
    projectId: projects.currentId,
    spec: clone(props.tab.spec),
    environmentId: envs.selectedId || undefined,
    options: clone(options.value)
  });

  if (ok) {
    saveRecent(projects.currentId, url);
    props.tab.title = titleFromUrl(url);
  }
}

function onDisconnect() {
  ws.disconnect(props.tab.key);
}

function onClearLog() {
  ws.clearLog(props.tab.key);
}

async function onSend() {
  const text = draft.value;
  if (!connected.value) return;

  sending.value = true;
  try {
    const ok = await ws.send(props.tab.key, text);
    // 发出去了才清空输入框，失败时内容还在，用户不用重打
    if (ok) draft.value = '';
  } finally {
    sending.value = false;
  }
}

function onComposerKeydown(event) {
  if (!event.ctrlKey && !event.metaKey) return;
  if (event.key !== 'Enter') return;
  event.preventDefault();
  onSend();
}

onMounted(function () {
  ws.ensure(props.tab.key);
});
</script>

<template>
  <div class="ws-tab">
    <div class="head">
      <n-input
        class="url"
        size="small"
        :value="spec.url"
        placeholder="wss://echo.example.com/socket，支持 {{变量}}"
        @update:value="(v) => { spec.url = v; }"
        @keyup.enter="onConnect"
      />

      <n-dropdown
        v-if="recentOptions.length"
        trigger="click"
        :options="recentOptions"
        @select="onPickRecent"
      >
        <n-button size="small" quaternary>最近</n-button>
      </n-dropdown>

      <n-tag size="small" :bordered="false" :type="statusType">{{ statusText }}</n-tag>
      <span v-if="channelHint" class="channel-hint">{{ channelHint }}</span>

      <n-button v-if="connected" size="small" type="warning" secondary @click="onDisconnect">
        断开
      </n-button>
      <n-button v-else size="small" type="primary" :loading="busy" @click="onConnect">
        连接
      </n-button>
    </div>

    <n-alert v-if="state.error" type="error" :show-icon="false" class="notice">
      {{ state.error }}
    </n-alert>

    <n-alert v-if="state.note" type="warning" :show-icon="false" class="notice">
      {{ state.note }}
    </n-alert>

    <div class="panes">
      <n-tabs v-model:value="activePane" type="line" size="small" animated>
        <n-tab-pane name="headers" tab="Headers">
          <div class="pane">
            <key-value-table
              v-model="spec.params.headers"
              key-placeholder="请求头"
              value-placeholder="值"
            />
            <p class="hint">
              Sec-WebSocket-Protocol 会作为子协议协商，不会当成普通请求头发出去。
            </p>
          </div>
        </n-tab-pane>

        <n-tab-pane name="query" tab="Query">
          <div class="pane">
            <key-value-table
              v-model="spec.params.query"
              key-placeholder="参数名"
              value-placeholder="值"
            />
          </div>
        </n-tab-pane>

        <n-tab-pane name="auth" tab="Auth">
          <div class="pane narrow">
            <auth-editor v-model="spec.auth" />
          </div>
        </n-tab-pane>

        <n-tab-pane name="settings" tab="设置">
          <div class="pane narrow">
            <div class="option-row">
              <n-switch
                size="small"
                :value="options.cookies"
                @update:value="(v) => setOption('cookies', v)"
              />
              <div class="option-text">
                <span class="option-title">自动带 Cookie</span>
                <span class="option-desc">
                  连接时按目标地址从 Cookie 库里取匹配的 cookie。握手响应里的 Set-Cookie
                  拿不到，不会写回。
                </span>
              </div>
            </div>
          </div>
        </n-tab-pane>
      </n-tabs>
    </div>

    <div class="log-head">
      <span class="label">消息日志</span>
      <n-button size="tiny" quaternary @click="onClearLog">清空日志</n-button>
    </div>

    <div class="log">
      <ws-message-log :events="state.events" :dropped="state.dropped" />
    </div>

    <div class="composer">
      <n-input
        v-model:value="draft"
        type="textarea"
        size="small"
        :autosize="{ minRows: 2, maxRows: 6 }"
        placeholder="要发送的内容，Ctrl+Enter 发送"
        @keydown="onComposerKeydown"
      />
      <n-button
        class="send"
        size="small"
        type="primary"
        :disabled="!connected"
        :loading="sending"
        @click="onSend"
      >
        发送
      </n-button>
    </div>
  </div>
</template>

<style scoped>
.ws-tab {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 8px;
  gap: 8px;
}

.head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
}

.url {
  flex: 1;
  min-width: 0;
}

.channel-hint {
  flex: none;
  font-size: 12px;
  opacity: 0.6;
}

.notice {
  flex: none;
  font-size: 12px;
}

.panes {
  flex: 0 0 auto;
  max-height: 40%;
  overflow: auto;
  border-bottom: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.16));
}

.pane {
  padding: 8px 2px;
}

.pane.narrow {
  max-width: 460px;
}

.hint {
  margin: 8px 0 0;
  font-size: 12px;
  opacity: 0.6;
}

.option-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}

.option-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.option-title {
  font-size: 13px;
}

.option-desc {
  font-size: 12px;
  opacity: 0.6;
  line-height: 1.6;
}

.log-head {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.label {
  font-size: 12px;
  opacity: 0.65;
}

.log {
  flex: 1;
  min-height: 0;
}

.composer {
  flex: none;
  display: flex;
  align-items: flex-end;
  gap: 8px;
}

.composer :deep(.n-input) {
  flex: 1;
  min-width: 0;
}

.send {
  flex: none;
  width: 72px;
}
</style>
