<script setup>
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
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
import VisualizerView from './VisualizerView.vue';
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

const emit = defineEmits(['save-example', 'save-sse-example', 'resend', 'add-assertion', 'add-extract']);

const { t } = useI18n();

const ERROR_TEXT = computed(function () {
  return {
    TIMEOUT: t('response.errorTimeout'),
    ABORTED: t('response.errorAborted'),
    DNS: t('response.errorDns'),
    CONNECT: t('response.errorConnect'),
    TLS: t('response.errorTls'),
    INVALID_URL: t('response.errorInvalidUrl'),
    INVALID_HEADER: t('response.errorInvalidHeader'),
    FILE: t('response.errorFile'),
    PROXY: t('response.errorProxy'),
    SCRIPT: t('response.errorScript'),
    OTHER: t('response.errorOther')
  };
});

/** 云端不发送请求时的那句话，按钮的悬停提示和这里共用同一份文案 */
const SERVER_SEND_DISABLED_TEXT = computed(function () {
  return t('response.serverSendDisabled');
});

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
 *
 * **发送没开始就失败**（`sendError`，比如云端不发送的 409）也要算「有东西」：
 * 那条错误只在 `tab.sendError` 上，如果这里还当它是空状态，错误就被整块藏掉了。
 */
const idle = computed(function () {
  return !response.value && !error.value && !props.tab.sending && !props.tab.cancelled &&
    !liveResponse.value && !props.tab.sendError;
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

/**
 * 响应设置的 Cookie（Cookies 页签，参考 Postman）：把每个 Set-Cookie 头拆成
 * 名字、值、Domain、Path、过期时间、HttpOnly、Secure、SameSite。
 */
const responseCookies = computed(function () {
  const list = [];
  (displayHeaders.value || []).forEach(function (pair) {
    if (String(pair[0]).toLowerCase() !== 'set-cookie') return;
    const parts = String(pair[1]).split(';');
    const first = parts.shift() || '';
    const eq = first.indexOf('=');
    const cookie = {
      name: (eq === -1 ? first : first.slice(0, eq)).trim(),
      value: eq === -1 ? '' : first.slice(eq + 1).trim(),
      domain: '',
      path: '',
      expires: '',
      httpOnly: false,
      secure: false,
      sameSite: ''
    };
    parts.forEach(function (attr) {
      const index = attr.indexOf('=');
      const key = (index === -1 ? attr : attr.slice(0, index)).trim().toLowerCase();
      const value = index === -1 ? '' : attr.slice(index + 1).trim();
      if (key === 'domain') cookie.domain = value;
      else if (key === 'path') cookie.path = value;
      else if (key === 'expires') cookie.expires = value;
      else if (key === 'max-age') cookie.expires = cookie.expires || t('response.maxAge', { value: value });
      else if (key === 'httponly') cookie.httpOnly = true;
      else if (key === 'secure') cookie.secure = true;
      else if (key === 'samesite') cookie.sameSite = value;
    });
    if (cookie.name) list.push(cookie);
  });
  return list;
});

const redirects = computed(function () {
  if (live.value) return live.value.redirects || [];
  return (result.value && result.value.redirects) || [];
});

/**
 * 这次请求**最终**打到的地址 —— 预览的基准地址要用它。
 *
 * 注意**不是** `result.request.url`：那个是用户最初发出的那一跳（`lib/executor.js`
 * 文件头写明），重定向链在 `redirects` 里，每一条的 `url` 是**跳转的目标地址**。
 * 所以最终地址 = `redirects` 最后一条的 url，没有重定向时才是 `request.url`。
 *
 * 用错了的话，跳转过的页面（`http://a.com/x` → `https://a.com/x/`）预览里的相对路径
 * 会解析到跳转前的地址上，样式和图片都是错的。
 */
const finalUrl = computed(function () {
  const list = redirects.value;
  if (list.length) return list[list.length - 1].url || '';
  return (request.value && request.value.url) || '';
});

/** 用户最初发出的那一跳用的方法。GET 才允许把地址丢给浏览器打开 */
const requestMethod = computed(function () {
  return (request.value && request.value.method) || '';
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
  const base = ERROR_TEXT.value[error.value.code] || ERROR_TEXT.value.OTHER;
  return t('response.errorWithCode', { message: base, code: error.value.code, detail: error.value.message });
});

/* ---------------- 网关相关的三种情况（G2） ---------------- */

/**
 * 直接打开云端、云端又不发送请求时，服务端返回 409 + `SERVER_SEND_DISABLED`。
 * 这不是「出错」，是我们自己的限制，所以不显示成红色的服务端错误。
 *
 * 这个错发生在 NDJSON 开始之前，进不了 `result.error`，只在 `tab.sendErrorCode` 上
 * （见 tabs.js 的 emptyLive / sendRequest）。
 */
const serverSendDisabled = computed(function () {
  return props.tab.sendErrorCode === 'SERVER_SEND_DISABLED';
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

/** 测试脚本里 pm.visualizer.set 的结果（「可视化」页签） */
const scriptVisualizer = computed(function () {
  return (scripts.value && scripts.value.visualizer) || null;
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
  return item.phase === 'prerequest' ? t('response.scriptErrorPrerequest') : t('response.scriptErrorResponse');
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
  if (!props.tab.apiId) return t('response.saveHintTemp');
  if (!response.value) return t('response.saveHintSendFirst');
  if (!canSaveExample.value) return t('response.saveHintBinary');
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
        <div v-if="idle" class="idle">{{ t('response.idleHint') }}</div>

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
          <p class="ln-title">{{ t('response.localNetworkTitle') }}</p>
          <p class="ln-body">
            {{ t('response.localNetworkBody') }}
          </p>
          <n-button size="small" type="primary" @click="emit('resend')">{{ t('response.resend') }}</n-button>
        </div>

        <n-alert
          v-if="tab.sendError && !serverSendDisabled"
          type="error"
          :show-icon="false"
          class="notice"
        >
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
          {{ t('response.cancelledNotice') }}
        </n-alert>

        <n-alert v-if="tab.historyTruncated" type="info" :show-icon="false" class="notice">
          {{ t('response.historyTruncatedNotice') }}
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
                      <n-tag size="small" :bordered="false" type="warning">{{ t('response.recordErrorTag') }}</n-tag>
                    </template>
                    {{ recordError }}
                  </n-tooltip>

                  <!-- 接收中：只报进度，不报耗时/最终大小（都还没定） -->
                  <span v-if="tab.sending" class="metric">
                    {{ t('response.receiving', { size: formatBytes(tab.receivedBytes) }) }}
                  </span>
                  <template v-else-if="result">
                    <span class="metric">{{ t('response.duration', { time: formatMs(result.timings && result.timings.total) }) }}</span>
                    <span class="metric">{{ t('response.size', { size: formatBytes(response.size) }) }}</span>
                  </template>

                  <n-tag v-if="proxy" size="small" :bordered="false" type="info" class="proxy-tag">
                    {{ t('response.viaProxy', { url: proxy.url }) }}
                  </n-tag>

                  <n-popover v-if="redirects.length" trigger="click" placement="bottom-start">
                    <template #trigger>
                      <n-tag size="small" :bordered="false" type="info" class="clickable">
                        {{ t('response.redirectCount', { n: redirects.length }) }}
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
                  <span class="metric">{{ t('response.connecting') }}</span>
                </template>

                <template v-else>
                  <span class="metric">{{ t('response.notSentYet') }}</span>
                </template>

                <n-popover v-if="!readonly && !isSse && saveHint" trigger="hover" placement="top-end">
                  <template #trigger>
                    <span>
                      <n-button size="tiny" disabled>{{ t('response.saveExample') }}</n-button>
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
                  {{ t('response.saveExample') }}
                </n-button>
              </div>
            </template>
            <n-tab-pane name="body" :tab="t('response.bodyTab')" :disabled="!response">
              <body-viewer
                v-if="response"
                :response="response"
                :request-url="finalUrl"
                :request-method="requestMethod"
                :readonly="readonly"
                @add-assertion="(payload) => emit('add-assertion', payload)"
                @add-extract="(payload) => emit('add-extract', payload)"
              />
            </n-tab-pane>

            <!-- 测试脚本调用过 pm.visualizer.set 才有（参考 Postman 的 Visualize） -->
            <n-tab-pane v-if="scriptVisualizer" name="visualize" :tab="t('response.visualizeTab')">
              <visualizer-view :visualizer="scriptVisualizer" />
            </n-tab-pane>

            <!-- 只有 content-type 是 text/event-stream 的响应才有这个页签 -->
            <n-tab-pane v-if="tab.sseEvents" name="events" :tab="t('response.eventsTab')">
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
                <span :class="testTabClass">{{ t('response.testResults', { passed: testCount.passed, total: testCount.total }) }}</span>
              </template>
              <div class="script-list">
                <div v-for="(item, index) in scriptTests" :key="index" class="test-row">
                  <span class="mark" :class="{ fail: !item.passed }">
                    {{ item.passed ? t('response.testPassed') : t('response.testFailed') }}
                  </span>
                  <span class="test-name">{{ item.name }}</span>
                  <!-- 可视化断言（第六轮第 1 节）的结果和脚本的测试结果混在一起，标一下来源 -->
                  <span v-if="item.source" class="test-source">{{ item.source }}</span>
                  <span v-if="!item.passed && item.error" class="test-error">{{ item.error }}</span>
                </div>
              </div>
            </n-tab-pane>

            <n-tab-pane v-if="scriptConsole.length" name="console" :tab="t('response.consoleTab')">
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

            <n-tab-pane name="cookies" :disabled="!displayHeaders">
              <template #tab>
                <span>{{ t('response.cookiesTab') }}<span v-if="responseCookies.length" class="tab-count">{{ responseCookies.length }}</span></span>
              </template>
              <div v-if="responseCookies.length" class="cookie-table">
                <div class="cookie-row head">
                  <span>{{ t('response.cookieName') }}</span><span>{{ t('response.cookieValue') }}</span><span>{{ t('response.cookieDomain') }}</span><span>{{ t('response.cookiePath') }}</span><span>{{ t('response.cookieExpires') }}</span><span>{{ t('response.cookieAttributes') }}</span>
                </div>
                <div v-for="(cookie, index) in responseCookies" :key="index" class="cookie-row">
                  <span class="mono strong" :title="cookie.name">{{ cookie.name }}</span>
                  <span class="mono" :title="cookie.value">{{ cookie.value }}</span>
                  <span :title="cookie.domain">{{ cookie.domain || '—' }}</span>
                  <span>{{ cookie.path || '—' }}</span>
                  <span :title="cookie.expires">{{ cookie.expires || t('response.cookieSession') }}</span>
                  <span class="flags">
                    <span v-if="cookie.httpOnly" class="flag">HttpOnly</span>
                    <span v-if="cookie.secure" class="flag">Secure</span>
                    <span v-if="cookie.sameSite" class="flag">SameSite={{ cookie.sameSite }}</span>
                  </span>
                </div>
              </div>
              <div v-else class="empty-tab">{{ t('response.noCookies') }}</div>
            </n-tab-pane>

            <n-tab-pane name="headers" :disabled="!displayHeaders">
              <template #tab>
                <span>{{ t('response.headersTab') }}<span v-if="displayHeaders && displayHeaders.length" class="tab-count">{{ displayHeaders.length }}</span></span>
              </template>
              <headers-table v-if="displayHeaders" :headers="displayHeaders" />
            </n-tab-pane>

            <n-tab-pane name="timings" :tab="t('response.timingsTab')" :disabled="!result">
              <timings-bar v-if="result" :timings="result.timings" />
            </n-tab-pane>

            <n-tab-pane name="request" :tab="t('response.requestTab')" :disabled="!request">
              <div v-if="request" class="sent-request">
                <div class="line">
                  <span class="method">{{ request.method }}</span>
                  <span class="url">{{ request.url }}</span>
                </div>
                <headers-table :headers="request.headers" />
                <template v-if="requestBodyText()">
                  <p class="label">{{ t('response.requestBody') }}</p>
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
  flex: 1;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/*
 * n-spin 会在 .response-panel 和 .inner 之间插两层 div（.n-spin-container / .n-spin-content），
 * 它们默认没有高度，.inner 的 height: 100% 就落空了 —— 整块按内容撑开，事件表格等
 * 滚不动（用户反馈，修 pane-wrapper 那一层之后仍然不行，问题在这里）。两层都要撑满。
 */
.response-panel > :deep(.n-spin-container) {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.response-panel > :deep(.n-spin-container > .n-spin-content) {
  flex: 1;
  min-height: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
}

.inner {
  flex: 1;
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
  flex: 1;
  min-height: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
}

/*
 * naive-ui 在页签和内容之间还有一层 .n-tabs-pane-wrapper，自带 overflow: hidden。
 * 它不占满剩余高度的话会按内容撑开、超出部分被直接剪掉 —— 「事件」表格几十行时
 * 下面的行看不到也滚不动（用户反馈）。这一层也得是「占满 + 可收缩」的弹性列。
 */
.tabs :deep(.n-tabs-pane-wrapper) {
  flex: 1;
  min-height: 0;
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
.tab-count {
  margin-left: 5px;
  padding: 0 5px;
  border-radius: 8px;
  font-size: 11px;
  line-height: 16px;
  display: inline-block;
  background: rgba(128, 128, 128, 0.16);
  opacity: 0.85;
}

.cookie-table {
  border: 1px solid rgba(128, 128, 128, 0.2);
  border-radius: 6px;
  overflow: auto;
  font-size: 12px;
}

.cookie-row {
  display: grid;
  grid-template-columns: minmax(90px, 1fr) minmax(120px, 2fr) minmax(80px, 1fr) 70px minmax(110px, 1.2fr) minmax(120px, 1.2fr);
  gap: 10px;
  padding: 7px 10px;
  align-items: center;
}

.cookie-row > span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cookie-row + .cookie-row {
  border-top: 1px solid rgba(128, 128, 128, 0.12);
}

.cookie-row.head {
  font-weight: 600;
  opacity: 0.6;
  background: rgba(128, 128, 128, 0.06);
}

.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.strong {
  font-weight: 600;
}

.flags {
  display: flex;
  gap: 4px;
}

.flag {
  padding: 0 5px;
  border-radius: 4px;
  font-size: 11px;
  background: rgba(128, 128, 128, 0.14);
}

.empty-tab {
  padding: 20px 0;
  font-size: 12px;
  opacity: 0.5;
}

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

/* 「断言」这类来源标记：测试脚本的结果没有 source，只有可视化断言才有 */
.test-source {
  flex: none;
  padding: 0 5px;
  border-radius: 4px;
  font-size: 11px;
  opacity: 0.6;
  background: rgba(128, 128, 128, 0.16);
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
