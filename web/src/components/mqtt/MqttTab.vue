<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  NAlert,
  NButton,
  NIcon,
  NInput,
  NInputNumber,
  NModal,
  NSelect,
  NSpace,
  NSwitch,
  NTabPane,
  NTabs,
  NTag,
  NTooltip,
  useMessage
} from 'naive-ui';
import { ChevronDown, ChevronRight } from '@vicons/tabler';
import { useProjectStore } from '@/stores/project';
import { useEnvStore } from '@/stores/env';
import { useMqttStore } from '@/stores/mqtt';
import { useTabsStore, emptyMqttSpec } from '@/stores/tabs';
import { useTreeStore } from '@/stores/tree';
import { useUiStore } from '@/stores/ui';
import { useGatewayStore } from '@/stores/gateway';
import * as apisApi from '@/api/apis';
import VarInput from '@/components/common/VarInput.vue';
import InlineRename from '@/components/common/InlineRename.vue';
import CodeEditor from '@/components/common/CodeEditor.vue';
import MqttMessageLog from './MqttMessageLog.vue';
import { folderChain } from '@/utils/tree';
import { resolveScope } from '@/utils/variables';
import { usePaneTabsTheme } from '@/utils/paneTabs';

/**
 * MQTT 标签页（第十三轮第 4 节）。两种形态共用这一个组件：
 * - **临时**（`apiId` 为空）：就是个调试窗口，不进目录树；想留下来点「保存到目录」；
 * - **绑定接口**（`apiId` 有值）：接口在目录树里，这里改的连接参数和常用发布可以保存回接口。
 *
 * 真正的连接由服务端建立（`lib/mqtt-sessions.js`），会话状态放在 `stores/mqtt.js` 里 ——
 * 组件会随着切换标签页被卸载重建，状态放这里等于一切走就断线。
 *
 * 请求形状和 WebSocket / Socket.IO 不一样的地方：**MQTT 没有请求头 / query / 鉴权**那一套，
 * 地址就是 broker（`mqtt://` / `mqtts://` / `ws://` / `wss://`），其余全在 `spec.mqtt` 里
 * （和 `apis.extra.mqtt` 同一份形状，见 `lib/api/dto.js` 的 `toApiMqtt`）。
 */
const props = defineProps({
  tab: { type: Object, required: true }
});

const projects = useProjectStore();
const envs = useEnvStore();
const mqtt = useMqttStore();
const tabs = useTabsStore();
const tree = useTreeStore();
const ui = useUiStore();
const gateway = useGatewayStore();
const message = useMessage();
const paneTabsTheme = usePaneTabsTheme();
const { t } = useI18n();

/** 这个接口和云端对不上：顶部一条红提示 + 「处理」入口（和 WsTab 那条一致） */
const conflicted = computed(function () {
  return Boolean(props.tab.apiId) && gateway.isConflicted('api', props.tab.apiId);
});

function openConflict() {
  if (!props.tab.apiId) return;
  ui.openConflict('api', props.tab.apiId);
}

const activePane = ref('connect');
const saving = ref(false);

/** 遗嘱消息那一块折叠着没有 */
const willOpen = ref(false);

const showSaveDialog = ref(false);
const saveForm = ref({ name: '', folderId: null });

/* ---------------- 会话状态 ---------------- */

const state = computed(function () {
  return mqtt.stateOf(props.tab.key) || null;
});

const spec = computed(function () {
  return props.tab.spec;
});

/** 没配过 mqtt 时给一份默认（老接口 / 新建的空标签页都可能没有） */
const mqttCfg = computed(function () {
  if (!spec.value.mqtt) spec.value.mqtt = emptyMqttSpec().mqtt;
  return spec.value.mqtt;
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
    idle: t('mqtt.statusIdle'),
    connecting: t('mqtt.statusConnecting'),
    open: t('mqtt.statusOpen'),
    reconnecting: t('mqtt.statusReconnecting'),
    closed: t('mqtt.statusClosed'),
    error: t('mqtt.statusError'),
    ended: t('mqtt.statusEnded')
  };
});

/**
 * 状态标签的配色：**只给需要人管的那几档上色**，已断开 / 未连接保持中性 ——
 * 一个常驻的灰标签不该抢眼（和 WsTab 的 STATUS_TYPE 一个口径）。
 */
const STATUS_TYPE = {
  open: 'success',
  connecting: 'info',
  reconnecting: 'warning',
  error: 'error',
  ended: 'error'
};

const statusText = computed(function () {
  return STATUS_TEXT.value[status.value] || status.value;
});

