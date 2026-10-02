<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  NButton,
  NCheckbox,
  NDropdown,
  NForm,
  NFormItem,
  NIcon,
  NInput,
  NModal,
  NSelect,
  NSpace,
  NSwitch,
  NTabPane,
  NTabs,
  useMessage
} from 'naive-ui';
import { ChevronDown, Code, DeviceFloppy } from '@vicons/tabler';
import { useProjectStore } from '@/stores/project';
import { useEnvStore } from '@/stores/env';
import { useTabsStore, specFromApi, emptyOptions } from '@/stores/tabs';
import { useTreeStore } from '@/stores/tree';
import * as apisApi from '@/api/apis';
import KeyValueTable from '@/components/common/KeyValueTable.vue';
import InlineRename from '@/components/common/InlineRename.vue';
import CurlSnippet from '@/components/request/CurlSnippet.vue';
import { mockBaseFor } from '@/utils/mock';
import TemplatizeDialog from '@/components/common/TemplatizeDialog.vue';
import CookieManagerModal from './CookieManagerModal.vue';
import UrlBar from './UrlBar.vue';
import BodyEditor from './BodyEditor.vue';
import AuthEditor from './AuthEditor.vue';
import ScriptEditor from '@/components/scripts/ScriptEditor.vue';
import MockPanel from '@/components/mock/MockPanel.vue';
import ResponsePanel from '@/components/response/ResponsePanel.vue';
import { folderChain } from '@/utils/tree';
import { inheritHint } from '@/utils/auth';
import { clampReplayDelay } from '@/utils/replay';
import { resolveScope, missingVariables } from '@/utils/variables';
import { HEADER_NAMES } from '@/utils/suggestions';
import { parseCurl } from '@/utils/curl';
import { encodeQueryPart } from '@/utils/query';
import { usePaneTabsTheme } from '@/utils/paneTabs';
import { useUiStore } from '@/stores/ui';
import { useGatewayStore } from '@/stores/gateway';
import { copyText } from '@/utils/clipboard';

/**
 * 一个标签页的完整内容：地址栏 + 请求编辑区（Params / Headers / Body / Auth / Scripts）
 * + 响应面板。
 *
 * spec 是标签页里那个编辑中的对象，下面各子组件直接改它；改动由本组件的深度 watch
 * 记成 dirty。发送时发的是编辑中的内容，不需要先保存。
 */
const props = defineProps({
  tab: { type: Object, required: true }
});

const projects = useProjectStore();
const envs = useEnvStore();
const tabs = useTabsStore();
const tree = useTreeStore();
const ui = useUiStore();
const gateway = useGatewayStore();

/** 这个接口和云端对不上：标签页顶部一条红提示 + 「处理」入口（设计稿第 7 节） */
const conflicted = computed(function () {
  return Boolean(props.tab.apiId) && gateway.isConflicted('api', props.tab.apiId);
});

function openConflict() {
  if (!props.tab.apiId) return;
  ui.openConflict('api', props.tab.apiId);
}
const paneTabsTheme = usePaneTabsTheme();
const message = useMessage();

const activePane = ref('params');
const saving = ref(false);
const savingExample = ref(false);
const showSaveDialog = ref(false);
const saveForm = ref({ name: '', folderId: null });

const showCookies = ref(false);

/* 「保存为示例」弹窗：可选先做智能模板化 */
const showSaveExample = ref(false);
const saveExampleName = ref('');
const saveExampleTemplatize = ref(false);
const showTemplatize = ref(false);
const templatizeBody = ref('');

const spec = computed(function () {
  return props.tab.spec;
});

/**
 * `/send` 的 options（契约第 12 节）。是标签页自己的界面状态，不落库。
 * 默认两个都开；老标签页上没有这个字段时兜一个默认值。
 */
const requestOptions = computed(function () {
  return props.tab.options || emptyOptions();
});

function setOption(key, value) {
  const next = Object.assign({}, requestOptions.value);
  next[key] = value;
  props.tab.options = next;
}

/**
 * 鉴权选了「继承父级」时，实际会用哪一级（契约第 5 节第 2 步）：
 * 接口所在的目录 → 各级父目录 → 项目，第一个真正配置过的生效。
 * 用目录树里已有的 folders 和项目自己的 auth 算，和服务端同一套规则。
 */
const authLevels = computed(function () {
  const levels = folderChain(tree.folders, props.tab.folderId).map(function (folder) {
    return { auth: folder.auth, label: '目录「' + folder.name + '」' };
  });

  levels.push({
    auth: projects.current ? projects.current.auth : null,
    label: '项目'
  });
  return levels;
});

const inheritAuthHint = computed(function () {
  return inheritHint(authLevels.value);
});

/* ---------------- 请求区 / 响应区之间的分隔线 ---------------- */

/**
 * 分栏位置只用一个键：`api` / `draft` / `history` 三种标签页都是 HTTP 请求，
 * 按 `kind` 分三份存的话，用户会觉得「刚拖好的高度怎么又变了」。
 */
const SPLIT_KEY = 'apiloop.split.http';
/** 两块各自的最小高度，拖到头就不让再拖了 */
const MIN_PANES = 120;
const MIN_RESPONSE = 120;
const DEFAULT_PANES = 260;

