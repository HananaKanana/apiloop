<script setup>
import { computed, ref, watch } from 'vue';
import { NAlert, NButton, NDropdown, NIcon, useMessage } from 'naive-ui';
import { Braces, ChevronDown, Copy, Download, Eye, ListDetails, Search, TextWrap } from '@vicons/tabler';
import CodeEditor from '@/components/common/CodeEditor.vue';
import JsonTreeView from '@/components/response/JsonTreeView.vue';
import { buildJsonRows } from '@/utils/jsonTree';
import { copyText } from '@/utils/clipboard';

/**
 * 响应体查看器（2026-10-01 按 Postman 重做：用户觉得原来的「太素」）。
 *
 * - **代码视图**：只读的 CodeMirror —— 语法高亮、行号、JSON 可折叠、⌘F / 搜索按钮查找；
 *   左上角选格式（自动识别 / JSON / XML / HTML / JavaScript / 原文），JSON 自动美化；
 * - **预览**：HTML 放进沙箱 iframe 渲染、图片直接显示；
 * - 右边：自动换行、搜索、复制、下载。
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
  requestMethod: { type: String, default: '' },
  /**
   * 只读角色（viewer）：不给「为这个字段加断言 / 提取为变量」这两个入口 ——
   * 它们会改接口、让接口变成「有未保存的修改」。
   */
  readonly: { type: Boolean, default: false }
});

const emit = defineEmits(['add-assertion', 'add-extract']);

const FORMAT_LIMIT = 1024 * 1024;
const WRAP_KEY = 'apiloop.responseWrap';

const message = useMessage();

/** code：代码视图；preview：预览 */
const view = ref('code');
/** auto 表示按 content-type 和内容自己认 */
const format = ref('auto');
const editorRef = ref(null);

function readWrap() {
  try {
    return localStorage.getItem(WRAP_KEY) !== '0';
  } catch (err) {
    return true;
  }
}
const wrap = ref(readWrap());

function toggleWrap() {
  wrap.value = !wrap.value;
  try {
    localStorage.setItem(WRAP_KEY, wrap.value ? '1' : '0');
  } catch (err) {
    // 存不下就只在这次生效
  }
}

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

/** 按 content-type 认格式；没写或写得不准（不少接口 JSON 也回 text/plain）再看内容 */
const detected = computed(function () {
  const type = lowerType.value;
  if (type.indexOf('json') !== -1) return 'json';
  if (type.indexOf('html') !== -1) return 'html';
  if (type.indexOf('xml') !== -1) return 'xml';
  if (type.indexOf('javascript') !== -1) return 'javascript';

  const head = body.value.trimStart().slice(0, 200).toLowerCase();
  if (head.charAt(0) === '{' || head.charAt(0) === '[') {
    try {
      JSON.parse(body.value);
      return 'json';
    } catch (err) {
      // 不是合法 JSON：往下按文本
    }
  }
  if (head.indexOf('<!doctype html') === 0 || head.indexOf('<html') === 0) return 'html';
  if (head.indexOf('<?xml') === 0) return 'xml';
  return 'text';
});

/** 实际用的格式：选了就用选的，否则自动识别的 */
const language = computed(function () {
  return format.value === 'auto' ? detected.value : format.value;
});

const FORMAT_LABELS = { json: 'JSON', xml: 'XML', html: 'HTML', javascript: 'JavaScript', text: '原文' };

const formatOptions = computed(function () {
  return [
    { label: '自动识别（' + FORMAT_LABELS[detected.value] + '）', key: 'auto' },
    { type: 'divider', key: 'd1' },
    { label: 'JSON', key: 'json' },
    { label: 'XML', key: 'xml' },
    { label: 'HTML', key: 'html' },
    { label: 'JavaScript', key: 'javascript' },
    { label: '原文（不格式化、不高亮）', key: 'text' }
  ];
});

function onFormat(key) {
  format.value = key;
  view.value = 'code';
}

/** 代码视图里显示的文字：JSON 美化（太大的不美化），其余原样 */
const prettyText = computed(function () {
  if (!isText.value) return '';
  if (language.value !== 'json' || tooBigToFormat.value) return body.value;
  try {
    return JSON.stringify(JSON.parse(body.value), null, 2);
  } catch (err) {
    // 不是合法 JSON 就按原文显示，不要报错
    return body.value;
  }
});

/** 编辑器的语言：原文不高亮 */
const editorLanguage = computed(function () {
  return language.value === 'text' ? 'text' : language.value;
});

async function copyBody() {
  try {
    await copyText(isText.value ? prettyText.value : body.value);
    message.success('已复制响应体');
  } catch (err) {
    message.warning('复制失败，请手动选中复制');
  }
}

function openSearch() {
  if (view.value !== 'code') view.value = 'code';
  if (editorRef.value) editorRef.value.openSearch();
}

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

/**
 * 「字段」视图的数据（第六轮第 1 节）：把 JSON 摊平成一行一个字段。
 *
 * 三个前置条件不满足就不给这个视图 —— 进了那个视图只会看到一句「为什么没有」，
 * 不如直接把入口藏掉：
 *  - 不是 JSON：没有字段这个概念；
 *  - 超过 1 MB：和「美化」同一个理由（`FORMAT_LIMIT`），解析一遍要几百毫秒；
 *  - 解析不过：`detected` 只在 parse 成功时才认成 json，用户手动选 JSON 时可能不过。
 */
