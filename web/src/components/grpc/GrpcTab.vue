<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  NAlert,
  NButton,
  NEmpty,
  NInput,
  NInputNumber,
  NSelect,
  NSwitch,
  NTabPane,
  NTabs,
  useMessage
} from 'naive-ui';
import { useProjectStore } from '@/stores/project';
import { useEnvStore } from '@/stores/env';
import { useGatewayStore } from '@/stores/gateway';
import { useGrpcStore } from '@/stores/grpc';
import { useTabsStore } from '@/stores/tabs';
import { useTreeStore } from '@/stores/tree';
import * as apisApi from '@/api/apis';
import { parseProto, reflect } from '@/api/grpc';
import { copyText } from '@/utils/clipboard';
import { usePrompt } from '@/utils/prompt';
import { methodColor } from '@/utils/method';
import { resolveScope } from '@/utils/variables';
import KeyValueTable from '@/components/common/KeyValueTable.vue';
import CodeEditor from '@/components/common/CodeEditor.vue';
import VarInput from '@/components/common/VarInput.vue';
import InlineRename from '@/components/common/InlineRename.vue';
import AssertionsPane from '@/components/assertions/AssertionsPane.vue';
import GrpcResponse from './GrpcResponse.vue';
import GrpcStreamList from './GrpcStreamList.vue';
import {
  DEADLINE_DEFAULT,
  DEADLINE_MAX,
  DEADLINE_MIN,
  clampDeadline,
  exampleOf,
  findMethod,
  grpcurlCommand,
  methodOptions,
  methodValue,
  nextProtoName,
  splitMethodValue
} from './grpc-util';

/**
 * gRPC 标签页（第十一轮第 3 节）。
 *
 * 和其它调试标签页（WebSocket / Socket.IO）一个形态：**临时**（`apiId` 为空，
 * 不进目录树）和**绑定接口**（有 `apiId`，改动能存回接口）共用这一个组件。
 *
 * 和它们最大的不同：gRPC **没有长连接会话**。一次调用 = 一次 POST + 一串 NDJSON
 * 事件，所以状态在 `stores/grpc.js` 里只有「这次调用的结果」，没有会话 id。
 */
const props = defineProps({
  tab: { type: Object, required: true }
});

const projects = useProjectStore();
const envs = useEnvStore();
const gateway = useGatewayStore();
const grpc = useGrpcStore();
const tabs = useTabsStore();
const tree = useTreeStore();
const message = useMessage();
const prompt = usePrompt();
const { t } = useI18n();

/**
 * 「可以写 `{{变量}}`」这句话里的那个占位符。
 *
 * 放在这里而不是直接写进模板：Vue 的插值语法里出现 `}}` 会被提前截断
 * （见 docs/HANDOFF.md 的「前端约定」）。
 */
const varHint = computed(function () { return t('grpc.varHint'); });

const activePane = ref('message');
const spec = computed(function () { return props.tab.spec; });

/** 地址栏：和目录树上的接口双向同步（改完点保存才写库） */
const urlText = computed({
  get: function () { return String(spec.value.url || ''); },
  set: function (value) { spec.value.url = String(value === undefined || value === null ? '' : value); touch(); }
});

/** 默认形状要和后端 `dto.toApiGrpc` 对齐（这里只是「还没配过」时界面上的初值） */
function emptyGrpc() {
  return {
    source: 'proto',
    reflection: null,
    protoFiles: [],
    service: '',
    method: '',
    tls: false,
    metadata: [],
    message: '',
    deadlineMs: DEADLINE_DEFAULT,
    savedMessages: []
  };
}

const grpcCfg = computed(function () {
  if (!spec.value.grpc) spec.value.grpc = emptyGrpc();
  return spec.value.grpc;
});

const editable = computed(function () { return projects.canEdit; });
const isGateway = computed(function () { return gateway.isGateway; });

const state = computed(function () { return grpc.stateOf(props.tab.key); });
const running = computed(function () {
  const current = state.value;
  return Boolean(current && current.phase === 'running');
});

