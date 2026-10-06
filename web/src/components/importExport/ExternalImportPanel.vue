<script setup>
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { NAlert, NButton, NInput, NRadioButton, NRadioGroup, NSpace, useMessage } from 'naive-ui';
import * as importExportApi from '@/api/importExport';
import { useProjectStore } from '@/stores/project';
import { useTreeStore } from '@/stores/tree';
import { readFileAsText } from '@/utils/download';

/**
 * YApi / Apifox 的导入面板（第九轮第 1 节）。
 *
 * 和「JSON 文件」那个页签是同一套流程（选文件 / 粘贴 → 解析预览 → 导入到新项目或当前项目），
 * 只是**服务端会自动认格式**：所以这里不传「我这是 YApi」，识别结果由服务端给回来，
 * 用户把文件贴错页签也能导进去（识别到别的格式时预览里会显示出来）。
 *
 * 单独抽成一个组件是因为两个新格式要一模一样的界面 —— 复制两遍的话，改一处忘另一处。
 */
const props = defineProps({
  /** 只用来决定文案（「YApi（JSON 导出文件）」这种），不影响解析 */
  format: { type: String, required: true }
});

const projects = useProjectStore();
const tree = useTreeStore();
const message = useMessage();
const { t } = useI18n();

/** 两个格式的输入框提示。用 computed 包住，切语言后跟着变 */
const LABELS = computed(function () {
  return {
    yapi: { title: 'YApi', placeholder: t('importExport.yapiPlaceholder') },
    apifox: { title: 'Apifox', placeholder: t('importExport.apifoxPlaceholder') }
  };
});

const label = computed(function () {
  return LABELS.value[props.format] || LABELS.value.yapi;
});

const canEdit = computed(function () { return projects.canEdit; });

/**
 * 文件内容放在**普通变量**里，不进 ref：几十 MB 的导出文件塞进带 autosize 的 textarea，
 * 浏览器和 naive-ui 会各复制一份到 DOM，界面直接卡死（和 JSON 文件那个页签同一个坑）。
 */
let fileText = null;

const text = ref('');
const fileInfo = ref('');
const preview = ref(null);
const mode = ref('new');
const busy = ref(false);

function payload() {
  return fileText === null ? text.value : fileText;
}

function pickFile() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.onchange = function () {
    const file = input.files && input.files[0];
    if (!file) return;

    readFileAsText(file).then(function (content) {
      fileText = content;
      fileInfo.value = file.name;
      text.value = '';
      preview.value = null;
    }).catch(function (err) {
      message.error(err.message);
    });
  };
  input.click();
}

function clearFile() {
  fileText = null;
  fileInfo.value = '';
  preview.value = null;
}

async function runPreview() {
  if (!String(payload() || '').trim()) {
    message.warning(t('importExport.pickOrPaste'));
    return;
  }

  busy.value = true;
  try {
    preview.value = await importExportApi.previewPostman(payload());
    mode.value = 'new';
  } catch (err) {
    preview.value = null;
    message.error(err.message);
  } finally {
    busy.value = false;
  }
}

/** 预览里「识别为」那一行。postman 是格式名，保留原样（见提交总结里那条提醒） */
const FORMAT_LABELS = computed(function () {
  return { postman: t('importExport.formatPostman'), yapi: 'YApi', apifox: 'Apifox' };
});

async function runImport() {
  busy.value = true;
  try {
    const data = await importExportApi.importPostman(payload(), {
      mode: mode.value,
      projectId: mode.value === 'into' ? projects.currentId : undefined
    });

    if (mode.value === 'new' && data.project) {
      await projects.load();
      projects.setCurrent(data.project.id);
      await tree.load(data.project.id);
    } else {
      await tree.refresh();
    }

    message.success(t('importExport.done'));
    clearFile();
    text.value = '';
    preview.value = null;
  } catch (err) {
    message.error(err.message);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="pane">
    <n-space align="center" :size="8">
      <n-button size="small" @click="pickFile">{{ t('importExport.pickFile') }}</n-button>
      <template v-if="fileInfo">
        <span class="hint">{{ fileInfo }}</span>
        <n-button size="small" quaternary @click="clearFile">{{ t('importExport.clear') }}</n-button>
      </template>
      <span v-else class="hint">{{ t('importExport.orPaste') }}</span>
    </n-space>

    <n-input
      v-if="!fileInfo"
      v-model:value="text"
      type="textarea"
      :autosize="{ minRows: 6, maxRows: 12 }"
      :placeholder="label.placeholder"
      @update:value="preview = null"
    />

    <n-space align="center" :size="8">
      <n-button size="small" secondary :loading="busy" @click="runPreview">{{ t('importExport.preview') }}</n-button>
    </n-space>

    <template v-if="preview">
      <n-alert type="info" :show-icon="false" class="notice">
        <div>{{ t('importExport.detected') }} {{ FORMAT_LABELS[preview.format] || preview.format }}</div>
        <div>{{ t('importExport.nameLabel') }} {{ preview.name }}</div>
        <div v-if="preview.stats">
          {{ t('importExport.stats', { folders: preview.stats.folders, apis: preview.stats.apis, examples: preview.stats.examples }) }}
          <template v-if="preview.stats.scripts">{{ t('importExport.statsScripts', { n: preview.stats.scripts }) }}</template>
          <template v-if="preview.stats.environments">{{ t('importExport.statsEnvs', { n: preview.stats.environments }) }}</template>
        </div>
      </n-alert>

      <n-alert
        v-for="(warning, index) in preview.warnings || []"
        :key="index"
        type="warning"
        :show-icon="false"
        class="notice"
      >
        {{ warning }}
      </n-alert>

      <n-radio-group v-if="canEdit" v-model:value="mode">
        <n-space vertical size="small">
          <n-radio-button value="new">{{ t('importExport.newProject') }}</n-radio-button>
          <n-radio-button value="into">
            {{ t('importExport.intoCurrent') }}{{ projects.current ? t('importExport.quoted', { name: projects.current.name }) : '' }}
          </n-radio-button>
        </n-space>
      </n-radio-group>
      <p v-else class="hint">{{ t('importExport.readonlyHint') }}</p>

      <n-space justify="end">
        <n-button size="small" type="primary" :loading="busy" @click="runImport">{{ t('importExport.importAction') }}</n-button>
      </n-space>
    </template>
  </div>
</template>

<style scoped>
.pane {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.hint {
  font-size: 12px;
  opacity: 0.6;
}

.notice {
  white-space: pre-wrap;
}
</style>
