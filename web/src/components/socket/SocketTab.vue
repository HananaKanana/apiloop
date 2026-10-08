<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  NAlert,
  NButton,
  NInput,
  NInputNumber,
  NModal,
  NSelect,
  NSwitch,
  NTabPane,
  NTabs,
  NTag,
  NTooltip,
  useMessage
} from 'naive-ui';
import { useProjectStore } from '@/stores/project';
import { useEnvStore } from '@/stores/env';
import { useSocketStore } from '@/stores/socket';
import { useTabsStore, emptySocketSpec } from '@/stores/tabs';
import { useTreeStore } from '@/stores/tree';
import { useUiStore } from '@/stores/ui';
import { useGatewayStore } from '@/stores/gateway';
import * as apisApi from '@/api/apis';
import VarInput from '@/components/common/VarInput.vue';
import InlineRename from '@/components/common/InlineRename.vue';
import SocketDataLog from './SocketDataLog.vue';
import { folderChain } from '@/utils/tree';
import { methodColor } from '@/utils/method';
import { resolveScope } from '@/utils/variables';
import { usePaneTabsTheme } from '@/utils/paneTabs';

/**
 * TCP / UDP 标签页（第十六轮）。两种协议共用这一个组件，按 `spec.method` 显示不同字段：
 * - **TCP**：连接超时、使用 TLS、忽略证书错误、分帧方式；
 * - **UDP**：本机端口、允许广播。
 *
 * 和 MqttTab 一样两种形态：临时标签页（不进目录树，想留下来点「保存到目录」）和
 * 绑定接口的标签页（连接参数和常用发送能存回接口）。
 *
 * 真正的连接由服务端建立（`lib/socket-sessions.js`），会话状态放在 `stores/socket.js` 里 ——
 * 组件会随着切换标签页被卸载重建，状态放这里等于一切走就断线。
 *
 * 请求形状和 WebSocket / Socket.IO 不一样的地方：**TCP / UDP 没有请求头 / query / 鉴权**那一套，
 * 地址就是 `tcp://host:port` / `tls://host:port` / `udp://host:port`，其余全在 `spec.socket` 里
 * （和 `apis.extra.socket` 同一份形状，见 `lib/api/dto.js` 的 `toApiSocket`）。
 * **`extra.socket` 里没有 method**（方法在 `api.method` 上），所以 spec 自己带一份。
 */
const props = defineProps({
  tab: { type: Object, required: true }
});

const projects = useProjectStore();
const envs = useEnvStore();
const socket = useSocketStore();
const tabs = useTabsStore();
const tree = useTreeStore();
const ui = useUiStore();
const gateway = useGatewayStore();
const message = useMessage();
const paneTabsTheme = usePaneTabsTheme();
const { t } = useI18n();

/** 这个接口和云端对不上：顶部一条红提示 + 「处理」入口（和 MqttTab 那条一致） */
const conflicted = computed(function () {
  return Boolean(props.tab.apiId) && gateway.isConflicted('api', props.tab.apiId);
});

function openConflict() {
  if (!props.tab.apiId) return;
  ui.openConflict('api', props.tab.apiId);
}

const activePane = ref('connect');
const saving = ref(false);

const showSaveDialog = ref(false);
const saveForm = ref({ name: '', folderId: null });

/* ---------------- 会话状态 ---------------- */

const state = computed(function () {
  return socket.stateOf(props.tab.key) || null;
});

const spec = computed(function () {
  return props.tab.spec;
});

/** 没配过 socket 时给一份默认（老接口 / 新建的空标签页都可能没有） */
const socketCfg = computed(function () {
  if (!spec.value.socket) spec.value.socket = emptySocketSpec().socket;
  return spec.value.socket;
});

/** 'TCP' / 'UDP'：决定显示哪些字段、按钮上写「连接」还是「打开」 */
const specMethod = computed(function () {
  return String(spec.value.method || 'TCP').toUpperCase() === 'UDP' ? 'UDP' : 'TCP';
});

const isUdp = computed(function () {
  return specMethod.value === 'UDP';
});

const bound = computed(function () {
  return Boolean(props.tab.apiId);
});

const canEdit = computed(function () {
  return projects.canEdit;
});

const status = computed(function () {
  return (state.value && state.value.status) || 'idle';
});

const connected = computed(function () {
  return status.value === 'open';
});