const fieldTree = computed(function () {
  if (!isText.value) return { ok: false, reason: '这段响应不是文本' };
  if (language.value !== 'json') return { ok: false, reason: '这段响应不是 JSON，没有字段列表' };
  if (tooBigToFormat.value) return { ok: false, reason: '响应超过 1 MB，为了不卡住界面不列字段' };
  return buildJsonRows(body.value);
});

// **必须写在 availableViews 前面**：下面那个 `watch(availableViews, …, { immediate: true })` 在组件创建时
// 立刻就要算 availableViews，它又要读 fieldTree —— fieldTree 写在后面的话还在 const 的暂时性死区里，
// 直接抛 ReferenceError，整个 Body 渲染不出来（2026-10-04 用户遇到：所有文本响应的 Body 都是空的）
const availableViews = computed(function () {
  if (isText.value) {
    // 是 JSON 就多一个「字段」视图（第六轮第 1 节）：一行一个字段，可以直接加断言 / 提取
    return fieldTree.value.ok ? ['code', 'fields', 'preview'] : ['code', 'preview'];
  }
  if (isImage.value) return ['preview'];
  return [];
});

// 新的一次响应：格式回到自动识别（上一个接口选的 XML 不该带到下一个 JSON 接口上）
watch(body, function () { format.value = 'auto'; });

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


/** 下载文件名按 content-type 取扩展名。
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
      <template v-if="isText">
        <!-- 格式：左边像 Postman 的「{ } JSON ▾」 -->
        <n-dropdown trigger="click" :options="formatOptions" @select="onFormat">
          <button class="tool format" :class="{ active: view === 'code' }" @click="view = 'code'">
            <n-icon size="14" :component="Braces" />
            <span>{{ FORMAT_LABELS[language] }}</span>
            <n-icon size="12" :component="ChevronDown" />
          </button>
        </n-dropdown>
        <button class="tool" :class="{ active: view === 'preview' }" @click="view = view === 'preview' ? 'code' : 'preview'">
          <n-icon size="14" :component="Eye" />
          <span>预览</span>
        </button>
        <!-- 字段列表（第六轮第 1 节）：只有 JSON 才有，右边每个字段可以直接加断言 / 提取 -->
        <button
          v-if="fieldTree.ok"
          class="tool"
          :class="{ active: view === 'fields' }"
          title="按字段列出响应，可以给某个字段加断言、提取成变量"
          @click="view = view === 'fields' ? 'code' : 'fields'"
        >
          <n-icon size="14" :component="ListDetails" />
          <span>字段</span>
        </button>
      </template>
      <span v-else-if="isImage" class="tool active static">
        <n-icon size="14" :component="Eye" />
        <span>图片</span>
      </span>

      <span class="spacer" />
      <span class="size">{{ formatSize(size) }}</span>

      <template v-if="isText">
        <button class="icon-tool" :class="{ on: wrap }" title="自动换行" @click="toggleWrap">
          <n-icon size="16" :component="TextWrap" />
        </button>
        <button class="icon-tool" title="在响应里查找（⌘F / Ctrl+F）" @click="openSearch">
          <n-icon size="16" :component="Search" />
        </button>
        <button class="icon-tool" title="复制响应体" @click="copyBody">
          <n-icon size="16" :component="Copy" />
        </button>
      </template>
      <button class="icon-tool" title="下载响应体" @click="download">
        <n-icon size="16" :component="Download" />
      </button>
    </div>

    <n-alert v-if="truncated" type="warning" :show-icon="false" class="notice">
      响应体超过上限，界面里只保留了前面一部分；大小显示的是完整长度。
    </n-alert>

    <n-alert
      v-if="language === 'json' && tooBigToFormat && view === 'code'"
      type="info"
      :show-icon="false"
      class="notice"
    >
      响应超过 1 MB，为了不卡住界面就不做美化了，直接显示原文。
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
      <template v-if="isText && view === 'code'">
        <code-editor
          ref="editorRef"
          :key="editorLanguage"
          class="code"
          :model-value="prettyText"
          :language="editorLanguage"
          :wrap="wrap"
          readonly
          min-height="120px"
        />
      </template>

      <template v-else-if="isText && view === 'fields'">
        <json-tree-view
          :tree="fieldTree"
          :readonly="readonly"
          @add-assertion="(payload) => emit('add-assertion', payload)"
          @add-extract="(payload) => emit('add-extract', payload)"
        />
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
  gap: 4px;
}

/* 左边两个「文字 + 图标」的按钮：格式、预览。选中的那个浅底 */
.tool {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 8px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: inherit;
  font-size: 12px;
  cursor: pointer;
  opacity: 0.7;
}

.tool:hover {
  opacity: 1;
  background: rgba(128, 128, 128, 0.12);
}

.tool.active {
  opacity: 1;
  background: rgba(128, 128, 128, 0.14);
  font-weight: 500;
}

.tool.static {
  cursor: default;
}

/* 右边的图标按钮：换行、搜索、复制、下载 */
.icon-tool {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 26px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  opacity: 0.6;
}

.icon-tool:hover {
  opacity: 1;
  background: rgba(128, 128, 128, 0.12);
}

/* 换行开着：常亮 + 浅底，和 Postman 一样能看出状态 */
.icon-tool.on {
  opacity: 1;
  background: rgba(128, 128, 128, 0.14);
}

.spacer {
  flex: 1;
}

.size {
  margin-right: 4px;
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

.code {
  height: 100%;
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
