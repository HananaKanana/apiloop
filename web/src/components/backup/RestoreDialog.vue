<script setup>
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { NAlert, NButton, NCheckbox, NForm, NFormItem, NInput, NModal, NSpace, NSpin, useMessage } from 'naive-ui';
import * as backupApi from '@/api/backup';
import { formatBytes } from '@/utils/bytes';
import { formatFullTime } from '@/utils/comment';
import { downloadText, readFileAsText } from '@/utils/download';

/**
 * 备份恢复对话框：选备份（文件或云端自动备份）→ 预览 → 二次确认 → 恢复。
 *
 * 两种模式：
 * - `new`：恢复成**新**项目，可以改名（默认用备份里的名字加「（恢复）」）；
 * - `overwrite`：覆盖 `pid` 这个项目，**必须手动输入当前项目名确认**，
 *   而且在真正覆盖之前**先自动下载一份当前项目的备份** —— 测试集覆盖时是直接删掉的，
 *   这份备份是找回它们的唯一途径。
 * - `merge`：合并更新进 `pid` 这个项目（用户 2026-10-22：内网导出、外网反复导入，见 lib/backup-merge.js）。
 *   选了文件先让服务端算一遍预览（新增 / 更新 / 没变、内网已删除的列表），确认后再写。
 *
 * 从文件恢复成**新**项目也走合并（不带 pid）：这样建出来的项目和以后的合并更新用同一套 id，
 * 再从同一个来源导入才认得出来（老的 `new` 每次都换随机 id，之后合并会全部重复）。
 *
 * 备份文件是整份项目数据（可能几 MB），**解析完的结果放在普通变量里、不进 ref**：
 * 让 Vue 把整棵对象做成响应式既慢又占内存，预览只需要几个数字（同 ImportDialog 的做法）。
 */
const props = defineProps({
  show: { type: Boolean, default: false },
  /** 'new' | 'overwrite' | 'merge' */
  mode: { type: String, default: 'new' },
  /** 覆盖哪个项目（`overwrite` 时必须给；`new` 时只用来定位云端自动备份） */
  pid: { type: String, default: '' },
  /** 当前项目名 —— 覆盖时要求用户输入它来确认 */
  projectName: { type: String, default: '' },
  /** 非空表示「从云端这一份自动备份恢复」，不用选文件 */
  autoId: { type: String, default: '' },
  autoAt: { type: Number, default: 0 },
  autoSize: { type: Number, default: 0 }
});

const emit = defineEmits(['update:show', 'restored']);

const { t } = useI18n();
const message = useMessage();

const fileInput = ref(null);

/** 解析好的备份对象（不进 ref，见文件头） */
let payload = null;

const busy = ref(false);
const errorText = ref('');
const fileInfo = ref('');
const preview = ref(null);
const newName = ref('');
const confirmName = ref('');
const restoring = ref(false);
const result = ref(null);
/** 合并更新的预览（服务端算的）：`{ counts, removable }`；要删的那几条 id */
const mergePreview = ref(null);
const mergeRemove = ref([]);

const visible = computed({
  get: function () { return props.show; },
  set: function (value) { emit('update:show', value); }
});

const title = computed(function () {
  if (props.mode === 'merge') return t('backup.restoreMergeTitle');
  return props.mode === 'overwrite' ? t('backup.restoreOverwriteTitle') : t('backup.restoreNewTitle');
});

/** 真正发给服务端的模式：从文件恢复成新项目也走 merge（见文件头）；云端自动备份照旧 */
function serverMode() {
  if (props.mode === 'merge') return 'merge';
  if (props.mode === 'new' && !props.autoId) return 'merge';
  return props.mode;
}

async function loadMergePreview() {
  if (props.mode !== 'merge' || !payload) return;
  busy.value = true;
  try {
    const data = await backupApi.restoreBackup({ backup: payload, mode: 'merge', projectId: props.pid, preview: true });
    mergePreview.value = { counts: data.counts || {}, removable: data.removable || [] };
    mergeRemove.value = [];
  } catch (err) {
    mergePreview.value = null;
    errorText.value = err.message;
  } finally {
    busy.value = false;
  }
}