const busy = computed(function () {
  return status.value === 'connecting';
});

const STATUS_TEXT = computed(function () {
  return {
    idle: t('socket.statusIdle'),
    connecting: t('socket.statusConnecting'),
    open: t('socket.statusOpen'),
    closed: t('socket.statusClosed'),
    error: t('socket.statusError'),
    ended: t('socket.statusEnded')
  };
});

/**
 * 状态标签的配色：**只给需要人管的那几档上色**，已断开 / 未连接保持中性 ——
 * 一个常驻的灰标签不该抢眼（和 MqttTab 的 STATUS_TYPE 一个口径）。
 */
const STATUS_TYPE = {
  open: 'success',
  connecting: 'info',
  error: 'error',
  ended: 'error'
};

const statusText = computed(function () {
  return STATUS_TEXT.value[status.value] || status.value;
});

const statusType = computed(function () {
  return STATUS_TYPE[status.value] || 'default';
});

/** events 长连接自己的状态：和 socket 状态分开显示（同 MqttTab） */
const channelHint = computed(function () {
  const current = state.value;
  if (!current) return '';
  if (current.channel === 'retrying') return t('socket.channelRetrying');
  if (current.channel === 'ended') return t('socket.channelEnded');
  return '';
});

/**
 * 网页版要把「连接 / 打开」灰掉 —— 这条**只在客户端里才有**。
 *
 * 判断用 `isGateway`，**不是** `cloudSendBlocked`：路由只挂在本机网关上
 * （`lib/api/socket.js` 在 `ctx.localSend` 为假时直接返回空 router），云端不管
 * `SERVER_SEND` 开没开都没有 `/socket`。和 MqttTab / GrpcTab 一个口径。
 *
 * 地址栏回车（var-input 的 @enter）也会走到 onConnect，那里再兜一次。
 */
const connectBlocked = computed(function () {
  return !gateway.isGateway;
});

/** 变量作用域：地址、发送内容里的 `{{变量}}` 都用它高亮 */
const scope = computed(function () {
  return resolveScope({
    project: projects.current,
    folders: tree.folders,
    folderId: props.tab.folderId,
    environment: envs.selected
  });
});

/* ---------------- 选项表 ---------------- */

const FRAMING_OPTIONS = computed(function () {
  return [
    { label: t('socket.framingNone'), value: 'none' },
    { label: t('socket.framingDelimiter'), value: 'delimiter' },
    { label: t('socket.framingLength'), value: 'length' }
  ];
});

const LENGTH_OPTIONS = [
  { label: '1', value: 1 },
  { label: '2', value: 2 },
  { label: '4', value: 4 }
];

const ENDIAN_OPTIONS = computed(function () {
  return [
    { label: t('socket.endianBe'), value: 'be' },
    { label: t('socket.endianLe'), value: 'le' }
  ];
});

const ENCODING_OPTIONS = computed(function () {
  return [
    { label: t('socket.formatText'), value: 'text' },
    { label: t('socket.formatHex'), value: 'hex' },
    { label: t('socket.formatBase64'), value: 'base64' }
  ];
});

const LINE_ENDING_OPTIONS = computed(function () {
  return [
    { label: t('socket.lineEndingNone'), value: 'none' },
    { label: t('socket.lineEndingLf'), value: 'lf' },
    { label: t('socket.lineEndingCrlf'), value: 'crlf' }
  ];
});

/**
 * 模板里**不能直接写 `{{变量}}`** —— Vue 会把它当成插值（一个叫「变量」的绑定），
 * 轻则渲染成空、重则报错。这种带花括号的示例文案一律走 i18n 的 `{'...'}` 转义
 * （见 `locales/zh-CN/socket.js` 与 `locales/en/socket.js` 的 `payloadHint` / `urlPlaceholderTcp`）。
 */

/* ---------------- 改了就标未保存 ---------------- */

function touch() {
  tabs.touch(props.tab);
}

/* ---------------- 连接 ---------------- */

const SCHEMES = /^(tcp|tls|udp):\/\//i;

/** 这个方法的地址前缀（新建时补协议头用） */
function schemeFor() {
  return isUdp.value ? 'udp://' : (tlsOn.value ? 'tls://' : 'tcp://');
}

/** 地址头是不是 tls://（「使用 TLS」那个开关的状态就存这儿，不再单独存一份） */
const tlsOn = computed(function () {
  return /^tls:\/\//i.test(String(spec.value.url || '').trim());
});

