<script setup>
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
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
const { t } = useI18n();

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
    message.success(t('views.stSaved'));
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
  <!-- skin-ribbons：小岛皮肤下分区标题画成飘带（styles/island.css） -->
  <div class="page skin-ribbons">
    <div class="header">
      <n-space align="center">
        <n-button quaternary size="small" @click="router.push('/workbench')">{{ t('views.psBack') }}</n-button>
        <span class="title">{{ t('views.stTitle') }}</span>
      </n-space>
      <n-button
        type="primary"
        size="small"
        :loading="saving"
        :disabled="loading || Boolean(errorText)"
        @click="save"
      >
        {{ t('views.psSave') }}
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
      <n-card v-else :bordered="false" size="small" :title="t('views.stProxyTitle')">
        <p class="tip">
          {{ t('views.stProxyTipLead') }}<code>http://</code>{{ t('views.stProxyTipTail') }}
        </p>
        <p class="tip">
          {{ t('views.stProxyEnvLead') }}<code>HTTP_PROXY</code>{{ t('views.stProxyEnvMid') }}<code>HTTPS_PROXY</code>{{ t('views.stProxyEnvMid') }}<code>NO_PROXY</code>{{ t('views.stProxyEnvTail') }}
        </p>

        <n-form label-placement="top">
          <n-form-item :label="t('views.stProxyEnabled')">
            <n-switch v-model:value="form.enabled" />
          </n-form-item>

          <n-form-item :label="t('views.stProxyHttpLabel')">
            <n-input v-model:value="form.http" :placeholder="t('views.stProxyHttpPlaceholder')" />
          </n-form-item>

          <n-form-item :label="t('views.stProxyHttpsLabel')">
            <n-input v-model:value="form.https" :placeholder="t('views.stProxyHttpsPlaceholder')" />
          </n-form-item>

          <n-form-item :label="t('views.stNoProxyLabel')">
            <n-input
              v-model:value="form.noProxy"
              type="textarea"
              :autosize="{ minRows: 2, maxRows: 4 }"
              placeholder="localhost,127.0.0.1,::1,.internal"
            />
          </n-form-item>
        </n-form>

        <p class="tip">
          {{ t('views.stNoProxyTipA') }}<code>.</code>{{ t('views.stNoProxyTipB') }}<code>host:port</code>{{ t('views.stNoProxyTipC') }}<code>*</code>{{ t('views.stNoProxyTipD') }}
        </p>
        <p class="tip">
          {{ t('views.stPasswordTipA') }}<code>***</code>{{ t('views.stPasswordTipB') }}
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
