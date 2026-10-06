<script setup>
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { NAlert, NButton, NCard, NEmpty, NSpace, NSpin, useMessage } from 'naive-ui';
import * as backupApi from '@/api/backup';
import { formatBytes } from '@/utils/bytes';
import { formatFullTime } from '@/utils/comment';
import { downloadText } from '@/utils/download';
import { useEnvStore } from '@/stores/env';
import { useGatewayStore } from '@/stores/gateway';
import { useProjectStore } from '@/stores/project';
import { useTabsStore } from '@/stores/tabs';
import { useTreeStore } from '@/stores/tree';
import RestoreDialog from './RestoreDialog.vue';

/**
 * 项目设置 → 「备份」页签。
 *
 * 三块：
 * - 下载备份（editor 及以上）：把整个项目导出成一个 JSON 文件；
 * - 从备份文件恢复（覆盖当前项目，只有 owner / 管理员）：先自动下载一份当前项目的备份再覆盖；
 * - 云端自动备份（owner）：云端每天写的那几份，可以下载，也可以直接拿来恢复。
 *
 * 「云端自动备份」那块的接口只有云端有：网关上没登录时请求会被挡在 409，
 * 这时不请求、直接说明（同 InstallDialog 对安装包列表的做法）。
 * 编辑器 / 只读角色看不了它（后端要 owner），所以整块不渲染，不是禁用。
 */
const props = defineProps({
  pid: { type: String, default: '' }
});

const { t } = useI18n();
const projects = useProjectStore();
const gateway = useGatewayStore();
const tree = useTreeStore();
const envs = useEnvStore();
const tabs = useTabsStore();
const message = useMessage();

/**
 * 这一块描述的是**传进来的那个项目**（`pid`），不是全局选中的那个 ——
 * 页面是按 `route.params.pid` 打开的，正常情况下两者一样，但不靠它。
 * 角色也照这个项目算（覆盖恢复的按钮、自动备份列都只在 owner 时才给）。
 */
const project = computed(function () {
  return projects.projects.find(function (item) { return item.id === props.pid; }) || null;
});

const myRole = computed(function () {
  return (project.value && project.value.myRole) || '';
});

const canEdit = computed(function () {
  return myRole.value === 'admin' || myRole.value === 'owner' || myRole.value === 'editor';
});

const isOwner = computed(function () {
  return myRole.value === 'admin' || myRole.value === 'owner';
});

const projectName = computed(function () {
  return (project.value && project.value.name) || '';
});

/* ---------------- 下载备份 ---------------- */

const downloading = ref(false);

async function download() {
  downloading.value = true;
  try {
    const file = await backupApi.exportBackup(props.pid);
    downloadText(file.filename, file.text, 'application/json');
    message.success(t('backup.downloaded'));
  } catch (err) {
    message.error(err.message);
  } finally {
    downloading.value = false;
  }
}

/* ---------------- 恢复对话框 ---------------- */

const showRestore = ref(false);
/** 这一次恢复的目标：从文件还是从某一份云端备份，恢复成新项目还是覆盖 */
const target = ref({ mode: 'overwrite', autoId: '', autoAt: 0, autoSize: 0 });

function openRestore(options) {
  target.value = options;
  showRestore.value = true;
}

/* ---------------- 云端自动备份 ---------------- */

const autoLoading = ref(false);
const autoLoaded = ref(false);
const autoError = ref('');
const autoEnabled = ref(true);
const autoItems = ref([]);

async function loadAuto() {
  if (!isOwner.value) return;

  // 没登录：这些文件在云端的磁盘上，本机拿不到 —— 不请求，直接说明
  if (!gateway.cloudFeaturesAvailable) {
    autoItems.value = [];
    autoError.value = '';
    autoLoaded.value = true;
    return;
  }

  autoLoading.value = true;
  autoError.value = '';
  try {
    const setting = await backupApi.getBackupSetting();
    autoEnabled.value = !setting.backup || setting.backup.enabled !== false;

    const data = await backupApi.listBackups(props.pid);
    autoItems.value = data.items || [];
    autoLoaded.value = true;
  } catch (err) {
    // 只有云端有的功能在没登录时是 409、角色不够是 403，都原样提示服务端的话
    autoError.value = err.message;
    autoItems.value = [];
  } finally {
    autoLoading.value = false;
  }
}

async function downloadAuto(item) {
  try {
    const file = await backupApi.exportAutoBackup(props.pid, item.id);
    downloadText(file.filename, file.text, 'application/json');
    message.success(t('backup.downloaded'));
  } catch (err) {
    message.error(err.message);
  }
}

/* ---------------- 恢复之后刷新 ---------------- */