/** 勾 / 取消「使用 TLS」：改地址的协议头，别处不动 */
function setTls(on) {
  const url = String(spec.value.url || '').trim();
  // 变量开头的地址本机判不了（协议头可能是变量拼出来的），交给服务端
  if (url.indexOf('{{') === 0) return;

  const scheme = on ? 'tls://' : (isUdp.value ? 'udp://' : 'tcp://');
  if (!url) {
    spec.value.url = scheme;
    touch();
    return;
  }
  spec.value.url = SCHEMES.test(url) ? url.replace(SCHEMES, scheme) : scheme + url;
  touch();
}

function connectPayload() {
  const cfg = socketCfg.value;
  const framing = cfg.framing || {};
  return {
    projectId: projects.currentId,
    apiId: props.tab.apiId || undefined,
    environmentId: envs.selectedId || undefined,
    method: specMethod.value,
    url: String(spec.value.url || '').trim(),
    connectTimeoutMs: cfg.connectTimeoutMs,
    tlsInsecure: cfg.tlsInsecure === true,
    framing: {
      type: framing.type || 'none',
      delimiter: framing.delimiter === undefined || framing.delimiter === null ? '\\n' : framing.delimiter,
      lengthBytes: framing.lengthBytes,
      endian: framing.endian
    },
    udp: {
      bindPort: cfg.udp ? cfg.udp.bindPort : null,
      broadcast: Boolean(cfg.udp && cfg.udp.broadcast)
    }
  };
}

async function onConnect() {
  // 网页版没有 /socket（只在客户端里有）：按钮已经灰了，但地址栏回车也会走到这里，兜一次
  if (connectBlocked.value) {
    message.warning(t('socket.connectBlocked'));
    return;
  }
  // 连接中再点一次会建出两个会话，前一个就漏在服务端了
  if (busy.value) return;

  let url = String(spec.value.url || '').trim();
  if (!url) {
    message.warning(t('socket.addressRequired'));
    return;
  }
  // 没写协议头的按方法补上（用户常常只输了 host:port）；
  // 已经带协议头的一律原样交给服务端 —— 它按**方法**为准解析，只认 host:port，
  // 方法 UDP 却写了 tcp:// 也照样能用（见 T28 的接口约定），前端不必替它纠错
  if (url.indexOf('{{') !== 0 && url.indexOf('://') === -1) {
    url = schemeFor() + url;
    spec.value.url = url;
  }
  if (!projects.currentId) {
    message.warning(t('socket.noProject'));
    return;
  }

  const ok = await socket.connect(props.tab.key, connectPayload());
  if (!ok) {
    const current = state.value;
    message.error((current && current.error) || t('socket.connectFailed'));
  }
}

function onDisconnect() {
  socket.disconnect(props.tab.key);
}

function onClearLog() {
  socket.clearLog(props.tab.key);
}

/* ---------------- 发送 ---------------- */

const draft = ref('');
const draftEncoding = ref('text');
const draftLineEnding = ref('none');
const draftTo = ref('');
const savedPick = ref(null);

/** 打开标签页时把接口上记的默认发送格式 / 行尾读进草稿 */
function syncDraftFromConfig() {
  const cfg = socketCfg.value;
  draftEncoding.value = cfg.sendEncoding || 'text';
  draftLineEnding.value = cfg.lineEnding || 'none';
}

const saved = computed(function () {
  return socketCfg.value.saved || [];
});

const savedOptions = computed(function () {
  return saved.value.map(function (item, index) {
    return { label: item.name, value: index };
  });
});

/**
 * 选了常用发送就填进草稿。
 *
 * `savedPick` **不重置**：它同时是「删除这条」按钮的锚点。同一个再选一次不会重新触发
 * `@update:value`，但草稿早就填好了，不影响用。
 */
function useSaved(index) {
  const item = saved.value[index];
  if (!item) return;
  savedPick.value = index;
  draft.value = item.payload || '';
  if (item.encoding) draftEncoding.value = item.encoding;
}

const showCommonDialog = ref(false);
const commonForm = ref({ name: '' });

function openSaveCommon() {
  const payload = String(draft.value || '');
  if (!payload.trim()) {
    message.warning(t('socket.emptyPayload'));
    return;
  }
  commonForm.value = { name: '' };
  showCommonDialog.value = true;
}

