<script setup>
import { computed, ref } from 'vue';
import { NButton, NCheckbox, NIcon, NInput, NSelect, NSpace, useMessage } from 'naive-ui';
import { File, Trash } from '@vicons/tabler';
import { BARE_INPUT_THEME } from '@/utils/bareInput';
import CodeEditor from '@/components/common/CodeEditor.vue';
import VarInput from '@/components/common/VarInput.vue';
import * as sendApi from '@/api/send';

/**
 * 请求体编辑器。
 *
 * spec 是标签页里那个编辑中的对象，这里直接改它（改动由 RequestTab 的深度 watch 记成 dirty）。
 * 文件（formdata 的文件行、binary）先上传到服务端，拿到绝对路径再填进 src，
 * 因为发送是在后端发起的，后端只能按本地路径读文件。
 */
const props = defineProps({
  spec: { type: Object, required: true },
  projectId: { type: String, default: '' },
  /** resolveScope() 的结果，给表单值的变量高亮和补全用 */
  scope: { type: Map, default: null }
});

const message = useMessage();

const MODE_OPTIONS = [
  { label: '无', value: 'none' },
  { label: 'JSON / 文本', value: 'raw' },
  { label: '表单 (urlencoded)', value: 'urlencoded' },
  { label: '表单 (form-data)', value: 'formdata' },
  { label: '二进制', value: 'binary' },
  { label: 'GraphQL', value: 'graphql' }
];

const LANGUAGE_OPTIONS = [
  { label: 'JSON', value: 'json' },
  { label: 'Text', value: 'text' },
  { label: 'XML', value: 'xml' },
  { label: 'HTML', value: 'html' },
  { label: 'JavaScript', value: 'javascript' }
];

const fileInput = ref(null);
const pendingUpload = ref(null);
const uploading = ref(false);

const body = computed(function () {
  if (!props.spec.body) props.spec.body = { mode: 'none' };
  return props.spec.body;
});

const mode = computed(function () {
  return body.value.mode || 'none';
});

function setMode(next) {
  const current = body.value;

  if (next === 'none') {
    props.spec.body = { mode: 'none' };
    return;
  }
  if (next === 'raw') {
    props.spec.body = {
      mode: 'raw',
      raw: current.mode === 'raw' ? current.raw : '',
      language: current.language || 'json'
    };
    return;
  }
  if (next === 'urlencoded' || next === 'formdata') {
    const rows = current.form || [];
    props.spec.body = {
      mode: next,
      form: rows.map(function (row) {
        return Object.assign({ kind: 'text', src: null }, row);
      })
    };
    return;
  }
  if (next === 'binary') {
    props.spec.body = { mode: 'binary', file: current.file || { src: null } };
    return;
  }
  if (next === 'graphql') {
    props.spec.body = {
      mode: 'graphql',
      graphql: current.graphql || { query: '', variables: '' }
    };
  }
}

/** 从绝对路径里取文件名，标签上只显示这个 */
function fileName(src) {
  const text = String(src || '');
  const at = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
  return at === -1 ? text : text.slice(at + 1);
}

/* ---------------- 表单行 ---------------- */

function formRows() {
  const list = (body.value.form || []).slice();
  const last = list[list.length - 1];
  if (!last || last.key !== '' || last.value !== '') {
    list.push({ key: '', value: '', enabled: true, kind: 'text', src: null, __draft: true });
  }
  return list;
}

function commitForm(list) {
  body.value.form = list.map(function (row) {
    const next = Object.assign({}, row);
    delete next.__draft;
    return next;
  });
}

function updateFormRow(index, patch) {
  const list = (body.value.form || []).slice();
  if (index >= list.length) {
    list.push({ key: '', value: '', enabled: true, kind: 'text', src: null });
  }
  Object.assign(list[index], patch);
  commitForm(list);
}

function removeFormRow(index) {
  const list = (body.value.form || []).slice();
  list.splice(index, 1);
  commitForm(list);
}

/* ---------------- 文件上传 ---------------- */

function pickFile(target) {
  pendingUpload.value = target;
  if (fileInput.value) {
    fileInput.value.value = '';
    fileInput.value.click();
  }
}

