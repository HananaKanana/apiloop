<script setup>
import { computed, ref, watch } from 'vue';
import {
  NAlert,
  NButton,
  NDropdown,
  NFormItem,
  NInputNumber,
  NModal,
  NSelect,
  NTag,
  useMessage
} from 'naive-ui';
import * as apisApi from '@/api/apis';
import * as sendApi from '@/api/send';
import CodeEditor from '@/components/common/CodeEditor.vue';
import KeyValueTable from '@/components/common/KeyValueTable.vue';
import TemplatizeDialog from '@/components/common/TemplatizeDialog.vue';
import PlaceholderMenu from './PlaceholderMenu.vue';

/**
 * 示例编辑器：状态码、响应类型、响应头、响应体。
 *
 * 普通改动 600ms 防抖后自动保存，不用点保存按钮。
 * 唯一的例外是「智能模板化」——它会整段改写响应体，改完只标成未保存，
 * 由用户自己点「保存」才落库（见 dirty）。
 */
const props = defineProps({
  example: { type: Object, required: true },
  placeholders: { type: Array, default: function () { return []; } },
  templates: { type: Array, default: function () { return []; } },
  /** 只读角色：字段全部禁用，写入口（保存 / 模板化 / 插入字段）不出现 */
  readonly: { type: Boolean, default: false }
});

const emit = defineEmits(['saved']);

const message = useMessage();

const RESPONSE_TYPES = [
  { label: 'JSON', value: 'json' },
  { label: '文本', value: 'text' },
  { label: 'HTML', value: 'html' },
  { label: 'SSE', value: 'sse' },
  { label: 'WebSocket', value: 'ws' }
];

/**
 * sse / ws 两种示例的 `body` 不是响应体，而是一段**回放场景**（契约第 17 节），
 * 所以编辑器切成 JSON 模式，并且给一行格式说明 + 一个能直接用的骨架。
 * 骨架是「插入示例结构」的内容，也是这两种类型最省事的起点。
 */
const SCENARIO = {
  sse: {
    title: 'SSE 回放场景',
    hint: '{ events: [{ delay /* 毫秒，和上一条的间隔；第一条相对响应头 */, event?, data, id? }], repeat }',
    template: {
      events: [
        { delay: 0, data: '第一条消息' },
        { delay: 1000, event: 'ping', data: '{"code":0}' }
      ],
      repeat: false
    }
  },
  ws: {
    title: 'WebSocket 回放场景',
    hint: '{ onOpen: [{ delay, send }], rules: [{ match: { type, value }, reply: [{ delay, send }] }], fallback }',
    template: {
      onOpen: [{ delay: 0, send: '{"type":"hello"}' }],
      rules: [
        { match: { type: 'equals', value: 'ping' }, reply: [{ delay: 200, send: 'pong' }] }
      ],
      fallback: 'echo'
    }
  }
};

const draft = ref(null);
const editorRef = ref(null);
const previewing = ref(false);
const previewResult = ref(null);
const showPreview = ref(false);
/** 有改动还没落库。自动保存的路径会在保存成功后清掉它 */
const dirty = ref(false);
const showTemplatize = ref(false);
/** 服务端返回的 400 原因（场景不合法这类），留在编辑器上方给用户看 */
const saveError = ref('');

let saveTimer = null;

const isScenario = computed(function () {
  return Boolean(draft.value && (draft.value.responseType === 'sse' || draft.value.responseType === 'ws'));
});

const scenario = computed(function () {
  return draft.value ? SCENARIO[draft.value.responseType] || null : null;
});

/** 两种场景都是 JSON；普通响应体还是按原来的规则 */
const editorLanguage = computed(function () {
  if (!draft.value) return 'text';
  if (isScenario.value || draft.value.responseType === 'json') return 'json';
  if (draft.value.responseType === 'html') return 'html';
  return 'text';
});

/**
 * 能不能美化：响应类型是 JSON、Content-Type 里带 json、或者内容看着就是个 JSON。
 * 后一条是给「类型选了文本、但内容其实是 JSON」的示例留的。
 */
const canFormat = computed(function () {
  if (!draft.value) return false;
  if (editorLanguage.value === 'json') return true;

  const contentType = (draft.value.headers || []).filter(function (row) {
    return String(row.key).toLowerCase() === 'content-type';
  }).map(function (row) {
    return String(row.value).toLowerCase();
  }).join(';');
  if (contentType.indexOf('json') !== -1) return true;

  const text = String(draft.value.body || '').trim();
  return text.charAt(0) === '{' || text.charAt(0) === '[';
});

