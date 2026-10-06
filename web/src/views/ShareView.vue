<script setup>
import { computed, h, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { NButton, NIcon, NSpin, NTag, NTree, useMessage } from 'naive-ui';
import { AlertTriangle, Copy } from '@vicons/tabler';
import logoUrl from '@/assets/logo.png';
import * as sharesApi from '@/api/shares';
import { buildTree, collectFolderKeys } from '@/utils/tree';
import { methodColor } from '@/utils/method';
import { authTypeName } from '@/utils/auth';
import { formatJson } from '@/utils/jsonFormat';
import { copyText } from '@/utils/clipboard';
import { statusMeta } from '@/utils/apiStatus';
import { mockUrlFor } from '@/utils/share';

/**
 * 公开的接口文档页（第 4 节）。地址是 `<云端地址>/#/share/<链接串>`，**不用登录**。
 *
 * 这一页是给外部人看的，所以：
 * - 顶部只有 logo 和项目名，没有任何入口（没有登录、没有菜单）；
 * - 数据全部来自服务端的公开接口，**脱敏已经在服务端做完**（这里不做也做不了判断）；
 * - 页面里出现的变量（`{{host}}` 这类）原样显示，不替换 —— 对方看到的就是写接口的人写的样子。
 *
 * 路由在 `web/src/router.js` 里标了 `meta.public`，所以路由守卫会直接放行，
 * 不会因为「没登录」被弹到登录页。
 */
const route = useRoute();
const message = useMessage();
const { t } = useI18n();

const loading = ref(true);
/** 链接失效时的整页提示（过期 / 撤销 / 不存在，服务端给的都是同一句） */
const errorText = ref('');
const doc = ref(null);
const selectedId = ref('');
const expandedKeys = ref([]);

/** 目录树：范围外的目录和接口服务端就没给，这里直接按 position 排 */
const nodes = computed(function () {
  return doc.value ? buildTree(doc.value.folders, doc.value.apis) : [];
});

const current = computed(function () {
  const api = (doc.value && doc.value.apis) || [];
  return api.find(function (item) { return item.id === selectedId.value; }) || null;
});

const selectedKeys = computed(function () {
  return selectedId.value ? ['a:' + selectedId.value] : [];
});

/** 状态标签（第四轮第 1 节）：认不出来的状态不显示，别在文档里留个空标签 */
const currentStatus = computed(function () {
  return current.value ? statusMeta(current.value.status) : null;
});

const mockUrl = computed(function () {
  return doc.value ? mockUrlFor(doc.value.mockPath) : '';
});

onMounted(async function () {
  try {
    const data = await sharesApi.getPublicDoc(route.params.token);
    doc.value = data.doc;
    // 目录默认全展开：这一页就是给人翻文档的，收着反而要一个个点开
    expandedKeys.value = collectFolderKeys(nodes.value);
    if (doc.value.apis.length) selectedId.value = doc.value.apis[0].id;
    document.title = doc.value.project.name + t('views.shareDocTitleSuffix');
  } catch (err) {
    errorText.value = err.message || t('views.shareLinkInvalid');
  } finally {
    loading.value = false;
  }
});

/* ---------------- 目录树 ---------------- */

function renderLabel(info) {
  const node = info.option;

  if (node.kind === 'folder') {
    return h('span', { class: 'folder-name', title: node.name }, node.name);
  }

  const method = String((node.api && node.api.method) || 'GET').toUpperCase();
  return h('span', { class: 'tree-label', title: node.name }, [
    h('span', { class: 'method', style: { color: methodColor(method) } }, method),
    h('span', { class: 'name' }, node.name || t('utils.untitledApi'))
  ]);
}

function nodeProps(info) {
  return {
    onClick: function () {
      if (info.option.kind !== 'api') return;
      selectedId.value = info.option.id;
    }
  };
}

/* ---------------- 文档内容 ---------------- */

/** 说明按段落显示（用户写的换行要保留成段，别挤成一坨） */
const description = computed(function () {
  const text = String((current.value && current.value.description) || '').trim();
  if (!text) return [];
  return text.split(/\n+/).map(function (line) { return line.trim(); }).filter(Boolean);
});

const authLabel = computed(function () {
  if (!current.value) return '';
  const type = current.value.authType;
  if (!type || type === 'inherit') return t('views.shareAuthInherit');
  return authTypeName({ type: type });
});

const params = computed(function () {
  const api = current.value;
  if (!api) return [];
  const rows = [];
  (api.params.path || []).forEach(function (row) { rows.push(Object.assign({ where: t('views.shareWherePath') }, row)); });
  (api.params.query || []).forEach(function (row) { rows.push(Object.assign({ where: t('views.shareWhereQuery') }, row)); });
  return rows;
});

const bodyView = computed(function () {
  const body = (current.value && current.value.body) || { mode: 'none' };
  if (body.mode === 'none') return null;

  if (body.mode === 'raw') {
    const text = String(body.raw || '');
    if (!text) return null;
    const language = String(body.language || 'text').toLowerCase();
    if (language === 'json') {
      const pretty = formatJson(text);
      return { kind: 'raw', text: pretty.ok ? pretty.text : text, json: true };
    }
    return { kind: 'raw', text: text, json: false };
  }

  if (body.mode === 'graphql') {
    return {
      kind: 'graphql',
      query: (body.graphql && body.graphql.query) || '',
      variables: (body.graphql && body.graphql.variables) || ''
    };
  }

  if (body.mode === 'binary') return { kind: 'binary' };
  if (body.form) return { kind: 'form', mode: body.mode, rows: body.form };

  return { kind: body.mode };
});

/* ---------------- 复制 ---------------- */

function shellQuote(text) {
  return "'" + String(text === undefined || text === null ? '' : text).replace(/'/g, "'\\''") + "'";
}

/** 「复制为 cURL」：按文档里的信息拼一条能直接跑的 curl（值可能是打码后的） */
const curlText = computed(function () {
  const api = current.value;
  if (!api) return '';

  const lines = ['curl -X ' + String(api.method || 'GET').toUpperCase() + ' ' + shellQuote(api.url)];
  (api.headers || []).forEach(function (row) {
    lines.push('  -H ' + shellQuote(row.key + ': ' + row.value));
  });

  const body = api.body || {};
  if (body.mode === 'raw' && body.raw) {
    lines.push('  --data-raw ' + shellQuote(body.raw));
  } else if (body.mode === 'graphql' && body.graphql && body.graphql.query) {
    lines.push('  --data-raw ' + shellQuote(body.graphql.query));
  } else if ((body.mode === 'urlencoded' || body.mode === 'formdata') && body.form) {
    body.form.forEach(function (row) {
      lines.push('  --data-urlencode ' + shellQuote(row.key + '=' + row.value));
    });
  }

  return lines.join(' \\\n');
});

async function copy(text, okText) {
  try {
    await copyText(text);
    message.success(okText || t('app.copied'));
  } catch (err) {
    message.error(err.message);
  }
}

function statusType(status) {
  if (status >= 200 && status < 300) return 'success';
  if (status >= 400 && status < 500) return 'warning';
  if (status >= 500) return 'error';
  return 'default';
}
</script>

<template>
  <div class="share-page">
    <header class="top">
      <img class="logo" :src="logoUrl" alt="apiloop" />
      <span class="brand">apiloop</span>
      <span v-if="doc" class="project">{{ doc.project.name }}</span>
      <span class="spacer" />
      <span v-if="doc" class="readonly">{{ t('views.shareReadonly') }}</span>
    </header>

    <div v-if="loading" class="center">
      <n-spin size="small" />
    </div>

    <div v-else-if="errorText" class="center">
      <div class="invalid">
        <n-icon size="26" :component="AlertTriangle" />
        <p class="invalid-text">{{ errorText }}</p>
        <p class="invalid-hint">{{ t('views.shareLinkInvalidFull') }}</p>
      </div>
    </div>

    <div v-else class="body">
      <!-- 左边：分享范围内的目录树 -->
      <aside class="side">
        <n-tree
          v-if="nodes.length"
          block-line
          expand-on-click
          :data="nodes"
          :expanded-keys="expandedKeys"
          :selected-keys="selectedKeys"
          :render-label="renderLabel"
          :node-props="nodeProps"
          :cancelable="false"
          @update:expanded-keys="(keys) => { expandedKeys = keys; }"
        />
        <p v-else class="side-empty">{{ t('views.shareNoApis') }}</p>
      </aside>

      <!-- 右边：选中接口的文档 -->
      <main class="doc">
        <div v-if="!current" class="doc-empty">{{ t('views.sharePickApi') }}</div>

        <template v-else>
          <div class="doc-head">
            <span class="method" :style="{ color: methodColor(current.method) }">
              {{ String(current.method || 'GET').toUpperCase() }}
            </span>
            <span class="doc-title">{{ current.name || t('utils.untitledApi') }}</span>
            <!-- 状态与负责人（第四轮第 1 节）：负责人只给名字，服务端查好的 -->
            <span
              v-if="currentStatus"
              class="doc-status"
              :style="{ color: currentStatus.color, borderColor: currentStatus.color }"
            >
              <span class="doc-status-dot" :style="{ background: currentStatus.color }" />
              {{ currentStatus.label }}
            </span>
            <span v-if="current.ownerName" class="doc-owner">{{ t('utils.ownerPrefix') }}{{ current.ownerName }}</span>
            <span class="spacer" />
            <n-button size="tiny" secondary @click="copy(curlText, t('views.shareCopiedCurl'))">
              {{ t('views.shareCopyAsCurl') }}
            </n-button>
          </div>

          <div class="url-row">
            <code class="url">{{ current.url }}</code>
            <n-button size="tiny" quaternary @click="copy(current.url, t('views.shareCopiedUrl'))">
              <template #icon><n-icon :component="Copy" /></template>
            </n-button>
          </div>

          <section v-if="description.length" class="section">
            <p v-for="(line, index) in description" :key="index" class="paragraph">{{ line }}</p>
          </section>

          <section class="section">
            <h3 class="section-title">{{ t('views.shareAuthTitle') }}</h3>
            <p class="plain">{{ authLabel }}</p>
          </section>

          <section v-if="params.length" class="section">
            <h3 class="section-title">Params</h3>
            <table class="kv">
              <thead>
                <tr><th>{{ t('views.colName') }}</th><th>{{ t('views.colSampleValue') }}</th><th>{{ t('views.colDesc') }}</th></tr>
              </thead>
              <tbody>
                <tr v-for="(row, index) in params" :key="'p' + index">
                  <td class="key">{{ row.key }}<span class="where">{{ row.where }}</span></td>
                  <td class="value">{{ row.value }}</td>
                  <td class="desc">{{ row.desc }}</td>
                </tr>
              </tbody>
            </table>
          </section>

          <section v-if="current.headers.length" class="section">
            <h3 class="section-title">Headers</h3>
            <table class="kv">
              <thead>
                <tr><th>{{ t('views.colName') }}</th><th>{{ t('views.colSampleValue') }}</th><th>{{ t('views.colDesc') }}</th></tr>
              </thead>
              <tbody>
                <tr v-for="(row, index) in current.headers" :key="'h' + index">
                  <td class="key">
                    {{ row.key }}<span v-if="row.common" class="where">{{ t('views.shareCommon') }}</span>
                  </td>
                  <td class="value">{{ row.value }}</td>
                  <td class="desc">{{ row.desc }}</td>
                </tr>
              </tbody>
            </table>
          </section>

          <section v-if="bodyView" class="section">
            <h3 class="section-title">Body</h3>

            <pre v-if="bodyView.kind === 'raw'" class="code">{{ bodyView.text }}</pre>

            <template v-else-if="bodyView.kind === 'graphql'">
              <pre class="code">{{ bodyView.query }}</pre>
              <pre v-if="bodyView.variables" class="code">{{ bodyView.variables }}</pre>
            </template>

            <table v-else-if="bodyView.kind === 'form'" class="kv">
              <thead>
                <tr><th>{{ t('views.colField') }}</th><th>{{ t('views.colValue') }}</th><th>{{ t('views.colDesc') }}</th></tr>
              </thead>
              <tbody>
                <tr v-for="(row, index) in bodyView.rows" :key="'b' + index">
                  <td class="key">{{ row.key }}</td>
                  <td class="value">{{ row.value }}</td>
                  <td class="desc">{{ row.desc }}</td>
                </tr>
              </tbody>
            </table>

            <p v-else class="plain">{{ t('views.shareBinary') }}</p>
          </section>

          <section v-if="current.examples.length" class="section">
            <h3 class="section-title">{{ t('views.shareExamples') }}</h3>
            <div v-for="(example, index) in current.examples" :key="'e' + index" class="example">
              <div class="example-head">
                <span class="example-name">{{ example.name || t('views.shareUnnamedExample') }}</span>
                <n-tag size="tiny" :bordered="false" :type="statusType(example.status)">
                  {{ example.status }}
                </n-tag>
              </div>
              <pre class="code">{{ example.body }}</pre>
            </div>
          </section>

          <!-- 响应字段说明（第六轮第 2 节）：没写过说明的接口不显示这一块 -->
          <section v-if="current.responseFields && current.responseFields.length" class="section">
            <h3 class="section-title">{{ t('views.shareResponseFields') }}</h3>
            <table class="kv">
              <thead>
                <tr><th>{{ t('views.colField') }}</th><th>{{ t('views.colType') }}</th><th>{{ t('views.colDesc') }}</th></tr>
              </thead>
              <tbody>
                <tr v-for="(field, index) in current.responseFields" :key="'f' + index">
                  <td class="key">{{ field.path }}</td>
                  <td class="type">{{ field.type }}</td>
                  <td class="desc">
                    {{ field.desc }}
                    <span v-if="field.required" class="required">{{ t('views.shareRequired') }}</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </section>

          <section class="section">
            <h3 class="section-title">{{ t('views.shareMockTitle') }}</h3>
            <div class="url-row">
              <code class="url">{{ mockUrl }}</code>
              <n-button size="tiny" quaternary @click="copy(mockUrl, t('views.shareCopiedMock'))">
                <template #icon><n-icon :component="Copy" /></template>
              </n-button>
            </div>
            <p class="tip">{{ t('views.shareMockTip') }}</p>
          </section>
        </template>
      </main>
    </div>
  </div>
</template>

<style scoped>
.share-page {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--apiloop-surface);
}

.top {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 48px;
  padding: 0 16px;
  border-bottom: 1px solid var(--apiloop-divider);
}

.logo {
  width: 22px;
  height: 22px;
}

.brand {
  font-size: 14px;
  font-weight: 600;
}

.project {
  font-size: 13px;
  opacity: 0.7;
  padding-left: 8px;
  border-left: 1px solid var(--apiloop-divider);
}

.spacer {
  flex: 1;
}

.readonly {
  font-size: 12px;
  opacity: 0.5;
}

.center {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

.invalid {
  text-align: center;
  opacity: 0.75;
}

.invalid-text {
  margin: 12px 0 4px;
  font-size: 14px;
}

.invalid-hint {
  margin: 0;
  font-size: 12px;
  opacity: 0.7;
}

.body {
  flex: 1;
  min-height: 0;
  display: flex;
}

.side {
  flex: none;
  width: 260px;
  overflow: auto;
  padding: 8px 6px;
  border-right: 1px solid var(--apiloop-divider);
}

.side-empty {
  padding: 12px;
  font-size: 12px;
  opacity: 0.5;
}

.doc {
  flex: 1;
  min-width: 0;
  overflow: auto;
  padding: 16px 24px 40px;
}

.doc-empty {
  padding: 24px 0;
  font-size: 13px;
  opacity: 0.5;
}

.doc-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.doc-title {
  font-size: 16px;
  font-weight: 600;
}

/* 状态标签：描边 + 同色的点和字，颜色跟着状态走（未设置就不显示这个标签） */
.doc-status {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 1px 8px;
  border: 1px solid currentColor;
  border-radius: 10px;
  font-size: 11px;
  line-height: 1.6;
  white-space: nowrap;
}

.doc-status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.doc-owner {
  font-size: 12px;
  opacity: 0.65;
  white-space: nowrap;
}

/* 方法缩写：只有文字颜色，和目录树、标签页上的那套一致 */
.doc-head .method {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.2px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.url-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
}

.url {
  flex: 1;
  min-width: 0;
  padding: 5px 8px;
  border-radius: 4px;
  background: rgba(128, 128, 128, 0.09);
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  word-break: break-all;
}

.section {
  margin-top: 22px;
}

.section-title {
  margin: 0 0 8px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.4px;
  opacity: 0.6;
  text-transform: uppercase;
}

.paragraph {
  margin: 0 0 8px;
  font-size: 13px;
  line-height: 1.75;
}

.plain {
  margin: 0;
  font-size: 13px;
}

.tip {
  margin: 8px 0 0;
  font-size: 12px;
  opacity: 0.55;
}

.kv {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.kv th {
  text-align: left;
  font-weight: 500;
  opacity: 0.55;
  padding: 6px 10px;
  border-bottom: 1px solid var(--apiloop-divider);
}

.kv td {
  padding: 6px 10px;
  border-bottom: 1px solid rgba(128, 128, 128, 0.1);
  vertical-align: top;
}

.kv .key {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: nowrap;
}

.kv .value {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  word-break: break-all;
  opacity: 0.85;
}

.kv .desc {
  opacity: 0.7;
}

/* 类型列：窄一点、等宽 */
.kv .type {
  width: 90px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  opacity: 0.75;
}

/* 「必有」小标记：中性灰底，别和状态色打架 */
.kv .required {
  margin-left: 6px;
  padding: 0 5px;
  border-radius: 3px;
  font-size: 10px;
  opacity: 0.7;
  background: rgba(128, 128, 128, 0.16);
}

.where {
  margin-left: 6px;
  padding: 0 5px;
  border-radius: 3px;
  font-size: 10px;
  opacity: 0.55;
  background: rgba(128, 128, 128, 0.14);
  font-family: inherit;
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
  overflow-x: auto;
}

.example + .example {
  margin-top: 12px;
}

.example-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.example-name {
  font-size: 13px;
  font-weight: 500;
}

:deep(.folder-name) {
  font-size: 13px;
}

:deep(.tree-label) {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

:deep(.tree-label .method) {
  flex: none;
  width: 44px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.2px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

:deep(.tree-label .name) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