async function confirmSaveCommon() {
  const name = String(commonForm.value.name || '').trim();
  if (!name) {
    message.warning(t('socket.commonNameRequired'));
    return;
  }

  const list = (socketCfg.value.saved || []).slice();
  list.push({ name: name, payload: draft.value, encoding: draftEncoding.value });
  socketCfg.value.saved = list;
  touch();
  showCommonDialog.value = false;

  if (props.tab.apiId) {
    try {
      const api = await persist();
      // 存回接口了就把快照对齐，别在标签页上留一个假的「未保存」圆点
      if (api) tabs.markSaved(props.tab, api);
      message.success(t('socket.commonSaved'));
    } catch (err) {
      message.error(err.message);
    }
  }
}

async function removeSaved(index) {
  const list = (socketCfg.value.saved || []).slice();
  if (index < 0 || index >= list.length) return;
  list.splice(index, 1);
  socketCfg.value.saved = list;
  // 删掉之后下标会整体前移，锚点跟着挪，别指向别的条目
  if (savedPick.value === index) savedPick.value = null;
  else if (savedPick.value > index) savedPick.value -= 1;
  touch();
  if (props.tab.apiId) {
    try {
      const api = await persist();
      if (api) tabs.markSaved(props.tab, api);
    } catch (err) { message.error(err.message); }
  }
}

/** 「发往」那一格：`host:port`。空着就是不传，服务端发到会话地址上 */
function parseTo(text) {
  const value = String(text || '').trim();
  if (!value) return undefined;
  const at = value.lastIndexOf(':');
  if (at <= 0) return null;
  const port = Number(value.slice(at + 1));
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return null;
  return { host: value.slice(0, at), port: port };
}

async function sendNow() {
  if (!connected.value) {
    message.warning(t('socket.notConnected'));
    return;
  }
  if (!String(draft.value || '').trim()) {
    message.warning(t('socket.emptyPayload'));
    return;
  }

  const payload = { payload: draft.value, encoding: draftEncoding.value };

  if (draftEncoding.value === 'text') {
    // 行尾每次发送都传（界面上可以临时改），不要读会话上存的值
    payload.lineEnding = draftLineEnding.value;
  }
  if (isUdp.value && String(draftTo.value || '').trim()) {
    const to = parseTo(draftTo.value);
    if (!to) {
      message.warning(t('socket.sendToPlaceholder'));
      return;
    }
    payload.to = to;
  }

  const ok = await socket.send(props.tab.key, payload);
  if (!ok) {
    const current = state.value;
    message.error((current && current.error) || t('socket.sendFailed'));
  }
}

/** ⌘Enter / Ctrl+Enter 也能发 */
function onPayloadKeydown(event) {
  if (!(event.metaKey || event.ctrlKey)) return;
  if (event.key !== 'Enter') return;
  event.preventDefault();
  sendNow();
}

/* ---------------- 保存（绑定了接口才有） ---------------- */

async function persist() {
  if (!props.tab.apiId) return null;
  const data = await apisApi.updateApi(props.tab.apiId, {
    url: spec.value.url,
    socket: spec.value.socket
  });
  return data.api;
}

async function save() {
  if (!props.tab.apiId) return;

  saving.value = true;
  try {
    const api = await persist();
    if (api) tabs.markSaved(props.tab, api);
    message.success(t('socket.saved'));
  } catch (err) {
    message.error(err.message);
  } finally {
    saving.value = false;
  }
}

/* ---------------- 保存到目录（临时标签页） ---------------- */

function folderOptions() {
  const list = [{ label: t('socket.rootFolder'), value: null }];
  (function walk(nodes, depth) {
    (nodes || []).forEach(function (node) {
      if (node.kind !== 'folder') return;
      list.push({ label: '　'.repeat(depth) + node.name, value: node.id });
      walk(node.children, depth + 1);
    });
  })(tree.nodes, 0);
  return list;
}

/** 项目 › 目录… › 名字，和普通接口标签页的面包屑一样 */
const crumbs = computed(function () {
  const list = [];
  if (projects.current) list.push(projects.current.name);
  folderChain(tree.folders, props.tab.folderId).forEach(function (folder) {
    list.push(folder.name);
  });
  list.push(props.tab.title || specMethod.value);
  return list;
});

