<script setup>
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { NAlert, NTag } from 'naive-ui';
import CodeEditor from '@/components/common/CodeEditor.vue';
import { formatJson } from '@/utils/jsonFormat';

/**
 * 一条录制记录的详情：请求 / 响应各一份头 + 体（只读编辑器，JSON 自动美化）。
 *
 * 用 CodeEditor 而不是 <pre>：长 body 能换行、能搜索，也和请求区里看到的排版一致。
 */
const props = defineProps({
  entry: { type: Object, required: true }
});

const { t } = useI18n();

function headerText(headers) {
  const rows = Object.keys(headers || {}).map(function (name) {
    const value = headers[name];
    return name + ': ' + (Array.isArray(value) ? value.join(', ') : String(value));
  });
  return rows.join('\n');
}

/** JSON 就美化一下；不是 JSON（或者不完整）原样给 */
function bodyText(body, contentType) {
  const text = String(body === undefined || body === null ? '' : body);
  if (!text) return '';
  if (String(contentType || '').indexOf('json') === -1) return text;

  const result = formatJson(text, 2);
  return result.ok ? result.text : text;
}

const requestHeaders = computed(function () {
  return headerText(props.entry.request && props.entry.request.headers) || t('record.none');
});

const requestBody = computed(function () {
  const request = props.entry.request || {};
  if (request.bodyTruncated) {
    return bodyText(request.body, request.contentType) + '\n\n' + t('record.truncated');
  }
  return bodyText(request.body, request.contentType) || t('record.emptyValue');
});

const responseHeaders = computed(function () {
  return headerText(props.entry.response && props.entry.response.headers) || t('record.none');
});

const responseBody = computed(function () {
  const response = props.entry.response || {};
  if (response.binary) return t('record.binary');
  if (response.bodyTruncated) {
    return bodyText(response.body, response.contentType) + '\n\n' + t('record.truncated');
  }
  return bodyText(response.body, response.contentType) || t('record.emptyValue');
});

const responseLanguage = computed(function () {
  const type = String((props.entry.response || {}).contentType || '');
  if (type.indexOf('json') > -1) return 'json';
  if (type.indexOf('html') > -1) return 'html';
  if (type.indexOf('xml') > -1) return 'xml';
  return 'text';
});

const requestLanguage = computed(function () {
  return String((props.entry.request || {}).contentType || '').indexOf('json') > -1 ? 'json' : 'text';
});
</script>

<template>
  <div class="detail">
    <n-alert v-if="entry.error" type="error" :show-icon="false">{{ entry.error }}</n-alert>

    <div class="meta">
      <span class="label">{{ t('record.matchedApi') }}</span>
      <n-tag v-if="entry.match" size="tiny" :bordered="false" type="success">{{ entry.match.apiName }}</n-tag>
      <span v-else class="none">{{ t('record.noMatchHint') }}</span>
      <span v-if="entry.match" class="path">{{ entry.match.method }} {{ entry.match.path }}</span>
    </div>

    <div class="block">
      <p class="label">{{ t('record.requestHeaders') }}</p>
      <pre class="pre">{{ requestHeaders }}</pre>
    </div>

    <div class="block">
      <p class="label">{{ t('record.requestBody') }}</p>
      <code-editor
        class="body"
        :model-value="requestBody"
        :language="requestLanguage"
        readonly
        wrap
        min-height="80px"
      />
    </div>

    <div class="block">
      <p class="label">{{ t('record.responseHeaders') }}</p>
      <pre class="pre">{{ responseHeaders }}</pre>
    </div>

    <div class="block">
      <p class="label">{{ t('record.responseBody') }}</p>
      <code-editor
        class="body"
        :model-value="responseBody"
        :language="responseLanguage"
        readonly
        wrap
        min-height="80px"
      />
    </div>
  </div>
</template>

<style scoped>
.detail {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 0 10px;
}

.meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.meta .none {
  opacity: 0.6;
}

.meta .path {
  opacity: 0.55;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.block {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.label {
  margin: 0;
  font-size: 12px;
  opacity: 0.6;
}

.pre {
  margin: 0;
  padding: 6px 8px;
  border-radius: 4px;
  background: rgba(128, 128, 128, 0.1);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 160px;
  overflow: auto;
}

.body {
  height: auto;
  max-height: 240px;
  overflow: auto;
}
</style>
