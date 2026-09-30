<script setup>
import { computed, ref, watch } from 'vue';
import { NAlert, NButton, NRadioButton, NRadioGroup } from 'naive-ui';

/**
 * 响应体查看器：美化 / 原文 / 预览三种视图。
 *
 * 预览一定放在 <iframe sandbox=""> 里渲染 —— 空 sandbox 表示禁掉脚本、表单和同源，
 * 所以被调试接口返回的恶意 HTML 也动不了管理台。**这里绝对不能用 v-html**，
 * 否则那段 HTML 会在管理台自己的域下执行脚本。
 */
const props = defineProps({
  response: { type: Object, default: null }
});

const FORMAT_LIMIT = 1024 * 1024;

const view = ref('pretty');

function headerValue(headers, name) {
  const target = String(name).toLowerCase();
  let found = '';
  (headers || []).forEach(function (pair) {
    if (String(pair[0]).toLowerCase() === target) found = String(pair[1]);
  });
  return found;
}

const contentType = computed(function () {
  return headerValue(props.response && props.response.headers, 'content-type');
});

const encoding = computed(function () {
  return (props.response && props.response.bodyEncoding) || 'utf8';
});

const body = computed(function () {
  return (props.response && props.response.body) || '';
});

const size = computed(function () {
  return (props.response && props.response.size) || 0;
});

const truncated = computed(function () {
  return Boolean(props.response && props.response.truncated);
});

const lowerType = computed(function () {
  return contentType.value.toLowerCase();
});

const isText = computed(function () {
  return encoding.value === 'utf8';
});

const isImage = computed(function () {
  return encoding.value === 'base64' && lowerType.value.indexOf('image/') !== -1;
});

const isJson = computed(function () {
  return lowerType.value.indexOf('json') !== -1;
});

const tooBigToFormat = computed(function () {
  return size.value > FORMAT_LIMIT;
});

const prettyText = computed(function () {
  if (!isText.value) return '';
  if (!isJson.value || tooBigToFormat.value) return body.value;
  try {
    return JSON.stringify(JSON.parse(body.value), null, 2);
  } catch (err) {
    // 不是合法 JSON 就按原文显示，不要报错
    return body.value;
  }
});

const dataUrl = computed(function () {
  if (!isImage.value) return '';
  return 'data:' + (contentType.value || 'image/png') + ';base64,' + body.value;
});

const availableViews = computed(function () {
  if (isText.value) return ['pretty', 'raw', 'preview'];
  if (isImage.value) return ['preview'];
  return [];
});

watch(
  availableViews,
  function (views) {
    if (!views.length) {
      view.value = '';
      return;
    }
    if (views.indexOf(view.value) === -1) view.value = views[0];
  },
  { immediate: true }
);

function download() {
  let blob;

  if (encoding.value === 'base64') {
    const binary = atob(body.value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    blob = new Blob([bytes], { type: contentType.value || 'application/octet-stream' });
  } else {
    blob = new Blob([body.value], { type: contentType.value || 'text/plain' });
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = isImage.value ? 'response.png' : 'response.bin';
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}
</script>

<template>
  <div class="body-viewer">
    <div class="toolbar">
      <n-radio-group v-if="availableViews.length > 1" v-model:value="view" size="small">
        <n-radio-button v-if="availableViews.indexOf('pretty') !== -1" value="pretty">美化</n-radio-button>
        <n-radio-button v-if="availableViews.indexOf('raw') !== -1" value="raw">原文</n-radio-button>
        <n-radio-button v-if="availableViews.indexOf('preview') !== -1" value="preview">预览</n-radio-button>
      </n-radio-group>
      <span v-else class="spacer" />

      <span class="size">{{ formatSize(size) }}</span>
      <n-button size="tiny" quaternary @click="download">下载</n-button>
    </div>

    <n-alert v-if="truncated" type="warning" :show-icon="false" class="notice">
      响应体超过上限，界面里只保留了前面一部分；大小显示的是完整长度。
    </n-alert>

    <n-alert
      v-if="isJson && tooBigToFormat"
      type="info"
      :show-icon="false"
      class="notice"
    >
      响应超过 1 MB，为了不卡住界面就不做格式化高亮了，直接显示原文。
    </n-alert>

    <div class="content">
      <template v-if="isText && view === 'pretty'">
        <pre class="text">{{ prettyText }}</pre>
      </template>

      <template v-else-if="isText && view === 'raw'">
        <pre class="text">{{ body }}</pre>
      </template>

      <template v-else-if="isText && view === 'preview'">
        <iframe class="preview" sandbox="" :srcdoc="body" />
      </template>

      <template v-else-if="isImage">
        <div class="image-wrap">
          <img class="image" :src="dataUrl" alt="响应图片" />
        </div>
      </template>

      <template v-else>
        <div class="binary">
          <p>这是二进制响应，界面里不展示内容。</p>
          <p class="binary-size">大小：{{ formatSize(size) }}</p>
          <n-button size="small" @click="download">下载</n-button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.body-viewer {
  display: flex;
  flex-direction: column;
  gap: 8px;
  height: 100%;
  min-height: 0;
}

.toolbar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
}

.spacer {
  flex: 1;
}

.size {
  font-size: 12px;
  opacity: 0.6;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.notice {
  font-size: 12px;
}

.content {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.text {
  margin: 0;
  padding: 8px 10px;
  border: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.24));
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.6;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: pre-wrap;
  word-break: break-all;
}

.preview {
  width: 100%;
  height: 100%;
  min-height: 320px;
  border: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.24));
  border-radius: 6px;
  background: #fff;
}

.image-wrap {
  display: flex;
  justify-content: center;
  padding: 12px;
}

.image {
  max-width: 100%;
  image-rendering: pixelated;
}

.binary {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  font-size: 13px;
  opacity: 0.8;
}

.binary p {
  margin: 0;
}

.binary-size {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
</style>