/**
 * 面包屑上双击改名（和 MqttTab 的 renameTitle 一样）：
 * 已保存的接口只改名字、立刻存；还没保存的只改标题，保存时默认用它。
 */
async function renameTitle(name) {
  if (!props.tab.apiId) {
    props.tab.title = name;
    props.tab.customTitle = true;
    return;
  }

  try {
    await tree.renameApi(props.tab.apiId, name);
    tabs.applyRename('api', props.tab.apiId, name);
    message.success(t('socket.renamed'));
  } catch (err) {
    message.error(err.message);
  }
}

/** 标签页标题用地址的主机名，光写「TCP」的话几个标签页分不出来 */
function titleFromUrl(url) {
  const text = String(url || '').replace(SCHEMES, '').split('/')[0];
  return text || specMethod.value;
}

function openSaveDialog() {
  saveForm.value = {
    name: props.tab.customTitle
      ? props.tab.title
      : (props.tab.spec.url ? titleFromUrl(props.tab.spec.url) : specMethod.value),
    folderId: null
  };
  showSaveDialog.value = true;
}

async function confirmSaveToFolder() {
  if (!String(saveForm.value.name || '').trim()) {
    message.warning(t('socket.apiNameRequired'));
    return;
  }

  saving.value = true;
  try {
    const data = await apisApi.createApi(projects.currentId, {
      method: specMethod.value,
      name: String(saveForm.value.name).trim(),
      folderId: saveForm.value.folderId,
      url: props.tab.spec.url,
      socket: props.tab.spec.socket
    });
    // markSaved 的 socket 分支会把这个临时标签页变成绑定接口的样子
    tabs.markSaved(props.tab, data.api);
    showSaveDialog.value = false;
    await tree.refresh();
    message.success(t('socket.savedToFolder'));
  } catch (err) {
    message.error(err.message);
  } finally {
    saving.value = false;
  }
}

/* ---------------- 快捷键 ---------------- */

function onKeydown(event) {
  if (!(event.ctrlKey || event.metaKey)) return;
  if (String(event.key).toLowerCase() !== 's') return;
  event.preventDefault();

  if (!canEdit.value) {
    message.warning(t('socket.readonlyCannotSave'));
    return;
  }
  if (bound.value) save();
  else openSaveDialog();
}

onMounted(function () {
  window.addEventListener('keydown', onKeydown);
  socket.ensure(props.tab.key);
  syncDraftFromConfig();
});

onBeforeUnmount(function () {
  window.removeEventListener('keydown', onKeydown);
});

/**
 * 绑定了接口的标签页要跟着接口标签页一样标「未保存」；
 * 临时标签页也要 —— 这里配的东西不少（连接参数、常用发送），
 * 关掉前提示一句比默默丢掉强（和 MqttTab 的 touch() 一个口径）。
 */
watch(
  function () { return props.tab.spec; },
  function () { tabs.touch(props.tab); },
  { deep: true }
);
</script>

