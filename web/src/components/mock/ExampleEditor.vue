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
  { label: 'HTML', value: 'html' }
];

const draft = ref(null);
const editorRef = ref(null);
const previewing = ref(false);
const previewResult = ref(null);
const showPreview = ref(false);
/** 有改动还没落库。自动保存的路径会在保存成功后清掉它 */
const dirty = ref(false);
const showTemplatize = ref(false);

let saveTimer = null;

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
}

watch(
  function () { return props.example && props.example.id; },
  function () { reset(props.example || {}); },
  { immediate: true }
);

function scheduleSave() {
  if (props.readonly) return;

  dirty.value = true;
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
    emit('saved', data.example);
  } catch (err) {
    message.error(err.message);
  }
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
          v-if="templateOptions.length"
          trigger="click"
          :options="templateOptions"
          @select="applyTemplate"
        >
          <n-button size="small" quaternary>常用模板</n-button>
        </n-dropdown>

        <n-button size="small" quaternary @click="openTemplatize">智能模板化</n-button>
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
      <p class="label">响应体</p>
      <code-editor
        ref="editorRef"
        :model-value="draft.body"
        :language="draft.responseType === 'json' ? 'json' : (draft.responseType === 'html' ? 'html' : 'text')"
        min-height="240px"
        :readonly="readonly"
        @update:model-value="(v) => { draft.body = v; scheduleSave(); }"
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