async function onFilePicked(event) {
  const file = event.target.files && event.target.files[0];
  const target = pendingUpload.value;
  pendingUpload.value = null;
  if (!file || !target) return;

  uploading.value = true;
  try {
    const data = await sendApi.uploadFile(props.projectId, file);
    if (target.kind === 'form') {
      updateFormRow(target.index, { src: data.src, value: data.src, kind: 'file' });
    } else {
      body.value.file = { src: data.src };
    }
    message.success('已上传 ' + data.name);
  } catch (err) {
    message.error(err.message);
  } finally {
    uploading.value = false;
  }
}
</script>

<template>
  <div class="body-editor">
    <n-space align="center" :size="8" class="head">
      <n-select
        size="small"
        style="width: 190px"
        :value="mode"
        :options="MODE_OPTIONS"
        @update:value="setMode"
      />
      <n-select
        v-if="mode === 'raw'"
        size="small"
        style="width: 130px"
        :value="body.language || 'json'"
        :options="LANGUAGE_OPTIONS"
        @update:value="(v) => { body.language = v; }"
      />
    </n-space>

    <div class="content">
      <template v-if="mode === 'raw'">
        <code-editor
          :model-value="body.raw || ''"
          :language="body.language || 'json'"
          min-height="220px"
          @update:model-value="(v) => { body.raw = v; }"
        />
      </template>

      <template v-else-if="mode === 'urlencoded' || mode === 'formdata'">
        <div class="form-table" :class="{ 'with-kind': mode === 'formdata' }">
          <div class="row head">
            <div class="cell check" />
            <div class="cell key">名称</div>
            <div class="cell kind" />
            <div class="cell value">值</div>
            <div class="cell action" />
          </div>

          <div v-for="(row, index) in formRows()" :key="index" class="row" :class="{ off: row.enabled === false }">
            <div class="cell check">
              <!-- 末尾的空行只是占位，不给复选框（勾着的空行像一条已启用的空参数） -->
              <n-checkbox
                v-if="!row.__draft"
                :checked="row.enabled !== false"
                @update:checked="(v) => updateFormRow(index, { enabled: v })"
              />
            </div>
            <div class="cell key">
              <n-input
                size="small"
                :value="row.key"
                :theme-overrides="BARE_INPUT_THEME"
                placeholder="名称"
                @update:value="(v) => updateFormRow(index, { key: v })"
              />
            </div>
            <div class="cell kind">
              <n-select
                v-if="mode === 'formdata'"
                size="small"
                style="width: 78px"
                :value="row.kind === 'file' ? 'file' : 'text'"
                :options="[{ label: '文本', value: 'text' }, { label: '文件', value: 'file' }]"
                @update:value="(v) => updateFormRow(index, { kind: v })"
              />
            </div>
            <div class="cell value">
              <template v-if="mode === 'formdata' && row.kind === 'file'">
                <!-- 选过文件之后显示「文件图标 + 文件名」的小标签，点它可以重选 -->
                <button
                  v-if="row.src"
                  class="file-tag"
                  :title="row.src"
                  @click="pickFile({ kind: 'form', index: index })"
                >
                  <n-icon size="13" :component="File" />
                  <span class="file-name">{{ fileName(row.src) }}</span>
                </button>
                <button
                  v-else
                  class="file-pick"
                  :disabled="uploading"
                  @click="pickFile({ kind: 'form', index: index })"
                >
                  {{ uploading ? '上传中…' : '选择文件' }}
                </button>
              </template>
              <var-input
                v-else
                :model-value="row.value"
                :scope="scope"
                placeholder="值"
                @update:model-value="(v) => updateFormRow(index, { value: v })"
              />
            </div>
            <div class="cell action">
              <button
                v-if="row.key || row.value"
                class="delete-button"
                title="删除这一行"
                @click="removeFormRow(index)"
              >
                <n-icon size="15" :component="Trash" />
              </button>
            </div>
          </div>
        </div>
      </template>

      <template v-else-if="mode === 'binary'">
        <n-space align="center" :size="8">
          <n-button size="small" :loading="uploading" @click="pickFile({ kind: 'binary' })">
            选择文件
          </n-button>
          <span class="file-path">{{ (body.file && body.file.src) || '尚未选择' }}</span>
        </n-space>
      </template>

      <template v-else-if="mode === 'graphql'">
        <div class="gql">
          <div class="gql-block">
            <p class="label">Query</p>
            <code-editor
              :model-value="(body.graphql && body.graphql.query) || ''"
              language="javascript"
              min-height="160px"
              @update:model-value="(v) => { body.graphql = Object.assign({ variables: '' }, body.graphql, { query: v }); }"
            />
          </div>
          <div class="gql-block">
            <p class="label">Variables（JSON）</p>
            <code-editor
              :model-value="(body.graphql && body.graphql.variables) || ''"
              language="json"
              min-height="120px"
              @update:model-value="(v) => { body.graphql = Object.assign({ query: '' }, body.graphql, { variables: v }); }"
            />
          </div>
        </div>
      </template>

      <p v-else class="empty">这个请求不带请求体。</p>
    </div>

    <input ref="fileInput" type="file" class="hidden-input" @change="onFilePicked" />
  </div>