<template>
  <div class="socket-tab">
    <!-- 这个接口和云端对不上：顶部一条红提示 + 处理入口 -->
    <div v-if="conflicted" class="conflict-bar">
      <span class="conflict-text">{{ t('socket.conflictText') }}</span>
      <n-button size="tiny" type="error" ghost @click="openConflict">{{ t('socket.resolve') }}</n-button>
    </div>

    <!-- 面包屑：项目 › 目录… › 名字（最后一级双击改名） -->
    <div class="crumbs">
      <template v-for="(part, index) in crumbs" :key="index">
        <span v-if="index" class="sep">›</span>
        <span v-if="index < crumbs.length - 1" class="crumb">{{ part }}</span>
        <span v-else class="crumb last">
          <inline-rename :value="part" :editable="projects.canEdit" @commit="renameTitle" />
        </span>
      </template>
    </div>

    <div class="head">
      <span class="method" :style="{ color: methodColor(specMethod) }">{{ specMethod }}</span>

      <var-input
        class="url"
        :model-value="spec.url"
        :scope="scope"
        :placeholder="isUdp ? t('socket.urlPlaceholderUdp') : t('socket.urlPlaceholderTcp')"
        @update:model-value="(v) => { spec.url = v; }"
        @enter="onConnect"
      />

      <n-tag size="small" :bordered="false" :type="statusType">{{ statusText }}</n-tag>
      <span v-if="channelHint" class="channel-hint">{{ channelHint }}</span>

      <!-- UDP 是本机绑端口，不是「连」到一个对端，所以说法不一样 -->
      <n-button v-if="connected" size="small" type="warning" secondary @click="onDisconnect">
        {{ isUdp ? t('socket.close') : t('socket.disconnect') }}
      </n-button>
      <!-- 网页版没有 /socket：灰掉并说明原因（禁用的按钮不派发鼠标事件，提示挂在外层 span 上） -->
      <n-tooltip v-else-if="connectBlocked" trigger="hover">
        <template #trigger>
          <span class="connect-wrap">
            <n-button size="small" type="primary" disabled>
              {{ isUdp ? t('socket.open') : t('socket.connect') }}
            </n-button>
          </span>
        </template>
        {{ t('socket.connectBlocked') }}
      </n-tooltip>
      <n-button v-else size="small" type="primary" :loading="busy" @click="onConnect">
        {{ isUdp ? t('socket.open') : t('socket.connect') }}
      </n-button>

      <n-button v-if="canEdit && bound" size="small" :loading="saving" @click="save">
        {{ t('socket.save') }}
      </n-button>
      <n-button v-if="canEdit && !bound" size="small" @click="openSaveDialog">
        {{ t('socket.saveToFolder') }}
      </n-button>
    </div>

    <n-alert v-if="state && state.error" type="error" :show-icon="false" class="notice">
      {{ state.error }}
    </n-alert>

    <n-alert v-if="state && state.note" type="warning" :show-icon="false" class="notice">
      {{ state.note }}
    </n-alert>

    <div class="panes">
      <n-tabs
        v-model:value="activePane"
        type="line"
        size="small"
        animated
        :theme-overrides="paneTabsTheme"
      >
        <!-- 连接 -->
        <n-tab-pane name="connect" :tab="t('socket.tabConnect')">
          <div class="pane">
            <!-- TCP 才有的几项 -->
            <div v-if="!isUdp" class="grid">
              <div class="field">
                <span class="label">{{ t('socket.connectTimeoutLabel') }}</span>
                <n-input-number
                  size="small"
                  :value="socketCfg.connectTimeoutMs"
                  :min="1000"
                  :max="60000"
                  :step="1000"
                  placeholder="10000"
                  @update:value="(v) => { socketCfg.connectTimeoutMs = v === null ? 10000 : v; touch(); }"
                />
              </div>

              <div class="field">
                <span class="label">{{ t('socket.tlsLabel') }}</span>
                <div class="inline">
                  <n-switch size="small" :value="tlsOn" @update:value="setTls" />
                  <span class="hint">{{ t('socket.tlsHint') }}</span>
                </div>
              </div>

              <div class="field">
                <span class="label">{{ t('socket.tlsInsecureLabel') }}</span>
                <div class="inline">
                  <n-switch
                    size="small"
                    :value="socketCfg.tlsInsecure === true"
                    @update:value="(v) => { socketCfg.tlsInsecure = v; touch(); }"
                  />
                  <span class="hint">{{ t('socket.tlsInsecureHint') }}</span>
                </div>
              </div>

              <div class="field">
                <span class="label">{{ t('socket.framingLabel') }}</span>
                <n-select
                  size="small"
                  :value="(socketCfg.framing || {}).type || 'none'"
                  :options="FRAMING_OPTIONS"
                  @update:value="(v) => { socketCfg.framing = Object.assign({}, socketCfg.framing, { type: v }); touch(); }"
                />
              </div>
            </div>

            <p v-if="!isUdp" class="hint">{{ t('socket.framingHint') }}</p>

            <!-- 分隔符分帧 -->
            <div v-if="!isUdp && (socketCfg.framing || {}).type === 'delimiter'" class="grid">
              <div class="field wide">
                <span class="label">{{ t('socket.delimiterLabel') }}</span>
                <div class="inline">
                  <n-input
                    class="delimiter"
                    size="small"
                    :value="(socketCfg.framing || {}).delimiter"
                    :placeholder="t('socket.delimiterPlaceholder')"
                    @update:value="(v) => { socketCfg.framing = Object.assign({}, socketCfg.framing, { delimiter: v }); touch(); }"
                  />
                  <n-button
                    size="small"
                    @click="socketCfg.framing = Object.assign({}, socketCfg.framing, { delimiter: '\\n' }); touch();"
                  >
                    {{ t('socket.delimiterLf') }}
                  </n-button>
                  <n-button
                    size="small"
                    @click="socketCfg.framing = Object.assign({}, socketCfg.framing, { delimiter: '\\r\\n' }); touch();"
                  >
                    {{ t('socket.delimiterCrlf') }}
                  </n-button>
                </div>
              </div>
            </div>

            <!-- 长度前缀分帧 -->
            <div v-if="!isUdp && (socketCfg.framing || {}).type === 'length'" class="grid">
              <div class="field">
                <span class="label">{{ t('socket.lengthBytesLabel') }}</span>
                <n-select
                  size="small"
                  :value="(socketCfg.framing || {}).lengthBytes"
                  :options="LENGTH_OPTIONS"
                  @update:value="(v) => { socketCfg.framing = Object.assign({}, socketCfg.framing, { lengthBytes: v }); touch(); }"
                />
              </div>
              <div class="field">
                <span class="label">{{ t('socket.endianLabel') }}</span>
                <n-select
                  size="small"
                  :value="(socketCfg.framing || {}).endian"
                  :options="ENDIAN_OPTIONS"
                  @update:value="(v) => { socketCfg.framing = Object.assign({}, socketCfg.framing, { endian: v }); touch(); }"
                />
              </div>
            </div>

            <!-- UDP 才有的几项 -->
            <div v-if="isUdp" class="grid">
              <div class="field">
                <span class="label">{{ t('socket.bindPortLabel') }}</span>
                <n-input-number
                  size="small"
                  :value="socketCfg.udp ? socketCfg.udp.bindPort : null"
                  :min="1"
                  :max="65535"
                  :placeholder="t('socket.bindPortPlaceholder')"
                  clearable
                  @update:value="(v) => { socketCfg.udp = Object.assign({}, socketCfg.udp, { bindPort: v === null ? null : v }); touch(); }"
                />
              </div>

              <div class="field">
                <span class="label">{{ t('socket.broadcastLabel') }}</span>
                <div class="inline">
                  <n-switch
                    size="small"
                    :value="Boolean(socketCfg.udp && socketCfg.udp.broadcast)"
                    @update:value="(v) => { socketCfg.udp = Object.assign({}, socketCfg.udp, { broadcast: v }); touch(); }"
                  />
                  <span class="hint">{{ t('socket.broadcastHint') }}</span>
                </div>
              </div>
            </div>

            <p v-if="isUdp" class="hint">{{ t('socket.bindPortHint') }}</p>
          </div>
        </n-tab-pane>

        <!-- 发送 -->
        <n-tab-pane name="send" :tab="t('socket.send')">
          <div class="pane">
            <div class="send-row">
              <span class="send-label">{{ t('socket.sendFormatLabel') }}</span>
              <n-select
                class="send-format"
                size="small"
                :value="draftEncoding"
                :options="ENCODING_OPTIONS"
                @update:value="(v) => { draftEncoding = v; }"
              />

              <template v-if="draftEncoding === 'text'">
                <span class="send-label">{{ t('socket.lineEndingLabel') }}</span>
                <n-select
                  class="send-ending"
                  size="small"
                  :value="draftLineEnding"
                  :options="LINE_ENDING_OPTIONS"
                  @update:value="(v) => { draftLineEnding = v; }"
                />
              </template>

              <n-button
                size="small"
                type="primary"
                :disabled="!connected"
                @click="sendNow"
              >
                {{ t('socket.send') }}
              </n-button>

              <n-select
                class="send-saved"
                size="small"
                clearable
                :value="savedPick"
                :options="savedOptions"
                :placeholder="saved.length ? t('socket.savedPlaceholder') : t('socket.noSaved')"
                :disabled="!saved.length"
                @update:value="useSaved"
              />
              <n-button size="small" @click="openSaveCommon">{{ t('socket.saveAsCommon') }}</n-button>
              <n-button
                v-if="savedPick !== null"
                size="small"
                quaternary
                type="error"
                @click="removeSaved(savedPick)"
              >
                {{ t('socket.deleteThis') }}
              </n-button>
            </div>

            <!-- UDP 可以临时发到别的地址上（一个 socket 收多个对端的数据很常见） -->
            <div v-if="isUdp" class="send-row">
              <span class="send-label">{{ t('socket.sendToLabel') }}</span>
              <n-input
                class="send-to"
                size="small"
                :value="draftTo"
                :placeholder="t('socket.sendToPlaceholder')"
                @update:value="(v) => { draftTo = v; }"
              />
            </div>

            <p class="hint">{{ t('socket.payloadHint') }}</p>

            <n-input
              class="payload"
              type="textarea"
              :value="draft"
              :autosize="{ minRows: 6, maxRows: 18 }"
              :placeholder="draftEncoding === 'hex' ? 'AA 01 00 FF' : ''"
              @update:value="(v) => { draft = v; }"
              @keydown="onPayloadKeydown"
            />
          </div>
        </n-tab-pane>
      </n-tabs>
    </div>

    <div class="log">
      <socket-data-log
        :events="(state && state.events) || []"
        :dropped="(state && state.dropped) || 0"
        :method="specMethod"
        @clear="onClearLog"
      />
    </div>

    <n-modal
      v-model:show="showSaveDialog"
      preset="card"
      :title="t('socket.saveToFolder')"
      style="width: 460px; max-width: 92vw"
    >
      <div class="dialog-form">
        <span class="label">{{ t('socket.nameLabel') }}</span>
        <n-input v-model:value="saveForm.name" size="small" :placeholder="t('socket.apiNamePlaceholder')" />
        <span class="label">{{ t('socket.folderLabel') }}</span>
        <n-select v-model:value="saveForm.folderId" size="small" :options="folderOptions()" />
      </div>
      <template #footer>
        <div class="dialog-footer">
          <n-button size="small" @click="showSaveDialog = false">{{ t('app.cancel') }}</n-button>
          <n-button size="small" type="primary" :loading="saving" @click="confirmSaveToFolder">
            {{ t('socket.save') }}
          </n-button>
        </div>
      </template>
    </n-modal>

    <n-modal
      v-model:show="showCommonDialog"
      preset="card"
      :title="t('socket.saveCommonTitle')"
      style="width: 420px; max-width: 92vw"
    >
      <div class="dialog-form">
        <span class="label">{{ t('socket.commonNameLabel') }}</span>
        <n-input
          v-model:value="commonForm.name"
          size="small"
          :placeholder="t('socket.commonNamePlaceholder')"
        />
      </div>
      <template #footer>
        <div class="dialog-footer">
          <n-button size="small" @click="showCommonDialog = false">{{ t('app.cancel') }}</n-button>
          <n-button size="small" type="primary" @click="confirmSaveCommon">
            {{ t('socket.save') }}
          </n-button>
        </div>
      </template>
    </n-modal>
  </div>