function toggleRemove(id, checked) {
  const list = mergeRemove.value.filter(function (item) { return item !== id; });
  if (checked) list.push(id);
  mergeRemove.value = list;
}

function kindLabel(kind) {
  return t('backup.mergeKind_' + kind);
}

/** 覆盖时必须一字不差地输入当前项目名（项目名没拿到就一律不放行） */
const confirmed = computed(function () {
  if (props.mode !== 'overwrite') return true;
  if (!props.projectName) return false;
  return confirmName.value.trim() === props.projectName;
});

const canSubmit = computed(function () {
  if (props.mode === 'merge' && !mergePreview.value) return false;
  return Boolean(payload) && confirmed.value && !busy.value;
});

/** 备份文件 → 预览用的几个数字；格式不对就抛（文案给用户看） */
function readBackup(text) {
  let data = null;
  try {
    data = JSON.parse(text);
  } catch (err) {
    data = null;
  }

  if (!data || typeof data !== 'object' || data.format !== 'apiloop-backup' || !data.project) {
    throw new Error(t('backup.notBackup'));
  }

  const counts = function (list) { return (list || []).length; };
  return {
    data: data,
    info: {
      name: String(data.project.name || ''),
      exportedAt: Number(data.exportedAt) || 0,
      folders: counts(data.folders),
      apis: counts(data.apis),
      examples: counts(data.examples),
      expectations: counts(data.expectations),
      environments: counts(data.environments),
      suites: counts(data.suites)
    }
  };
}

function reset() {
  payload = null;
  busy.value = false;
  errorText.value = '';
  fileInfo.value = '';
  preview.value = null;
  newName.value = '';
  confirmName.value = '';
  restoring.value = false;
  result.value = null;
  mergePreview.value = null;
  mergeRemove.value = [];
}

/** 恢复成新项目时默认叫「<备份里的名字>（恢复）」；用户已经改过就不动 */
function suggestName(info) {
  if (props.mode !== 'new' || newName.value) return;
  newName.value = info.name ? info.name + t('backup.nameSuffix') : '';
}

async function loadAuto() {
  busy.value = true;
  errorText.value = '';
  try {
    const file = await backupApi.exportAutoBackup(props.pid, props.autoId);
    const parsed = readBackup(file.text);
    payload = parsed.data;
    preview.value = parsed.info;
    fileInfo.value = file.filename;
    suggestName(parsed.info);
  } catch (err) {
    payload = null;
    preview.value = null;
    errorText.value = err.message;
  } finally {
    busy.value = false;
  }
}

watch(
  function () { return props.show; },
  function (open) {
    reset();
    if (open && props.autoId) loadAuto();
  },
  { immediate: true }
);

function pickFile() {
  if (fileInput.value) {
    fileInput.value.value = '';
    fileInput.value.click();
  }
}

async function onFile(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  busy.value = true;
  errorText.value = '';
  payload = null;
  preview.value = null;
  try {
    const text = await readFileAsText(file);
    const parsed = readBackup(text);
    payload = parsed.data;
    preview.value = parsed.info;
    fileInfo.value = file.name;
    suggestName(parsed.info);
  } catch (err) {
    errorText.value = err.message;
    fileInfo.value = '';
  } finally {
    busy.value = false;
  }
  await loadMergePreview();
}

/**
 * 覆盖之前先下载一份当前项目的备份。**下载（请求）失败就中止** ——
 * 宁可让用户重来一次，也不能把他现在的测试集悄悄换掉。
 */
async function backupCurrent() {
  const file = await backupApi.exportBackup(props.pid);
  downloadText(file.filename, file.text, 'application/json');
}