/** 变量作用域（契约第 5 节）：地址、metadata、消息里的 `{{变量}}` 都用它高亮 / 补全 */
const scope = computed(function () {
  return resolveScope({
    project: projects.current,
    folders: tree.folders,
    folderId: props.tab.folderId,
    environment: envs.selected
  });
});

function touch() {
  tabs.touch(props.tab);
}

/* ---------------- proto 解析 ---------------- */

/** 解析出来的服务清单；网页版拿不到（那条路由只在客户端里有） */
const services = ref([]);
const parseError = ref('');
const parsing = ref(false);

let parseTimer = null;

/** 当前在下面编辑器里打开的那个 proto 文件（列表里的下标） */
const activeFile = ref(0);

const files = computed(function () { return grpcCfg.value.protoFiles || []; });

const methodList = computed(function () { return methodOptions(services.value); });

const selected = computed(function () {
  return methodValue(grpcCfg.value.service, grpcCfg.value.method);
});

const currentMethod = computed(function () {
  return findMethod(services.value, grpcCfg.value.service, grpcCfg.value.method);
});

/**
 * 这个方法要不要走**流式会话**（客户端流 / 双向流，第十二轮第 2 节）。
 * 一元和服务端流还是走 `/grpc/call`。
 */
const needsStream = computed(function () {
  const found = currentMethod.value;
  return Boolean(found && found.clientStreaming === true);
});

/** 服务端流（一元不算）：响应区按「多条消息」显示 */
const currentStreaming = computed(function () {
  const found = currentMethod.value;
  return Boolean(found && found.serverStreaming === true && found.clientStreaming !== true);
});

/**
 * 下拉里要显示的选项。
 *
 * 已保存的那个「服务 / 方法」如果不在解析结果里（还没解析、或者网页版根本解析不了），
 * 补一条进去 —— 否则下拉是空的，用户会以为自己没选过。
 */
const selectOptions = computed(function () {
  const list = methodList.value.slice();
  const value = selected.value;
  if (!value) return list;
  if (list.some(function (item) { return item.value === value; })) return list;

  const parts = splitMethodValue(value);
  list.unshift({
    label: t('grpc.methodUnparsed', { service: parts.service, method: parts.method }),
    value: value,
    disabled: false
  });
  return list;
});

/* ---------------- 服务定义来源：proto 文件 / 服务端反射 ---------------- */

/** 'proto'（导入的文件）或 'reflection'（反射拿到的描述） */
const SOURCE_OPTIONS = computed(function () {
  return [
    { label: t('grpc.sourceProto'), value: 'proto' },
    { label: t('grpc.sourceReflection'), value: 'reflection' }
  ];
});

const source = computed({
  get: function () { return grpcCfg.value.source === 'reflection' ? 'reflection' : 'proto'; },
  set: function (value) {
    grpcCfg.value.source = value === 'reflection' ? 'reflection' : 'proto';
    touch();
    doParse();
  }
});

/** `{ descriptorSet, fetchedAt }`；没反射过是 null */
const reflection = computed(function () { return grpcCfg.value.reflection || null; });

const reflecting = ref(false);

const methodCount = computed(function () {
  return methodList.value.length;
});

/** 有没有「服务定义」可解析：proto 文件或者存下来的反射描述 */
const hasDefinition = computed(function () {
  return source.value === 'reflection' ? Boolean(reflection.value && reflection.value.descriptorSet) : files.value.length > 0;
});

const fetchedText = computed(function () {
  const info = reflection.value;
  if (!info || !info.fetchedAt) return '';
  const at = new Date(info.fetchedAt);
  function pad(n) { return n < 10 ? '0' + n : String(n); }
  return pad(at.getMonth() + 1) + '-' + pad(at.getDate()) + ' ' + pad(at.getHours()) + ':' + pad(at.getMinutes());
});

