<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { NAutoComplete, NAlert, NButton, NCheckbox, NDropdown, NIcon, useMessage } from 'naive-ui';
import { Braces, ChevronDown, Copy, Download, Eye, Filter, ListDetails, Search, TextWrap } from '@vicons/tabler';
import CodeEditor from '@/components/common/CodeEditor.vue';
import JsonTreeView from '@/components/response/JsonTreeView.vue';
import { buildJsonRows } from '@/utils/jsonTree';
import { copyText } from '@/utils/clipboard';
import {
  MAX_FILTER_LINES,
  evaluateJsonPath,
  filterByKeyword,
  pushRecentPath,
  readRecentPaths,
  toFilterText
} from '@/utils/responseFilter';

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
  readonly: { type: Boolean, default: false },
  /** 这个响应属于哪个接口（筛选的「最近用过」按它分开存）。临时标签页没有，给空串 */
  apiId: { type: String, default: '' }
});

const emit = defineEmits(['add-assertion', 'add-extract']);

const { t } = useI18n();

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

const FORMAT_LABELS = computed(function () {
  return { json: 'JSON', xml: 'XML', html: 'HTML', javascript: 'JavaScript', text: t('response.formatText') };
});

const formatOptions = computed(function () {
  return [
    { label: t('response.formatAuto', { format: FORMAT_LABELS.value[detected.value] }), key: 'auto' },
    { type: 'divider', key: 'd1' },
    { label: 'JSON', key: 'json' },
    { label: 'XML', key: 'xml' },
    { label: 'HTML', key: 'html' },
    { label: 'JavaScript', key: 'javascript' },
    { label: t('response.formatTextLabel'), key: 'text' }
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
    message.success(t('response.copiedBody'));
  } catch (err) {
    message.warning(t('app.copyFailed'));
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
  if (!isText.value) return { ok: false, reason: t('response.fieldReasonNotText') };
  if (language.value !== 'json') return { ok: false, reason: t('response.fieldReasonNotJson') };
  if (tooBigToFormat.value) return { ok: false, reason: t('response.fieldReasonTooBig') };
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

/* ---------------- 响应筛选（T37） ---------------- */

/** 输入之后多久才真的去算（打一半的表达式算出来全是错，白算） */
const FILTER_DELAY = 300;

const filterOpen = ref(false);
/** jsonpath / keyword */
const filterMode = ref('jsonpath');
/** 输入框里的原文 */
const filterInput = ref('');
/** 防抖之后真正生效的表达式 */
const filterApplied = ref('');
const caseSensitive = ref(false);
const showPath = ref(false);
const recentPaths = ref([]);

/**
 * 筛选结果：
 * `{ pending, mode, count, error, truncated, value, text, lines }`
 * - `pending`：大响应还在后台算；
 * - `text`：JSONPath 的显示文本 / 关键字命中的行（不带行号，复制用）；
 * - `lines`：关键字模式的行（带行号，显示用）。
 */
const filterState = ref({
  pending: false, mode: 'jsonpath', count: 0, error: '',
  truncated: false, value: null, text: '', lines: []
});

/** 每次重算都 +1，算完发现对不上就整批丢掉（大响应异步算时用户可能又改了输入） */
let filterToken = 0;
let filterTimer = null;

/** JSONPath 只在「文本 + 认定成 JSON」时能用 */
const canFilterPath = computed(function () {
  return isText.value && language.value === 'json';
});

/** 筛选真的在起作用（关掉之后要回到完整响应，所以这里带上 filterOpen） */
const filterActive = computed(function () {
  return filterOpen.value && filterApplied.value !== '' && isText.value;
});

const filterCountText = computed(function () {
  if (!filterActive.value || filterState.value.error) return '';
  if (filterState.value.pending) return t('response.filterComputing');
  if (!filterState.value.count) return t('response.filterNoMatch');
  return t('response.filterCount', { n: filterState.value.count });
});

const filterErrorText = computed(function () {
  const err = filterState.value.error;
  if (!err) return '';
  if (err === 'not-json') return t('response.filterNotJson');
  return t('response.filterPathError', { message: err });
});

const recentOptions = computed(function () {
  if (filterMode.value !== 'jsonpath') return [];
  return recentPaths.value.map(function (item) { return { label: item, value: item }; });
});

/**
 * 把一件重活推到空闲时再做（大响应按关键字筛要遍历几百 KB）。
 * `requestIdleCallback` 在 Safari 里还没有，退回 `setTimeout`。
 */
function deferFilter(fn) {
  if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(function () { fn(); }, { timeout: 300 });
    return;
  }
  setTimeout(fn, 0);
}

function computePath(expr) {
  const out = evaluateJsonPath(body.value, expr);
  if (!out.ok) {
    return {
      pending: false, mode: 'jsonpath', count: 0, error: out.error,
      truncated: false, value: null, text: '', lines: []
    };
  }

  const values = out.results.map(function (item) {
    return showPath.value ? { path: item.path, value: item.value } : item.value;
  });
  // 只有一个结果就直接给那个值；多个给数组。打开「显示路径」时一律是 [{ path, value }]
  const value = showPath.value ? values : (out.results.length === 1 ? values[0] : values);

  let text;
  try {
    text = JSON.stringify(value, null, 2);
  } catch (err) {
    text = String(value);
  }
  if (text === undefined) text = 'undefined';

  // 真的算出结果了才记进「最近用过」（打错的表达式不该占位）
  if (out.results.length) recentPaths.value = pushRecentPath(props.apiId, expr);

  return {
    pending: false, mode: 'jsonpath', count: out.results.length, error: '',
    truncated: false, value: value, text: text, lines: []
  };
}

function computeKeyword(expr) {
  // JSON 先格式化成多行再按行筛 —— 没格式化的 JSON 是一整行，按行筛等于没筛
  const out = filterByKeyword(toFilterText(body.value, language.value), expr, {
    caseSensitive: caseSensitive.value
  });

  return {
    pending: false,
    mode: 'keyword',
    count: out.total,
    error: '',
    truncated: out.truncated,
    value: null,
    text: out.lines.map(function (line) { return line.text; }).join('\n'),
    lines: out.lines
  };
}

function runFilter() {
  const token = ++filterToken;
  const mode = filterMode.value;
  const expr = filterApplied.value;

  if (!filterOpen.value || !expr || !isText.value) {
    filterState.value = {
      pending: false, mode: mode, count: 0, error: '',
      truncated: false, value: null, text: '', lines: []
    };
    return;
  }

  const compute = function () {
    // 算的时候用户又改了输入 / 关了筛选：这一份整批作废
    if (token !== filterToken) return;
    filterState.value = mode === 'jsonpath' ? computePath(expr) : computeKeyword(expr);
  };

  // 大响应不在这里硬算，推到空闲时做，免得打字卡顿
  if (size.value > FORMAT_LIMIT || body.value.length > 200000) {
    filterState.value = Object.assign({}, filterState.value, { pending: true });
    deferFilter(compute);
  } else {
    compute();
  }
}

function onFilterInput(value) {
  filterInput.value = value;
  if (filterTimer) clearTimeout(filterTimer);
  filterTimer = setTimeout(function () {
    filterTimer = null;
    filterApplied.value = filterInput.value;
  }, FILTER_DELAY);
}

function setFilterMode(mode) {
  if (mode === 'jsonpath' && !canFilterPath.value) return;
  filterMode.value = mode;
}

function toggleFilter() {
  if (filterOpen.value) {
    // 关掉只是不显示，输入框里的表达式留着 —— 再点开还是它
    filterOpen.value = false;
    return;
  }
  filterOpen.value = true;
  // 是 JSON 就默认 JSONPath，否则默认关键字
  filterMode.value = canFilterPath.value ? 'jsonpath' : 'keyword';
  recentPaths.value = readRecentPaths(props.apiId);
}

async function copyFilterResult() {
  try {
    await copyText(filterState.value.text);
    message.success(t('response.filterCopied'));
  } catch (err) {
    message.warning(t('app.copyFailed'));
  }
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 关键字高亮。**先按原文找命中位置再转义**，不是先转义再找 ——
 * 关键字里带 `<` 或 `&` 时先转义会对不上（响应体是外部数据，也必须转义后再塞进 innerHTML）。
 */
function highlight(line) {
  const text = String(line === undefined || line === null ? '' : line);
  const needle = filterApplied.value;
  if (!needle) return escapeHtml(text);

  const hay = caseSensitive.value ? text : text.toLowerCase();
  const find = caseSensitive.value ? needle : needle.toLowerCase();

  let out = '';
  let at = 0;
  let index = hay.indexOf(find, at);
  while (index !== -1) {
    out += escapeHtml(text.slice(at, index)) +
      '<mark>' + escapeHtml(text.slice(index, index + needle.length)) + '</mark>';
    at = index + needle.length;
    index = hay.indexOf(find, at);
  }
  return out + escapeHtml(text.slice(at));
}

/** ⌘⇧K / Ctrl+Shift+K：开关筛选（这个键位没被本应用别的功能占用） */
function onFilterKeydown(event) {
  if (!(event.metaKey || event.ctrlKey)) return;
  if (!event.shiftKey) return;
  if (String(event.key).toLowerCase() !== 'k') return;
  event.preventDefault();
  toggleFilter();
}

onMounted(function () {
  window.addEventListener('keydown', onFilterKeydown);
});

onBeforeUnmount(function () {
  window.removeEventListener('keydown', onFilterKeydown);
  if (filterTimer) clearTimeout(filterTimer);
});

/** 换接口就把「最近用过」换成这个接口的（临时标签页没有 apiId，读到的是空） */
watch(
  function () { return props.apiId; },
  function () { recentPaths.value = readRecentPaths(props.apiId); },
  { immediate: true }
);

/**
 * 重算的时机：表达式生效、模式变了、开关变了、**响应换了**（重新发送之后筛选条件保留，
 * 自动作用到新响应上）。`body` 变了会走这里，所以不用额外处理「重新发送」。
 */
watch([filterApplied, filterMode, caseSensitive, showPath, body, filterOpen], runFilter);
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
          <span>{{ t('response.preview') }}</span>
        </button>
        <!-- 字段列表（第六轮第 1 节）：只有 JSON 才有，右边每个字段可以直接加断言 / 提取 -->
        <button
          v-if="fieldTree.ok"
          class="tool"
          :class="{ active: view === 'fields' }"
          :title="t('response.fieldsTitle')"
          @click="view = view === 'fields' ? 'code' : 'fields'"
        >
          <n-icon size="14" :component="ListDetails" />
          <span>{{ t('response.fields') }}</span>
        </button>
        <!-- 筛选（T37）：JSONPath / 关键字，⌘⇧K -->
        <button
          class="tool"
          :class="{ active: filterOpen }"
          :title="t('response.filterTitle')"
          @click="toggleFilter"
        >
          <n-icon size="14" :component="Filter" />
          <span>{{ t('response.filterLabel') }}</span>
        </button>
      </template>
      <span v-else-if="isImage" class="tool active static">
        <n-icon size="14" :component="Eye" />
        <span>{{ t('response.image') }}</span>
      </span>

      <span class="spacer" />
      <span class="size">{{ formatSize(size) }}</span>

      <template v-if="isText">
        <button class="icon-tool" :class="{ on: wrap }" :title="t('response.wrapTitle')" @click="toggleWrap">
          <n-icon size="16" :component="TextWrap" />
        </button>
        <button class="icon-tool" :title="t('response.searchTitle')" @click="openSearch">
          <n-icon size="16" :component="Search" />
        </button>
        <button class="icon-tool" :title="t('response.copyBodyTitle')" @click="copyBody">
          <n-icon size="16" :component="Copy" />
        </button>
      </template>
      <button class="icon-tool" :title="t('response.downloadBodyTitle')" @click="download">
        <n-icon size="16" :component="Download" />
      </button>
    </div>

    <n-alert v-if="truncated" type="warning" :show-icon="false" class="notice">
      {{ t('response.truncatedNotice') }}
    </n-alert>

    <!-- 筛选栏（T37）：模式 + 表达式 + 结果数量 + 复制 / 关闭 -->
    <div v-if="filterOpen && isText" class="filter-bar">
      <div class="filter-modes">
        <button
          class="mode"
          :class="{ active: filterMode === 'jsonpath' }"
          :disabled="!canFilterPath"
          :title="canFilterPath ? '' : t('response.filterNotJson')"
          @click="setFilterMode('jsonpath')"
        >
          JSONPath
        </button>
        <button
          class="mode"
          :class="{ active: filterMode === 'keyword' }"
          @click="setFilterMode('keyword')"
        >
          {{ t('response.filterKeyword') }}
        </button>
      </div>

      <n-auto-complete
        class="filter-input"
        size="small"
        clearable
        :value="filterInput"
        :options="recentOptions"
        :placeholder="filterMode === 'jsonpath' ? t('response.filterPathPlaceholder') : t('response.filterKeywordPlaceholder')"
        @update:value="onFilterInput"
      />

      <n-checkbox
        v-if="filterMode === 'keyword'"
        size="small"
        :checked="caseSensitive"
        @update:checked="(v) => { caseSensitive = v; }"
      >
        {{ t('response.filterCaseSensitive') }}
      </n-checkbox>
      <n-checkbox
        v-else
        size="small"
        :checked="showPath"
        @update:checked="(v) => { showPath = v; }"
      >
        {{ t('response.filterShowPath') }}
      </n-checkbox>

      <span class="filter-count">{{ filterCountText }}</span>

      <n-button v-if="filterActive" size="tiny" quaternary @click="copyFilterResult">
        {{ t('response.filterCopy') }}
      </n-button>
      <button class="icon-tool" :title="t('response.filterClose')" @click="toggleFilter">×</button>
    </div>

    <!-- 表达式写错就写在输入框下面，不弹窗 -->
    <p v-if="filterErrorText" class="filter-error">{{ filterErrorText }}</p>

    <n-alert
      v-if="language === 'json' && tooBigToFormat && view === 'code'"
      type="info"
      :show-icon="false"
      class="notice"
    >
      {{ t('response.tooBigNotice') }}
    </n-alert>

    <!-- 骨架页在预览里是空白的，说清楚原因，并给一条能走的路 -->
    <n-alert
      v-if="isText && view === 'preview' && needsScript"
      type="info"
      :show-icon="false"
      class="notice"
    >
      <div class="script-note">
        <span>{{ t('response.needsScriptNotice') }}</span>
        <n-button v-if="canOpenInBrowser" size="tiny" quaternary type="primary" @click="openInBrowser">
          {{ t('response.openInBrowser') }}
        </n-button>
      </div>
    </n-alert>

    <div class="content">
      <!-- 筛选生效时：内容区显示筛选结果，完整响应让位 -->
      <template v-if="filterActive">
        <div v-if="filterState.pending" class="filter-pending">
          {{ t('response.filterComputing') }}
        </div>

        <template v-else-if="filterState.mode === 'keyword'">
          <p v-if="filterState.truncated" class="filter-note">
            {{ t('response.filterTruncated', { n: MAX_FILTER_LINES }) }}
          </p>
          <div class="kw-list">
            <div v-for="line in filterState.lines" :key="line.no" class="kw-line">
              <span class="kw-no">{{ line.no }}</span>
              <span class="kw-text" v-html="highlight(line.text)" />
            </div>
          </div>
        </template>

        <!-- JSONPath 的结果：单条就是那个值，多条是数组，只读高亮 -->
        <code-editor
          v-else
          class="code"
          :model-value="filterState.text"
          language="json"
          :wrap="wrap"
          readonly
          min-height="120px"
        />
      </template>

      <template v-else-if="isText && view === 'code'">
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
          <img class="image" :src="dataUrl" :alt="t('response.imageAlt')" />
        </div>
      </template>

      <template v-else>
        <div class="binary">
          <p>{{ t('response.binaryNotice') }}</p>
          <p class="binary-size">{{ t('response.binarySize', { size: formatSize(size) }) }}</p>
          <n-button size="small" @click="download">{{ t('response.download') }}</n-button>
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

/* ---------------- 响应筛选（T37） ---------------- */

.filter-bar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 6px;
  background: rgba(128, 128, 128, 0.09);
}

/* 模式切换：两个贴在一起的按钮，选中的那个浅底加粗 */
.filter-modes {
  flex: none;
  display: flex;
  gap: 2px;
}

.filter-modes .mode {
  height: 24px;
  padding: 0 10px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  font-size: 12px;
  cursor: pointer;
  opacity: 0.65;
}

.filter-modes .mode:hover:not(:disabled) {
  background: rgba(128, 128, 128, 0.14);
  opacity: 1;
}

.filter-modes .mode.active {
  background: rgba(128, 128, 128, 0.2);
  opacity: 1;
  font-weight: 500;
}

/* 非 JSON 时 JSONPath 灰掉（响应不是 JSON，表达式算不了） */
.filter-modes .mode:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.filter-input {
  flex: 1;
  min-width: 160px;
  max-width: 420px;
}

.filter-count {
  flex: none;
  font-size: 12px;
  opacity: 0.65;
  white-space: nowrap;
}

/* 表达式写错：红字写在输入框下面，不弹窗 */
.filter-error {
  flex: none;
  margin: 0;
  padding-left: 2px;
  font-size: 12px;
  color: #d03050;
  word-break: break-all;
}

.filter-pending,
.filter-note {
  margin: 0 0 6px;
  font-size: 12px;
  opacity: 0.6;
}

.kw-list {
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  line-height: 1.7;
}

.kw-line {
  display: flex;
  gap: 10px;
}

/* 行号那一列固定宽度、右对齐，右边正文不会因为行号位数变化而抖动 */
.kw-no {
  flex: none;
  width: 48px;
  text-align: right;
  opacity: 0.45;
  user-select: none;
}

.kw-text {
  flex: 1;
  min-width: 0;
  white-space: pre-wrap;
  word-break: break-all;
}

.kw-text :deep(mark) {
  padding: 0 1px;
  border-radius: 2px;
  background: rgba(255, 196, 0, 0.45);
  color: inherit;
}
</style>
