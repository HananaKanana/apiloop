<script setup>
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import {
  NAlert,
  NButton,
  NCard,
  NForm,
  NFormItem,
  NInput,
  NSpace,
  NSwitch,
  useMessage
} from 'naive-ui';
import * as settingsApi from '@/api/settings';
import AutoBackupSettings from '@/components/backup/AutoBackupSettings.vue';

/**
 * 系统设置（代理 + 自动备份）。**只有 admin 能进来**：路由上挂了 `meta.admin`，
 * 菜单入口也只对 admin 显示。代理是全局的 —— 改它等于把所有人的请求都指到另一个
 * 地址去，所以不该是随便谁都能动；自动备份也是全云端一份设置。
 *
 * 密码的约定：服务端返回的一律是 `***`，**不修改就原样提交回去**，服务端据此
 * 保留原来的密码（见 lib/proxy-settings.js 的 restorePassword）。
 */
const router = useRouter();
const message = useMessage();

const loading = ref(true);
const saving = ref(false);
const errorText = ref('');

const form = ref({
  enabled: false,
  http: '',
  https: '',
  noProxy: ''
});

function fillFrom(proxy) {
  form.value = {
    enabled: proxy.enabled !== false,
    http: proxy.http || '',
    https: proxy.https || '',
    noProxy: proxy.noProxy || ''
  };
}

async function load() {
  loading.value = true;
  errorText.value = '';
  try {
    const data = await settingsApi.getProxySetting();
    fillFrom(data.proxy || {});
  } catch (err) {
    errorText.value = err.message;
  } finally {
    loading.value = false;
  }
}

async function save() {
  saving.value = true;
  try {
    const data = await settingsApi.updateProxySetting({
      enabled: form.value.enabled,
      http: form.value.http.trim(),
      https: form.value.https.trim(),
      noProxy: form.value.noProxy.trim()
    });
    // 用服务端返回的覆盖本地：密码又变回 ***，地址也被规范化过
    fillFrom(data.proxy || {});
    message.success('已保存');
  } catch (err) {
    // socks:// / https:// 形式这类 400 原样提示
    message.error(err.message);
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="page">
    <div class="header">
      <n-space align="center">
        <n-button quaternary size="small" @click="router.push('/workbench')">← 返回</n-button>
        <span class="title">系统设置</span>
      </n-space>
      <n-button
        type="primary"
        size="small"
        :loading="saving"
        :disabled="loading || Boolean(errorText)"
        @click="save"
      >
        保存
      </n-button>
    </div>

    <div class="content">
      <n-alert v-if="errorText" type="error" :show-icon="false" class="alert">
        {{ errorText }}
      </n-alert>

      <!--
        两节各自读、各自存：页头那个「保存」只管代理（代理有密码回填那套约定），
        自动备份那一节的保存按钮在卡片里。
      -->
      <n-card v-else :bordered="false" size="small" title="代理">
        <p class="tip">
          代理是这台机器上的全局设置，所有项目共用。只支持 <code>http://</code> 形式的代理：
          目标是 https 时会先用 CONNECT 建立隧道。
        </p>
        <p class="tip">
          数据库里还没有这项设置时，默认值从环境变量 <code>HTTP_PROXY</code> /
          <code>HTTPS_PROXY</code> / <code>NO_PROXY</code> 读取，但不会写库。
        </p>

        <n-form label-placement="top">
          <n-form-item label="启用代理">
            <n-switch v-model:value="form.enabled" />
          </n-form-item>

          <n-form-item label="http 代理地址">
            <n-input v-model:value="form.http" placeholder="http://user:pass@host:port，留空表示不用" />
          </n-form-item>

          <n-form-item label="https 代理地址">
            <n-input v-model:value="form.https" placeholder="http://user:pass@host:port，留空则退回 http 那一栏" />
          </n-form-item>

          <n-form-item label="不走代理的地址列表">
            <n-input
              v-model:value="form.noProxy"
              type="textarea"
              :autosize="{ minRows: 2, maxRows: 4 }"
              placeholder="localhost,127.0.0.1,::1,.internal"
            />
          </n-form-item>
        </n-form>

        <p class="tip">
          用逗号分隔，每一项可以是精确的主机名、以 <code>.</code> 开头的后缀、
          <code>host:port</code>，或者 <code>*</code>（全部不走代理）。
        </p>
        <p class="tip">
          地址里的密码只显示为 <code>***</code>；不修改就原样保存，服务端会保留原来的密码。
        </p>
      </n-card>

      <!-- 自动备份（第十四轮第 2 节）：开关 / 每天几点 / 保留天数 -->
      <auto-backup-settings v-if="!errorText" class="card" />
    </div>
  </div>
</template>

<style scoped>
.page {
  height: 100%;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
}

.header {
  height: 48px;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px;
  border-bottom: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.24));
}

.title {
  font-size: 15px;
  font-weight: 600;
}

.content {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 12px;
  max-width: 760px;
  width: 100%;
  box-sizing: border-box;
}

.alert {
  margin-bottom: 12px;
}

/* 第二张卡片（自动备份）和第一张之间留一道空 */
.card {
  margin-top: 12px;
}

.tip {
  margin: 0 0 10px;
  font-size: 12px;
  opacity: 0.6;
  line-height: 1.7;
}

.tip code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
</style>