</template>

<style scoped>
.socket-tab {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.conflict-bar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 12px;
  background: rgba(208, 48, 80, 0.1);
}

.conflict-text {
  font-size: 12px;
}

.crumbs {
  flex: none;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 12px 0;
  font-size: 12px;
  opacity: 0.75;
}

.sep {
  opacity: 0.5;
}

.crumb.last {
  opacity: 1;
}

.head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
}

.head .method {
  flex: none;
  width: 44px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.2px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.head .url {
  flex: 1;
  min-width: 0;
}

/* 禁用的按钮不派发鼠标事件，提示要挂在外面的 span 上 */
.connect-wrap {
  display: inline-flex;
  flex: none;
}

.channel-hint {
  font-size: 12px;
  color: #d97706;
}

.notice {
  flex: none;
  margin: 0 12px 6px;
  font-size: 12px;
}

.panes {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 0 12px;
  overflow: auto;
}

.pane {
  padding: 10px 2px 4px;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 12px 16px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.field.wide {
  grid-column: 1 / -1;
}

.label {
  font-size: 12px;
  opacity: 0.7;
}

.hint {
  margin: 6px 0 0;
  font-size: 12px;
  opacity: 0.55;
}

.inline {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.inline .hint {
  margin: 0;
}

.delimiter {
  max-width: 180px;
}

.send-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}

.send-label {
  font-size: 12px;
  opacity: 0.7;
}

.send-format {
  width: 120px;
}

.send-ending {
  width: 110px;
}

.send-saved {
  width: 180px;
}

.send-to {
  flex: 1;
  min-width: 220px;
}

.payload :deep(.n-input__textarea-el),
.payload {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.log {
  flex: 1;
  min-height: 220px;
  padding: 0 12px 12px;
  display: flex;
  flex-direction: column;
}

.dialog-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
