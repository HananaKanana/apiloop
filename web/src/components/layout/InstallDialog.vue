<script setup>
import { computed, ref, watch } from 'vue';
import { NAlert, NButton, NModal, NSpace, NSpin, NTag } from 'naive-ui';
import * as downloadsApi from '@/api/downloads';
import { useGatewayStore } from '@/stores/gateway';
import { formatBytes } from '@/utils/bytes';
import UpdateAction from './UpdateAction.vue';

/**
 * 「安装本机 apiloop」对话框。
 *
 * 两个入口共用（计划 Task 3）：
 * - 直接打开云端时点顶栏的状态点 —— 装本机版之后请求就能从自己电脑发出；
 * - 在网关上、且网关和云端版本不一致时点「安装新版本」—— 覆盖安装拿新的安装包。
 *
 * 安装包列表来自云端的 `GET /__admin/api/downloads`。在网关上时，**下载地址要用云端地址**：
 * 网关不转发 `/__admin/downloads/`。
 */
const props = defineProps({
  show: { type: Boolean, default: false },
  /** 页面在网关上：下载走云端地址，第 3 步的说法也不一样 */
  isGateway: { type: Boolean, default: false },
  cloudUrl: { type: String, default: '' }
});

const emit = defineEmits(['update:show']);

const gateway = useGatewayStore();

const loading = ref(false);
const loadError = ref('');
const files = ref([]);
const loaded = ref(false);

const visible = computed({
  get: function () { return props.show; },
  set: function (value) { emit('update:show', value); }
});

const title = computed(function () {
  return props.isGateway ? '安装新版本' : '安装本机 apiloop';
});

/** 架构名要说人话，不能只写 arm64 / x64 */
const ARCH_LABELS = {
  arm64: 'Mac · Apple 芯片（M1、M2…）',
  x64: 'Mac · Intel 芯片',
  'win-x64': 'Windows 10 / 11'
};

/**
 * 安装步骤。前两步和最后一步两种场景一样，第三步不一样：
 * 网关上本来就是同一套数据，覆盖安装不动它；云端这边装完要登录才会同步。
 */
const steps = computed(function () {
  return [
    'Mac：下载后双击安装。如果提示「无法打开，因为来自身份不明的开发者」：打开「系统设置 → 隐私与安全性」，在下方点「仍要打开」。',
    'Windows：下载后双击运行。如果提示「Windows 已保护你的电脑」，点「更多信息 → 仍要运行」；不需要管理员权限。',
    '装完会自动打开 apiloop 窗口；以后从「应用程序」（Windows 是开始菜单或桌面）里打开。',
    props.isGateway
      ? '覆盖安装即可，数据不受影响。'
      // L1 起云端地址打包时写死（app/cloud.json），装完不用填任何地址；
      // 想用云端的项目就登录
      : '装完可以直接用；要使用云端的项目就登录。',
    'Mac：第一次访问局域网地址时，系统会弹「允许 node 查找本地网络上的设备」，点允许。'
  ];
});

async function load() {
  // 安装包列表存在云端，没登录时网关会返回 409 —— 干脆不请求，直接说「登录后可用」
  if (!gateway.cloudFeaturesAvailable) {
    files.value = [];
    loadError.value = '';
    loaded.value = true;
    return;
  }

  loading.value = true;
  loadError.value = '';
  try {
    const data = await downloadsApi.listDownloads();
    files.value = data.files || [];
    loaded.value = true;
  } catch (err) {
    loadError.value = err.message;
    files.value = [];
  } finally {
    loading.value = false;
  }
}

// 每次打开都重新拉：管理员可能刚把新的安装包传上去
watch(
  function () { return props.show; },
  function (open) { if (open) load(); }
);

/**
 * 用普通链接下载，不走 fetch —— 文件几十 MB，走 fetch 会先进内存。
 * 服务端带了 `Content-Disposition: attachment`，所以点一下就是下载，不会跳走。
 */
function download(file) {
  const url = downloadsApi.downloadUrl(file.name, {
    onGateway: props.isGateway,
    cloudUrl: props.cloudUrl
  });

  const link = document.createElement('a');
  link.href = url;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function archLabel(arch) {
  return ARCH_LABELS[arch] || arch;
}
</script>

<template>
  <n-modal
    v-model:show="visible"
    preset="card"
    :title="title"
    style="width: 620px; max-width: 94vw"
  >
    <n-spin :show="loading">
      <div class="install">
        <!-- 网关上、云端有更新的版本：一键更新放最上面，下面的列表是手动下载的备用 -->
        <div v-if="isGateway && gateway.versionMismatch" class="update-box">
          <p class="update-title">
            有新版本 {{ gateway.versionMismatch.cloudVersion }}（本机是 {{ gateway.versionMismatch.gatewayVersion }}）
          </p>
          <update-action />
          <p class="update-hint">自动下载这台电脑对应的安装包并打开安装；数据不受影响。也可以在下面手动下载。</p>
        </div>

        <n-alert v-if="loadError" type="error" :show-icon="false" class="notice">
          {{ loadError }}
        </n-alert>

        <!-- 安装包在云端，没登录拿不到列表（也就没得下） -->
        <n-alert v-else-if="!gateway.cloudFeaturesAvailable" type="info" :show-icon="false" class="notice">
          登录后可用。
        </n-alert>

        <template v-else-if="loaded && !files.length">
          <n-alert type="info" :show-icon="false" class="notice">
            管理员还没有上传安装包。
          </n-alert>
        </template>

        <template v-else>
          <div v-for="file in files" :key="file.name" class="file-row">
            <div class="file-main">
              <n-tag size="small" :bordered="false" type="info">{{ archLabel(file.arch) }}</n-tag>
              <span class="file-name">{{ file.name }}</span>
            </div>
            <span class="file-size">{{ formatBytes(file.size) }}</span>
            <n-button size="small" type="primary" @click="download(file)">下载</n-button>
          </div>
        </template>

        <!-- 登录后才有得下，步骤就等登录了再看 -->
        <div v-if="gateway.cloudFeaturesAvailable" class="steps">
          <p class="steps-title">安装步骤</p>
          <ol class="steps-list">
            <li v-for="(step, index) in steps" :key="index">{{ step }}</li>
          </ol>
        </div>
      </div>
    </n-spin>

    <template #footer>
      <n-space justify="end">
        <n-button @click="visible = false">关闭</n-button>
      </n-space>
    </template>
  </n-modal>
</template>

<style scoped>
.install {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.notice {
  font-size: 12px;
}

.update-box {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border-radius: 6px;
  background: rgba(255, 108, 55, 0.08);
}

.update-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.update-hint {
  margin: 0;
  font-size: 12px;
  opacity: 0.65;
}

.file-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.24));
  border-radius: 6px;
}

.file-main {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

.file-name {
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  opacity: 0.8;
}

.file-size {
  flex: none;
  font-size: 12px;
  opacity: 0.6;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.steps {
  border-top: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.16));
  padding-top: 10px;
}

.steps-title {
  margin: 0 0 6px;
  font-size: 13px;
  font-weight: 600;
  opacity: 0.85;
}

.steps-list {
  margin: 0;
  padding-left: 20px;
  font-size: 12px;
  line-height: 1.9;
  opacity: 0.8;
}

.steps-list li {
  margin-bottom: 2px;
}
</style>