function readSplitHeight() {
  try {
    const value = Number(localStorage.getItem(SPLIT_KEY));
    if (value >= MIN_PANES) return value;
  } catch (err) {
    // 读不到就用默认值
  }
  return DEFAULT_PANES;
}

const rootRef = ref(null);
const panesRef = ref(null);
const panesHeight = ref(readSplitHeight());
const draggingSplit = ref(false);

/**
 * 请求区最高能到多少：从**请求区的顶边**量到整个标签页的底边，再给响应区留出最小高度。
 *
 * 不能拿 `rootRef.clientHeight` 直接算 —— 请求区上面还有面包屑、地址栏，
 * 有时还有那条未定义变量的提示，加起来 100px 左右；不减掉的话，
 * 一拖动分隔线就跳到鼠标下方 100px 的地方，响应区还会被挤到只剩几十像素。
 *
 * @returns {number|null} 量不出来（或者容器太矮）时返回 null，调用方直接不动
 */
function maxPanesHeight() {
  if (!rootRef.value || !panesRef.value) return null;
  const bottom = rootRef.value.getBoundingClientRect().bottom;
  const top = panesRef.value.getBoundingClientRect().top;
  const max = bottom - top - MIN_RESPONSE - 8;
  return max < MIN_PANES ? null : max;
}

function startSplitDrag() {
  draggingSplit.value = true;
  document.body.style.userSelect = 'none';
  document.body.style.cursor = 'row-resize';
}

function onSplitMove(event) {
  if (!draggingSplit.value || !panesRef.value) return;
  const max = maxPanesHeight();
  if (max === null) return;
  const top = panesRef.value.getBoundingClientRect().top;
  panesHeight.value = Math.max(MIN_PANES, Math.min(event.clientY - top, max));
}

/**
 * 把高度夹回可视范围：在高屏上拖到 600px，换到矮屏或把窗口缩小之后，
 * 响应区会被挤到 120px 以下。挂载时和窗口 resize 时都要收一下。
 * 这里只改当前值、不写回 localStorage —— 窗口再变大时还能回到原来那个高度。
 */
function clampPanesHeight() {
  const max = maxPanesHeight();
  if (max === null) return;
  panesHeight.value = Math.max(MIN_PANES, Math.min(panesHeight.value, max));
}

function stopSplitDrag() {
  if (!draggingSplit.value) return;
  draggingSplit.value = false;
  document.body.style.userSelect = '';
  document.body.style.cursor = '';
  // 拖动的位置按标签页类型记下来，下次打开还是这个高度
  try {
    localStorage.setItem(SPLIT_KEY, String(Math.round(panesHeight.value)));
  } catch (err) {
    // 存不下就算了，这次会话内还是好用的
  }
}

/**
 * 地址里有没有 `:name` 这类路径变量。有才显示「路径参数」那一块 ——
 * 和 lib/url-utils.js 的 PATH_PARAM 同一套写法（`:` 前面是 `/` 或开头，
 * 免得把 http://host:8080 的端口号当成参数）。
 */
const hasPathParams = computed(function () {
  return /(^|\/):[\w-]+/.test(String(props.tab.spec.url || ''));
});

/**
 * 这次请求的变量作用域（契约第 5 节）：项目 < 目录链（从外到内）< 环境。
 * 地址栏、参数表、鉴权的变量高亮 / 补全 / 悬停提示都读它。
 */
const scope = computed(function () {
  return resolveScope({
    project: projects.current,
    folders: tree.folders,
    folderId: props.tab.folderId,
    environment: envs.selected
  });
});

/**
 * 发送**之前**就提示未定义的变量（原来那条在响应区，是关于请求的，位置不对）。
 * 用 findVariables + scope 在前端直接算，不用等发送回来。
 */
const undefinedVariables = computed(function () {
  return missingVariables(props.tab.spec, scope.value);
});

watch(
  function () { return props.tab.spec; },
  function () { tabs.touch(props.tab); },
  { deep: true }
);

/* ---------------- url 与 params 的同步 ---------------- */

function decodePart(text) {
  try {
    return decodeURIComponent(String(text).replace(/\+/g, ' '));
  } catch (err) {
    return String(text);
  }
}