const statusType = computed(function () {
  return STATUS_TYPE[status.value] || 'default';
});

/** events 长连接自己的状态：和 socket 状态分开显示（同 WsTab） */
const channelHint = computed(function () {
  const current = state.value;
  if (!current) return '';
  if (current.channel === 'retrying') return t('mqtt.channelRetrying');
  if (current.channel === 'ended') return t('mqtt.channelEnded');
  return '';
});

/**
 * MQTT 的「连接」在网页版要灰掉 —— 这条**只在客户端里才有**。
 *
 * 判断用 `isGateway`，**不是** `cloudSendBlocked`：MQTT 的路由只挂在本机网关上
 * （`lib/api/mqtt.js` 在 `ctx.localSend` 为假时直接返回空 router），云端不管
 * `SERVER_SEND` 开没开都没有 `/mqtt` —— 用 cloudSendBlocked 的话，管理员一开
 * SERVER_SEND=1 按钮就亮了，点下去是 404。和 GrpcTab 的 `isGateway` 一个口径。
 *
 * 地址栏回车（var-input 的 @enter）也会走到 onConnect，那里再兜一次。
 */
const connectBlocked = computed(function () {
  return !gateway.isGateway;
});

/** 变量作用域：broker 地址、主题、发布内容里的 `{{变量}}` 都用它高亮 */
const scope = computed(function () {
  return resolveScope({
    project: projects.current,
    folders: tree.folders,
    folderId: props.tab.folderId,
    environment: envs.selected
  });
});

/* ---------------- 选项表 ---------------- */

const PROTOCOL_OPTIONS = [
  { label: '3.1', value: 3 },
  { label: '3.1.1', value: 4 },
  { label: '5', value: 5 }
];

const QOS_OPTIONS = [
  { label: '0', value: 0 },
  { label: '1', value: 1 },
  { label: '2', value: 2 }
];

const QOS_OPTIONS_LONG = computed(function () {
  return [
    { label: t('mqtt.qos0'), value: 0 },
    { label: t('mqtt.qos1'), value: 1 },
    { label: t('mqtt.qos2'), value: 2 }
  ];
});

const PAYLOAD_LANGS = computed(function () {
  return [
    { label: t('mqtt.payloadJson'), value: 'json' },
    { label: t('mqtt.payloadText'), value: 'text' }
  ];
});

/**
 * 模板里**不能直接写 `{{变量}}`** —— Vue 会把它当成插值（一个叫「变量」的绑定），
 * 轻则渲染成空、重则报错。这种带花括号的示例文案一律放脚本里。
 */
const VAR_HINT = computed(function () { return t('mqtt.varHint'); });

/* ---------------- 改了就标未保存 ---------------- */

function touch() {
  tabs.touch(props.tab);
}

/** 客户端 ID 随机一个：broker 靠它认客户端，同一个重复了会把别人顶掉 */
function randomClientId() {
  mqttCfg.value.clientId = 'apiloop-' + Math.random().toString(36).slice(2, 10);
  touch();
}

/* ---------------- 连接 ---------------- */

const URL_SCHEMES = /^(mqtt|mqtts|ws|wss):\/\//i;

function connectPayload() {
  const cfg = mqttCfg.value;
  return {
    projectId: projects.currentId,
    apiId: props.tab.apiId || undefined,
    environmentId: envs.selectedId || undefined,
    url: String(spec.value.url || '').trim(),
    clientId: cfg.clientId,
    username: cfg.username,
    password: cfg.password,
    protocolVersion: cfg.protocolVersion,
    clean: cfg.clean !== false,
    keepalive: cfg.keepalive,
    connectTimeoutMs: cfg.connectTimeoutMs,
    will: cfg.will,
    subscriptions: (cfg.subscriptions || []).map(function (row) {
      return { topic: row.topic, qos: row.qos, enabled: row.enabled !== false };
    })
  };
}

async function onConnect() {
  // 网页版没有 /mqtt（只在客户端里有）：按钮已经灰了，但地址栏回车也会走到这里，兜一次
  if (connectBlocked.value) {
    message.warning(t('mqtt.connectBlocked'));
    return;
  }
  // 连接中再点一次会建出两个会话，前一个就漏在服务端了
  if (busy.value) return;

  const url = String(spec.value.url || '').trim();
  if (!url) {
    message.warning(t('mqtt.brokerRequired'));
    return;
  }
  // 地址以 {{变量}} 开头时本机判不了，交给服务端在变量替换之后再判，它返回的是同一个中文错误
  if (url.indexOf('{{') !== 0 && !URL_SCHEMES.test(url)) {
    message.warning(t('mqtt.schemeRequired'));
    return;
  }
  if (!projects.currentId) {
    message.warning(t('mqtt.noProject'));
    return;
  }
  if (mqttCfg.value.clean === false && !String(mqttCfg.value.clientId || '').trim()) {
    message.warning(t('mqtt.clientIdRequired'));
    return;
  }

  spec.value.url = url;
  const ok = await mqtt.connect(props.tab.key, connectPayload());
  if (!ok) {
    const current = state.value;
    message.error((current && current.error) || t('mqtt.connectFailed'));
  }
}