async function doReflect() {
  if (!isGateway.value) return;
  if (!String(spec.value.url || '').trim()) {
    message.warning(t('grpc.fillTargetFirst'));
    return;
  }

  reflecting.value = true;
  try {
    const data = await reflect(projects.currentId, {
      apiId: props.tab.apiId || undefined,
      environmentId: envs.selectedId || undefined,
      url: String(spec.value.url || ''),
      tls: grpcCfg.value.tls === true,
      metadata: JSON.parse(JSON.stringify(grpcCfg.value.metadata || []))
    });

    grpcCfg.value.reflection = {
      descriptorSet: data.descriptorSet || '',
      fetchedAt: data.fetchedAt || Date.now()
    };
    grpcCfg.value.source = 'reflection';
    touch();

    services.value = data.services || [];
    parseError.value = '';

    if (data.tooLarge) {
      message.warning(t('grpc.reflectTooLarge'));
    } else {
      message.success(t('grpc.reflectedCount', { n: services.value.length }));
    }
  } catch (err) {
    services.value = [];
    parseError.value = (err && err.message) || t('grpc.reflectFailed');
    message.error(parseError.value);
  } finally {
    reflecting.value = false;
  }
}

async function doParse() {
  if (!isGateway.value) return;   // 网页版没有 /grpc/parse，提示见模板

  const body = {};

  if (source.value === 'reflection') {
    const info = reflection.value;
    if (!info || !info.descriptorSet) {
      services.value = [];
      parseError.value = '';
      return;
    }
    // 用存下来的描述解析，不用再连服务端
    body.descriptorSet = info.descriptorSet;
  } else {
    if (!files.value.length) {
      services.value = [];
      parseError.value = '';
      return;
    }
    body.protoFiles = JSON.parse(JSON.stringify(files.value));
  }

  parsing.value = true;
  try {
    const data = await parseProto(projects.currentId, body);
    services.value = data.services || [];
    parseError.value = '';
  } catch (err) {
    services.value = [];
    parseError.value = (err && err.message) || t('grpc.parseFailed');
  } finally {
    parsing.value = false;
  }
}

/** 任何一次改动之后延迟一点再解析：正在敲的时候每敲一个字都解析一遍太吵 */
function scheduleParse() {
  if (parseTimer) clearTimeout(parseTimer);
  parseTimer = setTimeout(function () {
    parseTimer = null;
    doParse();
  }, 400);
}

watch(function () { return JSON.stringify(files.value); }, function () {
  scheduleParse();
});

function onPick(event) {
  const picked = Array.from((event.target && event.target.files) || []);
  event.target.value = '';

  picked.forEach(function (file) {
    const reader = new FileReader();
    reader.onload = function () {
      const name = String(file.name || '').replace(/^.*[\\/]/, '');
      const list = (grpcCfg.value.protoFiles || []).slice();
      // 同名直接换掉内容：用户重选一个改过的文件是最常见的动作
      const index = list.findIndex(function (item) { return item.name === name; });
      const entry = { name: name, content: String(reader.result || '') };
      if (index === -1) list.push(entry); else list[index] = entry;
      grpcCfg.value.protoFiles = list;
      activeFile.value = list.findIndex(function (item) { return item.name === name; });
      touch();
    };
    reader.readAsText(file);
  });
}

const activeValid = computed(function () {
  return activeFile.value >= 0 && activeFile.value < files.value.length;
});

const activeContent = computed({
  get: function () {
    const file = files.value[activeFile.value];
    return file ? String(file.content || '') : '';
  },
  set: function (value) {
    const file = files.value[activeFile.value];
    if (!file) return;
    file.content = String(value || '');
    touch();
  }
});

const activeName = computed({
  get: function () {
    const file = files.value[activeFile.value];
    return file ? String(file.name || '') : '';
  },
  set: function (value) {
    const file = files.value[activeFile.value];
    if (!file) return;
    file.name = String(value || '');
    touch();
  }
});

function addFile() {
  const list = (grpcCfg.value.protoFiles || []).slice();
  list.push({ name: nextProtoName(list), content: 'syntax = "proto3";\n\n' });
  grpcCfg.value.protoFiles = list;
  activeFile.value = list.length - 1;
  touch();
}

