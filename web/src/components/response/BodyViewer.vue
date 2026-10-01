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
  response: { type: Object, default: null },
  /**
   * 这次请求**最终**打到的地址（跟随跳转之后的那个）。预览的基准地址用它 ——
   * 页面里的相对路径（CSS、图片、链接）才能解析到真正的目标上，而不是 iframe 自己的
   * `about:srcdoc`。不是 http(s) 时不做任何事。
   */
  requestUrl: { type: String, default: '' },
  /** 这次请求的方法。GET 才允许「在浏览器中打开」 */
  requestMethod: { type: String, default: '' }
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

/* ---------------- 预览：基准地址与「需要脚本」提示 ---------------- */

/** 属性值里的 `"` `<` `&` 都要转义，免得把 <base> 这个标签本身写坏 */
function escapeAttr(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

/**
 * 给要预览的 HTML 补一个 `<base href="<最终地址>">`。
 *
 * iframe 用 `srcdoc` 时，页面里的相对路径是相对 `about:srcdoc` 解析的 ——
 * 不带样式、图片全裂。补上 base 之后就和在浏览器里打开一样了。
 *
 * 有 `<head>` 就插在它开标签后面（不区分大小写），没有就加在最前面。
 * 原文里已经有 `<base` 的不补（用户自己指定了，尊重它）。
 */
function withBase(html, requestUrl) {
  const url = String(requestUrl || '');
  if (!/^https?:\/\//i.test(url)) return html;
  if (/<base[\s/>]/i.test(html)) return html;

  const tag = '<base href="' + escapeAttr(url) + '">';
  const head = /<head[^>]*>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + tag + html.slice(at);
  }
  return tag + html;
}

/** 去掉脚本、样式、注释和所有标签之后剩下的可见文字 */
function visibleText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 这个页面是不是「要靠脚本才显示得出来」：有 `<script>`，而且去掉脚本 / 样式 / 注释 /
 * 标签之后几乎不剩可见文字。典型的是前端框架的骨架页（整页就一个空的 `<div id="app">`）——
 * 预览里不执行脚本，看到的就是一片空白，得跟用户说一声为什么。
 */
const needsScript = computed(function () {
  if (!isText.value) return false;
  if (!/<script/i.test(body.value)) return false;
  return visibleText(body.value).length < 20;
});

/** GET 且是 http(s) 地址才能直接丢给浏览器打开 */
const canOpenInBrowser = computed(function () {
  if (String(props.requestMethod || '').toUpperCase() !== 'GET') return false;
  return /^https?:\/\//i.test(String(props.requestUrl || ''));
});

function openInBrowser() {
  window.open(props.requestUrl, '_blank', 'noopener');
}

/** 预览用的 srcdoc：补过基准地址的那份 */
const previewHtml = computed(function () {
  return withBase(body.value, props.requestUrl);
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

/**
 * 下载文件名按 content-type 取扩展名。
 * 以前只要是图片就一律写 response.png，jpeg / gif / webp / svg 都会存成错的扩展名，
 * 双击打不开或者被系统当成 png。
 */
const EXTENSIONS = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'image/avif': 'avif',
  'image/tiff': 'tiff',
  'application/json': 'json',
  'application/xml': 'xml',
  'text/xml': 'xml',
  'text/html': 'html',
  'text/plain': 'txt',
  'text/css': 'css',
  'text/csv': 'csv',
  'application/javascript': 'js',
  'text/javascript': 'js',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'application/gzip': 'gz',
  'application/octet-stream': 'bin'
};

function downloadName() {
  const type = lowerType.value.split(';')[0].trim();
  if (EXTENSIONS[type]) return 'response.' + EXTENSIONS[type];

  // 认不出来的图片类型：拿子类型当扩展名，总比给个 .bin 强
  if (type.indexOf('image/') === 0) {
    const subtype = type.slice(6).split('+')[0].replace(/^x-/, '').replace(/[^a-z0-9]/g, '');
    if (subtype) return 'response.' + subtype;
  }
  return 'response.bin';
}

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
  link.download = downloadName();
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

    <!-- 骨架页在预览里是空白的，说清楚原因，并给一条能走的路 -->
    <n-alert
      v-if="isText && view === 'preview' && needsScript"
      type="info"
      :show-icon="false"
      class="notice"
    >
      <div class="script-note">
        <span>这个页面要运行脚本才能显示，预览里不执行脚本。</span>
        <n-button v-if="canOpenInBrowser" size="tiny" quaternary type="primary" @click="openInBrowser">
          在浏览器中打开
        </n-button>
      </div>
    </n-alert>

    <div class="content">
      <template v-if="isText && view === 'pretty'">
        <pre class="text">{{ prettyText }}</pre>
      </template>

      <template v-else-if="isText && view === 'raw'">
        <pre class="text">{{ body }}</pre>
      </template>

      <template v-else-if="isText && view === 'preview'">
        <!--
          sandbox="" 保持不变：空 sandbox 禁掉脚本、表单和同源。
          **不要加 allow-scripts** —— 被调试接口返回的恶意 HTML 就能在管理台的域下执行脚本了。
        -->
        <iframe class="preview" sandbox="" :srcdoc="previewHtml" />
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

/* 提示右边跟一个按钮：提示文字占满，按钮贴右 */
.script-note {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
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
