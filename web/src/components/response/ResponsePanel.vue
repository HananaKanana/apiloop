<script setup>
import { computed, ref } from 'vue';
import {
  NAlert,
  NButton,
  NEmpty,
  NPopover,
  NSpin,
  NTabPane,
  NTabs,
  NTag
} from 'naive-ui';
import BodyViewer from './BodyViewer.vue';
import HeadersTable from './HeadersTable.vue';
import TimingsBar from './TimingsBar.vue';
import { useUiStore } from '@/stores/ui';

/**
 * 响应面板。数据全部来自标签页上最近一次发送的结果。
 */
const props = defineProps({
  tab: { type: Object, required: true },
  savingExample: { type: Boolean, default: false }
});

const emit = defineEmits(['save-example']);

const ui = useUiStore();

const ERROR_TEXT = {
  TIMEOUT: '请求超时，对方在限定时间内没有返回。',
  ABORTED: '请求已取消。',
  DNS: '域名解析失败，检查一下主机名。',
  CONNECT: '连不上目标服务器，检查地址和端口，或者对方没在监听。',
  TLS: 'TLS 握手失败，证书可能有问题（自签名证书默认是放行的，说明不是这个原因）。',
  INVALID_URL: 'URL 不合法。',
  INVALID_HEADER: '请求头不合法。',
  FILE: '读取本地文件失败。',
  OTHER: '请求失败。'
};

const activeTab = ref('body');

const result = computed(function () {
  return props.tab.result;
});

const response = computed(function () {
  return result.value ? result.value.response : null;
});

const error = computed(function () {
  return result.value ? result.value.error : null;
});

const request = computed(function () {
  return result.value ? result.value.request : null;
});

const redirects = computed(function () {
  return (result.value && result.value.redirects) || [];
});