function removeFile(index) {
  const list = (grpcCfg.value.protoFiles || []).slice();
  list.splice(index, 1);
  grpcCfg.value.protoFiles = list;
  if (activeFile.value >= list.length) activeFile.value = list.length - 1;
  touch();
}

/* ---------------- 消息 ---------------- */

const messageText = computed({
  get: function () { return String(grpcCfg.value.message || ''); },
  set: function (value) { grpcCfg.value.message = String(value === undefined || value === null ? '' : value); touch(); }
});

function fillExample() {
  const text = exampleOf(services.value, grpcCfg.value.service, grpcCfg.value.method);
  if (!text) {
    message.warning(isGateway.value ? t('grpc.noMethodForExample') : t('grpc.parseProtoInClient'));
    return;
  }
  messageText.value = text;
}

const savedMessages = computed(function () { return grpcCfg.value.savedMessages || []; });

const savedOptions = computed(function () {
  return savedMessages.value.map(function (item, index) {
    return { label: item.name, value: index };
  });
});

function useSaved(index) {
  const item = savedMessages.value[index];
  if (!item) return;
  messageText.value = String(item.message || '');
}

async function saveAsSaved() {
  const text = String(grpcCfg.value.message || '').trim();
  if (!text) {
    message.warning(t('grpc.messageEmpty'));
    return;
  }

  const name = await prompt({
    title: t('grpc.saveAsSavedTitle'),
    label: t('grpc.saveAsSavedLabel'),
    value: t('grpc.savedMessageDefaultName', { n: savedMessages.value.length + 1 }),
    placeholder: t('grpc.savedMessagePlaceholder')
  });
  if (!name || !String(name).trim()) return;

  const list = savedMessages.value.slice();
  list.push({ name: String(name).trim(), message: text });
  grpcCfg.value.savedMessages = list;
  touch();

  if (props.tab.apiId) {
    try {
      await persist();
      message.success(t('grpc.savedMessageSaved'));
    } catch (err) {
      message.error(err.message);
    }
  } else {
    message.success(t('grpc.savedMessageSavedLocal'));
  }
}

function removeSaved(index) {
  const list = savedMessages.value.slice();
  list.splice(index, 1);
  grpcCfg.value.savedMessages = list;
  touch();
}

/* ---------------- 断言 / 提取变量（第十二轮第 1 节） ---------------- */

/** 和 HTTP 接口用的是同一份字段，AssertionsPane 直接用 */
const assertions = computed({
  get: function () { return spec.value.assertions || []; },
  set: function (value) { spec.value.assertions = value; touch(); }
});

const extracts = computed({
  get: function () { return spec.value.extracts || []; },
  set: function (value) { spec.value.extracts = value; touch(); }
});

/* ---------------- 调用 ---------------- */

const deadline = computed({
  get: function () { return clampDeadline(grpcCfg.value.deadlineMs); },
  set: function (value) {
    grpcCfg.value.deadlineMs = clampDeadline(value);
    touch();
  }
});

const callDisabledReason = computed(function () {
  if (!isGateway.value) return needsStream.value
    ? t('grpc.webNoStream')
    : t('grpc.webNoCall');
  if (!editable.value) return t('grpc.readonlyNoCall');
  if (!String(spec.value.url || '').trim()) return t('grpc.fillTargetFirst');
  if (!grpcCfg.value.service || !grpcCfg.value.method) return t('grpc.selectServiceMethod');
  return '';
});