async function submit() {
  if (!payload) {
    message.warning(t('backup.noFile'));
    return;
  }

  restoring.value = true;
  try {
    if (props.mode === 'overwrite') {
      try {
        await backupCurrent();
      } catch (err) {
        message.error(t('backup.backupFirstFailed', { message: err.message }));
        return;
      }
    }

    const name = props.mode === 'new' ? newName.value.trim() : '';
    const data = props.autoId
      ? await backupApi.restoreAutoBackup(props.pid, props.autoId, { mode: props.mode, name: name })
      : await backupApi.restoreBackup({
        backup: payload,
        mode: serverMode(),
        name: name,
        projectId: props.mode === 'overwrite' || props.mode === 'merge' ? props.pid : '',
        remove: props.mode === 'merge' ? mergeRemove.value : []
      });

    result.value = data || {};
    emit('restored', data || {});
  } catch (err) {
    message.error(err.message);
  } finally {
    restoring.value = false;
  }
}

function close() {
  visible.value = false;
}

/** 合并计数 → 文案参数（缺的当 0） */
function mergeCounts(counts) {
  const c = counts || {};
  return {
    added: Number(c.added) || 0,
    updated: Number(c.updated) || 0,
    unchanged: Number(c.unchanged) || 0,
    vars: Number(c.varsAdded) || 0,
    removed: Number(c.removed) || 0
  };
}
</script>

<template>
  <n-modal
    v-model:show="visible"
    preset="card"
    :title="title"
    style="width: 520px; max-width: 94vw"
  >
    <div class="dialog">
      <!-- 恢复完的收尾：说清楚哪些东西进回收站 / 被删了，再把 warnings 列出来 -->
      <template v-if="result">
        <n-alert type="success" :show-icon="false" :title="t('backup.doneTitle')">
          <template v-if="mode === 'merge'">
            {{ t('backup.doneMerge', mergeCounts(result.counts)) }}
          </template>
          <template v-else-if="mode === 'overwrite'">
            {{ t('backup.doneOverwrite', { n: Number(result.deletedSuites) || 0 }) }}
          </template>
          <template v-else>
            {{ t('backup.doneNew', { name: result.project ? result.project.name : '' }) }}
          </template>
        </n-alert>

        <div v-if="result.warnings && result.warnings.length" class="warnings">
          <p class="warnings-title">{{ t('backup.warningsTitle') }}</p>
          <ul class="warnings-list">
            <li v-for="(item, index) in result.warnings" :key="index">{{ item }}</li>
          </ul>
        </div>
      </template>

      <template v-else>
        <n-alert v-if="mode === 'overwrite'" type="warning" :show-icon="false">
          {{ t('backup.overwriteWarning') }}
          {{ t('backup.beforeRestoreDownload') }}
        </n-alert>

        <!-- 云端自动备份：不用选文件，打开就去把那一种读回来做预览 -->
        <div v-if="autoId" class="auto-line">
          <span class="auto-time">{{ formatFullTime(autoAt) }}</span>
          <span class="auto-size">{{ formatBytes(autoSize) }}</span>
        </div>

        <div v-else class="picker">
          <n-space align="center">
            <n-button size="small" :loading="busy" @click="pickFile">{{ t('backup.pickFile') }}</n-button>
            <span class="file-name">{{ fileInfo || t('backup.pickFileHint') }}</span>
          </n-space>
        </div>

        <n-alert v-if="errorText" type="error" :show-icon="false" class="block">
          {{ errorText }}
        </n-alert>

        <n-spin v-if="busy" size="small" class="block">{{ t('backup.previewLoading') }}</n-spin>

        <div v-if="preview" class="preview">
          <p class="preview-title">{{ t('backup.previewTitle') }}</p>
          <div class="line">
            <span class="label">{{ t('backup.previewName') }}</span>
            <span class="value strong">{{ preview.name || '—' }}</span>
          </div>
          <div class="line">
            <span class="label">{{ t('backup.previewExportedAt') }}</span>
            <span class="value">{{ formatFullTime(preview.exportedAt) || '—' }}</span>
          </div>
          <div class="counts">
            <span>{{ t('backup.previewFolders') }} {{ preview.folders }}</span>
            <span>{{ t('backup.previewApis') }} {{ preview.apis }}</span>
            <span>{{ t('backup.previewExamples') }} {{ preview.examples }}</span>
            <span>{{ t('backup.previewExpectations') }} {{ preview.expectations }}</span>
            <span>{{ t('backup.previewEnvironments') }} {{ preview.environments }}</span>
            <span>{{ t('backup.previewSuites') }} {{ preview.suites }}</span>
          </div>
        </div>

        <template v-if="mode === 'merge'">
          <n-alert v-if="!preview" type="info" :show-icon="false" class="block">
            {{ t('backup.mergeHint') }}
          </n-alert>
          <div v-if="mergePreview" class="preview">
            <p class="preview-title">{{ t('backup.mergePreviewTitle') }}</p>
            <p class="merge-counts">{{ t('backup.mergeCounts', mergeCounts(mergePreview.counts)) }}</p>
            <template v-if="mergePreview.removable.length">
              <p class="preview-title">{{ t('backup.mergeRemovedTitle', { n: mergePreview.removable.length }) }}</p>
              <p class="tip">{{ t('backup.mergeRemovedHint') }}</p>
              <div class="removable">
                <n-checkbox
                  v-for="item in mergePreview.removable"
                  :key="item.id"
                  size="small"
                  :checked="mergeRemove.indexOf(item.id) > -1"
                  @update:checked="(value) => toggleRemove(item.id, value)"
                >
                  {{ kindLabel(item.kind) }} · {{ item.name || '—' }}
                </n-checkbox>
              </div>
            </template>
          </div>
        </template>

        <n-form v-if="mode === 'new'" label-placement="top" class="block">
          <n-form-item :label="t('backup.newNameLabel')">
            <n-input v-model:value="newName" :placeholder="t('backup.newNamePlaceholder')" />
          </n-form-item>
        </n-form>

        <n-form v-if="mode === 'overwrite'" label-placement="top" class="block">
          <n-form-item :label="t('backup.overwriteConfirmLabel', { name: projectName })">
            <n-input
              v-model:value="confirmName"
              :placeholder="t('backup.overwriteConfirmPlaceholder', { name: projectName })"
            />
          </n-form-item>
        </n-form>
      </template>
    </div>

    <template #footer>
      <n-space justify="end">
        <template v-if="result">
          <n-button type="primary" @click="close">{{ t('backup.closeAction') }}</n-button>
        </template>
        <template v-else>
          <n-button @click="close">{{ t('app.cancel') }}</n-button>
          <n-button type="primary" :loading="restoring" :disabled="!canSubmit" @click="submit">
            {{ mode === 'merge' ? t('backup.mergeAction') : t('backup.restoreAction') }}
          </n-button>
        </template>
      </n-space>
    </template>

    <input
      ref="fileInput"
      type="file"
      accept=".json,application/json"
      class="hidden-input"
      @change="onFile"
    />
  </n-modal>
