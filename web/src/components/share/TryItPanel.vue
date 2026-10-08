<script setup>
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { NButton, NIcon, NInput, NTabPane, NTabs, NTag, useMessage } from 'naive-ui';
import { Copy } from '@vicons/tabler';
import KeyValueTable from '@/components/common/KeyValueTable.vue';
import { buildCurl } from '@/utils/curl';
import { copyText } from '@/utils/clipboard';
import { formatJson } from '@/utils/jsonFormat';
import { byteLength, formatBytes } from '@/utils/bytes';
import { methodColor } from '@/utils/method';
import { mockTargetUrl } from '@/utils/share';

/**
 * 公开文档页里的「试一试」（第十五轮）：对方不用装客户端、不用登录，直接给这个接口
 * 发一次请求，**打到这个项目的 Mock 上**，看返回什么。
 *
 * 几点必须说清楚的做法：
 * - **不经过本应用的后端**，所以不带 `X-Apiloop` 那个头（见 `api/client.js` 的 `baseHeaders()`）；
 *   分享页和 Mock 在同一个域名下（`/mock-<项目ID>/…`），不存在跨域。
 * - 地址是「Mock 前缀 + 接口路径」，前缀由外面算好传进来（`mockUrlFor(doc.mockPath)`），
 *   路径从接口地址里剥出来（`pathOfUrl`），`:id` / `{id}` 用表里的值替换（`fillPathParams`）。
 * - 文档里的值可能带着 `{{变量}}`（服务端只做脱敏，不做替换），**原样发出去** —— 这里
 *   没有环境变量可用，能替换的只有路径参数和查询参数。地址里还剩变量时给一句提示。
 * - 请求体是二进制的接口发不了（没有本地文件），发送按钮灰掉并说明。
 */
const props = defineProps({
  /** 文档里那个接口（`publicDoc` 给的那一份） */
  api: { type: Object, required: true },
  /** 这一页的 Mock 地址前缀（`mockUrlFor(doc.mockPath)`，不带接口路径） */
  mockBase: { type: String, default: '' }
});

const { t } = useI18n();
const message = useMessage();

/* ---------------- 表单状态 ---------------- */

const pathRows = ref([]);
const queryRows = ref([]);
const headerRows = ref([]);
/** raw 请求体的正文 */
const rawText = ref('');
/** urlencoded / formdata 的字段行（formdata 只留文本行，文件行另外显示） */
const formRows = ref([]);
/** formdata 里被灰掉的文件行（只展示，不发送） */
const fileRows = ref([]);
const gqlQuery = ref('');
const gqlVariables = ref('');

const sending = ref(false);
/** 上一次的结果：`{ status, ms, bytes, body, headers, error }`，null 表示还没发过 */
const result = ref(null);
const resultTab = ref('body');

/** 把文档里的行拷成表格能用的形状（值一律转成字符串，别让数字把输入框弄坏） */
function cloneRows(rows) {
  return (rows || []).map(function (row) {
    return {
      key: String(row && row.key !== undefined && row.key !== null ? row.key : ''),
      value: String(row && row.value !== undefined && row.value !== null ? row.value : ''),
      enabled: !row || row.enabled !== false,
      desc: String((row && row.desc) || ''),
      kind: row && row.kind === 'file' ? 'file' : 'text'
    };
  });
}

/**
 * 换一个接口就把面板重置成文档里的值。
 *
 * **必须挂上 `immediate`**：面板是「点开才渲染」的，第一次挂载时上面的 `ref` 还是空的，
 * 不立刻跑一遍的话表格是空白的。
 */
function reset() {
  const api = props.api || {};
  const body = api.body || { mode: 'none' };
  const params = api.params || {};

  pathRows.value = cloneRows(params.path);
  queryRows.value = cloneRows(params.query);
  headerRows.value = cloneRows(api.headers);

  rawText.value = body.mode === 'raw' ? String(body.raw || '') : '';
  gqlQuery.value = body.mode === 'graphql' ? String((body.graphql && body.graphql.query) || '') : '';
  gqlVariables.value = body.mode === 'graphql' ? String((body.graphql && body.graphql.variables) || '') : '';

  const form = body.mode === 'urlencoded' || body.mode === 'formdata' ? cloneRows(body.form) : [];
  formRows.value = form.filter(function (row) { return row.kind !== 'file'; });
  fileRows.value = form.filter(function (row) { return row.kind === 'file'; });

  result.value = null;
  resultTab.value = 'body';
}