/** url 里的 :name 同步进路径参数表；url 里的查询串同步进 query 表 */
function syncFromUrl(urlText) {
  const current = props.tab.spec;

  const names = [];
  const pattern = /(^|\/):([\w-]+)/g;
  let matched = pattern.exec(urlText);
  while (matched) {
    names.push(matched[2]);
    matched = pattern.exec(urlText);
  }

  const pathRows = (current.params.path || []).slice();
  names.forEach(function (name) {
    if (pathRows.some(function (row) { return row.key === name; })) return;
    pathRows.push({ key: name, value: '', type: 'string', required: false, desc: '', enabled: true });
  });
  // url 里删掉的参数，值为空的就一起删掉；有值的留着，免得误删
  current.params.path = pathRows.filter(function (row) {
    return names.indexOf(row.key) !== -1 || String(row.value || '') !== '';
  });

  const queryIndex = urlText.indexOf('?');
  const parsed = [];
  if (queryIndex !== -1) {
    urlText.slice(queryIndex + 1).split('#')[0].split('&').forEach(function (pair) {
      if (!pair) return;
      const eq = pair.indexOf('=');
      const key = eq === -1 ? pair : pair.slice(0, eq);
      const value = eq === -1 ? '' : pair.slice(eq + 1);
      if (!key) return;
      parsed.push({ key: decodePart(key), value: decodePart(value) });
    });
  }

  const previous = new Map((current.params.query || []).map(function (row) { return [row.key, row]; }));
  const next = parsed.map(function (item) {
    const old = previous.get(item.key);
    return old
      ? Object.assign({}, old, { value: item.value })
      : { key: item.key, value: item.value, type: 'string', required: false, desc: '', enabled: true };
  });

  // 停用的行不会出现在 url 里，但它们还得留在表里
  (current.params.query || []).forEach(function (row) {
    if (row.enabled === false && !next.some(function (item) { return item.key === row.key; })) {
      next.push(row);
    }
  });

  current.params.query = next;
}

function onUrlChange(value) {
  props.tab.spec.url = value;
  syncFromUrl(value);
}

/** 反过来：改 query 表格就把 url 的查询串重拼一遍 */
function onQueryChange(rows) {
  props.tab.spec.params.query = rows;
  const base = String(props.tab.spec.url || '').split('?')[0].split('#')[0];
  const queryString = (rows || []).filter(function (row) {
    return row.enabled !== false && row.key;
  }).map(function (row) {
    return encodeQueryPart(row.key) + '=' + encodeQueryPart(row.value);
  }).join('&');

  props.tab.spec.url = queryString ? base + '?' + queryString : base;
}

/* ---------------- 发送 ---------------- */

function onSend() {
  tabs.sendRequest(projects.currentId, envs.selectedId);
}

function onCancel() {
  tabs.cancelSend();
}

/* ---------------- 地址栏粘贴 cURL ---------------- */

/**
 * 地址栏里粘了一段 cURL（和 Postman 一样）：整条请求换成解析出来的那个，
 * **标签页的名字不动** —— 用户多半是想拿这个地址发一次，不是想改名。
 * 解析失败就只提示原因，地址栏里原来是什么还是什么。
 */
function onPasteCurl(text) {
  let parsed;
  try {
    parsed = parseCurl(text);
  } catch (err) {
    message.error(err.message);
    return;
  }

  const current = props.tab.spec;
  current.method = parsed.method;
  current.url = parsed.url;
  current.params = {
    path: [],
    query: parsed.params.query,
    headers: parsed.params.headers
  };
  current.body = parsed.body;
  current.auth = parsed.auth;
  // scripts 不在替换范围内，原样留着

  message.success('已从 cURL 填充');
}

/* ---------------- 保存 ---------------- */

function folderOptions() {
  const options = [{ label: '（根目录）', value: null }];
  (function walk(nodes, depth) {
    (nodes || []).forEach(function (node) {
      if (node.kind !== 'folder') return;
      options.push({ label: '　'.repeat(depth) + node.name, value: node.id });
      walk(node.children, depth + 1);
    });
  })(tree.nodes, 0);
  return options;
}

/** 只提交改动过的字段 */
function changedFields(api, current) {
  const saved = specFromApi(api);
  const patch = {};

  if (current.method !== saved.method) patch.method = current.method;
  if (current.url !== saved.url) patch.url = current.url;
  if (JSON.stringify(current.params) !== JSON.stringify(saved.params)) patch.params = current.params;
  if (JSON.stringify(current.body) !== JSON.stringify(saved.body)) patch.body = current.body;
  if (JSON.stringify(current.auth) !== JSON.stringify(saved.auth)) patch.auth = current.auth;
  if (JSON.stringify(current.scripts || []) !== JSON.stringify(saved.scripts || [])) {
    patch.scripts = current.scripts || [];
  }

  return patch;
}

async function save() {
  if (!projects.currentId) {
    message.warning('还没有选中项目');
    return;
  }

  // 还没保存过的临时标签页：先问目录和名称
  if (!props.tab.apiId) {
    saveForm.value = {
      // 双击改过名就用改的名字，否则用地址
      name: props.tab.customTitle ? props.tab.title : (props.tab.spec.url || '新建接口'),
      folderId: props.tab.folderId || null
    };
    showSaveDialog.value = true;
    return;
  }

  const patch = changedFields(props.tab.api, props.tab.spec);
  if (!Object.keys(patch).length) {
    message.info('没有改动');
    return;
  }

  saving.value = true;
  try {
    const data = await apisApi.updateApi(props.tab.apiId, patch);
    tabs.markSaved(props.tab, data.api);
    await tree.refresh();
    message.success('已保存');
  } catch (err) {
    message.error(err.message);
  } finally {
    saving.value = false;
  }
}