function formatBody() {
  if (editorRef.value) editorRef.value.format();
}

function onFormatError(text) {
  message.error(text);
}

function reset(source) {
  draft.value = {
    name: source.name || '',
    status: typeof source.status === 'number' ? source.status : 200,
    responseType: source.responseType || 'json',
    headers: JSON.parse(JSON.stringify(source.headers || [])),
    body: typeof source.body === 'string' ? source.body : '',
    isTemplate: source.isTemplate === true
  };
  dirty.value = false;
  saveError.value = '';
}

watch(
  function () { return props.example && props.example.id; },
  function () { reset(props.example || {}); },
  { immediate: true }
);

function scheduleSave() {
  if (props.readonly) return;

  dirty.value = true;
  // 用户一动手，上次那条 400 就不该再挂在那里了
  saveError.value = '';
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 600);
}

async function save() {
  if (!draft.value || !props.example || !props.example.id) return;

  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }

  try {
    const data = await apisApi.updateExample(props.example.id, {
      name: draft.value.name,
      status: draft.value.status,
      responseType: draft.value.responseType,
      headers: draft.value.headers,
      body: draft.value.body,
      isTemplate: draft.value.isTemplate
    });
    dirty.value = false;
    saveError.value = '';
    emit('saved', data.example);
  } catch (err) {
    // 400 的原因（比如 sse 场景不合法）要留在编辑器上方，只弹一下用户会漏掉
    saveError.value = err.message;
  }
}

/**
 * 「插入示例结构」：直接换掉 body，而不是往光标处插 —— 示例上原来那点
 * 默认 JSON 拼上场景骨架只会变成不合法的 JSON，一键得到能用的场景才是这个按钮的用处。
 * （CodeMirror 的撤销可以退回。）
 */
function insertScenario() {
  if (!draft.value || !scenario.value) return;

  draft.value.body = JSON.stringify(scenario.value.template, null, 2);
  scheduleSave();
}

/* ---------------- 智能模板化 ---------------- */

function openTemplatize() {
  if (!draft.value) return;
  showTemplatize.value = true;
}

/**
 * 确认替换后只改编辑器里的内容，**不自动保存**：这一步整段换掉了响应体，
 * 用户得自己看一眼、点一次保存。
 */
function onTemplatizeConfirm(payload) {
  if (payload.skipped) {
    message.warning(payload.skipped);
    return;
  }

  draft.value.body = payload.body;
  draft.value.isTemplate = true;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  dirty.value = true;
  message.info('已替换内容，确认后点「保存」');
}

/**
 * 给外面判断「现在切走会不会丢东西」用。
 * 目前只有智能模板化会留下未保存状态 —— 普通改动 600ms 后自己就存了。
 */
function isDirty() {
  return dirty.value;
}

defineExpose({ isDirty: isDirty });

const templateOptions = computed(function () {
  return (props.templates || []).map(function (item, index) {
    return { label: item.name, value: index };
  });
});

function applyTemplate(index) {
  const template = (props.templates || [])[index];
  if (!template) return;

  draft.value.body = template.response;
  scheduleSave();
}

function insertPlaceholder(text) {
  if (editorRef.value) editorRef.value.insertAtCursor(text);
  scheduleSave();
}

async function runPreview() {
  previewing.value = true;
  try {
    const data = await sendApi.preview({
      response: draft.value.body,
      responseType: draft.value.responseType
    });
    previewResult.value = data;
    showPreview.value = true;
  } catch (err) {
    message.error(err.message);
  } finally {
    previewing.value = false;
  }
}
</script>

