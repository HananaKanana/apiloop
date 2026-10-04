<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { NAlert, NButton, NIcon, NRadioButton, NRadioGroup, useMessage } from 'naive-ui';
import { File } from '@vicons/tabler';
import { useProjectStore } from '@/stores/project';
import * as suitesApi from '@/api/suites';

/**
 * 测试集的「数据」页签（数据驱动，第八轮第 1 节）。
 *
 * 一份数据就是一列列变量：**每一行跑一轮**。可以粘贴，也可以选文件（读进来存在测试集里，
 * 不另存文件）。预览走服务端的 `preview-data` —— 解析只有一份实现（`lib/suite-data.js`），
 * 前端不再写一份，两边判断「哪一行错了」的口径才一致。
 */
const props = defineProps({
  suite: { type: Object, required: true },
  disabled: { type: Boolean, default: false }
});

const emit = defineEmits(['change']);

const projects = useProjectStore();
const message = useMessage();

const canEdit = computed(function () { return projects.canEdit && !props.disabled; });

const format = ref('none');
const text = ref('');
const fileName = ref('');

const preview = ref(null);
const previewError = ref('');
const loading = ref(false);

let timer = null;
const fileInput = ref(null);

/** 从 suite 初始化（切测试集 / 外面改了之后同步） */
function fillFrom(suite) {
  const data = suite.data || null;
  format.value = data && data.format ? data.format : 'none';
  text.value = data && data.text ? data.text : '';
  fileName.value = (data && data.fileName) || '';
  preview.value = null;
  previewError.value = '';
  if (format.value !== 'none') runPreview();
}

watch(
  function () { return props.suite.id; },
  function () { fillFrom(props.suite); },
  { immediate: true }
);

function emitChange() {
  emit('change', {
    data: format.value === 'none'
      ? null
      : { format: format.value, fileName: fileName.value, text: text.value }
  });
}

function schedule() {
  emitChange();
  if (timer) clearTimeout(timer);
  timer = setTimeout(runPreview, 500);
}

watch(format, function (value) {
  if (value === 'none') {
    if (timer) clearTimeout(timer);
    preview.value = null;
    previewError.value = '';
    emitChange();
    return;
  }
  schedule();
});

onBeforeUnmount(function () { if (timer) clearTimeout(timer); });

async function runPreview() {
  if (format.value === 'none' || !text.value.trim()) {
    preview.value = null;
    previewError.value = '';
    return;
  }

  loading.value = true;
  try {
    const data = await suitesApi.previewData(projects.currentId, {
      format: format.value,
      text: text.value
    });
    preview.value = data;
    previewError.value = '';
  } catch (err) {
    preview.value = null;
    previewError.value = err.message;
  } finally {
    loading.value = false;
  }
}

/** 输入框里的提示（含换行和引号，写在模板里会被属性引号截断） */
const placeholder = computed(function () {
  if (format.value === 'csv') {
    return '第一行是列名，逗号分隔：\n账号,密码\nuser1,pass1\nuser2,pass2';
  }
  return '[{"账号":"user1","密码":"pass1"}]';
});

function pickFile() {
  if (fileInput.value) fileInput.value.click();
}

function onFilePicked(event) {
  const file = event.target.files && event.target.files[0];
  event.target.value = '';
  if (!file) return;

  if (file.size > 2 * 1024 * 1024) {
    message.error('文件超过 2 MB 了，拆小一点');
    return;
  }

  const reader = new FileReader();
  reader.onload = function () {
    text.value = String(reader.result || '');
    fileName.value = file.name;
    // 按扩展名猜一下格式，猜错了用户自己改
    if (!format.value || format.value === 'none') {
      format.value = /\.json$/i.test(file.name) ? 'json' : 'csv';
    }
    schedule();
  };
  reader.onerror = function () { message.error('读文件失败'); };
  reader.readAsText(file);
}
</script>

<template>
  <div class="pane">
    <div class="toolbar">
      <n-radio-group :value="format" size="small" :disabled="!canEdit" @update:value="(value) => { format = value; }">
        <n-radio-button value="none">不用数据</n-radio-button>
        <n-radio-button value="csv">CSV</n-radio-button>
        <n-radio-button value="json">JSON</n-radio-button>
      </n-radio-group>

      <n-button v-if="format !== 'none'" size="small" secondary :disabled="!canEdit" @click="pickFile">
        <template #icon><n-icon :component="File" /></template>
        选文件
      </n-button>
      <span v-if="fileName" class="file">{{ fileName }}</span>
    </div>

    <template v-if="format !== 'none'">
      <p class="hint">
        每一行跑一轮。列名就是变量名，接口里写 <code v-pre>{{列名}}</code> 就能用；
        脚本里用 <code>pm.iterationData.get('列名')</code>。<strong>数据变量优先于环境变量。</strong>
        上限 1000 行 / 2 MB。
      </p>

      <textarea
        v-model="text"
        class="editor"
        :disabled="!canEdit"
        spellcheck="false"
        :placeholder="placeholder"
        @input="schedule"
      />

      <n-alert v-if="previewError" type="error" :show-icon="false" class="alert">
        {{ previewError }}
      </n-alert>

      <div v-else-if="preview" class="preview">
        <p class="count">共 {{ preview.total }} 行，会跑 {{ preview.total }} 轮（下面预览前 20 行）</p>
        <div class="table-wrap">
          <table class="grid">
            <thead>
              <tr>
                <th class="seq">#</th>
                <th v-for="column in preview.columns" :key="column">{{ column }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, index) in preview.rows" :key="index">
                <td class="seq">{{ index + 1 }}</td>
                <td v-for="column in preview.columns" :key="column" :title="row[column]">{{ row[column] }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>

    <p v-else class="hint">不用数据时，按「设置」里那个轮数跑（默认 1 轮）。</p>

    <input ref="fileInput" type="file" accept=".csv,.json,text/csv,application/json" class="hidden" @change="onFilePicked" />
  </div>
</template>

<style scoped>
.pane {
  padding: 10px 14px 16px;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.file {
  font-size: 12px;
  opacity: 0.6;
}

.hint {
  margin: 0 0 8px;
  font-size: 12px;
  line-height: 1.8;
  opacity: 0.65;
}

.hint code {
  padding: 1px 4px;
  border-radius: 3px;
  background: rgba(128, 128, 128, 0.14);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.editor {
  width: 100%;
  min-height: 160px;
  padding: 8px 10px;
  border: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.24));
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  line-height: 1.7;
  resize: vertical;
  outline: none;
}

.alert {
  margin-top: 10px;
}

.preview {
  margin-top: 10px;
}

.count {
  margin: 0 0 6px;
  font-size: 12px;
  opacity: 0.7;
}

.table-wrap {
  max-height: 260px;
  overflow: auto;
  border: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.2));
  border-radius: 6px;
}

.grid {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.grid th,
.grid td {
  padding: 4px 8px;
  text-align: left;
  border-bottom: 1px solid rgba(128, 128, 128, 0.12);
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.grid th {
  position: sticky;
  top: 0;
  background: var(--apiloop-surface);
  opacity: 0.7;
  font-weight: 500;
}

.grid .seq {
  width: 36px;
  opacity: 0.45;
}

.hidden {
  display: none;
}
</style>