async function confirmSaveDraft() {
  if (!saveForm.value.name.trim()) {
    message.warning('请填写接口名称');
    return;
  }

  saving.value = true;
  try {
    const payload = Object.assign({}, props.tab.spec, {
      name: saveForm.value.name.trim(),
      folderId: saveForm.value.folderId
    });
    const data = await apisApi.createApi(projects.currentId, payload);
    tabs.markSaved(props.tab, data.api);
    showSaveDialog.value = false;
    await tree.refresh();
    message.success('已保存');
  } catch (err) {
    message.error(err.message);
  } finally {
    saving.value = false;
  }
}

/* ---------------- 面包屑与「另存为」 ---------------- */

/** 项目 › 目录… › 接口名。临时标签页还没名字，最后一级就是「新建请求」 */
const crumbs = computed(function () {
  const list = [];
  if (projects.current) list.push(projects.current.name);
  folderChain(tree.folders, props.tab.folderId).forEach(function (folder) {
    list.push(folder.name);
  });
  list.push(props.tab.title || '新建请求');
  return list;
});

/**
 * 面包屑上双击改名。
 *
 * - 已保存的接口：**只改名字**，立刻存（`renameApi`），别的没保存的修改原样留着；
 * - 还没保存过的新请求：只改标题，记一个 `customTitle`，保存时弹窗里的默认名用它。
 *
 * 失败时不动标题，面包屑显示的自然还是原名。
 */
async function renameTitle(name) {
  if (!props.tab.apiId) {
    props.tab.title = name;
    props.tab.customTitle = true;
    return;
  }

  try {
    await tree.renameApi(props.tab.apiId, name);
    tabs.applyRename('api', props.tab.apiId, name);
    message.success('已重命名');
  } catch (err) {
    message.error(err.message);
  }
}

const saveMenu = [
  { label: '另存为…', key: 'save-as' },
  { label: '复制为 cURL', key: 'copy-curl' }
];

function onSaveMenu(key) {
  if (key === 'save-as') saveAs();
  if (key === 'copy-curl') copyCurl();
}

/* ---------------- 代码片段（cURL） ---------------- */

const showSnippet = ref(false);

/** 按当前环境生成这个请求的 cURL（后台按发送的同一套规则解析变量和鉴权，不发请求） */
function loadCurl() {
  return apisApi.curlFor(projects.currentId, {
    request: JSON.parse(JSON.stringify(props.tab.spec)),
    apiId: props.tab.apiId || undefined,
    environmentId: envs.selectedId || undefined,
    mockBase: mockBaseFor(envs.selectedId, projects.current)
  });
}

/** 一键复制：不开面板，直接进剪贴板 */
async function copyCurl() {
  try {
    const data = await loadCurl();
    await copyText(data.curl || '');
    message.success(data.missing && data.missing.length
      ? '已复制 cURL（有未定义的变量：' + data.missing.join('、') + '）'
      : '已复制 cURL');
  } catch (err) {
    message.error('复制失败：' + err.message);
  }
}

/**
 * 另存为：不管当前这个标签页绑没绑接口，都开那个「名称 + 目录」的弹窗，
 * 确认之后走 createApi 建一个新的。绑了接口的会把标题带上「副本」做默认名。
 */
function saveAs() {
  if (!projects.currentId) {
    message.warning('还没有选中项目');
    return;
  }

  const fallback = props.tab.apiId ? props.tab.title + ' 副本' : (props.tab.spec.url || '新建接口');
  saveForm.value = {
    name: fallback,
    folderId: props.tab.folderId || null
  };
  showSaveDialog.value = true;
}

/* ---------------- 页签上的计数 ---------------- */

/** 已启用、而且填了内容的行才算一条 */
function enabledCount(rows) {
  return (rows || []).filter(function (row) {
    return row && row.enabled !== false && (row.key || row.value);
  }).length;
}

/** 鉴权页签后面跟的那个词，和 AuthEditor 里的类型下拉一致 */
const AUTH_LABELS = {
  inherit: '继承',
  none: '无',
  bearer: 'Bearer',
  basic: 'Basic',
  apikey: 'API Key'
};

const paneStatus = computed(function () {
  const spec = props.tab.spec;
  const params = spec.params || {};
  const auth = spec.auth || {};

  return {
    params: enabledCount(params.path) + enabledCount(params.query),
    headers: enabledCount(params.headers),
    hasBody: Boolean(spec.body && spec.body.mode && spec.body.mode !== 'none'),
    hasScripts: (spec.scripts || []).some(function (item) {
      return item && String(item.exec || '').trim();
    }),
    auth: AUTH_LABELS[String(auth.type || 'inherit')] || '继承'
  };
});

/* ---------------- 保存为示例 ---------------- */

function guessResponseType(headers) {
  let contentType = '';
  (headers || []).forEach(function (pair) {
    if (String(pair[0]).toLowerCase() === 'content-type') contentType = String(pair[1]).toLowerCase();
  });
  if (contentType.indexOf('json') !== -1) return 'json';
  if (contentType.indexOf('html') !== -1) return 'html';
  return 'text';
}

function stamp() {
  const now = new Date();
  function pad(value) { return String(value).padStart(2, '0'); }
  return now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) +
    ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds());
}