function formatSize(bytes) {
  if (!bytes && bytes !== 0) return '—';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

function formatMs(value) {
  if (value === null || value === undefined) return '—';
  return Math.round(value) + ' ms';
}

const statusType = computed(function () {
  const status = response.value ? response.value.status : 0;
  if (status >= 200 && status < 300) return 'success';
  if (status >= 400 && status < 500) return 'warning';
  if (status >= 500) return 'error';
  return 'default';
});

const errorText = computed(function () {
  if (!error.value) return '';
  const base = ERROR_TEXT[error.value.code] || ERROR_TEXT.OTHER;
  return base + '（' + error.value.code + '：' + error.value.message + '）';
});

/** 只有文本响应能存成示例；二进制存下来没意义 */
const canSaveExample = computed(function () {
  return Boolean(response.value && response.value.bodyEncoding === 'utf8');
});

const saveHint = computed(function () {
  if (!props.tab.apiId) return '临时标签页要先保存成接口，才能存示例';
  if (!response.value) return '先发一次请求';
  if (!canSaveExample.value) return '二进制响应不能存成示例';
  return '';
});

function requestBodyText() {
  return (request.value && request.value.bodyPreview) || '';
}
</script>

<template>
  <div class="response-panel">
    <n-spin :show="tab.sending">
      <div class="inner">
        <div class="status-bar">
          <template v-if="response">
            <n-tag :type="statusType" size="small" :bordered="false">
              {{ response.status }} {{ response.statusText }}
            </n-tag>
            <span class="metric">耗时 {{ formatMs(result.timings && result.timings.total) }}</span>
            <span class="metric">大小 {{ formatSize(response.size) }}</span>

            <n-popover v-if="redirects.length" trigger="click" placement="bottom-start">
              <template #trigger>
                <n-tag size="small" :bordered="false" type="info" class="clickable">
                  重定向 {{ redirects.length }} 次
                </n-tag>
              </template>
              <div class="redirect-list">
                <div v-for="(hop, index) in redirects" :key="index" class="redirect-item">
                  <span class="redirect-status">{{ hop.status }}</span>
                  <span class="redirect-url">{{ hop.url }}</span>
                </div>
              </div>
            </n-popover>
          </template>

          <template v-else-if="error">
            <n-tag type="error" size="small" :bordered="false">{{ error.code }}</n-tag>
          </template>

          <template v-else>
            <span class="metric">还没发送</span>
          </template>

          <span class="spacer" />

          <n-popover v-if="saveHint" trigger="hover" placement="top-end">
            <template #trigger>
              <span>
                <n-button size="tiny" disabled>保存为示例</n-button>
              </span>
            </template>
            {{ saveHint }}
          </n-popover>
          <n-button
            v-else
            size="tiny"
            secondary
            type="primary"
            :loading="savingExample"
            @click="emit('save-example')"
          >
            保存为示例
          </n-button>
        </div>

        <n-alert v-if="error" type="error" :show-icon="false" class="notice">
          {{ errorText }}
        </n-alert>

        <n-alert v-if="tab.sendError" type="error" :show-icon="false" class="notice">
          {{ tab.sendError }}
        </n-alert>

        <n-alert v-if="tab.historyTruncated" type="info" :show-icon="false" class="notice">
          这条历史里的响应体超过了 256 KB，落库时做了截断，下面是截断后的内容。
        </n-alert>

        <n-alert
          v-if="tab.missingVariables && tab.missingVariables.length"
          type="warning"
          :show-icon="false"
          class="notice"
        >
          <div class="missing">
            <span>以下变量未定义：{{ tab.missingVariables.join('、') }}</span>
            <n-button size="tiny" quaternary type="primary" @click="ui.openEnvManager()">
              去环境管理
            </n-button>
          </div>
        </n-alert>

        <div class="tabs">
          <n-tabs v-model:value="activeTab" type="line" size="small" animated>
            <n-tab-pane name="body" tab="Body" :disabled="!response">
              <body-viewer v-if="response" :response="response" />
            </n-tab-pane>

            <n-tab-pane name="headers" tab="Headers" :disabled="!response">
              <headers-table v-if="response" :headers="response.headers" />
            </n-tab-pane>

            <n-tab-pane name="timings" tab="耗时" :disabled="!result">
              <timings-bar v-if="result" :timings="result.timings" />
            </n-tab-pane>

            <n-tab-pane name="request" tab="请求" :disabled="!request">
              <div v-if="request" class="sent-request">
                <div class="line">
                  <span class="method">{{ request.method }}</span>
                  <span class="url">{{ request.url }}</span>
                </div>
                <headers-table :headers="request.headers" />
                <template v-if="requestBodyText()">
                  <p class="label">请求体</p>
                  <pre class="body-preview">{{ requestBodyText() }}</pre>
                </template>
              </div>
            </n-tab-pane>
          </n-tabs>

          <n-empty
            v-if="!response && !error"
            class="placeholder"
            size="small"
            description="点「发送」看结果"
          />
        </div>
      </div>
    </n-spin>
  </div>
</template>

<style scoped>
.response-panel {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.inner {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.status-bar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
}

.metric {
  opacity: 0.7;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.spacer {
  flex: 1;
}

.clickable {
  cursor: pointer;
}

.redirect-list {
  max-width: 520px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.redirect-item {
  display: flex;
  gap: 8px;
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.redirect-status {
  flex: none;
  color: #2080f0;
}

.redirect-url {
  word-break: break-all;
}

.notice {
  flex: none;
  font-size: 12px;
}

.missing {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.tabs {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  position: relative;
}

.tabs :deep(.n-tabs) {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.tabs :deep(.n-tab-pane) {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.placeholder {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0.5;
}

.sent-request {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.line {
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}

.method {
  flex: none;
  font-weight: 700;
  color: #18a058;
}

.url {
  word-break: break-all;
}

.label {
  margin: 0;
  font-size: 12px;
  opacity: 0.65;
}

.body-preview {
  margin: 0;
  padding: 8px 10px;
  border: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.24));
  border-radius: 6px;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
</style>
