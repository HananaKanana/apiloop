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
import { useAmqpStore } from '@/stores/amqp';
import { useTabsStore, emptyAmqpSpec } from '@/stores/tabs';
import { useTreeStore } from '@/stores/tree';
import { useUiStore } from '@/stores/ui';
import { useGatewayStore } from '@/stores/gateway';
import * as apisApi from '@/api/apis';
import VarInput from '@/components/common/VarInput.vue';
import InlineRename from '@/components/common/InlineRename.vue';
import CodeEditor from '@/components/common/CodeEditor.vue';
import KeyValueTable from '@/components/common/KeyValueTable.vue';
import AmqpMessageLog from './AmqpMessageLog.vue';
import { folderChain } from '@/utils/tree';
import { resolveScope } from '@/utils/variables';
import { usePaneTabsTheme } from '@/utils/paneTabs';

/**
 * RabbitMQ 标签页（第十六轮 T41）。两种形态共用这一个组件：
 * - **临时**（`apiId` 为空）：就是个调试窗口，不进目录树；想留下来点「保存到目录」；
 * - **绑定接口**（`apiId` 有值）：接口在目录树里，这里改的连接参数、消费列表和常用发布可以保存回接口。
 *
 * 真正的连接由服务端建立（`lib/amqp-sessions.js`），会话状态放在 `stores/amqp.js` 里 ——
 * 组件会随着切换标签页被卸载重建，状态放这里等于一切走就断线。
 *
 * 和 MQTT 标签页的三处不同：
 * - MQTT 是「订阅主题」，这里是**起停 consumer**（`consume` / `cancel`），一个会话能同时开好几个；
 * - 手动确认的消息要在**消息列表**上回 ack / nack / reject（那一块在 AmqpMessageLog 里）；
 * - 发布走 confirm channel，另外多一个「查队列堆积」。
 *
 * 请求形状和 WebSocket / Socket.IO 不一样的地方：**RabbitMQ 没有请求头 / query / 鉴权**那一套，
 * 地址就是 broker（`amqp://` / `amqps://`），其余全在 `spec.amqp` 里
 * （和 `apis.extra.amqp` 同一份形状，见 `lib/api/dto.js` 的 `toApiAmqp`）。
 */
const props = defineProps({
  tab: { type: Object, required: true }
});

const projects = useProjectStore();
const envs = useEnvStore();
const amqp = useAmqpStore();
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

/** 属性那一块折叠着没有 */
const propsOpen = ref(false);

const showSaveDialog = ref(false);
const saveForm = ref({ name: '', folderId: null });

/* ---------------- 会话状态 ---------------- */

const state = computed(function () {
  return amqp.stateOf(props.tab.key) || null;
});

const spec = computed(function () {
  return props.tab.spec;
});