</template>

<style scoped>
.body-editor {
  display: flex;
  flex-direction: column;
  gap: 10px;
  height: 100%;
  min-height: 0;
}

.head {
  flex: none;
}

.content {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.form-table {
  /* 和请求区的键值表格同一套细线网格；formdata 多一列「文本 / 文件」 */
  --form-cols: 32px minmax(0, 26%) minmax(0, 1fr) 40px;
  border: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.24));
  border-radius: 4px;
  overflow: hidden;
}

.form-table.with-kind {
  --form-cols: 32px minmax(0, 26%) 78px minmax(0, 1fr) 40px;
}

.row {
  display: grid;
  grid-template-columns: var(--form-cols);
  border-bottom: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.16));
}

.row:hover {
  background: rgba(128, 128, 128, 0.06);
}

.row .cell {
  min-width: 0;
  display: flex;
  align-items: center;
  min-height: 32px;
  padding: 0 8px;
  border-right: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.16));
}

.row .cell:last-child {
  border-right: none;
}

.row.head .cell {
  opacity: 0.6;
}

.row .cell:focus-within {
  background: rgba(255, 108, 55, 0.08);
}

.row.head .cell:focus-within {
  background: transparent;
}

.row .cell.check,
.row .cell.action {
  justify-content: center;
  padding: 0;
}

.row.off .cell.key,
.row.off .cell.value {
  opacity: 0.5;
}

.file-tag,
.file-pick {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 100%;
  padding: 2px 8px;
  border: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.32));
  border-radius: 4px;
  background: rgba(128, 128, 128, 0.08);
  color: inherit;
  font-size: 12px;
  cursor: pointer;
}

.file-tag:hover,
.file-pick:hover {
  border-color: var(--apiloop-primary);
}

.file-pick:disabled {
  opacity: 0.6;
  cursor: default;
}

.file-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.delete-button {
  width: 26px;
  height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  opacity: 0;
}

.row:hover .delete-button {
  opacity: 0.6;
}

.delete-button:hover {
  background: rgba(235, 32, 19, 0.12);
  color: #eb2013;
  opacity: 1;
}

.row:last-child {
  border-bottom: none;
}

.row.head {
  font-size: 12px;
  opacity: 0.65;
}

.cell {
  min-width: 0;
}

.cell.check {
  flex: none;
  width: 26px;
  display: flex;
  justify-content: center;
}

.cell.kind {
  flex: none;
}

.cell.action {
  flex: none;
  width: 52px;
  display: flex;
  justify-content: flex-end;
}

.cell.key {
  flex: 0 0 26%;
}

.cell.value {
  flex: 1;
}


.gql {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.label {
  margin: 0 0 4px;
  font-size: 12px;
  opacity: 0.65;
}

.empty {
  margin: 0;
  font-size: 13px;
  opacity: 0.55;
}

.hidden-input {
  display: none;
}
</style>