/** `/grpc/call` 和流式会话共用的请求体（按来源带 protoFiles 或 descriptorSet） */
function buildBody() {
  const body = {
    apiId: props.tab.apiId || undefined,
    environmentId: envs.selectedId || undefined,
    url: String(spec.value.url || ''),
    tls: grpcCfg.value.tls === true,
    service: grpcCfg.value.service,
    method: grpcCfg.value.method,
    metadata: JSON.parse(JSON.stringify(grpcCfg.value.metadata || [])),
    message: String(grpcCfg.value.message || ''),
    deadlineMs: clampDeadline(grpcCfg.value.deadlineMs),
    assertions: JSON.parse(JSON.stringify(spec.value.assertions || [])),
    extracts: JSON.parse(JSON.stringify(spec.value.extracts || []))
  };

  if (source.value === 'reflection') {
    body.descriptorSet = (reflection.value && reflection.value.descriptorSet) || '';
  } else {
    body.protoFiles = JSON.parse(JSON.stringify(grpcCfg.value.protoFiles || []));
  }

  return body;
}

async function onCall() {
  if (running.value) {
    grpc.cancel(props.tab.key);
    return;
  }

  await grpc.run(props.tab.key, { projectId: projects.currentId, body: buildBody() });

  const current = state.value;
  if (current && current.phase === 'error' && current.error) message.error(current.error);
}

/* ---------------- 流式会话（客户端流 / 双向流） ---------------- */

const streamState = computed(function () { return grpc.streamOf(props.tab.key); });

const streamOpen = computed(function () {
  const current = streamState.value;
  return Boolean(current && current.id);
});

async function onConnect() {
  if (streamOpen.value) {
    grpc.cancelStream(props.tab.key);
    return;
  }

  const body = buildBody();
  delete body.message;   // 流式会话不带初始消息，消息逐条发

  await grpc.openStream(props.tab.key, { projectId: projects.currentId, body });

  const current = streamState.value;
  if (current && current.phase === 'error' && current.error) message.error(current.error);
}

async function onSend() {
  const text = String(grpcCfg.value.message || '').trim();
  if (!text) {
    message.warning(t('grpc.writeMessageFirst'));
    return;
  }

  try {
    await grpc.sendStream(props.tab.key, text);
  } catch (err) {
    message.error(err.message);
  }
}

async function onEndSend() {
  try {
    await grpc.endStreamSend(props.tab.key);
  } catch (err) {
    message.error(err.message);
  }
}

async function copyGrpcurl() {
  const command = grpcurlCommand({
    target: spec.value.url,
    tls: grpcCfg.value.tls === true,
    metadata: grpcCfg.value.metadata,
    message: grpcCfg.value.message,
    service: grpcCfg.value.service,
    method: grpcCfg.value.method,
    protoFiles: grpcCfg.value.protoFiles,
    source: source.value,
    streaming: needsStream.value
  });
  await copyText(command);
  message.success(t('grpc.copiedGrpcurl'));
}

/* ---------------- 保存 ---------------- */

const saving = ref(false);

async function persist() {
  if (!props.tab.apiId) return null;
  const data = await apisApi.updateApi(props.tab.apiId, {
    url: spec.value.url,
    grpc: spec.value.grpc,
    // 断言和提取变量住在接口自己的字段上（和 HTTP 接口同一份）
    assertions: spec.value.assertions || [],
    extracts: spec.value.extracts || []
  });
  return data.api;
}

async function save() {
  if (!props.tab.apiId) return;
  saving.value = true;
  try {
    const api = await persist();
    if (api) tabs.markSaved(props.tab, api);
    message.success(t('grpc.saved'));
  } catch (err) {
    message.error(err.message);
  } finally {
    saving.value = false;
  }
}

/** 标签页里改地址之后，目录树上的接口也要跟着变（和其它标签页一致） */
onMounted(function () {
  if (!props.tab.spec.grpc) props.tab.spec.grpc = emptyGrpc();
  if (!props.tab.spec.assertions) props.tab.spec.assertions = [];
  if (!props.tab.spec.extracts) props.tab.spec.extracts = [];

  // 反射来源：用存下来的描述解析一遍（不用再连服务端），服务 / 方法下拉就有值了
  if (source.value === 'reflection') {
    if (reflection.value && reflection.value.descriptorSet) doParse();
    return;
  }
  if ((props.tab.spec.grpc.protoFiles || []).length) doParse();
});
</script>