/** 没配过 amqp 时给一份默认（老接口 / 新建的空标签页都可能没有） */
const amqpCfg = computed(function () {
  if (!spec.value.amqp) spec.value.amqp = emptyAmqpSpec().amqp;
  return spec.value.amqp;
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
    idle: t('amqp.statusIdle'),
    connecting: t('amqp.statusConnecting'),
    open: t('amqp.statusOpen'),
    closed: t('amqp.statusClosed'),
    error: t('amqp.statusError'),
    ended: t('amqp.statusEnded')
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

/** events 长连接自己的状态：和连接状态分开显示（同 MqttTab） */
const channelHint = computed(function () {
  const current = state.value;
  if (!current) return '';
  if (current.channel === 'retrying') return t('amqp.channelRetrying');
  if (current.channel === 'ended') return t('amqp.channelEnded');
  return '';
});

/** 连上之后在状态标签旁边显示 broker 的版本（`connected.server` 就是 serverProperties） */
const brokerHint = computed(function () {
  const server = state.value && state.value.server;
  if (!server) return '';
  const name = server.product || 'RabbitMQ';
  const version = server.version || '';
  return t('amqp.brokerHint', { name: name, version: version });
});

/**
 * RabbitMQ 的「连接」在网页版要灰掉 —— 这条**只在客户端里才有**。
 *
 * 判断用 `isGateway`，**不是** `cloudSendBlocked`：这些路由只挂在本机网关上
 * （`lib/api/amqp.js` 在 `ctx.localSend` 为假时直接返回空 router），云端连路由都没有 ——
 * 用 cloudSendBlocked 的话，管理员一开 SERVER_SEND=1 按钮就亮了，点下去是 404。
 * 和 MqttTab / GrpcTab 一个口径。
 */
const connectBlocked = computed(function () {
  return !gateway.isGateway;
});

/** 变量作用域：broker 地址、队列名、发布内容里的 `{{变量}}` 都用它高亮 */
const scope = computed(function () {
  return resolveScope({
    project: projects.current,
    folders: tree.folders,
    folderId: props.tab.folderId,
    environment: envs.selected
  });
});

/**
 * 模板里**不能直接写 `{{变量}}`** —— Vue 会把它当成插值（一个叫「变量」的绑定），
 * 轻则渲染成空、重则报错。这种带花括号的示例文案一律放脚本里。
 */
const VAR_HINT = computed(function () { return t('amqp.varHint'); });

/* ---------------- 选项表 ---------------- */

const MODE_OPTIONS = computed(function () {
  return [
    { label: t('amqp.modeQueue'), value: 'queue' },
    { label: t('amqp.modeExchange'), value: 'exchange' }
  ];
});

const ACK_OPTIONS = computed(function () {
  return [
    { label: t('amqp.ackAuto'), value: 'auto' },
    { label: t('amqp.ackManual'), value: 'manual' }
  ];
});

const PAYLOAD_LANGS = computed(function () {
  return [
    { label: t('amqp.payloadJson'), value: 'json' },
    { label: t('amqp.payloadText'), value: 'text' }
  ];
});

/** 忽略证书错误只在地址是 amqps:// 时有意义；地址带 `{{变量}}` 时看不出协议头，就先不显示 */
const isTls = computed(function () {
  return /^amqps:\/\//i.test(String(spec.value.url || '').trim());
});

/* ---------------- 改了就标未保存 ---------------- */

function touch() {
  tabs.touch(props.tab);
}

/* ---------------- 连接 ---------------- */

const URL_SCHEMES = /^(amqp|amqps):\/\//i;

function connectPayload() {
  const cfg = amqpCfg.value;
  return {
    projectId: projects.currentId,
    apiId: props.tab.apiId || undefined,
    environmentId: envs.selectedId || undefined,
    url: String(spec.value.url || '').trim(),
    username: cfg.username,
    password: cfg.password,
    heartbeat: cfg.heartbeat,
    connectTimeoutMs: cfg.connectTimeoutMs,
    tlsInsecure: cfg.tlsInsecure === true,
    consumers: (cfg.consumers || []).map(function (row) {
      return {
        mode: row.mode === 'exchange' ? 'exchange' : 'queue',
        queue: row.queue,
        exchange: row.exchange,
        routingKey: row.routingKey,
        ack: row.ack === 'manual' ? 'manual' : 'auto',
        prefetch: row.prefetch,
        enabled: row.enabled !== false
      };
    })
  };
}

async function onConnect() {
  // 网页版没有 /amqp（只在客户端里有）：按钮已经灰了，但地址栏回车也会走到这里，兜一次
  if (connectBlocked.value) {
    message.warning(t('amqp.connectBlocked'));
    return;
  }
  // 连接中再点一次会建出两个会话，前一个就漏在服务端了
  if (busy.value) return;

  const url = String(spec.value.url || '').trim();
  if (!url) {
    message.warning(t('amqp.urlRequired'));
    return;
  }
  // 地址以 {{变量}} 开头时本机判不了，交给服务端在变量替换之后再判，它返回的是同一个中文错误
  if (url.indexOf('{{') !== 0 && !URL_SCHEMES.test(url)) {
    message.warning(t('amqp.schemeRequired'));
    return;
  }
  if (!projects.currentId) {
    message.warning(t('amqp.noProject'));
    return;
  }

  spec.value.url = url;
  const ok = await amqp.connect(props.tab.key, connectPayload());
  if (!ok) {
    const current = state.value;
    message.error((current && current.error) || t('amqp.connectFailed'));
  }
}

function onDisconnect() {
  amqp.disconnect(props.tab.key);
}

function onClearLog() {
  amqp.clearLog(props.tab.key);
}

/* ---------------- 消费 ---------------- */

const consumers = computed(function () {
  return amqpCfg.value.consumers || [];
});

function addConsumer() {
  const list = (amqpCfg.value.consumers || []).slice();
  list.push({
    mode: 'queue',
    queue: '',
    exchange: '',
    routingKey: '',
    ack: 'auto',
    prefetch: 10,
    enabled: true
  });
  amqpCfg.value.consumers = list;
  touch();
}

function removeConsumer(index) {
  const list = (amqpCfg.value.consumers || []).slice();
  list.splice(index, 1);
  amqpCfg.value.consumers = list;
  touch();
}

function updateConsumer(index, patch) {
  const list = (amqpCfg.value.consumers || []).slice();
  list[index] = Object.assign({}, list[index], patch);
  amqpCfg.value.consumers = list;
  touch();
}

/**
 * 服务端记的 consumer 里，队列名 / 交换机名 / routing key 都是**替换过变量之后**的那一份，
 * 而配置行里可能是 `orders.{{env}}`。这里按作用域把普通变量替换一遍再去找 ——
 * 换不出来的（`{{$guid}}` 这种动态变量）就按原样找，找不到时状态显示「已停止」。
 */
const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;

function resolvedName(text) {
  return String(text || '').replace(PLACEHOLDER, function (whole, name) {
    const hit = scope.value.get(String(name).trim());
    return hit ? hit.value : whole;
  });
}

/**
 * 这一行现在对应的那个 consumer，没有就是还没开起来。
 *
 * **只在连着的会话里算数**：断开之后服务端那边的 consumer 已经没了（重连时会重新起一遍），
 * 界面上还挂着「消费中」会让人以为现在还能收消息。
 *
 * exchange 模式的临时队列每次都不一样，所以只按「交换机 + routing key」对；
 * 队列模式按队列名对。
 */
function liveConsumer(row) {
  const current = state.value;
  if (!current || current.status !== 'open') return null;

  const mode = row.mode === 'exchange' ? 'exchange' : 'queue';
  const wantQueue = resolvedName(row.queue).trim();
  const wantExchange = resolvedName(row.exchange).trim();
  const wantKey = resolvedName(row.routingKey);

  const list = Object.keys(current.consumers).map(function (tag) {
    return current.consumers[tag];
  });

  return list.filter(function (item) {
    if (item.mode !== mode) return false;
    if (mode === 'queue') return Boolean(wantQueue) && item.queue === wantQueue;
    return Boolean(wantExchange) && item.exchange === wantExchange && item.routingKey === wantKey;
  })[0] || null;
}

/** 每一行自己的错（开始 / 停止失败），按内容当键 —— 删掉中间一行时不会串到别的行上 */
const rowErrors = ref({});

function rowKey(row) {
  return [
    row.mode === 'exchange' ? 'exchange' : 'queue',
    String(row.queue || ''),
    String(row.exchange || ''),
    String(row.routingKey || '')
  ].join('|');
}

function rowError(row) {
  return rowErrors.value[rowKey(row)] || '';
}

function setRowError(row, text) {
  const key = rowKey(row);
  if (!text) {
    if (rowErrors.value[key]) {
      const next = Object.assign({}, rowErrors.value);
      delete next[key];
      rowErrors.value = next;
    }
    return;
  }
  rowErrors.value = Object.assign({}, rowErrors.value, { [key]: text });
}

function rowState(row) {
  const current = state.value;
  if (!current || current.status !== 'open') return 'off';
  if (rowError(row)) return 'error';
  return liveConsumer(row) ? 'on' : 'off';
}

function rowStatusText(row) {
  const which = rowState(row);
  if (which === 'on') return t('amqp.consuming');
  if (which === 'error') return t('amqp.consumerError');
  return t('amqp.stopped');
}

function rowStatusType(row) {
  const which = rowState(row);
  if (which === 'on') return 'success';
  if (which === 'error') return 'error';
  return 'default';
}

function rowStatusHint(row) {
  if (rowError(row)) return rowError(row);
  const hit = liveConsumer(row);
  if (hit && hit.consumerTag) return t('amqp.consumerTagHint', { tag: hit.consumerTag });
  return t('amqp.stoppedHint');
}

function rowSpec(row) {
  return {
    mode: row.mode === 'exchange' ? 'exchange' : 'queue',
    queue: String(row.queue || ''),
    exchange: String(row.exchange || ''),
    routingKey: String(row.routingKey || ''),
    ack: row.ack === 'manual' ? 'manual' : 'auto',
    prefetch: row.prefetch
  };
}

async function startRow(row) {
  if (!connected.value) {
    message.warning(t('amqp.notConnected'));
    return;
  }
  if (row.mode === 'exchange') {
    if (!String(row.exchange || '').trim()) {
      message.warning(t('amqp.exchangeRequired'));
      return;
    }
  } else if (!String(row.queue || '').trim()) {
    message.warning(t('amqp.queueRequired'));
    return;
  }

  const ok = await amqp.consume(props.tab.key, rowSpec(row));
  if (ok) {
    setRowError(row, '');
    return;
  }
  const current = state.value;
  const text = (current && current.error) || t('amqp.consumeFailed');
  setRowError(row, text);
  message.error(text);
}

async function stopRow(row) {
  const hit = liveConsumer(row);
  if (!hit || !hit.consumerTag) return;

  const ok = await amqp.cancel(props.tab.key, hit.consumerTag);
  if (ok) {
    setRowError(row, '');
    return;
  }
  const current = state.value;
  const text = (current && current.error) || t('amqp.cancelFailed');
  setRowError(row, text);
  message.error(text);
}

/* ---------------- 查看队列 ---------------- */

const queueInfo = ref({ show: false, queue: '', loading: false, messageCount: 0, consumerCount: 0, error: '' });

async function openQueueInfo(row) {
  const queue = String(row.queue || '').trim();
  if (!queue) {
    message.warning(t('amqp.queueRequired'));
    return;
  }
  if (!connected.value) {
    message.warning(t('amqp.notConnected'));
    return;
  }

  queueInfo.value = { show: true, queue: queue, loading: true, messageCount: 0, consumerCount: 0, error: '' };
  const result = await amqp.queueInfo(props.tab.key, queue);
  queueInfo.value = {
    show: true,
    queue: queue,
    loading: false,
    messageCount: result.messageCount || 0,
    consumerCount: result.consumerCount || 0,
    error: result.ok ? '' : (result.error || t('amqp.queueInfoFailed'))
  };
}

/* ---------------- 发布 ---------------- */

const draftExchange = ref('');
const draftRoutingKey = ref('');
const draftPayload = ref('');
const draftLang = ref('json');
const draftMandatory = ref(false);
const draftProps = ref(emptyPublishProps());
const savedPick = ref(null);

function emptyPublishProps() {
  return {
    contentType: '',
    persistent: false,
    headers: [],
    correlationId: '',
    replyTo: '',
    expiration: '',
    messageId: '',
    priority: null
  };
}

const saved = computed(function () {
  return amqpCfg.value.saved || [];
});

const savedOptions = computed(function () {
  return saved.value.map(function (item, index) {
    return { label: item.name, value: index };
  });
});

/** 属性那块有没有配过东西（折叠着的时候给一句提示，别让人看不出设过） */
const propsSummary = computed(function () {
  const p = draftProps.value;
  const parts = [];
  if (String(p.contentType || '').trim()) parts.push('content-type=' + p.contentType);
  if (p.persistent === true) parts.push('persistent');
  if ((p.headers || []).filter(function (r) { return r && r.enabled !== false && r.key; }).length) {
    parts.push('headers=' + (p.headers || []).filter(function (r) { return r && r.enabled !== false && r.key; }).length);
  }
  if (String(p.correlationId || '').trim()) parts.push('correlationId');
  if (String(p.replyTo || '').trim()) parts.push('replyTo');
  if (String(p.expiration || '').trim()) parts.push('expiration');
  if (String(p.messageId || '').trim()) parts.push('messageId');
  if (p.priority !== null && p.priority !== undefined && p.priority !== '') parts.push('priority=' + p.priority);
  return parts.length ? parts.join('、') : t('amqp.propsEmpty');
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
  draftExchange.value = item.exchange || '';
  draftRoutingKey.value = item.routingKey || '';
  draftPayload.value = item.payload || '';
  draftProps.value = Object.assign(emptyPublishProps(), item.properties || {});
  if (!Array.isArray(draftProps.value.headers)) draftProps.value.headers = [];
}

const showCommonDialog = ref(false);
const commonForm = ref({ name: '' });

function openSaveCommon() {
  // 名字可以从交换机 / routing key 里猜一个，用户多半要改
  commonForm.value = { name: String(draftRoutingKey.value || draftExchange.value || '').trim() };
  showCommonDialog.value = true;
}

async function confirmSaveCommon() {
  const name = String(commonForm.value.name || '').trim();
  if (!name) {
    message.warning(t('amqp.commonNameRequired'));
    return;
  }

  const list = (amqpCfg.value.saved || []).slice();
  list.push({
    name: name,
    exchange: draftExchange.value,
    routingKey: draftRoutingKey.value,
    payload: draftPayload.value,
    properties: JSON.parse(JSON.stringify(draftProps.value))
  });
  amqpCfg.value.saved = list;
  touch();
  showCommonDialog.value = false;

  if (props.tab.apiId) {
    try {
      const api = await persist();
      // 存回接口了就把快照对齐，别在标签页上留一个假的「未保存」圆点
      if (api) tabs.markSaved(props.tab, api);
      message.success(t('amqp.commonSaved'));
    } catch (err) {
      message.error(err.message);
    }
  }
}

async function removeSaved(index) {
  const list = (amqpCfg.value.saved || []).slice();
  if (index < 0 || index >= list.length) return;
  list.splice(index, 1);
  amqpCfg.value.saved = list;
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

function publishPayload() {
  const p = draftProps.value;
  return {
    exchange: String(draftExchange.value || '').trim(),
    routingKey: draftRoutingKey.value,
    payload: draftPayload.value,
    mandatory: draftMandatory.value === true,
    properties: {
      contentType: p.contentType,
      persistent: p.persistent === true,
      headers: (p.headers || []).map(function (row) {
        return { key: row.key, value: row.value, enabled: row.enabled !== false };
      }),
      correlationId: p.correlationId,
      replyTo: p.replyTo,
      expiration: p.expiration,
      messageId: p.messageId,
      priority: p.priority
    }
  };
}

async function publishNow() {
  if (!connected.value) {
    message.warning(t('amqp.notConnected'));
    return;
  }

  const ok = await amqp.publish(props.tab.key, publishPayload());
  if (!ok) {
    const current = state.value;
    message.error((current && current.error) || t('amqp.publishFailed'));
  }
}

/* ---------------- 保存（绑定了接口才有） ---------------- */

async function persist() {
  if (!props.tab.apiId) return null;
  const data = await apisApi.updateApi(props.tab.apiId, {
    url: spec.value.url,
    amqp: spec.value.amqp
  });
  return data.api;
}

async function save() {
  if (!props.tab.apiId) return;

  saving.value = true;
  try {
    const api = await persist();
    if (api) tabs.markSaved(props.tab, api);
    message.success(t('amqp.saved'));
  } catch (err) {
    message.error(err.message);
  } finally {
    saving.value = false;
  }
}

/* ---------------- 保存到目录（临时标签页） ---------------- */

function folderOptions() {
  const list = [{ label: t('amqp.rootFolder'), value: null }];
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
  list.push(props.tab.title || 'RabbitMQ');
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
    message.success(t('amqp.renamed'));
  } catch (err) {
    message.error(err.message);
  }
}

/** 标签页标题用地址的主机名，光写「RabbitMQ」的话几个标签页分不出来 */
function titleFromUrl(url) {
  const text = String(url || '').replace(/^(amqp|amqps):\/\//i, '').split('/')[0];
  return text || 'RabbitMQ';
}

function openSaveDialog() {
  saveForm.value = {
    name: props.tab.customTitle
      ? props.tab.title
      : (props.tab.spec.url ? titleFromUrl(props.tab.spec.url) : 'RabbitMQ'),
    folderId: null
  };
  showSaveDialog.value = true;
}

async function confirmSaveToFolder() {
  if (!String(saveForm.value.name || '').trim()) {
    message.warning(t('amqp.apiNameRequired'));
    return;
  }

  saving.value = true;
  try {
    const data = await apisApi.createApi(projects.currentId, {
      method: 'AMQP',
      name: String(saveForm.value.name).trim(),
      folderId: saveForm.value.folderId,
      url: props.tab.spec.url,
      amqp: props.tab.spec.amqp
    });
    // markSaved 的 AMQP 分支会把这个临时标签页变成绑定接口的样子
    tabs.markSaved(props.tab, data.api);
    showSaveDialog.value = false;
    await tree.refresh();
    message.success(t('amqp.savedToFolder'));
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
    message.warning(t('amqp.readonlyCannotSave'));
    return;
  }
  if (bound.value) save();
  else openSaveDialog();
}

onMounted(function () {
  window.addEventListener('keydown', onKeydown);
  amqp.ensure(props.tab.key);
  // 已经配过属性就展开那一块，不然用户看不出它设过
  if (propsOpenConfigured()) propsOpen.value = true;
});

/** 常用发布里存了属性，或者上一次就展开过：打开时直接摊开 */
function propsOpenConfigured() {
  return Boolean(draftProps.value && (
    String(draftProps.value.contentType || '').trim() ||
    draftProps.value.persistent === true ||
    (draftProps.value.headers || []).some(function (row) { return row && row.enabled !== false && row.key; })
  ));
}

onBeforeUnmount(function () {
  window.removeEventListener('keydown', onKeydown);
});

/**
 * 绑定了接口的标签页要跟着接口标签页一样标「未保存」；
 * 临时标签页也要 —— 这里配的东西不少（凭据、消费列表、常用发布），
 * 关掉前提示一句比默默丢掉强（和 MqttTab 的 touch() 一个口径）。
 */
watch(
  function () { return props.tab.spec; },
  function () { tabs.touch(props.tab); },
  { deep: true }
);
</script>

<template>
  <div class="amqp-tab">
    <!-- 这个接口和云端对不上：顶部一条红提示 + 处理入口 -->
    <div v-if="conflicted" class="conflict-bar">
      <span class="conflict-text">{{ t('amqp.conflictText') }}</span>
      <n-button size="tiny" type="error" ghost @click="openConflict">{{ t('amqp.resolve') }}</n-button>
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
        :placeholder="t('amqp.urlPlaceholder')"
        @update:model-value="(v) => { spec.url = v; }"
        @enter="onConnect"
      />

      <n-tag size="small" :bordered="false" :type="statusType">{{ statusText }}</n-tag>
      <span v-if="brokerHint" class="broker-hint">{{ brokerHint }}</span>
      <span v-if="channelHint" class="channel-hint">{{ channelHint }}</span>

      <n-button v-if="connected" size="small" type="warning" secondary @click="onDisconnect">
        {{ t('amqp.disconnect') }}
      </n-button>
      <!-- 网页版没有 /amqp：灰掉并说明原因（禁用的按钮不派发鼠标事件，提示挂在外层 span 上） -->
      <n-tooltip v-else-if="connectBlocked" trigger="hover">
        <template #trigger>
          <span class="connect-wrap">
            <n-button size="small" type="primary" disabled>{{ t('amqp.connect') }}</n-button>
          </span>
        </template>
        {{ t('amqp.connectBlocked') }}
      </n-tooltip>
      <n-button v-else size="small" type="primary" :loading="busy" @click="onConnect">
        {{ t('amqp.connect') }}
      </n-button>

      <n-button v-if="canEdit && bound" size="small" :loading="saving" @click="save">
        {{ t('amqp.save') }}
      </n-button>
      <n-button v-if="canEdit && !bound" size="small" @click="openSaveDialog">
        {{ t('amqp.saveToFolder') }}
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
        <n-tab-pane name="connect" :tab="t('amqp.tabConnect')">
          <div class="pane">
            <div class="grid">
              <div class="field">
                <span class="label">{{ t('amqp.username') }}</span>
                <n-input
                  size="small"
                  :value="amqpCfg.username"
                  :placeholder="t('amqp.supportVar')"
                  @update:value="(v) => { amqpCfg.username = v; touch(); }"
                />
              </div>

              <div class="field">
                <span class="label">{{ t('amqp.password') }}</span>
                <n-input
                  size="small"
                  type="password"
                  show-password-on="click"
                  :value="amqpCfg.password"
                  :placeholder="t('amqp.supportVar')"
                  @update:value="(v) => { amqpCfg.password = v; touch(); }"
                />
              </div>

              <div class="field">
                <span class="label">{{ t('amqp.heartbeatLabel') }}</span>
                <n-input-number
                  size="small"
                  :value="amqpCfg.heartbeat"
                  :min="0"
                  :max="3600"
                  placeholder="60"
                  @update:value="(v) => { amqpCfg.heartbeat = v === null ? 60 : v; touch(); }"
                />
              </div>

              <div class="field">
                <span class="label">{{ t('amqp.connectTimeoutLabel') }}</span>
                <n-input-number
                  size="small"
                  :value="amqpCfg.connectTimeoutMs"
                  :min="1000"
                  :max="60000"
                  :step="1000"
                  placeholder="10000"
                  @update:value="(v) => { amqpCfg.connectTimeoutMs = v === null ? 10000 : v; touch(); }"
                />
              </div>

              <div v-if="isTls" class="field wide">
                <span class="label">{{ t('amqp.tlsInsecureLabel') }}</span>
                <div class="inline">
                  <n-switch
                    size="small"
                    :value="amqpCfg.tlsInsecure === true"
                    @update:value="(v) => { amqpCfg.tlsInsecure = v; touch(); }"
                  />
                  <span class="hint">{{ t('amqp.tlsInsecureHint') }}</span>
                </div>
              </div>
            </div>

            <p class="hint cred-hint">
              {{ t('amqp.credHint') }}
            </p>
          </div>
        </n-tab-pane>

        <!-- 消费 -->
        <n-tab-pane name="consume" :tab="t('amqp.tabConsume')">
          <div class="pane">
            <p class="hint">
              {{ t('amqp.consumeHintLead') }}<strong>{{ t('amqp.consumeHintStrong') }}</strong>{{ t('amqp.consumeHintTail') }}
              <code>*</code>{{ t('amqp.consumeHintAnd') }} <code>#</code>{{ t('amqp.consumeHintEnd') }}
            </p>

            <div class="cons-head">
              <span class="col-mode">{{ t('amqp.colMode') }}</span>
              <span class="col-target">{{ t('amqp.colTarget') }}</span>
              <span class="col-ack">{{ t('amqp.colAck') }}</span>
              <span class="col-prefetch">prefetch</span>
              <span class="col-enabled">{{ t('amqp.colEnabled') }}</span>
              <span class="col-status">{{ t('amqp.colStatus') }}</span>
              <span class="col-actions" />
            </div>

            <div v-for="(row, index) in consumers" :key="index" class="cons-row">
              <n-select
                class="col-mode"
                size="small"
                :value="row.mode === 'exchange' ? 'exchange' : 'queue'"
                :options="MODE_OPTIONS"
                @update:value="(v) => updateConsumer(index, { mode: v })"
              />

              <div class="col-target">
                <var-input
                  v-if="row.mode !== 'exchange'"
                  class="target-input"
                  :model-value="row.queue"
                  :scope="scope"
                  :placeholder="t('amqp.queuePlaceholder')"
                  @update:model-value="(v) => updateConsumer(index, { queue: v })"
                />
                <template v-else>
                  <var-input
                    class="target-input"
                    :model-value="row.exchange"
                    :scope="scope"
                    :placeholder="t('amqp.exchangePlaceholder')"
                    @update:model-value="(v) => updateConsumer(index, { exchange: v })"
                  />
                  <var-input
                    class="target-input"
                    :model-value="row.routingKey"
                    :scope="scope"
                    :placeholder="t('amqp.routingKeyPlaceholder')"
                    @update:model-value="(v) => updateConsumer(index, { routingKey: v })"
                  />
                </template>
              </div>

              <n-select
                class="col-ack"
                size="small"
                :value="row.ack === 'manual' ? 'manual' : 'auto'"
                :options="ACK_OPTIONS"
                @update:value="(v) => updateConsumer(index, { ack: v })"
              />

              <n-input-number
                v-if="row.ack === 'manual'"
                class="col-prefetch"
                size="small"
                :value="row.prefetch"
                :min="0"
                :max="100000"
                placeholder="10"
                @update:value="(v) => updateConsumer(index, { prefetch: v === null ? 10 : v })"
              />
              <span v-else class="col-prefetch" />

              <span class="col-enabled">
                <n-switch
                  size="small"
                  :value="row.enabled !== false"
                  @update:value="(v) => updateConsumer(index, { enabled: v })"
                />
              </span>

              <span class="col-status">
                <n-tooltip v-if="connected" trigger="hover">
                  <template #trigger>
                    <n-tag size="tiny" :bordered="false" :type="rowStatusType(row)">
                      {{ rowStatusText(row) }}
                    </n-tag>
                  </template>
                  {{ rowStatusHint(row) }}
                </n-tooltip>
                <n-tag v-else size="tiny" :bordered="false">—</n-tag>
              </span>

              <span class="col-actions">
                <n-button
                  v-if="connected && rowState(row) === 'on'"
                  size="tiny"
                  @click="stopRow(row)"
                >
                  {{ t('amqp.stopConsume') }}
                </n-button>
                <n-button
                  v-else
                  size="tiny"
                  secondary
                  :disabled="!connected"
                  @click="startRow(row)"
                >
                  {{ t('amqp.startConsume') }}
                </n-button>
                <n-button
                  v-if="row.mode !== 'exchange'"
                  size="tiny"
                  :disabled="!connected"
                  @click="openQueueInfo(row)"
                >
                  {{ t('amqp.viewQueue') }}
                </n-button>
                <n-button size="tiny" quaternary type="error" @click="removeConsumer(index)">
                  {{ t('app.delete') }}
                </n-button>
              </span>
            </div>

            <p v-if="!consumers.length" class="empty">{{ t('amqp.emptyConsumers') }}</p>

            <n-button size="small" secondary class="add-cons" @click="addConsumer">
              {{ t('amqp.addConsumer') }}
            </n-button>
          </div>
        </n-tab-pane>

        <!-- 发布 -->
        <n-tab-pane name="publish" :tab="t('amqp.tabPublish')">
          <div class="pane">
            <div class="pub-row">
              <span class="pub-label">{{ t('amqp.exchangeLabel') }}</span>
              <var-input
                class="pub-exchange"
                :model-value="draftExchange"
                :scope="scope"
                :placeholder="t('amqp.exchangeHint')"
                @update:model-value="(v) => { draftExchange = v; }"
              />
            </div>

            <div class="pub-row">
              <span class="pub-label">{{ t('amqp.routingKeyLabel') }}</span>
              <var-input
                class="pub-routing"
                :model-value="draftRoutingKey"
                :scope="scope"
                placeholder="order.created"
                @update:model-value="(v) => { draftRoutingKey = v; }"
              />
              <span class="pub-mandatory">
                <n-switch size="small" :value="draftMandatory" @update:value="(v) => { draftMandatory = v; }" />
                <span class="hint">{{ t('amqp.mandatoryLabel') }}</span>
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
                {{ t('amqp.publish') }}
              </n-button>
              <n-select
                class="pub-saved"
                size="small"
                clearable
                :value="savedPick"
                :options="savedOptions"
                :placeholder="saved.length ? t('amqp.savedPlaceholder') : t('amqp.noSaved')"
                :disabled="!saved.length"
                @update:value="useSaved"
              />
              <n-button size="small" @click="openSaveCommon">{{ t('amqp.saveAsCommon') }}</n-button>
              <n-button
                v-if="savedPick !== null"
                size="small"
                quaternary
                type="error"
                @click="removeSaved(savedPick)"
              >
                {{ t('amqp.deleteThis') }}
              </n-button>
            </div>

            <p class="hint">
              {{ t('amqp.publishHintLead') }} <code>{{ VAR_HINT }}</code>{{ t('amqp.publishHintEnd') }}
            </p>

            <code-editor
              :model-value="draftPayload"
              :language="draftLang"
              min-height="160px"
              @update:model-value="(v) => { draftPayload = v; }"
              @format-error="(text) => message.error(text)"
            />

            <!-- 发布属性：可折叠 -->
            <div class="fold-head" @click="propsOpen = !propsOpen">
              <n-icon size="14" :component="propsOpen ? ChevronDown : ChevronRight" />
              <span class="fold-title">{{ t('amqp.propertiesTitle') }}</span>
              <span class="hint">{{ propsSummary }}</span>
            </div>

            <div v-if="propsOpen" class="grid">
              <div class="field">
                <span class="label">content-type</span>
                <n-input
                  size="small"
                  :value="draftProps.contentType"
                  placeholder="application/json"
                  @update:value="(v) => { draftProps.contentType = v; }"
                />
              </div>

              <div class="field">
                <span class="label">priority</span>
                <n-input-number
                  size="small"
                  :value="draftProps.priority"
                  :min="0"
                  :max="9"
                  clearable
                  @update:value="(v) => { draftProps.priority = v === null ? null : v; }"
                />
              </div>

              <div class="field">
                <span class="label">correlationId</span>
                <n-input
                  size="small"
                  :value="draftProps.correlationId"
                  @update:value="(v) => { draftProps.correlationId = v; }"
                />
              </div>

              <div class="field">
                <span class="label">replyTo</span>
                <n-input
                  size="small"
                  :value="draftProps.replyTo"
                  @update:value="(v) => { draftProps.replyTo = v; }"
                />
              </div>

              <div class="field">
                <span class="label">expiration</span>
                <n-input
                  size="small"
                  :value="draftProps.expiration"
                  :placeholder="t('amqp.expirationPlaceholder')"
                  @update:value="(v) => { draftProps.expiration = v; }"
                />
              </div>

              <div class="field">
                <span class="label">messageId</span>
                <n-input
                  size="small"
                  :value="draftProps.messageId"
                  @update:value="(v) => { draftProps.messageId = v; }"
                />
              </div>

              <div class="field wide">
                <span class="label">headers</span>
                <key-value-table
                  :model-value="draftProps.headers"
                  :scope="scope"
                  kind="amqpHeaders"
                  @update:model-value="(v) => { draftProps.headers = v; }"
                />
              </div>

              <div class="field wide">
                <span class="label">{{ t('amqp.propPersistent') }}</span>
                <div class="inline">
                  <n-switch
                    size="small"
                    :value="draftProps.persistent === true"
                    @update:value="(v) => { draftProps.persistent = v; }"
                  />
                  <span class="hint">{{ t('amqp.persistentHint') }}</span>
                </div>
              </div>

              <p class="hint wide">{{ t('amqp.mandatoryHint') }}</p>
            </div>
          </div>
        </n-tab-pane>
      </n-tabs>
    </div>

    <div class="log">
      <amqp-message-log
        :events="(state && state.events) || []"
        :dropped="(state && state.dropped) || 0"
        @clear="onClearLog"
        @ack="(payload) => amqp.ack(props.tab.key, payload)"
      />
    </div>

    <!-- 队列堆积 -->
    <n-modal
      v-model:show="queueInfo.show"
      preset="card"
      :title="t('amqp.queueInfoTitle')"
      style="width: 360px; max-width: 92vw"
    >
      <div class="queue-info">
        <div class="qi-row">
          <span class="qi-label">{{ t('amqp.queueLabel') }}</span>
          <span class="qi-value mono">{{ queueInfo.queue }}</span>
        </div>
        <div v-if="queueInfo.loading" class="qi-loading">{{ t('amqp.queueInfoLoading') }}</div>
        <n-alert v-else-if="queueInfo.error" type="error" :show-icon="false" class="notice">
          {{ queueInfo.error }}
        </n-alert>
        <template v-else>
          <div class="qi-row">
            <span class="qi-label">{{ t('amqp.queueInfoMessages') }}</span>
            <span class="qi-value">{{ queueInfo.messageCount }}</span>
          </div>
          <div class="qi-row">
            <span class="qi-label">{{ t('amqp.queueInfoConsumers') }}</span>
            <span class="qi-value">{{ queueInfo.consumerCount }}</span>
          </div>
        </template>
      </div>

      <template #footer>
        <n-space justify="end">
          <n-button @click="queueInfo.show = false">{{ t('app.close') }}</n-button>
        </n-space>
      </template>
    </n-modal>

    <n-modal
      v-model:show="showSaveDialog"
      preset="card"
      :title="t('amqp.saveToFolder')"
      style="width: 460px; max-width: 92vw"
    >
      <n-space vertical :size="12">
        <div class="field">
          <span class="label">{{ t('amqp.nameLabel') }}</span>
          <n-input v-model:value="saveForm.name" size="small" :placeholder="t('amqp.apiNamePlaceholder')" />
        </div>
        <div class="field">
          <span class="label">{{ t('amqp.folderLabel') }}</span>
          <n-select v-model:value="saveForm.folderId" size="small" :options="folderOptions()" />
        </div>
      </n-space>

      <template #footer>
        <n-space justify="end">
          <n-button @click="showSaveDialog = false">{{ t('app.cancel') }}</n-button>
          <n-button type="primary" :loading="saving" @click="confirmSaveToFolder">{{ t('amqp.save') }}</n-button>
        </n-space>
      </template>
    </n-modal>

    <n-modal
      v-model:show="showCommonDialog"
      preset="card"
      :title="t('amqp.saveCommonTitle')"
      style="width: 420px; max-width: 92vw"
    >
      <div class="field">
        <span class="label">{{ t('amqp.commonNameLabel') }}</span>
        <n-input v-model:value="commonForm.name" size="small" :placeholder="t('amqp.commonNamePlaceholder')" />
      </div>

      <template #footer>
        <n-space justify="end">
          <n-button @click="showCommonDialog = false">{{ t('app.cancel') }}</n-button>
          <n-button type="primary" @click="confirmSaveCommon">{{ t('amqp.save') }}</n-button>
        </n-space>
      </template>
    </n-modal>
  </div>
</template>

<style scoped>
.amqp-tab {
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

.channel-hint,
.broker-hint {
  flex: none;
  font-size: 12px;
  opacity: 0.6;
}

.broker-hint {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.notice {
  flex: none;
  font-size: 12px;
}

.panes {
  flex: 0 0 auto;
  max-height: 46%;
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

.hint {
  margin: 0;
  font-size: 12px;
  opacity: 0.6;
  line-height: 1.6;
}

.cred-hint {
  margin-top: 12px;
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

/* 消费表：固定列宽 + 目标列自适应，别让操作列把目标挤没了 */
.cons-head,
.cons-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.cons-head {
  margin-top: 10px;
  font-size: 12px;
  opacity: 0.6;
}

.cons-row {
  padding: 4px 0;
}

.col-mode {
  flex: none;
  width: 92px;
}

.col-target {
  flex: 1 1 240px;
  min-width: 0;
  display: flex;
  gap: 6px;
}

.target-input {
  flex: 1;
  min-width: 0;
}

.col-ack {
  flex: none;
  width: 88px;
}

.col-prefetch {
  flex: none;
  width: 96px;
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
  display: flex;
  justify-content: flex-end;
  gap: 4px;
  min-width: 230px;
}

.add-cons {
  margin-top: 10px;
}

.pub-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.pub-label {
  flex: none;
  width: 92px;
  font-size: 12px;
  font-weight: 600;
  opacity: 0.8;
}

.pub-exchange,
.pub-routing {
  flex: 1;
  min-width: 0;
}

.pub-mandatory {
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

.queue-info {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.qi-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 13px;
}

.qi-label {
  opacity: 0.7;
}

.qi-value {
  font-weight: 600;
}

.qi-value.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-weight: 400;
  word-break: break-all;
}

.qi-loading {
  font-size: 12px;
  opacity: 0.6;
}

code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
</style>
