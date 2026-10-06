<script setup>
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { NButton, NCheckbox, NForm, NFormItem, NModal, NRadio, NRadioGroup, NSpace, useMessage } from 'naive-ui';
import * as exportDocApi from '@/api/exportDoc';
import { downloadBlob } from '@/utils/download';
import { useEnvStore } from '@/stores/env';
import { useProjectStore } from '@/stores/project';
import { mockBaseFor } from '@/utils/mock';

/**
 * 「导出文档…」的小弹窗（第九轮第 2 节）。
 *
 * 三件事：格式、范围、三个选项。范围由调用方定 —— 项目菜单进来是整个项目，
 * 目录右键进来默认是那个目录（含子目录），服务端按 `folderId` 划。
 *
 * 文件在**服务端生成**（读本机库），前端只负责落盘：三种格式的排版规则都在
 * `lib/export-doc.js` 里，和分享文档页用的是同一份数据和同一套打码。
 */
const props = defineProps({
  show: { type: Boolean, default: false },
  pid: { type: String, default: '' },
  /** 从目录右键进来时给这个目录；项目菜单进来是空 */
  folderId: { type: String, default: null },
  scopeName: { type: String, default: '' }
});

const emit = defineEmits(['update:show']);

const envs = useEnvStore();
const projects = useProjectStore();
const message = useMessage();
const { t } = useI18n();

const format = ref('md');
const scope = ref('project');
const examples = ref(true);
const mock = ref(false);
const doneOnly = ref(false);
const exporting = ref(false);

const show = computed({
  get: function () { return props.show; },
  set: function (value) { emit('update:show', value); }
});

/** 目录右键进来时默认导这个目录，也可以切回整个项目 */
const hasFolder = computed(function () { return Boolean(props.folderId); });

const title = computed(function () {
  return props.scopeName ? t('importExport.exportDocFor', { name: props.scopeName }) : t('importExport.exportDoc');
});

// 每次打开回到默认：整个项目（没从目录进来时没有第二个选项）、带示例响应
watch(function () { return props.show; }, function (value) {
  if (!value) return;
  format.value = 'md';
  scope.value = props.folderId ? 'folder' : 'project';
  examples.value = true;
  mock.value = false;
  doneOnly.value = false;
});

async function confirm() {
  if (!props.pid) return;

  exporting.value = true;
  try {
    const folderId = scope.value === 'folder' ? props.folderId : null;

    const data = await exportDocApi.downloadDoc(props.pid, {
      format: format.value,
      folderId: folderId,
      examples: examples.value,
      mock: mock.value,
      doneOnly: doneOnly.value,
      // 「包含 Mock 地址」时把本机的 Mock 基地址带上（服务端不知道对外的域名和端口）
      mockBase: mock.value ? mockBaseFor(envs.selectedId, projects.current) : ''
    });

    downloadBlob(data.filename, data.blob);
    message.success(t('importExport.exported'));
    show.value = false;
  } catch (err) {
    message.error(err.message);
  } finally {
    exporting.value = false;
  }
}
</script>

<template>
  <n-modal
    v-model:show="show"
    preset="card"
    :title="title"
    style="width: 480px; max-width: 92vw"
  >
    <n-form label-placement="left" label-width="60">
      <n-form-item :label="t('importExport.format')">
        <n-radio-group v-model:value="format">
          <n-space vertical size="small">
            <n-radio value="md">Markdown（.md）</n-radio>
            <n-radio value="html">{{ t('importExport.formatHtml') }}</n-radio>
            <n-radio value="docx">Word（.docx）</n-radio>
          </n-space>
        </n-radio-group>
      </n-form-item>

      <n-form-item v-if="hasFolder" :label="t('importExport.scope')">
        <n-radio-group v-model:value="scope">
          <n-space vertical size="small">
            <n-radio value="folder">{{ t('importExport.thisFolder', { name: scopeName }) }}</n-radio>
            <n-radio value="project">{{ t('importExport.wholeProject') }}</n-radio>
          </n-space>
        </n-radio-group>
      </n-form-item>

      <n-form-item :label="t('importExport.options')">
        <n-space vertical size="small">
          <n-checkbox v-model:checked="examples">{{ t('importExport.withExamples') }}</n-checkbox>
          <n-checkbox v-model:checked="mock">{{ t('importExport.withMockUrl') }}</n-checkbox>
          <n-checkbox v-model:checked="doneOnly">{{ t('importExport.doneOnly') }}</n-checkbox>
        </n-space>
      </n-form-item>
    </n-form>

    <p class="hint">{{ t('importExport.exportDocHint') }}</p>

    <template #footer>
      <n-space justify="end">
        <n-button @click="show = false">{{ t('app.cancel') }}</n-button>
        <n-button type="primary" :loading="exporting" @click="confirm">{{ t('importExport.exportAction') }}</n-button>
      </n-space>
    </template>
  </n-modal>
</template>

<style scoped>
.hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  opacity: 0.6;
}
</style>