<template>
  <div class="grpc-tab">
    <div class="bar">
      <inline-rename
        :value="tab.title"
        :editable="editable && Boolean(tab.apiId)"
        :placeholder="t('grpc.namePlaceholder')"
        class="title"
        @commit="(name) => tabs.applyRename('api', tab.apiId, name)"
      />
      <span class="method" :style="{ color: methodColor('GRPC') }">gRPC</span>

      <div class="bar-tools">
        <n-button size="small" @click="copyGrpcurl">{{ t('grpc.copyAsGrpcurl') }}</n-button>
        <n-button v-if="tab.apiId && editable" size="small" :loading="saving" @click="save">{{ t('grpc.save') }}</n-button>
      </div>
    </div>

    <div class="addr">
      <var-input
        v-model="urlText"
        :readonly="!editable"
        :scope="scope"
        placeholder="127.0.0.1:50051"
        class="url"
      />
      <div class="tls">
        <n-switch
          :value="grpcCfg.tls === true"
          :disabled="!editable"
          size="small"
          @update:value="(v) => { grpcCfg.tls = v; touch(); }"
        />
        <span class="tls-label">TLS</span>
      </div>
      <n-select
        :value="selected || null"
        :options="selectOptions"
        :disabled="!editable"
        size="small"
        filterable
        :placeholder="t('grpc.serviceMethodPlaceholder')"
        class="method-select"
        @update:value="(v) => {
          const parts = splitMethodValue(v);
          grpcCfg.service = parts.service;
          grpcCfg.method = parts.method;
          touch();
        }"
      />
      <n-button
        v-if="needsStream"
        size="small"
        :type="streamOpen ? 'error' : 'primary'"
        :ghost="streamOpen"
        :disabled="!streamOpen && Boolean(callDisabledReason)"
        @click="onConnect"
      >
        {{ streamOpen ? t('grpc.disconnect') : t('grpc.connect') }}
      </n-button>
      <n-button
        v-else
        size="small"
        :type="running ? 'error' : 'primary'"
        :ghost="running"
        :disabled="!running && Boolean(callDisabledReason)"
        @click="onCall"
      >
        {{ running ? t('app.cancel') : t('grpc.call') }}
      </n-button>
    </div>

    <div v-if="!editable" class="notice">
      {{ t('grpc.readonlyNotice') }}
    </div>
    <div v-if="!isGateway" class="notice">
      {{ t('grpc.webNoCallPrefix') }}<b>{{ t('grpc.webNoCallBold') }}</b>{{ t('grpc.webNoCallSuffix') }}
    </div>

    <n-alert v-if="parseError" type="error" :show-icon="false" class="parse-error">
      {{ parseError }}
    </n-alert>
    <p v-if="parsing" class="dim">{{ t('grpc.parsingProto') }}</p>
    <n-alert
      v-else-if="isGateway && services.length === 0 && hasDefinition"
      type="warning"
      :show-icon="false"
      class="parse-error"
    >
      {{ source === 'reflection'
        ? t('grpc.reflectEmpty')
        : t('grpc.parseEmpty') }}
    </n-alert>

    <n-alert
      v-if="state && state.note"
      type="info"
      :show-icon="false"
      class="parse-error"
    >
      {{ state.note }}
    </n-alert>

    <div class="split">
      <n-tabs v-model:value="activePane" type="line" size="small" class="panes">
        <n-tab-pane name="message" :tab="t('grpc.messages')">
          <div class="row">
            <n-button size="small" :disabled="!editable" @click="fillExample">{{ t('grpc.generateExample') }}</n-button>
            <n-select
              :value="null"
              :options="savedOptions"
              :disabled="!editable || !savedOptions.length"
              size="small"
              :placeholder="t('grpc.savedMessages')"
              class="saved"
              @update:value="useSaved"
            />
            <n-button size="small" :disabled="!editable" @click="saveAsSaved">{{ t('grpc.saveAsSaved') }}</n-button>
          </div>

          <code-editor
            v-model="messageText"
            language="json"
            :readonly="!editable"
            min-height="220px"
            wrap
          />

          <!-- 客户端流 / 双向流：消息是逐条发的 -->
          <div v-if="needsStream" class="row">
            <n-button
              size="small"
              type="primary"
              :disabled="!editable || !streamOpen || (streamState && streamState.halfClosed)"
              @click="onSend"
            >
              {{ t('grpc.send') }}
            </n-button>
            <n-button
              size="small"
              :disabled="!editable || !streamOpen || (streamState && streamState.halfClosed)"
              @click="onEndSend"
            >
              {{ t('grpc.endSend') }}
            </n-button>
            <span class="dim">
              {{ streamOpen
                ? ((streamState && streamState.halfClosed) ? t('grpc.streamHalfClosed') : t('grpc.streamSendHint'))
                : t('grpc.streamConnectFirst') }}
            </span>
          </div>

          <template v-if="savedMessages.length">
            <p class="label">{{ t('grpc.savedMessages') }}</p>
            <div class="saved-list">
              <div v-for="(item, index) in savedMessages" :key="index" class="saved-item">
                <n-button size="tiny" quaternary @click="useSaved(index)">{{ item.name }}</n-button>
                <span class="saved-text">{{ item.message }}</span>
                <n-button v-if="editable" size="tiny" quaternary type="error" @click="removeSaved(index)">
                  {{ t('app.delete') }}
                </n-button>
              </div>
            </div>
          </template>
        </n-tab-pane>

        <n-tab-pane name="metadata" tab="Metadata">
          <p class="label">{{ t('grpc.metadataHintPrefix') }}<code>{{ varHint }}</code>{{ t('grpc.metadataHintSuffix') }}</p>
          <key-value-table
            :model-value="grpcCfg.metadata"
            :disabled="!editable"
            :scope="scope"
            :key-placeholder="t('grpc.keyPlaceholder')"
            :value-placeholder="t('grpc.valuePlaceholder')"
            @update:model-value="(v) => { grpcCfg.metadata = v; touch(); }"
          />
        </n-tab-pane>

        <n-tab-pane name="proto" :tab="t('grpc.tabDefinition')">
          <div class="row">
            <n-select
              :value="source"
              :options="SOURCE_OPTIONS"
              :disabled="!editable"
              size="small"
              class="source-select"
              @update:value="(v) => { source = v; }"
            />
            <template v-if="source === 'reflection'">
              <n-button
                size="small"
                type="primary"
                :disabled="!editable || !isGateway"
                :loading="reflecting"
                @click="doReflect"
              >
                {{ t('grpc.fetchFromServer') }}
              </n-button>
              <span class="dim">{{ reflection ? t('grpc.fetchedAt', { time: fetchedText }) : t('grpc.notFetchedYet') }}</span>
            </template>
            <span v-else class="dim">{{ t('grpc.autoReparse') }}</span>
          </div>

          <!-- 服务端反射 -->
          <template v-if="source === 'reflection'">
            <p v-if="reflection" class="label">
              {{ t('grpc.reflectedGot') }}<b>{{ services.length }}</b>{{ t('grpc.reflectedServicesSuffix') }}<b>{{ methodCount }}</b>{{ t('grpc.reflectedMethodsAt', { time: fetchedText }) }}
              {{ t('grpc.reflectedSaved') }}
            </p>
            <n-empty v-else size="small" :description="t('grpc.noReflectionYet')" />
            <p v-if="!isGateway" class="dim">
              {{ t('grpc.webNoReflectHint') }}
            </p>
          </template>

          <!-- 导入 proto 文件 -->
          <template v-else>
            <div class="row">
              <label class="file-pick">
                <input type="file" accept=".proto" multiple :disabled="!editable" @change="onPick" />
                <n-button size="small" :disabled="!editable">{{ t('grpc.importProto') }}</n-button>
              </label>
              <n-button size="small" :disabled="!editable" @click="addFile">{{ t('grpc.newFile') }}</n-button>
            </div>

            <div v-if="files.length" class="files">
              <div
                v-for="(file, index) in files"
                :key="index"
                class="file"
                :class="{ active: index === activeFile }"
                @click="activeFile = index"
              >
                <span class="fname">{{ file.name }}</span>
                <n-button v-if="editable" size="tiny" quaternary type="error" @click.stop="removeFile(index)">
                  {{ t('app.delete') }}
                </n-button>
              </div>
            </div>
            <n-empty v-else size="small" :description="t('grpc.noProtoFiles')" />

            <template v-if="activeValid">
              <p class="label">{{ t('grpc.fileNameLabel') }}</p>
              <n-input v-model:value="activeName" size="small" :disabled="!editable" placeholder="user.proto" />
              <code-editor
                v-model="activeContent"
                language="text"
                :readonly="!editable"
                min-height="240px"
                wrap
              />
            </template>
          </template>
        </n-tab-pane>

        <n-tab-pane name="assertions" :tab="t('grpc.tabAssertions')">
          <p class="label">
            {{ t('grpc.assertionsHint') }}
          </p>
          <assertions-pane
            v-model:assertions="assertions"
            v-model:extracts="extracts"
            :disabled="!editable"
            :has-environment="Boolean(envs.selectedId)"
          />
        </n-tab-pane>

        <n-tab-pane name="settings" :tab="t('grpc.tabSettings')">
          <div class="field">
            <span class="label">{{ t('grpc.timeoutLabel') }}</span>
            <n-input-number
              v-model:value="deadline"
              :min="DEADLINE_MIN"
              :max="DEADLINE_MAX"
              :disabled="!editable"
              size="small"
              class="w160"
            />
          </div>
          <p class="note">
            {{ t('grpc.timeoutNote', { n: DEADLINE_DEFAULT }) }}
          </p>
        </n-tab-pane>
      </n-tabs>

      <grpc-stream-list v-if="needsStream" :state="streamState" />
      <grpc-response v-else :state="state" :streaming="currentStreaming" />
    </div>
  </div>