function onDisconnect() {
  mqtt.disconnect(props.tab.key);
}

function onClearLog() {
  mqtt.clearLog(props.tab.key);
}

/* ---------------- 订阅 ---------------- */

const subscriptions = computed(function () {
  return mqttCfg.value.subscriptions || [];
});

function addSubscription() {
  const list = (mqttCfg.value.subscriptions || []).slice();
  list.push({ topic: '', qos: 0, enabled: true });
  mqttCfg.value.subscriptions = list;
  touch();
}

function removeSubscription(index) {
  const list = (mqttCfg.value.subscriptions || []).slice();
  list.splice(index, 1);
  mqttCfg.value.subscriptions = list;
  touch();
}

function updateSubscription(index, patch) {
  const list = (mqttCfg.value.subscriptions || []).slice();
  list[index] = Object.assign({}, list[index], patch);
  mqttCfg.value.subscriptions = list;
  touch();
}

/**
 * 服务端记的订阅结果里，主题是**替换过变量之后**的那一份，而配置行里可能是
 * `devices/{{id}}/status`。这里按作用域把普通变量替换一遍再去找 —— 换不出来的
 * （`{{$guid}}` 这种动态变量）就按原样找，找不到时状态显示「—」。
 */
const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;

function resolvedTopic(topic) {
  return String(topic || '').replace(PLACEHOLDER, function (whole, name) {
    const hit = scope.value.get(String(name).trim());
    return hit ? hit.value : whole;
  });
}

/**
 * 这一行的订阅状态：`{ granted, error }`，没有就是还没订过。
 *
 * **只在连着的会话里算数**：断开之后服务端那边的订阅已经不作数了（重连时会重新自动订阅
 * 一轮），界面上还挂着「已订阅」会让人以为现在还能收消息。
 */
function subState(row) {
  const current = state.value;
  if (!current) return null;
  if (current.status !== 'open' && current.status !== 'reconnecting') return null;

  const topic = String(row.topic || '').trim();
  if (!topic) return null;
  return current.subs[topic] || current.subs[resolvedTopic(topic)] || null;
}

function subStatusText(row) {
  const hit = subState(row);
  if (!hit) return '—';
  if (hit.error) return t('mqtt.subRejected');
  return t('mqtt.subSubscribed');
}

function subStatusType(row) {
  const hit = subState(row);
  if (!hit) return 'default';
  return hit.error ? 'error' : 'default';
}

function subStatusHint(row) {
  const hit = subState(row);
  if (!hit) return t('mqtt.subNever');
  if (hit.error) return hit.error;
  if (hit.granted === null || hit.granted === undefined) return t('mqtt.subAccepted');
  return t('mqtt.subGranted', { qos: hit.granted });
}

function isSubscribed(row) {
  const hit = subState(row);
  return Boolean(hit && !hit.error);
}

async function subscribeRow(row) {
  const topic = String(row.topic || '').trim();
  if (!topic) {
    message.warning(t('mqtt.topicRequired'));
    return;
  }
  const ok = await mqtt.subscribe(props.tab.key, { topic: topic, qos: row.qos });
  if (!ok) {
    const current = state.value;
    message.error((current && current.error) || t('mqtt.subscribeFailed'));
  }
}

async function unsubscribeRow(row) {
  const topic = String(row.topic || '').trim();
  if (!topic) return;
  const ok = await mqtt.unsubscribe(props.tab.key, topic);
  if (!ok) {
    const current = state.value;
    message.error((current && current.error) || t('mqtt.unsubscribeFailed'));
  }
}

/* ---------------- 发布 ---------------- */

const draftTopic = ref('');
const draftPayload = ref('');
const draftQos = ref(0);
const draftRetain = ref(false);
const draftLang = ref('json');
const savedPick = ref(null);

const saved = computed(function () {
  return mqttCfg.value.saved || [];
});

const savedOptions = computed(function () {
  return saved.value.map(function (item, index) {
    return { label: item.name, value: index };
  });
});

