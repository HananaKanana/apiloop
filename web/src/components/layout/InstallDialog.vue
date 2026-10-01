<script setup>
import { computed, ref, watch } from 'vue';
import { NAlert, NButton, NModal, NSpace, NSpin, NTag } from 'naive-ui';
import * as downloadsApi from '@/api/downloads';
import { formatBytes } from '@/utils/bytes';

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
  arm64: 'Apple 芯片（M1、M2…）',
  x64: 'Intel 芯片'
};

/**
 * 安装步骤。前两步和最后一步两种场景一样，第三步不一样：
 * 网关上本来就是同一套数据，覆盖安装不动它；云端这边装完要登录才会同步。
 */
const steps = computed(function () {
  return [
    '下载后双击安装。如果提示「无法打开，因为来自身份不明的开发者」：打开「系统设置 → 隐私与安全性」，在下方点「仍要打开」。',
    '装完会自动用浏览器打开 127.0.0.1:47321；以后从「应用程序」里点 apiloop 打开。',
    props.isGateway
      ? '覆盖安装即可，数据不受影响。'
      // 现状（L1 之前）：网关第一次打开要填云端地址。L1 把地址打包写死以后改成
      // 「装完可以直接用；要和云端同步就登录」（docs/design/2026-10-01-local-first.md 4.1）
      : '第一次打开时要填云端地址，填 ' + window.location.origin + '（就是现在这个网址），然后用同一个账号登录。',
    '第一次访问局域网地址时，系统会弹「允许 node 查找本地网络上的设备」，点允许。'
  ];
});

async function load() {
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
        <n-alert v-if="loadError" type="error" :show-icon="false" class="notice">
          {{ loadError }}
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

        <div class="steps">
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