/** 录制的响应是不是 JSON —— 只有 JSON 才谈得上「智能模板化」 */
const recordedResponseType = computed(function () {
  const response = props.tab.result && props.tab.result.response;
  return response ? guessResponseType(response.headers) : 'text';
});

const canTemplatize = computed(function () {
  return recordedResponseType.value === 'json';
});

/** 点「保存为示例」：先开弹窗，让用户决定要不要模板化 */
function openSaveExample() {
  const response = props.tab.result && props.tab.result.response;
  if (!response || !props.tab.apiId) return;

  saveExampleName.value = response.status + ' 录制于 ' + stamp();
  // 只有 JSON 默认勾选；其他类型连这个选项都不显示
  saveExampleTemplatize.value = canTemplatize.value;
  showSaveExample.value = true;
}

function confirmSaveExample() {
  const response = props.tab.result && props.tab.result.response;
  if (!response) return;

  showSaveExample.value = false;

  if (!saveExampleTemplatize.value) {
    saveExample(response.body, false);
    return;
  }

  // 先看替换清单，确认了才动数据
  templatizeBody.value = response.body;
  showTemplatize.value = true;
}

/**
 * 模板化确认回调。服务端说 skipped（不是合法 JSON / 换完解析不过）时，
 * 原样提示原因，并按**原文**保存 —— 用户要的是「存下来」，不能因为模板化失败就丢掉。
 */
function onTemplatizeConfirm(payload) {
  const response = props.tab.result && props.tab.result.response;
  if (!response) return;

  if (payload.skipped) {
    message.warning(payload.skipped);
    saveExample(response.body, false);
    return;
  }

  saveExample(payload.body, true);
}

/* ---------------- 保存为 SSE 示例（契约第 17 节） ---------------- */

/** 逐跳和长度相关的响应头不录进示例：SSE 回放时长度由服务端自己决定 */
const SSE_HEADER_SKIP = ['content-length', 'content-encoding', 'transfer-encoding', 'connection'];

function sseExampleHeaders() {
  const head = props.tab.head;
  const headers = (head && head.response && head.response.headers) || [];

  return headers.filter(function (pair) {
    return SSE_HEADER_SKIP.indexOf(String(pair[0]).toLowerCase()) === -1;
  }).map(function (pair) {
    return {
      key: pair[0],
      value: pair[1],
      type: 'string',
      required: false,
      desc: '',
      enabled: true
    };
  });
}

/**
 * 把这次收到的事件存成 `sse` 类型的示例。
 *
 * `delay` 是**和上一条之间的间隔**，第一条相对于响应头到达的时刻（契约第 17 节），
 * 所以要从 `tab.head.time` 起算。事件视图最多留 2000 条，丢过的话要提醒用户
 * 存下来的不是全部。
 *
 * 间隔超过 60 秒的按 60 秒截断 —— 心跳间隔本来就可能是好几分钟，
 * 不截的话服务端会以「delay 越界」直接 400，整个示例都存不下去。
 */
async function saveSseExample() {
  const tab = props.tab;
  const events = tab.sseEvents || [];
  if (!tab.apiId || !events.length) return;

  let previous = (tab.head && tab.head.time) || events[0].time;
  let cappedDelays = 0;

  const list = events.map(function (item) {
    const clamped = clampReplayDelay(item.time - previous);
    previous = item.time;
    if (clamped.capped) cappedDelays += 1;

    const entry = { delay: clamped.delay, data: item.data };
    // 解析器把没有 event 字段的都当成 message，存回去时就不写它了
    if (item.event && item.event !== 'message') entry.event = item.event;
    if (item.id) entry.id = item.id;
    return entry;
  });

  const status = (tab.result && tab.result.response && tab.result.response.status) || 200;

  savingExample.value = true;
  try {
    const data = await apisApi.createExample(tab.apiId, {
      name: status + ' SSE 录制于 ' + stamp(),
      status: status,
      headers: sseExampleHeaders(),
      body: JSON.stringify({ events: list, repeat: false }, null, 2),
      responseType: 'sse',
      isTemplate: false,
      source: 'recorded'
    });

    tab.api = data.api;
    // 切到 Mock 页签并选中刚存下的这条，用户接着就能启用 mock
    tab.focusExampleId = data.example.id;
    activePane.value = 'mock';

    const notes = [];
    if (tab.sseDropped) notes.push('事件超过上限，只保存了最近 2000 条');
    if (cappedDelays) notes.push('有 ' + cappedDelays + ' 处间隔超过 60 秒，按 60 秒保存');

    if (notes.length) message.warning('已存为 SSE 示例；' + notes.join('；'));
    else message.success('已存为 SSE 示例');
  } catch (err) {
    message.error(err.message);
  } finally {
    savingExample.value = false;
  }
}