/**
 * 选了常用发布就填进草稿。
 *
 * `savedPick` **不重置**：它同时是「删除这条」按钮的锚点。同一个再选一次不会重新触发
 * `@update:value`，但草稿早就填好了，不影响用。
 */
function useSaved(index) {
  const item = saved.value[index];
  if (!item) return;
  savedPick.value = index;
  draftTopic.value = item.topic || '';
  draftPayload.value = item.payload || '';
  draftQos.value = item.qos || 0;
  draftRetain.value = item.retain === true;
}

const showCommonDialog = ref(false);
const commonForm = ref({ name: '' });

function openSaveCommon() {
  const topic = String(draftTopic.value || '').trim();
  if (!topic) {
    message.warning(t('mqtt.publishTopicRequired'));
    return;
  }
  commonForm.value = { name: topic };
  showCommonDialog.value = true;
}

async function confirmSaveCommon() {
  const name = String(commonForm.value.name || '').trim();
  if (!name) {
    message.warning(t('mqtt.commonNameRequired'));
    return;
  }

  const list = (mqttCfg.value.saved || []).slice();
  list.push({
    name: name,
    topic: String(draftTopic.value || '').trim(),
    payload: draftPayload.value,
    qos: draftQos.value,
    retain: draftRetain.value === true
  });
  mqttCfg.value.saved = list;
  touch();
  showCommonDialog.value = false;

  if (props.tab.apiId) {
    try {
      const api = await persist();
      // 存回接口了就把快照对齐，别在标签页上留一个假的「未保存」圆点
      if (api) tabs.markSaved(props.tab, api);
      message.success(t('mqtt.commonSaved'));
    } catch (err) {
      message.error(err.message);
    }
  }
}

async function removeSaved(index) {
  const list = (mqttCfg.value.saved || []).slice();
  if (index < 0 || index >= list.length) return;
  list.splice(index, 1);
  mqttCfg.value.saved = list;
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

async function publishNow() {
  const topic = String(draftTopic.value || '').trim();
  if (!connected.value) {
    message.warning(t('mqtt.notConnected'));
    return;
  }
  if (!topic) {
    message.warning(t('mqtt.publishTopicRequired'));
    return;
  }
  if (topic.indexOf('+') > -1 || topic.indexOf('#') > -1) {
    message.warning(t('mqtt.publishWildcard'));
    return;
  }

  const ok = await mqtt.publish(props.tab.key, {
    topic: topic,
    payload: draftPayload.value,
    qos: draftQos.value,
    retain: draftRetain.value === true
  });
  if (!ok) {
    const current = state.value;
    message.error((current && current.error) || t('mqtt.publishFailed'));
  }
}

/* ---------------- 保存（绑定了接口才有） ---------------- */

async function persist() {
  if (!props.tab.apiId) return null;
  const data = await apisApi.updateApi(props.tab.apiId, {
    url: spec.value.url,
    mqtt: spec.value.mqtt
  });
  return data.api;
}

async function save() {
  if (!props.tab.apiId) return;

  saving.value = true;
  try {
    const api = await persist();
    if (api) tabs.markSaved(props.tab, api);
    message.success(t('mqtt.saved'));
  } catch (err) {
    message.error(err.message);
  } finally {
    saving.value = false;
  }
}

/* ---------------- 保存到目录（临时标签页） ---------------- */

function folderOptions() {
  const list = [{ label: t('mqtt.rootFolder'), value: null }];
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
  list.push(props.tab.title || 'MQTT');
  return list;
});

