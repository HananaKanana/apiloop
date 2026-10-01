<script setup>
import { computed, ref, watch } from 'vue';
import {
  NAlert,
  NButton,
  NEmpty,
  NPopover,
  NSpin,
  NTabPane,
  NTabs,
  NTag,
  NTooltip
} from 'naive-ui';
import BodyViewer from './BodyViewer.vue';
import HeadersTable from './HeadersTable.vue';
import SseEventsTable from './SseEventsTable.vue';
import TimingsBar from './TimingsBar.vue';
import { formatBytes } from '@/utils/bytes';
import { usePaneTabsTheme } from '@/utils/paneTabs';

/**
 * 响应面板。数据全部来自标签页上最近一次发送的结果。
 */
const paneTabsTheme = usePaneTabsTheme();

const props = defineProps({
  tab: { type: Object, required: true },
  savingExample: { type: Boolean, default: false },
  /** 只读角色：不给「保存为示例」这个写入口 */
  readonly: { type: Boolean, default: false }
});

const emit = defineEmits(['save-example', 'save-sse-example', 'resend']);

const ERROR_TEXT = {
  TIMEOUT: '请求超时，对方在限定时间内没有返回。',
  ABORTED: '请求已取消。',
  DNS: '域名解析失败，检查一下主机名。',
  CONNECT: '连不上目标服务器，检查地址和端口，或者对方没在监听。',
  TLS: 'TLS 握手失败，证书可能有问题（自签名证书默认是放行的，说明不是这个原因）。',
  INVALID_URL: 'URL 不合法。',
  INVALID_HEADER: '请求头不合法。',
  FILE: '读取本地文件失败。',
  PROXY: '代理不可用：连不上代理，或者 CONNECT 隧道被拒绝了。检查系统设置里的代理地址，或者关掉这次请求的「使用系统代理」。',
  SCRIPT: '前置脚本出错，请求没有发送。改完脚本再发，或者在「设置」页签里关掉这次请求的「执行脚本」。',
  OTHER: '请求失败。'
};

/** 云端不发送请求时的那句话，按钮的悬停提示和这里共用同一份文案 */
const SERVER_SEND_DISABLED_TEXT = '云端不发送请求，请从本机的 apiloop 打开';

const activeTab = ref('body');

/**
 * 收到的事件流是 SSE 时自动切到「事件」视图；下一次请求开始时事件列表被清空，
 * 这时要切回 Body —— 否则会停在一个已经不存在的页签上。
 */
watch(
  function () { return props.tab.sseEvents; },
  function (list) {
    if (list) activeTab.value = 'events';
    else if (activeTab.value === 'events') activeTab.value = 'body';
  }
);

const result = computed(function () {
  return props.tab.result;
});

const response = computed(function () {
  return result.value ? result.value.response : null;
});

const error = computed(function () {
  return result.value ? result.value.error : null;
});

/**
 * 什么都还没有：没发过、没在发、也没出错。这时面板给一句居中提示，
 * 不然整块是空的，看着像坏了。取消过的请求不算 —— 那种情况下面有专门的说明；
 * 流式发送时 `liveResponse`（响应头）一到就有东西可看了，也不算空。
 */
const idle = computed(function () {
  return !response.value && !error.value && !props.tab.sending && !props.tab.cancelled &&
    !liveResponse.value;
});

const request = computed(function () {
  return result.value ? result.value.request : null;
});

/**
 * 流式发送时，`head` 事件一到就有响应头了 —— 状态码、响应头都能立刻显示，
 * 不用等整个响应体下完。取消之后 result 始终是空的，这时候继续显示 head，
 * 让用户至少能看到对方返回的状态码。
 */
const live = computed(function () {
  if (result.value) return null;
  return props.tab.head || null;
});

const liveResponse = computed(function () {
  return live.value ? live.value.response : null;
});

/** 状态条上那一行响应信息：接收中看 head，结束后看 result */
const statusLine = computed(function () {
  return liveResponse.value || response.value;
});