async function saveExample(body, isTemplate) {
  const response = props.tab.result && props.tab.result.response;
  if (!response || !props.tab.apiId) return;

  savingExample.value = true;
  try {
    const data = await apisApi.createExample(props.tab.apiId, {
      name: saveExampleName.value || (response.status + ' 录制于 ' + stamp()),
      status: response.status,
      headers: (response.headers || []).map(function (pair) {
        return {
          key: pair[0],
          value: pair[1],
          type: 'string',
          required: false,
          desc: '',
          enabled: true
        };
      }),
      body: body,
      responseType: recordedResponseType.value,
      isTemplate: Boolean(isTemplate),
      source: 'recorded'
    });

    props.tab.api = data.api;
    // Mock 页签打开着（或下次打开）时直接选中刚存的这条
    if (data.example) props.tab.focusExampleId = data.example.id;
    message.success(isTemplate ? '已存为模板示例' : '已存为示例');
  } catch (err) {
    message.error(err.message);
  } finally {
    savingExample.value = false;
  }
}

/* ---------------- 快捷键 ---------------- */

function onKeydown(event) {
  if (!(event.metaKey || event.ctrlKey)) return;
  if (String(event.key).toLowerCase() !== 's') return;
  event.preventDefault();

  // 只读角色连快捷键也要挡住，并说清楚为什么
  if (!projects.canEdit) {
    message.warning('当前角色是只读，不能保存修改');
    return;
  }

  save();
}

onMounted(function () {
  window.addEventListener('keydown', onKeydown);
  window.addEventListener('mousemove', onSplitMove);
  window.addEventListener('mouseup', stopSplitDrag);
  window.addEventListener('resize', clampPanesHeight);
  // 等 DOM 量出来再夹一次（存的高度可能是高屏上拖的）
  nextTick(clampPanesHeight);
});

onBeforeUnmount(function () {
  window.removeEventListener('keydown', onKeydown);
  window.removeEventListener('mousemove', onSplitMove);
  window.removeEventListener('mouseup', stopSplitDrag);
  window.removeEventListener('resize', clampPanesHeight);
});
</script>