<template>
  <div v-if="draft" class="example-editor">
    <div class="toolbar">
      <n-form-item label="状态码" :show-feedback="false" class="status">
        <n-input-number
          size="small"
          :value="draft.status"
          :min="100"
          :max="599"
          :disabled="readonly"
          @update:value="(v) => { draft.status = v || 200; scheduleSave(); }"
        />
      </n-form-item>

      <n-form-item label="响应类型" :show-feedback="false" class="type">
        <n-select
          size="small"
          :value="draft.responseType"
          :options="RESPONSE_TYPES"
          :disabled="readonly"
          @update:value="(v) => { draft.responseType = v; scheduleSave(); }"
        />
      </n-form-item>

      <span class="spacer" />

      <template v-if="!readonly">
        <n-tag v-if="dirty" size="tiny" :bordered="false" type="warning">未保存</n-tag>

        <n-button size="small" secondary :disabled="!dirty" @click="save">保存</n-button>

        <placeholder-menu :placeholders="placeholders" @insert="insertPlaceholder">
          <n-button size="small" quaternary>插入 Mock 字段</n-button>
        </placeholder-menu>

        <n-dropdown
          v-if="!isScenario && templateOptions.length"
          trigger="click"
          :options="templateOptions"
          @select="applyTemplate"
        >
          <n-button size="small" quaternary>常用模板</n-button>
        </n-dropdown>

        <!-- 智能模板化会整段重写响应体，对「回放场景」是错的，两种场景下不出现 -->
        <n-button v-if="!isScenario" size="small" quaternary @click="openTemplatize">
          智能模板化
        </n-button>
      </template>

      <n-button size="small" secondary type="primary" :loading="previewing" @click="runPreview">
        预览
      </n-button>
    </div>

    <div class="block">
      <p class="label">响应头</p>
      <key-value-table
        v-model="draft.headers"
        key-placeholder="名称"
        value-placeholder="值"
        :disabled="readonly"
        @update:model-value="scheduleSave"
      />
    </div>

    <div class="block body-block">
      <div class="body-head">
        <p class="label">{{ scenario ? scenario.title : '响应体' }}</p>
        <span class="spacer" />
        <n-button
          v-if="canFormat && !readonly"
          size="tiny"
          quaternary
          title="⇧⌥F。带 {{变量}} 也能美化；只调整空白，数字和字符串都一字不改"
          @click="formatBody"
        >
          美化
        </n-button>
        <n-button
          v-if="scenario && !readonly"
          size="tiny"
          quaternary
          type="primary"
          title="会用骨架替换当前内容（可以撤销）"
          @click="insertScenario"
        >
          插入示例结构
        </n-button>
      </div>

      <p v-if="scenario" class="format-hint">{{ scenario.hint }}</p>

      <n-alert v-if="saveError" type="error" :show-icon="false" class="notice">
        {{ saveError }}
      </n-alert>

      <code-editor
        ref="editorRef"
        :model-value="draft.body"
        :language="editorLanguage"
        :placeholders="placeholders"
        min-height="240px"
        :readonly="readonly"
        @update:model-value="(v) => { draft.body = v; scheduleSave(); }"
        @format-error="onFormatError"
      />
    </div>

    <n-modal
      v-model:show="showPreview"
      preset="card"
      title="预览"
      style="width: 720px; max-width: 94vw"
    >
      <template v-if="previewResult">
        <n-alert
          v-if="previewResult.warnings && previewResult.warnings.length"
          type="warning"
          :show-icon="false"
          class="notice"
        >
          <div v-for="(warning, index) in previewResult.warnings" :key="index">{{ warning }}</div>
        </n-alert>

        <n-alert v-if="!previewResult.jsonValid" type="error" :show-icon="false" class="notice">
          JSON 不合法：{{ previewResult.jsonError }}
        </n-alert>

        <pre class="preview-body">{{ previewResult.rendered }}</pre>
      </template>
    </n-modal>

    <templatize-dialog
      v-model:show="showTemplatize"
      :body="draft.body"
      @confirm="onTemplatizeConfirm"
    />
  </div>
</template>

<style scoped>
.example-editor {
  display: flex;
  flex-direction: column;
  gap: 10px;
  height: 100%;
  min-height: 0;
  overflow: auto;
}

.toolbar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
}

.status {
  width: 130px;
}

.type {
  width: 150px;
}

.spacer {
  flex: 1;
}

.block {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.body-block {
  flex: 1;
  min-height: 0;
}

.body-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.body-head .spacer {
  flex: 1;
}

/* sse / ws 场景的格式说明：等宽字体，让花括号对齐好认一点 */
.format-hint {
  margin: 4px 0 0;
  font-size: 12px;
  opacity: 0.6;
  line-height: 1.6;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  word-break: break-all;
}

.label {
  margin: 0;
  font-size: 12px;
  opacity: 0.65;
}

.notice {
  margin-bottom: 10px;
  font-size: 12px;
}

.preview-body {
  margin: 0;
  padding: 10px;
  max-height: 50vh;
  overflow: auto;
  border: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.24));
  border-radius: 6px;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
</style>