/**
 * 面包屑上双击改名（和 WsTab 的 renameTitle 一样）：
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
    message.success(t('mqtt.renamed'));
  } catch (err) {
    message.error(err.message);
  }
}

/** 标签页标题用地址的主机名，光写「MQTT」的话几个标签页分不出来 */
function titleFromUrl(url) {
  const text = String(url || '').replace(/^(mqtt|mqtts|ws|wss):\/\//i, '').split('/')[0];
  return text || 'MQTT';
}

function openSaveDialog() {
  saveForm.value = {
    name: props.tab.customTitle
      ? props.tab.title
      : (props.tab.spec.url ? titleFromUrl(props.tab.spec.url) : 'MQTT'),
    folderId: null
  };
  showSaveDialog.value = true;
}

async function confirmSaveToFolder() {
  if (!String(saveForm.value.name || '').trim()) {
    message.warning(t('mqtt.apiNameRequired'));
    return;
  }

  saving.value = true;
  try {
    const data = await apisApi.createApi(projects.currentId, {
      method: 'MQTT',
      name: String(saveForm.value.name).trim(),
      folderId: saveForm.value.folderId,
      url: props.tab.spec.url,
      mqtt: props.tab.spec.mqtt
    });
    // markSaved 的 MQTT 分支会把这个临时标签页变成绑定接口的样子
    tabs.markSaved(props.tab, data.api);
    showSaveDialog.value = false;
    await tree.refresh();
    message.success(t('mqtt.savedToFolder'));
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
    message.warning(t('mqtt.readonlyCannotSave'));
    return;
  }
  if (bound.value) save();
  else openSaveDialog();
}

onMounted(function () {
  window.addEventListener('keydown', onKeydown);
  mqtt.ensure(props.tab.key);
  // 已经配了遗嘱就展开那一块，不然用户看不出它设过
  if (mqttCfg.value.will && String(mqttCfg.value.will.topic || '').trim()) willOpen.value = true;
});

onBeforeUnmount(function () {
  window.removeEventListener('keydown', onKeydown);
});

/**
 * 绑定了接口的标签页要跟着接口标签页一样标「未保存」；
 * 临时标签页也要 —— 这里配的东西比 WebSocket 多（凭据、订阅、常用发布），
 * 关掉前提示一句比默默丢掉强（和 SioTab 的 touch() 一个口径）。
 */
watch(
  function () { return props.tab.spec; },
  function () { tabs.touch(props.tab); },
  { deep: true }
);
</script>

<template>
  <div class="mqtt-tab">
    <!-- 这个接口和云端对不上：顶部一条红提示 + 处理入口 -->
    <div v-if="conflicted" class="conflict-bar">
      <span class="conflict-text">{{ t('mqtt.conflictText') }}</span>
      <n-button size="tiny" type="error" ghost @click="openConflict">{{ t('mqtt.resolve') }}</n-button>
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
      <var-input
        class="url"
        :model-value="spec.url"
        :scope="scope"
        :placeholder="t('mqtt.urlPlaceholder')"
        @update:model-value="(v) => { spec.url = v; }"
        @enter="onConnect"
      />

      <n-tag size="small" :bordered="false" :type="statusType">{{ statusText }}</n-tag>
      <span v-if="channelHint" class="channel-hint">{{ channelHint }}</span>

      <n-button v-if="connected" size="small" type="warning" secondary @click="onDisconnect">
        {{ t('mqtt.disconnect') }}
      </n-button>
      <!-- 网页版没有 /mqtt：灰掉并说明原因（禁用的按钮不派发鼠标事件，提示挂在外层 span 上） -->
      <n-tooltip v-else-if="connectBlocked" trigger="hover">
        <template #trigger>
          <span class="connect-wrap">
            <n-button size="small" type="primary" disabled>{{ t('mqtt.connect') }}</n-button>
          </span>
        </template>
        {{ t('mqtt.connectBlocked') }}
      </n-tooltip>
      <n-button v-else size="small" type="primary" :loading="busy" @click="onConnect">
        {{ t('mqtt.connect') }}
      </n-button>

      <n-button v-if="canEdit && bound" size="small" :loading="saving" @click="save">
        {{ t('mqtt.save') }}
      </n-button>
      <n-button v-if="canEdit && !bound" size="small" @click="openSaveDialog">
        {{ t('mqtt.saveToFolder') }}
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
        <n-tab-pane name="connect" :tab="t('mqtt.tabConnect')">
          <div class="pane">
            <div class="grid">
              <div class="field">
                <span class="label">{{ t('mqtt.clientIdLabel') }}</span>
                <div class="with-button">
                  <n-input
                    size="small"
                    :value="mqttCfg.clientId"
                    :placeholder="t('mqtt.clientIdPlaceholder')"
                    @update:value="(v) => { mqttCfg.clientId = v; touch(); }"
                  />
                  <n-button size="small" @click="randomClientId">{{ t('mqtt.random') }}</n-button>
                </div>
              </div>

              <div class="field">
                <span class="label">{{ t('mqtt.protocolVersion') }}</span>
                <n-select
                  size="small"
                  :value="mqttCfg.protocolVersion"
                  :options="PROTOCOL_OPTIONS"
                  @update:value="(v) => { mqttCfg.protocolVersion = v; touch(); }"
                />
              </div>

              <div class="field">
                <span class="label">{{ t('mqtt.username') }}</span>
                <n-input
                  size="small"
                  :value="mqttCfg.username"
                  :placeholder="t('mqtt.supportVar')"
                  @update:value="(v) => { mqttCfg.username = v; touch(); }"
                />
              </div>

              <div class="field">
                <span class="label">{{ t('mqtt.password') }}</span>
                <n-input
                  size="small"
                  type="password"
                  show-password-on="click"
                  :value="mqttCfg.password"
                  :placeholder="t('mqtt.supportVar')"
                  @update:value="(v) => { mqttCfg.password = v; touch(); }"
                />
              </div>

              <div class="field">
                <span class="label">{{ t('mqtt.keepaliveLabel') }}</span>
                <n-input-number
                  size="small"
                  :value="mqttCfg.keepalive"
                  :min="0"
                  :max="65535"
                  placeholder="60"
                  @update:value="(v) => { mqttCfg.keepalive = v === null ? 60 : v; touch(); }"
                />
              </div>

              <div class="field">
                <span class="label">{{ t('mqtt.connectTimeoutLabel') }}</span>
                <n-input-number
                  size="small"
                  :value="mqttCfg.connectTimeoutMs"
                  :min="1000"
                  :max="60000"
                  :step="1000"
                  placeholder="10000"
                  @update:value="(v) => { mqttCfg.connectTimeoutMs = v === null ? 10000 : v; touch(); }"
                />
              </div>

              <div class="field wide">
                <span class="label">clean session</span>
                <div class="inline">
                  <n-switch
                    size="small"
                    :value="mqttCfg.clean !== false"
                    @update:value="(v) => { mqttCfg.clean = v; touch(); }"
                  />
                  <span class="hint">
                    {{ t('mqtt.cleanSessionHint') }}
                  </span>
                </div>
              </div>
            </div>

            <!-- 遗嘱消息：可折叠，主题留空就是不设 -->
            <div class="fold-head" @click="willOpen = !willOpen">
              <n-icon size="14" :component="willOpen ? ChevronDown : ChevronRight" />
              <span class="fold-title">{{ t('mqtt.willTitle') }}</span>
              <span class="hint">
                {{ mqttCfg.will && mqttCfg.will.topic ? t('mqtt.willSet', { topic: mqttCfg.will.topic }) : t('mqtt.willEmptyHint') }}
              </span>
            </div>

            <div v-if="willOpen" class="grid">
              <div class="field wide">
                <span class="label">{{ t('mqtt.willTopicLabel') }}</span>
                <var-input
                  :model-value="mqttCfg.will ? mqttCfg.will.topic : ''"
                  :scope="scope"
                  :placeholder="t('mqtt.willTopicPlaceholder')"
                  @update:model-value="(v) => { mqttCfg.will = Object.assign({}, mqttCfg.will, { topic: v }); touch(); }"
                />
              </div>
              <div class="field wide">
                <span class="label">{{ t('mqtt.willPayloadLabel') }}</span>
                <n-input
                  size="small"
                  :value="mqttCfg.will ? mqttCfg.will.payload : ''"
                  :placeholder="t('mqtt.willPayloadPlaceholder')"
                  @update:value="(v) => { mqttCfg.will = Object.assign({}, mqttCfg.will, { payload: v }); touch(); }"
                />
              </div>
              <div class="field">
                <span class="label">QoS</span>
                <n-select
                  size="small"
                  :value="mqttCfg.will ? mqttCfg.will.qos : 0"
                  :options="QOS_OPTIONS_LONG"
                  @update:value="(v) => { mqttCfg.will = Object.assign({}, mqttCfg.will, { qos: v }); touch(); }"
                />
              </div>
              <div class="field">
                <span class="label">retain</span>
                <div class="inline">
                  <n-switch
                    size="small"
                    :value="Boolean(mqttCfg.will && mqttCfg.will.retain)"
                    @update:value="(v) => { mqttCfg.will = Object.assign({}, mqttCfg.will, { retain: v }); touch(); }"
                  />
                </div>
              </div>
            </div>
          </div>
        </n-tab-pane>

        <!-- 订阅 -->
        <n-tab-pane name="subscribe" :tab="t('mqtt.tabSubscribe')">
          <div class="pane">
            <p class="hint">
              {{ t('mqtt.subHintLead') }}<strong>{{ t('mqtt.subHintStrong') }}</strong>{{ t('mqtt.subHintTail') }}
              <code>+</code>{{ t('mqtt.subHintAnd') }} <code>#</code>{{ t('mqtt.subHintEnd') }}
            </p>

            <div class="sub-head">
              <span class="col-topic">{{ t('mqtt.colTopic') }}</span>
              <span class="col-qos">QoS</span>
              <span class="col-enabled">{{ t('mqtt.colEnabled') }}</span>
              <span class="col-status">{{ t('mqtt.colStatus') }}</span>
              <span class="col-actions" />
            </div>

            <div v-for="(row, index) in subscriptions" :key="index" class="sub-row">
              <var-input
                class="col-topic"
                :model-value="row.topic"
                :scope="scope"
                placeholder="devices/+/status"
                @update:model-value="(v) => updateSubscription(index, { topic: v })"
              />
              <n-select
                class="col-qos"
                size="small"
                :value="row.qos"
                :options="QOS_OPTIONS"
                @update:value="(v) => updateSubscription(index, { qos: v })"
              />
              <span class="col-enabled">
                <n-switch
                  size="small"
                  :value="row.enabled !== false"
                  @update:value="(v) => updateSubscription(index, { enabled: v })"
                />
              </span>
              <span class="col-status">
                <n-tooltip trigger="hover">
                  <template #trigger>
                    <n-tag size="tiny" :bordered="false" :type="subStatusType(row)">
                      {{ subStatusText(row) }}
                    </n-tag>
                  </template>
                  {{ subStatusHint(row) }}
                </n-tooltip>
              </span>
              <span class="col-actions">
                <n-button
                  v-if="connected && isSubscribed(row)"
                  size="tiny"
                  @click="unsubscribeRow(row)"
                >
                  {{ t('mqtt.unsubscribe') }}
                </n-button>
                <n-button
                  v-else
                  size="tiny"
                  secondary
                  :disabled="!connected"
                  @click="subscribeRow(row)"
                >
                  {{ t('mqtt.subscribe') }}
                </n-button>
                <n-button size="tiny" quaternary type="error" @click="removeSubscription(index)">
                  {{ t('app.delete') }}
                </n-button>
              </span>            </div>

            <p v-if="!subscriptions.length" class="empty">{{ t('mqtt.emptySubs') }}</p>

            <n-button size="small" secondary class="add-sub" @click="addSubscription">
              {{ t('mqtt.addSubscription') }}
            </n-button>
          </div>
        </n-tab-pane>

        <!-- 发布 -->
        <n-tab-pane name="publish" :tab="t('mqtt.tabPublish')">
          <div class="pane">
            <div class="pub-row">
              <var-input
                class="pub-topic"
                :model-value="draftTopic"
                :scope="scope"
                placeholder="devices/1/cmd"
                @update:model-value="(v) => { draftTopic = v; }"
              />
              <n-select
                class="pub-qos"
                size="small"
                :value="draftQos"
                :options="QOS_OPTIONS_LONG"
                @update:value="(v) => { draftQos = v; }"
              />
              <span class="pub-retain">
                <n-switch size="small" :value="draftRetain" @update:value="(v) => { draftRetain = v; }" />
                <span class="hint">retain</span>
              </span>
            </div>

            <div class="pub-row">
              <n-select
                class="pub-lang"
                size="small"
                :value="draftLang"
                :options="PAYLOAD_LANGS"
                @update:value="(v) => { draftLang = v; }"
              />
              <n-button size="small" type="primary" :disabled="!connected" @click="publishNow">
                {{ t('mqtt.publish') }}
              </n-button>
              <n-select
                class="pub-saved"
                size="small"
                clearable
                :value="savedPick"
                :options="savedOptions"
                :placeholder="saved.length ? t('mqtt.savedPlaceholder') : t('mqtt.noSaved')"
                :disabled="!saved.length"
                @update:value="useSaved"
              />
              <n-button size="small" @click="openSaveCommon">{{ t('mqtt.saveAsCommon') }}</n-button>
              <n-button
                v-if="savedPick !== null"
                size="small"
                quaternary
                type="error"
                @click="removeSaved(savedPick)"
              >
                {{ t('mqtt.deleteThis') }}
              </n-button>
            </div>

            <p class="hint">
              {{ t('mqtt.publishHintLead') }} <code>+</code> {{ t('mqtt.publishHintOr') }} <code>#</code>{{ t('mqtt.publishHintTail') }}
              <code>{{ VAR_HINT }}</code>{{ t('mqtt.publishHintEnd') }}
            </p>

            <code-editor
              :model-value="draftPayload"
              :language="draftLang"
              min-height="180px"
              @update:model-value="(v) => { draftPayload = v; }"
              @format-error="(text) => message.error(text)"
            />
          </div>
        </n-tab-pane>
      </n-tabs>
    </div>

    <div class="log">
      <mqtt-message-log
        :events="(state && state.events) || []"
        :dropped="(state && state.dropped) || 0"
        @clear="onClearLog"
      />
    </div>

    <n-modal
      v-model:show="showSaveDialog"
      preset="card"
      :title="t('mqtt.saveToFolder')"
      style="width: 460px; max-width: 92vw"
    >
      <n-space vertical :size="12">
        <div class="field">
          <span class="label">{{ t('mqtt.nameLabel') }}</span>
          <n-input v-model:value="saveForm.name" size="small" :placeholder="t('mqtt.apiNamePlaceholder')" />
        </div>
        <div class="field">
          <span class="label">{{ t('mqtt.folderLabel') }}</span>
          <n-select v-model:value="saveForm.folderId" size="small" :options="folderOptions()" />
        </div>
      </n-space>

      <template #footer>
        <n-space justify="end">
          <n-button @click="showSaveDialog = false">{{ t('app.cancel') }}</n-button>
          <n-button type="primary" :loading="saving" @click="confirmSaveToFolder">{{ t('mqtt.save') }}</n-button>
        </n-space>
      </template>
    </n-modal>

    <n-modal
      v-model:show="showCommonDialog"
      preset="card"
      :title="t('mqtt.saveCommonTitle')"
      style="width: 420px; max-width: 92vw"
    >
      <div class="field">
        <span class="label">{{ t('mqtt.commonNameLabel') }}</span>
        <n-input v-model:value="commonForm.name" size="small" :placeholder="t('mqtt.commonNamePlaceholder')" />
      </div>

      <template #footer>
        <n-space justify="end">
          <n-button @click="showCommonDialog = false">{{ t('app.cancel') }}</n-button>
          <n-button type="primary" @click="confirmSaveCommon">{{ t('mqtt.save') }}</n-button>
        </n-space>
      </template>
    </n-modal>
  </div>
</template>

<style scoped>
.mqtt-tab {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 12px 16px;
  gap: 8px;
}

/* 冲突提示条：和普通接口标签页那条一致 */
.conflict-bar {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 5px 10px;
  border-radius: 5px;
  font-size: 12px;
  color: #b3160c;
  background: rgba(235, 32, 19, 0.1);
}

.conflict-text {
  font-weight: 600;
}

.crumbs {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 12px;
  overflow: hidden;
}

.crumb {
  flex: none;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.55;
}

.crumb.last {
  opacity: 1;
  font-weight: 600;
  max-width: 320px;
}

.sep {
  flex: none;
  opacity: 0.35;
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

/* 禁用的按钮不派发鼠标事件，提示要挂在外面的 span 上 */
.connect-wrap {
  display: inline-flex;
  flex: none;
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
  max-height: 44%;
  overflow: auto;
  border-bottom: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.16));
}