<template>
  <div ref="rootRef" class="request-tab">
    <!--
      这个接口和云端对不上：顶部一条红提示 + 处理入口（设计稿第 7 节）。
      放在面包屑上面，不挤工具栏。
    -->
    <div v-if="conflicted" class="conflict-bar">
      <span class="conflict-text">这个接口和云端有冲突</span>
      <n-button size="tiny" type="error" ghost @click="openConflict">处理</n-button>
    </div>

    <!-- 面包屑：项目 › 目录… › 接口名，右边是保存 -->
    <curl-snippet
      v-model:show="showSnippet"
      :load="loadCurl"
      :env-name="envs.selected ? envs.selected.name : ''"
    />

    <div class="crumb-bar">
      <div class="crumbs">
        <template v-for="(part, index) in crumbs" :key="index">
          <span v-if="index" class="sep">›</span>
          <span v-if="index < crumbs.length - 1" class="crumb">{{ part }}</span>
          <!-- 最后一级是接口名：双击改名（参考 Postman） -->
          <span v-else class="crumb last">
            <inline-rename :value="part" :editable="projects.canEdit" @commit="renameTitle" />
          </span>
        </template>
      </div>

      <n-space align="center" :size="4">
        <!-- 代码片段：当前请求的 cURL，一键复制（参考 Postman 右侧的 Code snippet） -->
        <n-button size="small" quaternary title="代码片段（cURL）" @click="showSnippet = true">
          <template #icon>
            <n-icon :component="Code" />
          </template>
          代码
        </n-button>
        <template v-if="projects.canEdit">
        <n-button
          size="small"
          :disabled="Boolean(tab.apiId) && !tab.dirty"
          :loading="saving"
          @click="save"
        >
          <template #icon>
            <n-icon :component="DeviceFloppy" />
          </template>
          保存
        </n-button>

        <n-dropdown trigger="click" :options="saveMenu" @select="onSaveMenu">
          <n-button size="small" quaternary title="更多保存方式">
            <template #icon>
              <n-icon :component="ChevronDown" />
            </template>
          </n-button>
        </n-dropdown>
        </template>
      </n-space>
    </div>

    <div class="head">
      <url-bar
        :method="spec.method"
        :url="spec.url"
        :sending="tab.sending"
        :scope="scope"
        :send-blocked="gateway.cloudSendBlocked"
        send-blocked-hint="云端不发送请求，请从本机的 apiloop 打开"
        @update:method="(v) => { spec.method = v; }"
        @update:url="onUrlChange"
        @send="onSend"
        @cancel="onCancel"
        @paste-curl="onPasteCurl"
      />
    </div>

    <!-- 未定义的变量：发送前就提示，别等请求发出去才发现 -->
    <div v-if="undefinedVariables.length" class="var-hint">
      <span>以下变量未定义：{{ undefinedVariables.join('、') }}</span>
      <n-button size="tiny" quaternary type="primary" @click="ui.setSidebarTab('env')">
        去环境管理
      </n-button>
    </div>

    <div
      ref="panesRef"
      class="panes"
      :class="{ full: activePane === 'mock' }"
      :style="activePane === 'mock' ? null : { height: panesHeight + 'px' }"
    >
      <n-tabs
        v-model:value="activePane"
        type="line"
        size="small"
        animated
        :theme-overrides="paneTabsTheme"
      >
        <!-- 最右边：Cookie 管理（原来在地址栏那一行） -->
        <template #suffix>
          <n-button size="tiny" quaternary @click="showCookies = true">Cookies</n-button>
        </template>

        <n-tab-pane name="params">
          <template #tab>
            <span class="pane-tab">
              Params<span v-if="paneStatus.params" class="count">{{ paneStatus.params }}</span>
            </span>
          </template>
          <div class="pane">
            <p class="label">查询参数</p>
            <key-value-table
              :model-value="spec.params.query"
              :scope="scope"
              kind="query"
              key-placeholder="参数名"
              @update:model-value="onQueryChange"
            />

            <!-- 地址里没有 :name 这种路径变量时，整块都不显示（和 Postman 一样） -->
            <template v-if="hasPathParams">
              <p class="label">路径参数</p>
              <key-value-table
                v-model="spec.params.path"
                :scope="scope"
                kind="path"
                key-placeholder="参数名"
                value-placeholder="值"
              />
            </template>
          </div>
        </n-tab-pane>

        <n-tab-pane name="headers">
          <template #tab>
            <span class="pane-tab">
              Headers<span v-if="paneStatus.headers" class="count">{{ paneStatus.headers }}</span>
            </span>
          </template>
          <div class="pane">
            <key-value-table
              v-model="spec.params.headers"
              :scope="scope"
              kind="headers"
              :key-suggestions="HEADER_NAMES"
              key-placeholder="请求头"
              value-placeholder="值"
            />
          </div>
        </n-tab-pane>

        <n-tab-pane name="body">
          <template #tab>
            <span class="pane-tab">
              Body<span v-if="paneStatus.hasBody" class="pane-dot" />
            </span>
          </template>
          <div class="pane">
            <body-editor :spec="spec" :project-id="projects.currentId" :scope="scope" />
          </div>
        </n-tab-pane>

        <n-tab-pane name="auth">
          <template #tab>
            <span class="pane-tab">
              Auth<span class="count">{{ paneStatus.auth }}</span>
            </span>
          </template>
          <div class="pane narrow">
            <auth-editor
              :model-value="spec.auth"
              :inherit-hint="inheritAuthHint"
              :scope="scope"
              @update:model-value="(v) => { spec.auth = v; }"
            />
          </div>
        </n-tab-pane>

        <n-tab-pane name="scripts">
          <template #tab>
            <span class="pane-tab">
              Scripts<span v-if="paneStatus.hasScripts" class="pane-dot" />
            </span>
          </template>
          <div class="pane">
            <script-editor v-model="spec.scripts" :disabled="!projects.canEdit" />
          </div>
        </n-tab-pane>

        <n-tab-pane name="settings" tab="设置">
          <div class="pane narrow">
            <p class="label">这次请求的发送选项</p>
            <div class="option-row">
              <n-switch
                size="small"
                :value="requestOptions.cookies"
                @update:value="(v) => setOption('cookies', v)"
              />
              <div class="option-text">
                <span class="option-title">自动管理 Cookie</span>
                <span class="option-desc">
                  开启时每一跳都会自动带上 Cookie 库里匹配的 cookie，响应里的 Set-Cookie 也会写回；
                  请求头里手写了 Cookie 的话，以手写的为准（但响应仍然写回）。
                </span>
              </div>
            </div>

            <div class="option-row">
              <n-switch
                size="small"
                :value="requestOptions.proxy"
                @update:value="(v) => setOption('proxy', v)"
              />
              <div class="option-text">
                <span class="option-title">使用系统代理</span>
                <span class="option-desc">
                  按系统设置里的代理配置决定是否走代理（连不上的域名由「不走代理的地址列表」排除）。
                  关掉就是这次直连。
                </span>
              </div>
            </div>

            <div class="option-row">
              <n-switch
                size="small"
                :value="requestOptions.scripts"
                @update:value="(v) => setOption('scripts', v)"
              />
              <div class="option-text">
                <span class="option-title">执行脚本</span>
                <span class="option-desc">
                  这次请求执行项目和目录上的脚本，以及接口自己的前置脚本和测试脚本。
                  关掉就一段都不执行，适合脚本写坏了一时改不回来的情况。
                </span>
              </div>
            </div>
          </div>
        </n-tab-pane>

        <n-tab-pane name="mock" tab="Mock">
          <div class="pane">
            <mock-panel :tab="tab" @save-response="openSaveExample" />
          </div>
        </n-tab-pane>
      </n-tabs>
    </div>

    <!-- 请求区 / 响应区之间的分隔线，按住上下拖（Mock 页签要整块高度，那时候不要） -->
    <div
      v-if="activePane !== 'mock'"
      class="h-splitter"
      :class="{ active: draggingSplit }"
      @mousedown.prevent="startSplitDrag"
    />

    <div v-if="activePane !== 'mock'" class="response">
      <response-panel
        :tab="tab"
        :saving-example="savingExample"
        :readonly="!projects.canEdit"
        @save-example="openSaveExample"
        @save-sse-example="saveSseExample"
        @resend="onSend"
      />
    </div>

    <n-modal
      v-model:show="showSaveExample"
      preset="card"
      title="保存为示例"
      style="width: 520px; max-width: 94vw"
    >
      <n-form>
        <n-form-item label="名称">
          <n-input v-model:value="saveExampleName" placeholder="示例名称" />
        </n-form-item>
        <n-form-item v-if="canTemplatize" :show-feedback="false">
          <n-checkbox v-model:checked="saveExampleTemplatize">
            智能模板化（把手机号、姓名、时间等换成每次随机的数据）
          </n-checkbox>
        </n-form-item>
      </n-form>

      <template #footer>
        <n-space justify="end">
          <n-button @click="showSaveExample = false">取消</n-button>
          <n-button type="primary" @click="confirmSaveExample">
            {{ saveExampleTemplatize && canTemplatize ? '下一步' : '保存' }}
          </n-button>
        </n-space>
      </template>
    </n-modal>

    <templatize-dialog v-model:show="showTemplatize" :body="templatizeBody" @confirm="onTemplatizeConfirm" />

    <cookie-manager-modal v-model:show="showCookies" />

    <n-modal
      v-model:show="showSaveDialog"
      preset="card"
      title="保存接口"
      style="width: 460px; max-width: 92vw"
    >
      <n-form>
        <n-form-item label="名称">
          <n-input v-model:value="saveForm.name" placeholder="接口名称" />
        </n-form-item>
        <n-form-item label="目录">
          <n-select v-model:value="saveForm.folderId" :options="folderOptions()" />
        </n-form-item>
      </n-form>

      <template #footer>
        <n-space justify="end">
          <n-button @click="showSaveDialog = false">取消</n-button>
          <n-button type="primary" :loading="saving" @click="confirmSaveDraft">保存</n-button>
        </n-space>
      </template>
    </n-modal>
  </div>
