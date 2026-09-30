<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  NAlert,
  NButton,
  NDropdown,
  NForm,
  NFormItem,
  NInput,
  NModal,
  NSelect,
  NSpace,
  NSwitch,
  NTabPane,
  NTabs,
  NTag,
  useMessage
} from 'naive-ui';
import { useProjectStore } from '@/stores/project';
import { useEnvStore } from '@/stores/env';
import { useWsStore } from '@/stores/ws';
import { useTabsStore } from '@/stores/tabs';
import { useTreeStore } from '@/stores/tree';
import * as apisApi from '@/api/apis';
import KeyValueTable from '@/components/common/KeyValueTable.vue';
import VarInput from '@/components/common/VarInput.vue';
import AuthEditor from '@/components/request/AuthEditor.vue';
import MockPanel from '@/components/mock/MockPanel.vue';
import WsMessageLog from './WsMessageLog.vue';
import WsScenarioDialog from './WsScenarioDialog.vue';
import { buildWsScenario } from '@/utils/wsScenario';
import { resolveScope } from '@/utils/variables';
import { HEADER_NAMES } from '@/utils/suggestions';

/**
 * WebSocket 标签页（契约第 15、17 节）。两种形态共用这一个组件：
 * - **临时**（`apiId` 为空）：就是个调试窗口，不进目录树；想留下来点「保存到目录」；
 * - **绑定接口**（`apiId` 有值）：接口在目录树里，这里改的 url / 请求头 / query / 鉴权
 *   可以保存回接口，还多一个 Mock 页签和「保存为 mock」。
 *
 * 真正的连接由服务端建立，会话状态放在 stores/ws.js 里 —— 组件会随着切换标签页
 * 被卸载重建，状态放这里等于一切走就断线。
 */
const props = defineProps({
  tab: { type: Object, required: true }
});

const projects = useProjectStore();
const envs = useEnvStore();
const ws = useWsStore();
const tabs = useTabsStore();
const tree = useTreeStore();
const message = useMessage();

const activePane = ref('headers');
const sending = ref(false);
const draft = ref('');

const saving = ref(false);
const showSaveDialog = ref(false);
const saveForm = ref({ name: '', folderId: null });

const showScenario = ref(false);
const scenario = ref(null);
const scenarioStats = ref({
  pushed: 0,
  ruleCount: 0,
  skipped: 0,
  cappedDelays: 0,
  truncated: 0,
  duplicates: 0
});
const savingScenario = ref(false);

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

/** 绑定了接口：可以保存、有 Mock 页签、可以「保存为 mock」 */
const bound = computed(function () {
  return Boolean(props.tab.apiId);
});