.panes :deep(.n-tabs-nav-scroll-content) {
  padding-left: 16px;
}

.pane {
  padding: 12px 16px;
}

.grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px 18px;
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
  font-weight: 600;
  opacity: 0.8;
}

.inline {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.with-button {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.with-button :deep(.n-input) {
  flex: 1;
  min-width: 0;
}

.hint {
  margin: 0;
  font-size: 12px;
  opacity: 0.6;
  line-height: 1.6;
}

.fold-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 14px 0 8px;
  cursor: pointer;
  font-size: 12px;
}

.fold-title {
  font-weight: 600;
}

/* 订阅表：固定列宽 + 主题列自适应，别让操作列把主题挤没了 */
.sub-head,
.sub-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.sub-head {
  margin-top: 10px;
  font-size: 12px;
  opacity: 0.6;
}

.sub-row {
  padding: 3px 0;
}

.col-topic {
  flex: 1;
  min-width: 0;
}

.col-qos {
  flex: none;
  width: 72px;
}

.col-enabled {
  flex: none;
  width: 46px;
  display: flex;
  justify-content: center;
}

.col-status {
  flex: none;
  width: 84px;
}

.col-actions {
  flex: none;
  width: 152px;
  display: flex;
  justify-content: flex-end;
  gap: 4px;
}

.add-sub {
  margin-top: 10px;
}

.pub-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.pub-topic {
  flex: 1;
  min-width: 0;
}

.pub-qos {
  flex: none;
  width: 140px;
}

.pub-retain {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
}

.pub-lang {
  flex: none;
  width: 110px;
}

.pub-saved {
  flex: none;
  width: 200px;
}

.empty {
  margin: 10px 0 0;
  font-size: 12px;
  opacity: 0.55;
}

.log {
  flex: 1;
  min-height: 0;
}

code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
</style>