</template>

<style scoped>
.request-tab {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.16));
}

/* 面包屑那一行：左边是路径，右边是保存 */
/* 冲突提示条：面包屑上面一条，红底红字，右边一个「处理」 */
.conflict-bar {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin: 8px 16px 0;
  padding: 5px 10px;
  border-radius: 5px;
  font-size: 12px;
  color: #b3160c;
  background: rgba(235, 32, 19, 0.1);
}

.conflict-text {
  font-weight: 600;
}

.crumb-bar {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 16px 0;
}

.crumbs {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 12px;
  overflow: hidden;
}

.crumb {
  flex: none;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.55;
}

/* 最后一级是当前接口，颜色正常、加粗一点。可以双击改名，省略号交给里面的 InlineRename */
.crumb.last {
  opacity: 1;
  font-weight: 600;
  max-width: 320px;
}

.sep {
  flex: none;
  opacity: 0.35;
}

.head > :first-child {
  flex: 1;
  min-width: 0;
}

/* 未定义变量：一行紧凑的黄色提示，紧贴地址栏下面 */
.var-hint {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin: 8px 16px 0;
  padding: 3px 10px;
  border-radius: 4px;
  font-size: 12px;
  line-height: 1.8;
  color: #f0a020;
  background: rgba(240, 160, 32, 0.12);
}

.panes {
  flex: none;
  min-height: 120px;
  overflow: auto;
}

/* 页签条左边留 16px。只推内容、不动 nav 本身，底下的分隔线才能整条贯通 */
.panes :deep(.n-tabs-nav-scroll-content) {
  padding-left: 16px;
}

/* 页签名字后面跟的计数 / 圆点 */
.pane-tab {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.pane-tab .count {
  font-size: 11px;
  opacity: 0.55;
}

.pane-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #0cbb52;
}

/* Mock 页签内容多，给它整块高度，响应面板先收起来 */
.panes.full {
  flex: 1;
  min-height: 0;
  height: auto !important;
}

/* 上下分栏的分隔线：和左右那条一样，平时透明、鼠标上去才显色 */
.h-splitter {
  position: relative;
  flex: none;
  /* 可拖的区域 7px 高，好抓；看得见的只有中间那条线（::after） */
  height: 7px;
  margin: -3px 0 -4px;
  z-index: 2;
  cursor: row-resize;
  background: transparent;
}

.h-splitter::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: 3px;
  height: 1px;
  background: var(--apiloop-divider);
  transition: background 0.15s, height 0.15s, top 0.15s;
}

/* 悬停 / 拖动：线加粗到 2px、颜色加深，不再整块涂成主色（用户嫌粗、嫌颜色难看） */
.h-splitter:hover::after,
.h-splitter.active::after {
  top: 2.5px;
  height: 2px;
  background: var(--apiloop-divider-active);
}

.pane {
  padding: 12px 16px;
}

.pane.narrow {
  max-width: 460px;
}

/* 分组标题：和 Postman 一样 13px、半粗体 */
.label {
  margin: 0 0 6px;
  font-size: 13px;
  font-weight: 600;
  opacity: 0.85;
}

.pane .label + * {
  margin-bottom: 14px;
}

.option-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin-bottom: 14px;
}

.option-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.option-title {
  font-size: 13px;
}

.option-desc {
  font-size: 12px;
  opacity: 0.6;
  line-height: 1.6;
}

.response {
  flex: 1;
  min-height: 0;
  padding: 12px 16px;
  display: flex;
  flex-direction: column;
}
</style>