</template>

<style scoped>
.dialog {
  display: flex;
  flex-direction: column;
  gap: 12px;
  font-size: 13px;
}

.block {
  margin: 0;
}

.hidden-input {
  display: none;
}

.picker .file-name {
  font-size: 12px;
  opacity: 0.7;
}

.auto-line {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  opacity: 0.75;
}

.auto-size {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.preview {
  padding: 10px 12px;
  border-radius: 6px;
  background: rgba(128, 128, 128, 0.06);
}

.preview-title {
  margin: 0 0 8px;
  font-size: 12px;
  font-weight: 600;
  opacity: 0.8;
}

.line {
  display: flex;
  gap: 12px;
  line-height: 1.8;
}

.label {
  flex: none;
  width: 76px;
  opacity: 0.6;
  font-size: 12px;
}

.value {
  min-width: 0;
  word-break: break-all;
}

.value.strong {
  font-weight: 600;
}

.counts {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 6px;
  font-size: 12px;
  opacity: 0.65;
}

.warnings-title {
  margin: 0 0 6px;
  font-size: 12px;
  font-weight: 600;
}

.warnings-list {
  margin: 0;
  padding-left: 20px;
  font-size: 12px;
  line-height: 1.8;
  opacity: 0.8;
}
.merge-counts {
  margin: 0 0 8px;
  font-size: 13px;
}

.removable {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 180px;
  overflow: auto;
}

</style>