</template>

<style scoped>
.grpc-tab {
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

.method {
  flex: none;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.4px;
  text-transform: uppercase;
}

.bar-tools {
  margin-left: auto;
  display: flex;
  gap: 6px;
}

.addr {
  display: flex;
  align-items: center;
  gap: 6px;
}

.url {
  flex: 1;
  min-width: 0;
}

.tls {
  flex: none;
  display: flex;
  align-items: center;
  gap: 4px;
}

.tls-label {
  font-size: 12px;
  opacity: 0.75;
}

.method-select {
  width: 320px;
  flex: none;
}

.source-select {
  width: 160px;
  flex: none;
}

.reflect-info {
  padding: 6px 8px;
  border-radius: 4px;
  background: rgba(128, 128, 128, 0.1);
  font-size: 12px;
  line-height: 1.7;
}

.notice {
  flex: none;
  padding: 5px 10px;
  border-radius: 4px;
  font-size: 12px;
  background: rgba(128, 128, 128, 0.12);
}

.parse-error {
  flex: none;
  font-size: 12px;
}

.split {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.panes {
  flex: 0 0 46%;
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

.row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.saved {
  width: 200px;
  flex: none;
}

.label {
  margin: 12px 0 6px;
  font-size: 12px;
  font-weight: 600;
  opacity: 0.8;
}

.dim {
  font-size: 12px;
  opacity: 0.6;
}

.note {
  margin: 8px 0 0;
  font-size: 12px;
  opacity: 0.7;
}

.field {
  display: flex;
  align-items: center;
  gap: 8px;
}

.w160 {
  width: 160px;
}

.saved-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.saved-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  padding: 3px 6px;
  border-radius: 4px;
  background: rgba(128, 128, 128, 0.08);
}

.saved-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.7;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.file-pick {
  display: inline-block;
}

.file-pick input {
  display: none;
}

.files {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}

.file {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 4px 2px 8px;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  background: rgba(128, 128, 128, 0.1);
}

.file.active {
  outline: 1px solid rgba(128, 128, 128, 0.5);
}

.fname {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
</style>