/**
 * 覆盖之后项目里的目录 / 接口 / 环境全换了一批：
 * 目录树和环境要重新拉一份；打开着的接口标签页指向的 id 已经不存在了，
 * 走目录树自己那套 `syncWithApis` / `syncWithFolders` 把它们收掉。
 */
async function onRestored() {
  const mode = target.value.mode;

  try {
    await projects.load();
  } catch (err) {
    // 列表没刷新不影响恢复本身的结果
  }

  if (mode === 'overwrite') {
    try {
      await tree.load(props.pid);
      tabs.syncWithApis(tree.apis.map(function (api) { return api.id; }));
      tabs.syncWithFolders(tree.folders.map(function (folder) { return folder.id; }));
      await envs.load(props.pid);
    } catch (err) {
      message.error(err.message);
    }
    loadAuto();
  }
}

// 一上来就拉一次（面板是在页签里按需挂载的，挂载时项目已经确定了），项目换了再拉一次
watch(function () { return props.pid; }, loadAuto, { immediate: true });
// 角色是随项目变的：从 owner 的项目切到只读的项目时，自动备份那一块整个消失
watch(isOwner, loadAuto);</script>

<template>
  <div class="backup-panel">
    <n-card :bordered="false" size="small" :title="t('backup.downloadTitle')">
      <p class="tip">{{ t('backup.downloadHint') }}</p>
      <n-space>
        <n-button size="small" :loading="downloading" :disabled="!canEdit" @click="download">
          {{ t('backup.downloadAction') }}
        </n-button>
      </n-space>
    </n-card>

    <n-card :bordered="false" size="small" :title="t('backup.restoreFileTitle')" class="card">
      <p class="tip">{{ t('backup.restoreFileHint') }}</p>
      <p v-if="!isOwner" class="tip">{{ t('backup.ownerOnly') }}</p>
      <n-space v-else>
        <n-button size="small" @click="openRestore({ mode: 'overwrite', autoId: '', autoAt: 0, autoSize: 0 })">
          {{ t('backup.restoreFileAction') }}
        </n-button>
      </n-space>
    </n-card>

    <n-card v-if="isOwner" :bordered="false" size="small" :title="t('backup.autoTitle')" class="card">
      <p class="tip">{{ t('backup.autoHint') }}</p>

      <n-spin :show="autoLoading">
        <n-alert v-if="autoError" type="error" :show-icon="false" class="notice">
          {{ autoError }}
        </n-alert>

        <n-alert v-else-if="!gateway.cloudFeaturesAvailable" type="info" :show-icon="false" class="notice">
          {{ t('backup.autoUnavailable') }}
        </n-alert>

        <template v-else-if="autoLoaded">
          <n-alert v-if="!autoItems.length && !autoEnabled" type="info" :show-icon="false" class="notice">
            {{ t('backup.autoDisabled') }}
          </n-alert>

          <n-empty v-else-if="!autoItems.length" size="small" :description="t('backup.autoEmpty')" />

          <div v-for="item in autoItems" :key="item.id" class="auto-row">
            <span class="auto-time">{{ formatFullTime(item.at) }}</span>
            <span class="auto-size">{{ formatBytes(item.size) }}</span>
            <n-space :size="6">
              <n-button size="tiny" @click="downloadAuto(item)">{{ t('backup.autoDownloadAction') }}</n-button>
              <n-button
                size="tiny"
                @click="openRestore({ mode: 'new', autoId: item.id, autoAt: item.at, autoSize: item.size })"
              >
                {{ t('backup.autoRestoreNew') }}
              </n-button>
              <n-button
                size="tiny"
                type="warning"
                @click="openRestore({ mode: 'overwrite', autoId: item.id, autoAt: item.at, autoSize: item.size })"
              >
                {{ t('backup.autoRestoreOverwrite') }}
              </n-button>
            </n-space>
          </div>
        </template>
      </n-spin>
    </n-card>

    <restore-dialog
      v-model:show="showRestore"
      :mode="target.mode"
      :pid="pid"
      :project-name="projectName"
      :auto-id="target.autoId"
      :auto-at="target.autoAt"
      :auto-size="target.autoSize"
      @restored="onRestored"
    />
  </div>
</template>

<style scoped>
.card {
  margin-top: 12px;
}

.tip {
  margin: 0 0 10px;
  font-size: 12px;
  opacity: 0.6;
  line-height: 1.7;
}

.notice {
  font-size: 12px;
}

.auto-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 7px 0;
  border-bottom: 1px solid rgba(128, 128, 128, 0.14);
}

.auto-row:last-child {
  border-bottom: none;
}

.auto-time {
  flex: 1;
  min-width: 0;
  font-size: 13px;
}

.auto-size {
  flex: none;
  width: 76px;
  text-align: right;
  font-size: 12px;
  opacity: 0.6;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
</style>