/** 响应头表格的数据源：接收中用 head，结束后用 result */
const displayHeaders = computed(function () {
  if (liveResponse.value) return liveResponse.value.headers;
  return response.value ? response.value.headers : null;
});

const redirects = computed(function () {
  if (live.value) return live.value.redirects || [];
  return (result.value && result.value.redirects) || [];
});

/** 这次请求实际用的代理（地址里的密码服务端已经打码）；直连时为 null */
const proxy = computed(function () {
  return (result.value && result.value.proxy) || null;
});

function formatMs(value) {
  if (value === null || value === undefined) return '—';
  return Math.round(value) + ' ms';
}

const statusType = computed(function () {
  const status = statusLine.value ? statusLine.value.status : 0;
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

/* ---------------- 网关相关的三种情况（G2） ---------------- */

/**
 * 直接打开云端、云端又不发送请求时，服务端返回 409 + `SERVER_SEND_DISABLED`。
 * 这不是「出错」，是我们自己的限制，所以不显示成红色的服务端错误。
 */
const serverSendDisabled = computed(function () {
  return Boolean(error.value && error.value.code === 'SERVER_SEND_DISABLED');
});

/**
 * Mac 第一次访问局域网时被系统拦下（G0 已有这个标记）。
 * 这时候要给的是一套操作步骤，不是一行「请求失败」。
 */
const localNetworkHint = computed(function () {
  return Boolean(error.value && error.value.localNetworkHint === true);
});

/** 请求发成功了，但历史和变量没存到云端（G1）。响应照常显示，另外给个黄标签 */
const recordError = computed(function () {
  return (result.value && result.value.recordError) || '';
});

/* ---------------- 脚本结果（契约第 16 节） ---------------- */

/** 一段脚本都没执行时服务端给 null */
const scripts = computed(function () {
  return (result.value && result.value.scripts) || null;
});

const scriptTests = computed(function () {
  return (scripts.value && scripts.value.tests) || [];
});

const scriptConsole = computed(function () {
  return (scripts.value && scripts.value.console) || [];
});

const scriptErrors = computed(function () {
  return (scripts.value && scripts.value.errors) || [];
});

const scriptWarnings = computed(function () {
  return (scripts.value && scripts.value.warnings) || [];
});

const testCount = computed(function () {
  const list = scriptTests.value;
  return {
    total: list.length,
    passed: list.filter(function (item) { return item.passed; }).length
  };
});

/** 页签标题的颜色：全通过是绿的，有失败是红的 */
const testTabClass = computed(function () {
  if (!testCount.value.total) return '';
  return testCount.value.passed === testCount.value.total ? 'tests-pass' : 'tests-fail';
});

function scriptErrorTitle(item) {
  return item.phase === 'prerequest' ? '前置脚本出错' : '测试脚本出错';
}

/** 只有文本响应能存成示例；二进制存下来没意义 */
const canSaveExample = computed(function () {
  return Boolean(response.value && response.value.bodyEncoding === 'utf8');
});

/**
 * SSE 响应要存成 `sse` 类型的示例（存的是事件场景，不是响应文本），
 * 走的是事件视图里那个按钮，所以这里两个条件要互斥。
 */
const isSse = computed(function () {
  return Boolean(props.tab.sseEvents);
});

/** editor 及以上 + 绑定了接口 + 响应已经结束 + 至少收到一条事件 */
const canSaveSseExample = computed(function () {
  if (props.readonly || isSse.value === false) return false;
  if (!props.tab.apiId || props.tab.sending) return false;
  return (props.tab.sseEvents || []).length > 0;
});

const saveHint = computed(function () {
  if (props.readonly) return '';
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
        <!-- 还没发过请求：给一句提示，别让面板空着 -->
        <div v-if="idle" class="idle">点击发送，或按 Enter，查看响应</div>

        <template v-else>

        <n-alert
          v-if="error && !serverSendDisabled && !localNetworkHint"
          type="error"
          :show-icon="false"
          class="notice"
        >
          {{ errorText }}
        </n-alert>

        <!-- 云端不发送请求：这不是「服务端出错」，是我们自己的限制，别用红色 -->
        <n-alert v-if="serverSendDisabled" type="warning" :show-icon="false" class="notice">
          {{ SERVER_SEND_DISABLED_TEXT }}
        </n-alert>

        <!-- Mac 第一次访问局域网被系统拦下：给一套能照着做的步骤，而不是一行错误 -->
        <div v-if="localNetworkHint" class="local-network">
          <p class="ln-title">需要允许本地网络访问</p>
          <p class="ln-body">
            系统刚才弹出了「允许 node 访问本地网络」，请点「允许」后重新发送。
            如果没看到弹框：打开「系统设置 → 隐私与安全性 → 本地网络」，把 node 打开。
          </p>
          <n-button size="small" type="primary" @click="emit('resend')">重新发送</n-button>
        </div>

        <n-alert v-if="tab.sendError" type="error" :show-icon="false" class="notice">
          {{ tab.sendError }}
        </n-alert>

        <!-- 脚本出错：来源和原因都要写出来，不然用户不知道该去改哪一段 -->
        <n-alert
          v-for="(item, index) in scriptErrors"
          :key="'script-error-' + index"
          type="error"
          :show-icon="false"
          class="notice"
        >
          {{ scriptErrorTitle(item) }}（{{ item.source }}）：{{ item.message }}
        </n-alert>

        <n-alert v-if="scriptWarnings.length" type="warning" :show-icon="false" class="notice">
          <div v-for="(text, index) in scriptWarnings" :key="index">{{ text }}</div>
        </n-alert>

        <n-alert v-if="tab.cancelled && !tab.sending" type="info" :show-icon="false" class="notice">
          这次请求已经取消。服务端会照常记一条历史（状态是「已取消」），里面是断开前收到的部分。
        </n-alert>

        <n-alert v-if="tab.historyTruncated" type="info" :show-icon="false" class="notice">
          这条历史里的响应体超过了 256 KB，落库时做了截断，下面是截断后的内容。
        </n-alert>

        <div class="tabs">
          <n-tabs
            v-model:value="activeTab"
            type="line"
            size="small"
            animated
            :theme-overrides="paneTabsTheme"
          >
            <!-- 状态码 / 耗时 / 大小和页签挤在同一行（和 Postman 一样） -->
            <template #suffix>
              <div class="status-line">
                <template v-if="statusLine">
                  <n-tag :type="statusType" size="small" :bordered="false">
                    {{ statusLine.status }} {{ statusLine.statusText }}
                  </n-tag>

                  <!-- 请求发成功了，但历史和变量没存到云端：响应照常看，这里只提醒一句 -->
                  <n-tooltip v-if="recordError" trigger="hover">
                    <template #trigger>
                      <n-tag size="small" :bordered="false" type="warning">未保存历史</n-tag>
                    </template>
                    {{ recordError }}
                  </n-tooltip>

                  <!-- 接收中：只报进度，不报耗时/最终大小（都还没定） -->
                  <span v-if="tab.sending" class="metric">
                    接收中… {{ formatBytes(tab.receivedBytes) }}
                  </span>
                  <template v-else-if="result">
                    <span class="metric">耗时 {{ formatMs(result.timings && result.timings.total) }}</span>
                    <span class="metric">大小 {{ formatBytes(response.size) }}</span>
                  </template>

                  <n-tag v-if="proxy" size="small" :bordered="false" type="info" class="proxy-tag">
                    经由代理 {{ proxy.url }}
                  </n-tag>

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

                <template v-else-if="tab.sending">
                  <span class="metric">正在连接…</span>
                </template>

                <template v-else>
                  <span class="metric">还没发送</span>
                </template>

                <n-popover v-if="!readonly && !isSse && saveHint" trigger="hover" placement="top-end">
                  <template #trigger>
                    <span>
                      <n-button size="tiny" disabled>保存为示例</n-button>
                    </span>
                  </template>
                  {{ saveHint }}
                </n-popover>
                <n-button
                  v-else-if="!readonly && !isSse"
                  size="tiny"
                  secondary
                  type="primary"
                  :loading="savingExample"
                  @click="emit('save-example')"
                >
                  保存为示例
                </n-button>
              </div>
            </template>
            <n-tab-pane name="body" tab="Body" :disabled="!response">
              <body-viewer v-if="response" :response="response" />
            </n-tab-pane>

            <!-- 只有 content-type 是 text/event-stream 的响应才有这个页签 -->
            <n-tab-pane v-if="tab.sseEvents" name="events" tab="事件">
              <sse-events-table
                :events="tab.sseEvents"
                :dropped="tab.sseDropped || 0"
                :can-save="canSaveSseExample"
                @save-example="emit('save-sse-example')"
              />
            </n-tab-pane>

            <!-- 有测试才有「测试结果」，有输出才有「控制台」—— 空页签是噪音 -->
            <n-tab-pane v-if="scriptTests.length" name="tests">
              <template #tab>
                <span :class="testTabClass">测试结果 {{ testCount.passed }}/{{ testCount.total }}</span>
              </template>
              <div class="script-list">
                <div v-for="(item, index) in scriptTests" :key="index" class="test-row">
                  <span class="mark" :class="{ fail: !item.passed }">
                    {{ item.passed ? '通过' : '失败' }}
                  </span>
                  <span class="test-name">{{ item.name }}</span>
                  <span v-if="!item.passed && item.error" class="test-error">{{ item.error }}</span>
                </div>
              </div>
            </n-tab-pane>

            <n-tab-pane v-if="scriptConsole.length" name="console" tab="控制台">
              <div class="script-list">
                <div
                  v-for="(line, index) in scriptConsole"
                  :key="index"
                  class="console-row"
                  :class="'level-' + line.level"
                >
                  <span class="console-source">{{ line.source }}</span>
                  <span class="console-level">{{ line.level }}</span>
                  <span class="console-text">{{ line.text }}</span>
                </div>
              </div>
            </n-tab-pane>

            <n-tab-pane name="headers" tab="Headers" :disabled="!displayHeaders">
              <headers-table v-if="displayHeaders" :headers="displayHeaders" />
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
        </div>
        </template>
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

/* 状态码 / 耗时 / 大小：现在是页签那一行的右侧 */
.status-line {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
}

/* 还没发过请求时的空状态 */
.idle {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  opacity: 0.5;
}

.metric {
  opacity: 0.7;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}


.clickable {
  cursor: pointer;
}

/* 代理地址可能很长，别把状态条撑开 */
.proxy-tag {
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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

/* 局域网授权：比一行错误重，所以自己画一块带步骤的提示 */
.local-network {
  flex: none;
  padding: 10px 12px;
  border: 1px solid rgba(240, 160, 32, 0.45);
  border-radius: 6px;
  background: rgba(240, 160, 32, 0.1);
}

.ln-title {
  margin: 0 0 6px;
  font-size: 13px;
  font-weight: 600;
}

.ln-body {
  margin: 0 0 10px;
  font-size: 12px;
  line-height: 1.7;
  opacity: 0.85;
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

/* 页签标题上的通过数：全通过才绿，有失败就红 */
.tests-pass {
  color: #18a058;
}

.tests-fail {
  color: #d03050;
}

.script-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 4px 0;
}

.test-row,
.console-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 12px;
  line-height: 1.6;
}

/* 通过是常态，保持中性；只有失败才上色 */
.mark {
  flex: none;
  width: 32px;
  opacity: 0.65;
}

.mark.fail {
  color: #d03050;
  opacity: 1;
}

.test-name {
  flex: none;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.test-error {
  flex: 1;
  min-width: 0;
  word-break: break-all;
}

.console-source {
  flex: none;
  width: 96px;
  opacity: 0.6;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.console-level {
  flex: none;
  width: 44px;
  opacity: 0.6;
}

.console-text {
  flex: 1;
  min-width: 0;
  white-space: pre-wrap;
  word-break: break-all;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.console-row.level-warn .console-text {
  color: #f0a020;
}

.console-row.level-error .console-text {
  color: #d03050;
}
</style>