const canEdit = computed(function () {
  return projects.canEdit;
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

/** 变量作用域（契约第 5 节），地址栏和请求头里的 `{{变量}}` 都用它 */
const scope = computed(function () {
  return resolveScope({
    project: projects.current,
    folders: tree.folders,
    folderId: props.tab.folderId,
    environment: envs.selected
  });
});

/** 消息日志里有没有可以用来生成场景的文本消息 */
const canSaveScenario = computed(function () {
  if (!bound.value || !canEdit.value) return false;
  return (state.value.events || []).some(function (event) {
    return event && event.type === 'message' && !event.base64;
  });
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
    if (!bound.value) props.tab.title = titleFromUrl(url);
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

/* ---------------- 保存（绑定了接口才有） ---------------- */

async function save() {
  if (!bound.value) return;

  saving.value = true;
  try {
    const data = await apisApi.updateApi(props.tab.apiId, {
      url: props.tab.spec.url,
      params: props.tab.spec.params,
      auth: props.tab.spec.auth
    });
    tabs.markSaved(props.tab, data.api);
    message.success('已保存');
  } catch (err) {
    message.error(err.message);
  } finally {
    saving.value = false;
  }
}

/* ---------------- 保存到目录（临时标签页） ---------------- */

function folderOptions() {
  const list = [{ label: '（根目录）', value: null }];
  (function walk(nodes, depth) {
    (nodes || []).forEach(function (node) {
      if (node.kind !== 'folder') return;
      list.push({ label: '　'.repeat(depth) + node.name, value: node.id });
      walk(node.children, depth + 1);
    });
  })(tree.nodes, 0);
  return list;
}

function openSaveDialog() {
  saveForm.value = {
    name: props.tab.spec.url ? titleFromUrl(props.tab.spec.url) : 'WebSocket',
    folderId: null
  };
  showSaveDialog.value = true;
}

async function confirmSaveToFolder() {
  if (!String(saveForm.value.name || '').trim()) {
    message.warning('请填写接口名称');
    return;
  }

  saving.value = true;
  try {
    const data = await apisApi.createApi(projects.currentId, {
      method: 'WS',
      name: String(saveForm.value.name).trim(),
      folderId: saveForm.value.folderId,
      url: props.tab.spec.url,
      params: props.tab.spec.params,
      auth: props.tab.spec.auth
    });
    // markSaved 的 WS 分支会把这个临时标签页变成绑定接口的样子
    tabs.markSaved(props.tab, data.api);
    showSaveDialog.value = false;
    await tree.refresh();
    message.success('已保存到目录');
  } catch (err) {
    message.error(err.message);
  } finally {
    saving.value = false;
  }
}

/* ---------------- 保存为 mock ---------------- */

function openScenario() {
  const built = buildWsScenario(state.value.events || []);
  scenario.value = built.scenario;
  scenarioStats.value = {
    pushed: built.pushed,
    ruleCount: built.ruleCount,
    skipped: built.skipped,
    cappedDelays: built.cappedDelays,
    truncated: built.truncated,
    duplicates: built.duplicates
  };
  showScenario.value = true;
}

async function confirmScenario() {
  if (!scenario.value || !props.tab.apiId) return;

  savingScenario.value = true;
  try {
    const data = await apisApi.createExample(props.tab.apiId, {
      name: 'WS 录制于 ' + stamp(),
      // WS 的握手是 101，示例上存这个值只是表明它是个 WebSocket 场景
      status: 101,
      headers: [],
      body: JSON.stringify(scenario.value, null, 2),
      responseType: 'ws',
      isTemplate: false,
      source: 'recorded'
    });

    props.tab.api = data.api;
    props.tab.focusExampleId = data.example.id;
    showScenario.value = false;
    activePane.value = 'mock';
    message.success('已存为 WebSocket 示例');
  } catch (err) {
    message.error(err.message);
  } finally {
    savingScenario.value = false;
  }
}

function stamp() {
  const now = new Date();
  function pad(value) { return String(value).padStart(2, '0'); }
  return now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) +
    ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds());
}

/* ---------------- 快捷键 ---------------- */

function onKeydown(event) {
  if (!(event.ctrlKey || event.metaKey)) return;
  if (String(event.key).toLowerCase() !== 's') return;
  event.preventDefault();

  if (!canEdit.value) {
    message.warning('当前角色是只读，不能保存修改');
    return;
  }
  if (bound.value) save();
  else openSaveDialog();
}

onMounted(function () {
  window.addEventListener('keydown', onKeydown);
  ws.ensure(props.tab.key);
});

onBeforeUnmount(function () {
  window.removeEventListener('keydown', onKeydown);
});

/**
 * 绑定接口的标签页要跟着接口标签页一样标「未保存」。
 * 临时标签页不算：它没有基线，标了也永远是脏的。
 */
watch(
  function () { return props.tab.spec; },
  function () {
    if (bound.value) tabs.touch(props.tab);
  },
  { deep: true }
);
</script>

<template>
  <div class="ws-tab">
    <div class="head">
      <var-input
        class="url"
        :model-value="spec.url"
        :scope="scope"
        placeholder="wss://echo.example.com/socket，支持 {{变量}}"
        @update:model-value="(v) => { spec.url = v; }"
        @enter="onConnect"
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

      <n-button v-if="canEdit && bound" size="small" :loading="saving" @click="save">
        保存
      </n-button>
      <n-button v-if="canEdit && !bound" size="small" @click="openSaveDialog">
        保存到目录
      </n-button>
    </div>

    <n-alert v-if="state.error" type="error" :show-icon="false" class="notice">
      {{ state.error }}
    </n-alert>

    <n-alert v-if="state.note" type="warning" :show-icon="false" class="notice">
      {{ state.note }}
    </n-alert>

    <div class="panes" :class="{ full: activePane === 'mock' }">
      <n-tabs v-model:value="activePane" type="line" size="small" animated>
        <n-tab-pane name="headers" tab="Headers">
          <div class="pane">
            <key-value-table
              v-model="spec.params.headers"
              :scope="scope"
              kind="ws-headers"
              :key-suggestions="HEADER_NAMES"
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
              :scope="scope"
              kind="ws-query"
              key-placeholder="参数名"
              value-placeholder="值"
            />
          </div>
        </n-tab-pane>

        <n-tab-pane name="auth" tab="Auth">
          <div class="pane narrow">
            <auth-editor v-model="spec.auth" :scope="scope" />
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

        <n-tab-pane v-if="bound" name="mock" tab="Mock">
          <div class="pane">
            <mock-panel :tab="tab" />
          </div>
        </n-tab-pane>
      </n-tabs>
    </div>

    <template v-if="activePane !== 'mock'">
      <div class="log-head">
        <span class="label">消息日志</span>
        <n-button
          v-if="canSaveScenario"
          size="tiny"
          quaternary
          type="primary"
          title="按消息日志生成回放场景，存成 ws 类型的示例"
          @click="openScenario"
        >
          保存为 mock
        </n-button>
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
    </template>

    <n-modal
      v-model:show="showSaveDialog"
      preset="card"
      title="保存到目录"
      style="width: 460px; max-width: 92vw"
    >
      <n-form>
        <n-form-item label="名称">
          <n-input v-model:value="saveForm.name" placeholder="接口名称" />
        </n-form-item>
        <n-form-item label="目录">
          <n-select v-model:value="saveForm.folderId" :options="folderOptions()" />
        </n-form-item>
      </n-form>

      <template #footer>
        <n-space justify="end">
          <n-button @click="showSaveDialog = false">取消</n-button>
          <n-button type="primary" :loading="saving" @click="confirmSaveToFolder">保存</n-button>
        </n-space>
      </template>
    </n-modal>

    <ws-scenario-dialog
      v-model:show="showScenario"
      :scenario="scenario"
      :stats="scenarioStats"
      :saving="savingScenario"
      @confirm="confirmScenario"
    />
  </div>
</template>

<style scoped>
.ws-tab {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 12px 16px;
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

/* 页签条左边留 16px，和请求区一致 */
.panes :deep(.n-tabs-nav-scroll-content) {
  padding-left: 16px;
}

/* Mock 页签内容多，给它整块高度，日志和输入区先收起来 */
.panes.full {
  flex: 1;
  max-height: none;
}

.pane {
  padding: 12px 16px;
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
  gap: 6px;
}

.log-head .label {
  flex: 1;
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