/* ---------------- 地址 ---------------- */

const method = computed(function () {
  return String((props.api && props.api.method) || 'GET').toUpperCase();
});

const targetUrl = computed(function () {
  return mockTargetUrl(props.mockBase, props.api.url, pathRows.value, queryRows.value);
});

/** 地址里还剩没替换的 `{{变量}}` 或 `:参数`：Mock 不一定认得，提醒一句 */
const unresolved = computed(function () {
  const url = targetUrl.value;
  return /\{\{/.test(url) || /(^|\/):[\w-]+/.test(url);
});

/** 接口地址里有 `:id` / `{id}` 就显示路径参数表（文档里没填过也能补） */
const hasPathParams = computed(function () {
  if (pathRows.value.length) return true;
  return /(^|\/):[\w-]+|\{[\w-]+\}/.test(String((props.api && props.api.url) || ''));
});

const bodyMode = computed(function () {
  return String((props.api && props.api.body && props.api.body.mode) || 'none');
});

const bodyUnsupported = computed(function () {
  return bodyMode.value === 'binary';
});

const sendDisabled = computed(function () {
  return bodyUnsupported.value || !targetUrl.value;
});

/* ---------------- 拼这次请求 ---------------- */

function headerList() {
  const list = [];
  headerRows.value.forEach(function (row) {
    if (row.enabled === false) return;
    const key = String(row.key || '').trim();
    if (!key) return;
    list.push([key, String(row.value === undefined || row.value === null ? '' : row.value)]);
  });
  return list;
}

function hasHeader(list, name) {
  return list.some(function (pair) { return pair[0].toLowerCase() === name; });
}

/** 变量表里的值可能是 JSON 文本；解析不了就当空对象（发送不该因为一行备注失败） */
function parseVariables(text) {
  const source = String(text || '').trim();
  if (!source) return {};
  try {
    const parsed = JSON.parse(source);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    return {};
  }
}

/** 这一行字段要不要发出去（空 key 不发） */
function usableFields(rows) {
  return rows.filter(function (row) {
    if (row.enabled === false) return false;
    if (row.kind === 'file') return false;
    return String(row.key || '').trim() !== '';
  });
}

/**
 * @returns {{method: string, url: string, headers: Array, body: any, form: Array}}
 *   `body` 直接交给 fetch；`form` 是给生成 cURL 用的原始行
 */
function buildRequest() {
  const headers = headerList();
  const url = targetUrl.value;
  const mode = bodyMode.value;
  let body;
  let form = [];

  // GET / HEAD 不带请求体（带了浏览器也会忽略，不如不发）
  if (mode !== 'none' && mode !== 'binary' && method.value !== 'GET' && method.value !== 'HEAD') {
    if (mode === 'raw' && rawText.value) {
      body = rawText.value;
      // 文档里标了 json 就补一个 Content-Type，用户自己写了就用他的
      if (props.api.body && props.api.body.language === 'json' && !hasHeader(headers, 'content-type')) {
        headers.push(['Content-Type', 'application/json']);
      }
    } else if (mode === 'urlencoded') {
      const params = new URLSearchParams();
      usableFields(formRows.value).forEach(function (row) {
        params.append(String(row.key).trim(), String(row.value === undefined || row.value === null ? '' : row.value));
      });
      form = usableFields(formRows.value);
      body = params.toString();
      if (!hasHeader(headers, 'content-type')) {
        headers.push(['Content-Type', 'application/x-www-form-urlencoded']);
      }
    } else if (mode === 'formdata') {
      // 文件字段跳过（分享页拿不到对方的本地文件）
      const data = new FormData();
      form = usableFields(formRows.value);
      form.forEach(function (row) {
        data.append(String(row.key).trim(), String(row.value === undefined || row.value === null ? '' : row.value));
      });
      // Content-Type 不手写：boundary 只能由浏览器生成
      body = data;
    } else if (mode === 'graphql') {
      form = [{ key: 'query', value: gqlQuery.value, enabled: true, kind: 'text' }];
      body = JSON.stringify({ query: gqlQuery.value, variables: parseVariables(gqlVariables.value) });
      if (!hasHeader(headers, 'content-type')) {
        headers.push(['Content-Type', 'application/json']);
      }
    }
  }

  return { method: method.value, url: url, headers: headers, body: body, form: form };
}

/* ---------------- 发送 ---------------- */

function statusType(status) {
  if (status >= 200 && status < 300) return 'success';
  if (status >= 400 && status < 500) return 'warning';
  if (status >= 500) return 'error';
  return 'default';
}

async function send() {
  if (sending.value || sendDisabled.value) return;

  const built = buildRequest();
  sending.value = true;
  const started = Date.now();

  try {
    const res = await fetch(built.url, {
      method: built.method,
      headers: built.headers,
      body: built.body
    });
    const text = await res.text();
    const headers = [];
    res.headers.forEach(function (value, name) { headers.push([name, value]); });

    result.value = {
      status: res.status,
      ms: Date.now() - started,
      bytes: byteLength(text),
      body: text,
      headers: headers,
      error: ''
    };
  } catch (err) {
    // 网络层就失败了（对方 Mock 挂了、地址写错、被浏览器拦下）：给原文，别只说「失败」
    result.value = {
      status: 0,
      ms: Date.now() - started,
      bytes: 0,
      body: '',
      headers: [],
      error: (err && err.message) ? err.message : String(err)
    };
  } finally {
    sending.value = false;
    resultTab.value = 'body';
  }
}

/* ---------------- 复制 ---------------- */

async function copyCurl() {
  const built = buildRequest();
  const command = buildCurl({
    method: built.method,
    url: built.url,
    headers: headerRows.value,
    body: {
      mode: bodyMode.value,
      raw: rawText.value,
      graphql: { query: gqlQuery.value, variables: gqlVariables.value },
      form: formRows.value
    }
  });

  try {
    await copyText(command);
    message.success(t('share.tryCopiedCurl'));
  } catch (err) {
    message.error(t('app.copyFailed'));
  }
}

/* ---------------- 响应 ---------------- */

const responseBody = computed(function () {
  if (!result.value || !result.value.body) return '';
  const pretty = formatJson(result.value.body);
  return pretty.ok ? pretty.text : result.value.body;
});

const responseHeaders = computed(function () {
  return (result.value && result.value.headers) || [];
});

watch(function () { return props.api && props.api.id; }, reset, { immediate: true });
</script>

<template>
  <div class="try">
    <div class="try-head">
      <span class="try-hint">{{ t('share.tryHint') }}</span>
      <span class="spacer" />
      <n-button
        size="tiny"
        type="primary"
        :loading="sending"
        :disabled="sendDisabled"
        @click="send"
      >
        {{ sending ? t('share.trySending') : t('share.trySend') }}
      </n-button>
    </div>

    <!-- 地址行：方法徽标 + 拼好的 Mock 地址 + 复制 cURL -->
    <div class="try-url">
      <span class="method" :style="{ color: methodColor(method) }">{{ method }}</span>
      <code class="url">{{ targetUrl }}</code>
      <n-button size="tiny" quaternary @click="copyCurl">
        <template #icon><n-icon :component="Copy" /></template>
        {{ t('share.tryCopyCurl') }}
      </n-button>
    </div>
    <p v-if="unresolved" class="warn">{{ t('share.tryUnresolved') }}</p>

    <section v-if="hasPathParams" class="block">
      <h4 class="block-title">{{ t('share.tryPathTitle') }}</h4>
      <key-value-table v-model="pathRows" :allow-desc="false" />
    </section>

    <section v-if="queryRows.length" class="block">
      <h4 class="block-title">{{ t('share.tryQueryTitle') }}</h4>
      <key-value-table v-model="queryRows" :allow-desc="false" />
    </section>

    <section v-if="headerRows.length" class="block">
      <h4 class="block-title">{{ t('share.tryHeadersTitle') }}</h4>
      <key-value-table v-model="headerRows" :allow-desc="false" />
    </section>

    <section class="block">
      <h4 class="block-title">{{ t('share.tryBodyTitle') }}</h4>

      <p v-if="bodyMode === 'none'" class="plain">{{ t('share.tryNoBody') }}</p>

      <p v-else-if="bodyUnsupported" class="plain">{{ t('share.tryBinaryBody') }}</p>

      <n-input
        v-else-if="bodyMode === 'raw'"
        v-model:value="rawText"
        type="textarea"
        size="small"
        :autosize="{ minRows: 5, maxRows: 16 }"
      />

      <template v-else-if="bodyMode === 'graphql'">
        <n-input
          v-model:value="gqlQuery"
          type="textarea"
          size="small"
          :autosize="{ minRows: 5, maxRows: 14 }"
        />
        <n-input
          v-model:value="gqlVariables"
          class="gql-vars"
          type="textarea"
          size="small"
          placeholder="{}"
          :autosize="{ minRows: 2, maxRows: 8 }"
        />
      </template>

      <template v-else>
        <key-value-table v-model="formRows" :allow-desc="false" />
        <div v-for="(row, index) in fileRows" :key="'f' + index" class="file-row">
          <n-input size="small" :value="row.key" disabled />
          <n-input size="small" :value="row.value" disabled />
          <span class="file-hint">{{ t('share.tryFormFile') }}</span>
        </div>
      </template>
    </section>

    <section v-if="result" class="block result">
      <div class="result-meta">
        <n-tag size="small" :bordered="false" :type="statusType(result.status)">
          {{ result.status || '—' }}
        </n-tag>
        <span class="meta">{{ t('share.tryDuration') }} {{ result.ms }} ms</span>
        <span class="meta">{{ t('share.trySize') }} {{ formatBytes(result.bytes) }}</span>
      </div>

      <p v-if="result.error" class="error">{{ t('share.tryNetworkError', { message: result.error }) }}</p>

      <n-tabs v-else v-model:value="resultTab" type="line" size="small">
        <n-tab-pane name="body" :tab="t('share.tryTabBody')">
          <pre v-if="responseBody" class="code">{{ responseBody }}</pre>
          <p v-else class="plain">{{ t('share.tryEmptyBody') }}</p>
        </n-tab-pane>
        <n-tab-pane name="headers" :tab="t('share.tryTabHeaders')">
          <table v-if="responseHeaders.length" class="kv">
            <tbody>
              <tr v-for="(pair, index) in responseHeaders" :key="'h' + index">
                <td class="key">{{ pair[0] }}</td>
                <td class="value">{{ pair[1] }}</td>
              </tr>
            </tbody>
          </table>
          <p v-else class="plain">{{ t('share.tryEmptyBody') }}</p>
        </n-tab-pane>
      </n-tabs>
    </section>
  </div>
</template>

<style scoped>
.try {
  margin-top: 14px;
  padding: 12px 14px 14px;
  border: 1px solid var(--apiloop-divider);
  border-radius: 8px;
  background: rgba(128, 128, 128, 0.045);
}

.try-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.try-hint {
  font-size: 12px;
  opacity: 0.6;
}

.spacer {
  flex: 1;
}

.try-url {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
}

.try-url .method {
  flex: none;
  width: 44px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.2px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.try-url .url {
  flex: 1;
  min-width: 0;
  padding: 5px 8px;
  border-radius: 4px;
  background: rgba(128, 128, 128, 0.1);
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  word-break: break-all;
}

.warn {
  margin: 6px 0 0;
  font-size: 12px;
  color: #d97706;
}

.block {
  margin-top: 14px;
}

.block-title {
  margin: 0 0 6px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.4px;
  text-transform: uppercase;
  opacity: 0.55;
}

.plain {
  margin: 0;
  font-size: 13px;
  opacity: 0.7;
}

.gql-vars {
  margin-top: 6px;
}

/* form-data 里的文件行：灰掉 + 一句说明（分享页拿不到对方的本地文件） */
.file-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
}

.file-row :deep(.n-input) {
  flex: 1;
  min-width: 0;
}

.file-hint {
  flex: none;
  font-size: 11px;
  opacity: 0.55;
}

.result-meta {
  display: flex;
  align-items: center;
  gap: 12px;
}

.meta {
  font-size: 12px;
  opacity: 0.65;
}

.error {
  margin: 8px 0 0;
  font-size: 12px;
  color: #eb2013;
  word-break: break-all;
}

.code {
  margin: 0;
  padding: 10px 12px;
  border-radius: 6px;
  background: rgba(128, 128, 128, 0.09);
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 320px;
  overflow: auto;
}

.kv {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.kv td {
  padding: 5px 10px;
  border-bottom: 1px solid rgba(128, 128, 128, 0.1);
  vertical-align: top;
}

.kv .key {
  width: 200px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  opacity: 0.75;
}

.kv .value {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  word-break: break-all;
}
</style>
