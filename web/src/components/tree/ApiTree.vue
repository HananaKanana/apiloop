<script setup>
import { computed, h, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { NButton, NDropdown, NEmpty, NIcon, NInput, NModal, NSpace, NSpin, NTree, NTreeSelect, useMessage } from 'naive-ui';
import { ChevronDown, ChevronRight, FileImport, Filter, Fold, FoldDown, Plus, Star } from '@vicons/tabler';
import { useProjectStore } from '@/stores/project';
import { usePrefsStore } from '@/stores/prefs';
import { useTreeStore } from '@/stores/tree';
import { useGatewayStore } from '@/stores/gateway';
import { useTabsStore } from '@/stores/tabs';
import { useUiStore } from '@/stores/ui';
import { collectFolderKeys, filterTree, findNode, walkTree } from '@/utils/tree';
import { usePrompt } from '@/utils/prompt';
import { useDialog } from '@/utils/dialog';
import { useSessionStore } from '@/stores/session';
import {
  FILTER_ALL,
  STATUS_FILTER_OPTIONS,
  filterCondition,
  isDeprecated,
  statusMeta,
  statusTooltip
} from '@/utils/apiStatus';
import { loadMembers } from '@/utils/projectMembers';
import { METHOD_LABEL_WIDTH, methodColor } from '@/utils/method';
import ContextMenu from '@/components/common/ContextMenu.vue';
import ShareDialog from '@/components/share/ShareDialog.vue';
import SyncDialog from '@/components/openapi/SyncDialog.vue';
import OpenapiExportDialog from '@/components/importExport/OpenapiExportDialog.vue';
import ExportDocDialog from '@/components/importExport/ExportDocDialog.vue';
import CopyNodeDialog from '@/components/tree/CopyNodeDialog.vue';

const emit = defineEmits(['open', 'new-api', 'new-ws', 'new-sio', 'new-grpc', 'new-mqtt', 'new-amqp', 'new-tcp', 'new-udp', 'open-folder', 'run', 'import']);

const projects = useProjectStore();
const prefs = usePrefsStore();
const tree = useTreeStore();
const gateway = useGatewayStore();
const tabs = useTabsStore();
const ui = useUiStore();
const session = useSessionStore();
const message = useMessage();
const prompt = usePrompt();
const dialog = useDialog();
const { t } = useI18n();

/**
 * 行高 28px（计划里的全局约束）。naive-ui 的树高走 `nodeHeight` 主题变量，
 * 悬停 / 选中的底色也从主题里给 —— 默认那层太淡，看不出来。
 */
const TREE_THEME = {
  nodeHeight: '28px',
  nodeColorHover: 'rgba(128, 128, 128, 0.14)',
  nodeColorActive: 'rgba(128, 128, 128, 0.2)'
};

/** 方法标签固定宽度，各行的接口名才能对齐 */
const methodWidth = METHOD_LABEL_WIDTH;

/** 工具条上「＋」和「…」两个菜单。用 computed 包住，切语言后条目跟着变 */
const newOptions = computed(function () {
  return [
    { label: t('tree.newMenuApi'), key: 'api' },
    { label: t('tree.newMenuFolder'), key: 'folder' },
    { label: 'WebSocket', key: 'ws' },
    // Socket.IO（第九轮第 4 节）：和 WebSocket 并列的调试标签页入口
    { label: 'Socket.IO', key: 'sio' },
    // gRPC（第十一轮第 3 节）/ MQTT（第十三轮第 4 节）：同上，各自开一个临时调试标签页
    { label: 'gRPC', key: 'grpc' },
    { label: 'MQTT', key: 'mqtt' },
    // RabbitMQ（第十六轮 T41）：同上，开一个 RabbitMQ（AMQP）调试标签页
    { label: 'RabbitMQ', key: 'amqp' },
    // TCP / UDP（第十六轮）：同上，两种协议共用一个标签页（按方法显示不同字段）
    { label: 'TCP', key: 'tcp' },
    { label: 'UDP', key: 'udp' }
  ];
});

function onNewSelect(key) {
  if (key === 'api') {
    emit('new-api', null);
    return;
  }
  if (key === 'ws') {
    emit('new-ws');
    return;
  }
  if (key === 'sio') {
    emit('new-sio');
    return;
  }
  if (key === 'grpc') {
    emit('new-grpc');
    return;
  }
  if (key === 'mqtt') {
    emit('new-mqtt');
    return;
  }
  if (key === 'amqp') {
    emit('new-amqp');
    return;
  }
  if (key === 'tcp') {
    emit('new-tcp');
    return;
  }
  if (key === 'udp') {
    emit('new-udp');
    return;
  }
  if (key === 'folder') {
    // 建在当前选中的目录下（和导入的落点规则一致）
    createFolder(tree.selectedFolderId || null);
  }
}

const searchText = ref('');
const expandedKeys = ref([]);
const selectedKeys = ref([]);

const menu = ref({ show: false, x: 0, y: 0, node: null, options: [] });

const deleteTarget = ref(null);
const showDelete = ref(false);

/* ---------------- 分享文档（第 4 节） ---------------- */

/**
 * 分享依赖云端：网关里没登录（本机空间）时项目还没上过云端，生成出来的链接也打不开，
 * 所以这两个入口干脆不显示。和成员管理、Mock 日志用的是同一个判断
 * （`cloudFeaturesAvailable`）。
 *
 * 另外只有 editor 及以上才给 —— 生成链接是写操作，只读角色点进去也只会拿到 403。
 * 撤销和查看已生成的链接在「项目设置 → 分享链接」里，viewer 在那里能看到列表。
 */
const canShare = computed(function () {
  return projects.canEdit && gateway.cloudFeaturesAvailable;
});

const showShare = ref(false);
const shareFolderId = ref(null);
const shareScopeName = ref('');

function openShare(folderId) {
  shareFolderId.value = folderId || null;
  const folder = folderId ? tree.folderById.get(folderId) : null;
  shareScopeName.value =
    (folder && folder.name) || (projects.current && projects.current.name) || t('tree.projectFallback');
  showShare.value = true;
}

/* ---------------- 导出 OpenAPI（第四轮第 2 节） ---------------- */

/**
 * 目录右键「导出为 OpenAPI」：范围是这个目录**连同子目录**。
 * 导的是看数据，viewer 也能用（服务端 `GET /projects/:pid/export/openapi` 就是 viewer 权限）。
 * 整个项目的导出在顶栏的项目菜单里。
 */
const showOpenapiExport = ref(false);
const exportFolderId = ref(null);
const exportScopeName = ref('');

/// 导出文档（第九轮第 2 节）：范围是这个目录连同子目录
const showDocExport = ref(false);
const docFolderId = ref(null);
const docScopeName = ref('');

function openDocExport(folderId) {
  docFolderId.value = folderId || null;
  const folder = folderId ? tree.folderById.get(folderId) : null;
  docScopeName.value =
    (folder && folder.name) || (projects.current && projects.current.name) || t('tree.projectFallback');
  showDocExport.value = true;
}

function openOpenapiExport(folderId) {
  exportFolderId.value = folderId || null;
  const folder = folderId ? tree.folderById.get(folderId) : null;
  exportScopeName.value =
    (folder && folder.name) || (projects.current && projects.current.name) || t('tree.projectFallback');
  showOpenapiExport.value = true;
}

/* ---------------- 从 OpenAPI 同步更新（第四轮第 3 节） ---------------- */

const showSync = ref(false);
const syncFolderId = ref(null);
const syncFolderName = ref('');

function openSync(folderId) {
  syncFolderId.value = folderId || null;
  const folder = folderId ? tree.folderById.get(folderId) : null;
  syncFolderName.value =
    (folder && folder.name) || (projects.current && projects.current.name) || t('tree.projectFallback');
  showSync.value = true;
}

/* ---------------- 跨项目复制 / 移动（第六轮第 3 节） ---------------- */

const showCopy = ref(false);
const copyTarget = ref({ kind: 'api', id: '', name: '', move: false });

function openCopy(node, move) {
  copyTarget.value = { kind: node.kind, id: node.id, name: node.name || '', move: move };
  showCopy.value = true;
}

/**
 * 复制 / 移动完了：一句提示 + 一个「去看看」。
 *
 * 「去看看」会**切到目标项目**（有没保存的标签页先问一句），然后打开复制过去的第一个
 * 接口 / 目录 —— 用户刚做完这件事，下一步十有八九就是去那边看一眼。
 */
function onCopied(result) {
  const where = t('tree.quotedName', { name: result.projectName }) +
    (result.folderName ? ' / ' + result.folderName : '');

  message.success(
    h('span', { class: 'copy-done' }, [
      t(result.move ? 'tree.movedDone' : 'tree.copiedDone', { n: result.apiCount, where: where }),
      h(NButton, {
        size: 'tiny',
        quaternary: true,
        style: 'margin-left: 10px',
        onClick: function () { goToCopied(result); }
      }, { default: function () { return t('tree.goLook'); } })
    ]),
    { duration: 8000 }
  );

  // 移动会把当前项目里的东西挪走，目录树要跟着刷新
  tree.refresh().catch(function () {});
}

function confirmSwitchProject() {
  return new Promise(function (resolve) {
    dialog.warning({
      // 和 ProjectSwitcher / QuickOpen 用的是同一句话，直接复用 layout 区域那三个键
      title: t('layout.switchProjectTitle'),
      content: t('layout.switchProjectBody'),
      positiveText: t('layout.switchAction'),
      negativeText: t('app.cancel'),
      onPositiveClick: function () { resolve(true); },
      onNegativeClick: function () { resolve(false); },
      onClose: function () { resolve(false); },
      onMaskClick: function () { resolve(false); }
    });
  });
}

async function goToCopied(result) {
  if (tabs.hasDirty && !(await confirmSwitchProject())) return;

  tabs.closeAll();
  projects.setCurrent(result.projectId);

  if (result.apiIds && result.apiIds.length) {
    try {
      await tabs.openApi(result.apiIds[0]);
    } catch (err) {
      message.error(err.message);
    }
    return;
  }
  if (result.folderIds && result.folderIds.length) tabs.openFolder(result.folderIds[0]);
}

/* ---------------- 状态与负责人（第四轮第 1 节） ---------------- */

/**
 * 状态存在 `apis.extra.status` 里（`GET /projects/:pid/tree` 的接口节点上就带着），
 * 负责人的名字要自己查成员列表 —— 树里只有 ownerId。
 *
 * 成员列表和「负责人」下拉共用一份缓存（`utils/projectMembers.js`），
 * 不会因为多开几个接口标签页就重复请求。
 */
const members = ref([]);
const statusFilter = ref(FILTER_ALL);

const memberNames = computed(function () {
  const map = new Map();
  members.value.forEach(function (member) {
    map.set(member.userId, member.displayName || member.username || '');
  });
  return map;
});

const myUserId = computed(function () {
  return (session.user && session.user.id) || '';
});

const statusFilterLabel = computed(function () {
  const found = STATUS_FILTER_OPTIONS.filter(function (item) { return item.value === statusFilter.value; })[0];
  // 选项表来自 utils/apiStatus.js（不在本任务的改动范围里），它的 label 还没迁 —— 这里只是兜底
  return found ? found.label : t('tree.filterAll');
});

async function loadProjectMembers() {
  const pid = projects.currentId;
  if (!pid) {
    members.value = [];
    return;
  }
  try {
    members.value = await loadMembers(pid);
  } catch (err) {
    // 没登录（本机空间）时是 409：树照常画，只是悬停提示里没有负责人
    members.value = [];
  }
}

watch(function () { return projects.currentId; }, loadProjectMembers, { immediate: true });

const displayTree = computed(function () {
  return filterTree(tree.nodes, searchText.value, filterCondition(statusFilter.value, myUserId.value));
});

// 搜索 / 筛选时自动展开命中节点所在的目录
watch([searchText, statusFilter], function () {
  if (!searchText.value.trim() && statusFilter.value === FILTER_ALL) return;
  const keys = collectFolderKeys(displayTree.value);
  expandedKeys.value = Array.from(new Set(expandedKeys.value.concat(keys)));
});

const emptyDescription = computed(function () {
  if (searchText.value.trim() || statusFilter.value !== FILTER_ALL) return t('tree.emptyNoMatch');
  return projects.canEdit ? t('tree.emptyEditable') : t('tree.emptyReadonly');
});

watch(
  function () { return projects.currentId; },
  async function (pid) {
    selectedKeys.value = [];
    if (!pid) return;
    try {
      await tree.load(pid);
      // 进来（和切项目）时目录全部收起，想看哪个点哪个；要全展开用工具栏那个按钮
      expandedKeys.value = [];
    } catch (err) {
      message.error(err.message);
    }
  },
  { immediate: true }
);

/* ---------------- 渲染 ---------------- */

/** 16×16 的文件夹：收起是描边的闭合文件夹，展开是多一面前翻盖的开口文件夹 */
const FOLDER_PATH = 'M2 4.6A1.6 1.6 0 0 1 3.6 3h2.5a1 1 0 0 1 .8.4l.9 1.2h4.6A1.6 1.6 0 0 1 14 6.2v5.2A1.6 1.6 0 0 1 12.4 13H3.6A1.6 1.6 0 0 1 2 11.4z';
const FOLDER_OPEN_BACK = 'M2 4.6A1.6 1.6 0 0 1 3.6 3h2.5a1 1 0 0 1 .8.4l.9 1.2h4.6A1.6 1.6 0 0 1 14 6.2v1.3H2z';
const FOLDER_OPEN_FRONT = 'M1.7 12.1 3.3 8.3c.2-.5.7-.8 1.2-.8h9c.6 0 1 .5.8 1.1l-1.4 3.6c-.2.5-.7.9-1.3.9H2.5c-.6 0-1-.5-.8-1z';

const SVG_ATTRS = {
  viewBox: '0 0 16 16',
  width: '15',
  height: '15',
  fill: 'none',
  stroke: 'currentColor',
  'stroke-width': '1.3',
  'stroke-linejoin': 'round',
  'aria-hidden': 'true'
};

function folderIcon(expanded) {
  const paths = expanded
    ? [
        h('path', { d: FOLDER_OPEN_BACK, 'stroke-linecap': 'round' }),
        h('path', { d: FOLDER_OPEN_FRONT })
      ]
    : [h('path', { d: FOLDER_PATH, 'stroke-linecap': 'round' })];

  return h('svg', Object.assign({ class: 'folder-icon' }, SVG_ATTRS), paths);
}

/**
 * 展开 / 收起的小箭头：**永远画朝右的**。
 * n-tree 展开时会给外层加 `.n-tree-node-switcher--expanded { transform: rotate(90deg) }`，
 * 自定义图标也一样会被转 —— 朝右转 90° 正好朝下。之前按状态自己画了一个朝下的，
 * 再被转 90° 就成了朝左（用户 2026-09-30 反馈「展开怎么向左」）。
 */
function renderSwitcherIcon() {
  return h('svg', Object.assign({ class: 'switcher-icon' }, SVG_ATTRS, { width: '14', height: '14' }), [
    h('path', { d: 'M6 3.5 10.5 8 6 12.5', 'stroke-linecap': 'round' })
  ]);
}

function renderLabel(info) {
  const node = info.option;

  if (node.kind === 'folder') {
    return h('span', { class: 'tree-label folder', title: node.name }, [
      folderIcon(Boolean(info.expanded)),
      h('span', { class: 'name' }, node.name)
    ]);
  }

  const api = node.api || {};
  const method = String(api.method || 'GET').toUpperCase();
  const name = node.name || t('tree.untitledApi');
  const meta = statusMeta(api.status);
  const ownerName = api.ownerId ? (memberNames.value.get(api.ownerId) || '') : '';
  const tip = statusTooltip(api.status, ownerName);

  return h('span', { class: 'tree-label api', title: tip ? tip + ' · ' + name : name }, [
    h('span', { class: 'method', style: { color: methodColor(method), width: methodWidth } }, method),
    // 状态小色点（第四轮第 1 节）：认不出来的状态不画点，和「未设置」一样
    meta ? h('span', { class: 'status-dot', style: { background: meta.color } }) : null,
    h('span', { class: 'name' + (isDeprecated(api.status) ? ' deprecated' : '') }, name)
  ]);
}

/**
 * 名字后面的小标记（设计稿第 7 节）：
 * - 和云端有冲突 → 红色感叹号，**点它直接开冲突对话框**（目录也能点，
 *   不然目录的冲突只能从顶栏进 —— 审阅第 11 轮 N7）；
 * - 还没同步到云端 → 灰色小圆点；
 * - mock 开着 → 原来那个绿点，照旧。
 */
function renderSuffix(info) {
  const node = info.option;
  const marks = [];

  if (gateway.isConflicted(node.kind, node.id)) {
    marks.push(h('span', {
      class: 'sync-mark conflict',
      title: t('tree.conflictMark'),
      onClick: function (event) {
        // 别把点击透给节点本身：否则还会顺带展开目录 / 打开接口
        event.stopPropagation();
        ui.openConflict(node.kind, node.id);
      }
    }, '!'));
  } else if (gateway.isPending(node.kind, node.id)) {
    marks.push(h('span', { class: 'sync-mark pending', title: t('tree.pendingMark') }));
  }

  if (node.kind === 'api' && node.api && node.api.mockEnabled) {
    marks.push(h('span', { class: 'mock-dot', title: t('tree.mockMark') }));
  }

  return marks.length ? marks : null;
}

function nodeProps(info) {
  return {
    /**
     * 点接口：打开它的标签页。点目录：展开 / 收起（n-tree 的 expand-on-click）之外，
     * 再把目录设置页打开 —— 和 Postman 一样；只点左边那个小箭头时只展开收起，不开页。
     *
     * **必须放在 onClick，不能靠 selected 变化**：节点已经选中时再点，selected 不会变
     * （cancelable 是 false），可那个标签页可能已经被关掉了 —— 之前就是这样，
     * 打开一个接口、关掉标签页，再点它就打不开了（用户 2026-09-30 报的 bug）。
     */
    // 记下这次点击按没按 ⌘ / ⇧：overrideClick 只拿得到节点、拿不到事件，mousedown 比 click 先到
    onMousedown: function (event) {
      clickMods = { toggle: event.metaKey || event.ctrlKey, range: event.shiftKey };
    },
    onClick: function (event) {
      if (event.metaKey || event.ctrlKey) {
        toggleSelect(info.option.key);
        return;
      }
      if (event.shiftKey) {
        selectRange(info.option.key);
        return;
      }
      openNode(event, info.option, true);
    },
    /** 双击：把预览标签页固定下来（和 Postman 一样） */
    onDblclick: function (event) {
      openNode(event, info.option, false);
    },
    onContextmenu: function (event) {
      event.preventDefault();
      event.stopPropagation();
      openMenu(event, info.option);
    }
  };
}

/**
 * 单击用预览标签页打开（再单击别的会把它换掉），双击打开成普通标签页。
 * 只点左边那个小箭头时只展开收起，不开页。
 */
function openNode(event, node, preview) {
  if (node.kind === 'api') {
    if (node.api) emit('open', node.api, { preview: preview });
    return;
  }
  if (node.kind !== 'folder') return;
  if (event.target && event.target.closest && event.target.closest('.n-tree-node-switcher')) return;
  emit('open-folder', node.id, { preview: preview });
}

/* ---------------- 收藏（第七轮第 2 节） ---------------- */

/** 收藏区折叠起来了没有。只在这次会话里记着，没进偏好那三个 key */
const starredCollapsed = ref(false);

/**
 * 这个项目里收藏的接口。
 *
 * 只认目录树里还找得到的 —— 被删掉的收藏直接不显示（计划里说了不用专门去清），
 * 所以这里不用管「找不到的那个要不要从偏好里删掉」。
 */
const starredApis = computed(function () {
  const list = [];
  prefs.favoriteApiIdsOf(tree.projectId).forEach(function (id) {
    const api = tree.apiById.get(id);
    if (api) list.push(api);
  });
  return list;
});

function toggleStar(api) {
  prefs.toggleApiFavorite(tree.projectId, api.id).catch(function (err) {
    message.error(err.message);
  });
}

/** 收藏区里右键：走和目录树里一样的接口菜单（node 从树里找回来，菜单项要用的字段才齐） */
function openStarredMenu(event, api) {
  const node = findNode(tree.nodes, 'a:' + api.id) ||
    { kind: 'api', id: api.id, name: api.name || '' };
  menu.value = {
    show: true,
    x: event.clientX,
    y: event.clientY,
    node: node,
    options: apiMenuOptions(node)
  };
}

/* ---------------- 多选（用户 2026-10-08） ---------------- */

/**
 * ⌘ / Ctrl 点击：选上或去掉一个；⇧ 点击：从上次点的那个连着选到这个（按树上看得见的顺序）。
 * 普通点击照旧只选一个、打开它。多选后可以一起拖动，右键「移动到…」「删除 N 项」。
 * 目录和它里面的东西一起选了，只动那个目录（服务端也会再去一遍）。
 */
let clickMods = { toggle: false, range: false };
/** ⇧ 点击的起点：上一次普通点击或 ⌘ 点击的那个 */
const anchorKey = ref('');

/** 按了 ⌘ / ⇧：不要树自带的「选中 + 展开」，选择由下面两个函数算 */
function overrideClick() {
  return clickMods.toggle || clickMods.range ? 'none' : 'default';
}

function toggleSelect(key) {
  const list = selectedKeys.value.slice();
  const at = list.indexOf(key);
  if (at === -1) list.push(key);
  else list.splice(at, 1);
  selectedKeys.value = list;
  anchorKey.value = key;
}

/** 树上看得见的节点，从上到下（收起的目录里面的不算） */
function visibleKeys() {
  const out = [];
  const open = new Set(expandedKeys.value);
  (function walk(list) {
    list.forEach(function (node) {
      out.push(node.key);
      if (node.children && open.has(node.key)) walk(node.children);
    });
  })(displayTree.value);
  return out;
}

function selectRange(key) {
  const keys = visibleKeys();
  const from = keys.indexOf(anchorKey.value);
  const to = keys.indexOf(key);
  if (from === -1 || to === -1) {
    toggleSelect(key);
    return;
  }
  selectedKeys.value = keys.slice(Math.min(from, to), Math.max(from, to) + 1);
}

const isMulti = computed(function () { return selectedKeys.value.length > 1; });

/** 选中的节点，按树上的顺序（拖过去、移过去之后也保持这个先后） */
function selectedNodesInOrder(keys) {
  const wanted = new Set(keys || selectedKeys.value);
  const out = [];
  walkTree(tree.nodes, function (node) {
    if (wanted.has(node.key) && (node.kind === 'folder' || node.kind === 'api')) out.push(node);
  });
  return out;
}

function clearMulti() {
  if (!isMulti.value) return;
  const last = selectedKeys.value[selectedKeys.value.length - 1];
  selectedKeys.value = last ? [last] : [];
}

function onWindowKeydown(event) {
  if (event.key !== 'Escape' || !isMulti.value) return;
  const target = event.target;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
  clearMulti();
}

onMounted(function () { window.addEventListener('keydown', onWindowKeydown); });
onBeforeUnmount(function () { window.removeEventListener('keydown', onWindowKeydown); });

/** 多选时的右键菜单 */
function multiMenuOptions() {
  const n = selectedKeys.value.length;
  return [
    { label: t('tree.multiMoveTo'), key: 'multi-move' },
    { type: 'divider', key: 'multi-d' },
    { label: t('tree.multiDelete', { n: n }), key: 'multi-delete', props: { style: 'color: #d03050' } }
  ];
}

/* ---------- 「移动到…」 ---------- */

const ROOT_TARGET = '__root__';
const showMoveTo = ref(false);
const moveToTarget = ref(ROOT_TARGET);

/** 目录选择框的数据：项目根 + 所有目录（选中的目录和它的子孙不能选，挪不进自己） */
const moveToOptions = computed(function () {
  const blocked = new Set();
  selectedNodesInOrder().forEach(function (node) {
    if (node.kind !== 'folder') return;
    blocked.add(node.key);
    walkTree(node.children || [], function (child) { blocked.add(child.key); });
  });
  function convert(list) {
    return list.filter(function (node) { return node.kind === 'folder'; }).map(function (node) {
      const children = convert(node.children || []);
      return {
        key: node.id,
        label: node.name,
        disabled: blocked.has(node.key),
        children: children.length ? children : undefined
      };
    });
  }
  return [{ key: ROOT_TARGET, label: t('tree.moveToRoot') }].concat(convert(tree.nodes));
});

function openMoveTo() {
  moveToTarget.value = ROOT_TARGET;
  showMoveTo.value = true;
}

async function confirmMoveTo() {
  const items = selectedNodesInOrder().map(function (node) { return { kind: node.kind, id: node.id }; });
  if (!items.length) return;
  const parentId = moveToTarget.value === ROOT_TARGET ? null : moveToTarget.value;
  try {
    await tree.moveMany({ items: items, parentId: parentId });
    showMoveTo.value = false;
    if (parentId) expandedKeys.value = Array.from(new Set(expandedKeys.value.concat(['f:' + parentId])));
    message.success(t('tree.multiMoved', { n: items.length }));
  } catch (err) {
    message.error(err.message);
  }
}

function confirmDeleteMany() {
  const nodes = selectedNodesInOrder();
  if (!nodes.length) return;
  const folders = nodes.filter(function (node) { return node.kind === 'folder'; }).length;
  dialog.error({
    title: t('tree.multiDeleteTitle', { n: nodes.length }),
    content: folders ? t('tree.multiDeleteBodyFolders', { n: nodes.length, folders: folders }) : t('tree.multiDeleteBody', { n: nodes.length }),
    positiveText: t('app.delete'),
    negativeText: t('app.cancel'),
    onPositiveClick: async function () {
      try {
        const removed = await tree.removeMany(nodes.map(function (node) { return { kind: node.kind, id: node.id }; }));
        selectedKeys.value = [];
        message.success(t('tree.multiDeleted', { n: removed }));
      } catch (err) {
        message.error(err.message);
      }
    }
  });
}

/* ---------------- 选中与右键 ---------------- */

function onSelectedChange(keys, options, meta) {
  // 树开着 multiple（多选要画出好几行高亮），它自己点一下是「追加」—— 普通点击要的是「只选这一个」，
  // 所以只认**这次点的那个**（meta.node）。不能取 keys 的最后一个：点一个已经选中的，keys 原样不变，
  // 最后一个是别的。⌘ / ⇧ 点击不走这里（见 overrideClick），由 toggleSelect / selectRange 算
  const key = (meta && meta.node && meta.node.key) || keys[keys.length - 1];
  selectedKeys.value = key ? [key] : [];
  anchorKey.value = key || '';
  if (!key) return;

  const node = findNode(tree.nodes, key);
  // 打开标签页在 nodeProps 的 onClick 里做，这里只记选中位置
  if (node && node.kind === 'api') {
    tree.setSelectedFolder(node.parentId);
    return;
  }
  // 选中目录时记下来，导入 cURL / OpenAPI 会落到这个目录
  tree.setSelectedFolder(node ? node.id : null);
}

function openMenu(event, node) {
  /**
   * viewer 没有任何写权限，但「目录设置」和「收藏 / 取消收藏」是能用的：收藏只属于自己、
   * 不改项目数据（第七轮第 2 节），所以接口上也要弹 —— 弹出来只有收藏那一项。
   * 别的节点类型上仍然没有 viewer 能用的项，那就不弹：弹一个全是灰项的菜单比不弹更让人困惑。
   */
  if (!projects.canEdit && node.kind !== 'folder' && node.kind !== 'api') return;

  // 在多选里的某一项上右键：批量菜单（只读角色没有批量操作，退回单个的菜单）
  if (isMulti.value && selectedKeys.value.indexOf(node.key) > -1 && projects.canEdit) {
    menu.value = { show: true, x: event.clientX, y: event.clientY, node: null, options: multiMenuOptions() };
    return;
  }
  // 在多选之外的节点上右键：多选作废，只选它
  if (isMulti.value) selectedKeys.value = [node.key];

  menu.value = {
    show: true,
    x: event.clientX,
    y: event.clientY,
    node: node,
    options: node.kind === 'folder' ? folderMenuOptions() : apiMenuOptions(node)
  };
}

/**
 * 在目录树的空白处右键：项目根这一层的操作（第 2 节的「运行全部」就在这里）、
 * 新建、全部收起 / 展开（节点上的右键会 stopPropagation，不会走到这里）
 */
function openBlankMenu(event) {
  // 「运行全部」放最上面：发请求 viewer 也能做（服务端 /send 就是 viewer 权限）
  const options = [{ label: t('tree.runAll'), key: 'blank-run' }];

  // 同步更新要 editor（服务端那两个接口都是 editor 权限）
  if (projects.canEdit) {
    options.push({ label: t('tree.syncFromOpenapi'), key: 'blank-sync-openapi' });
  }

  if (canShare.value) {
    options.push({ label: t('tree.shareProjectDoc'), key: 'blank-share' });
  }

  if (projects.canEdit) {
    options.push({ type: 'divider', key: 'blank-d' });
    options.push({ label: t('tree.menuNewApi'), key: 'blank-new-api' });
    options.push({ label: t('tree.menuNewFolder'), key: 'blank-new-folder' });
  }
  options.push({ type: 'divider', key: 'blank-d2' });
  options.push({ label: anyExpanded.value ? t('tree.collapseAll') : t('tree.expandAll'), key: 'blank-toggle' });

  menu.value = { show: true, x: event.clientX, y: event.clientY, node: null, options: options };
}

function folderMenuOptions() {
  // viewer 也能「运行」和「导出为 OpenAPI」：发请求和导出都是只读角色要做的事
  // （服务端 `/send` 和 `/export/openapi` 都是 viewer 权限）
  if (!projects.canEdit) {
    return [
      { label: t('tree.folderSettings'), key: 'folder-settings' },
      { label: t('tree.run'), key: 'run' },
      { label: t('tree.exportOpenapi'), key: 'export-openapi' },
      { label: t('tree.exportDoc'), key: 'export-doc' }
    ];
  }

  const options = [
    { label: t('tree.folderSettings'), key: 'folder-settings' },
    { type: 'divider', key: 'd0' },
    { label: t('tree.run'), key: 'run' },
    { label: t('tree.exportOpenapi'), key: 'export-openapi' },
    { label: t('tree.exportDoc'), key: 'export-doc' },
    // 计划里这条本来想只在「这个目录是从 OpenAPI 导入的、或者里面有从 OpenAPI 导入的
    // 接口时」显示 —— 那需要目录树接口带上 extra.openapi（dto.js 的 toApiSummary），
    // 而这一轮 dto.js / tree.js 是 session1 在改（第 1 节的 status / ownerId 就要动它）。
    // 先对所有目录都显示：点进去没东西可同步时，弹窗会说「已经是最新的」或者
    // 全列成新增，不会改坏什么。
    { label: t('tree.syncFromOpenapi'), key: 'sync-openapi' }
  ];
  if (canShare.value) options.push({ label: t('tree.shareDoc'), key: 'share' });

  return options.concat([
    { type: 'divider', key: 'd1' },
    { label: t('tree.newSubfolder'), key: 'new-folder' },
    { label: t('tree.menuNewApi'), key: 'new-api' },
    { type: 'divider', key: 'd2' },
    // 跨项目复制 / 移动（第六轮第 3 节）
    { label: t('tree.copyToProject'), key: 'copy-to' },
    { label: t('tree.moveToProject'), key: 'move-to' },
    { type: 'divider', key: 'd3' },
    { label: t('tree.rename'), key: 'rename' },
    { label: t('tree.delete'), key: 'delete', props: { style: 'color: #d03050' } }
  ]);
}

function apiMenuOptions(node) {
  // 接口收藏（第七轮第 2 节）：只属于自己，viewer 也能用，所以单独放在最上面。
  // **node 必须由调用方传进来**：下面 openMenu 是先算 options 再赋值给 menu.value 的，
  // 这时候从 menu.value.node 读到的还是上一次右键的那个节点。
  const starred = Boolean(node && prefs.isApiFavorite(tree.projectId, node.id));
  const favorite = {
    label: starred ? t('layout.removeFavorite') : t('layout.addFavorite'),
    key: 'favorite'
  };

  // viewer 只给这一项（其余全是写操作，服务端会 403）
  if (!projects.canEdit) return [favorite];

  return [
    favorite,
    { type: 'divider', key: 'd0' },
    { label: t('tree.duplicate'), key: 'duplicate' },
    { label: t('tree.rename'), key: 'rename' },
    { type: 'divider', key: 'd2' },
    // 跨项目复制 / 移动（第六轮第 3 节）
    { label: t('tree.copyToProject'), key: 'copy-to' },
    { label: t('tree.moveToProject'), key: 'move-to' },
    { type: 'divider', key: 'd3' },
    { label: t('tree.delete'), key: 'delete', props: { style: 'color: #d03050' } }
  ];
}

async function onMenuSelect(key) {
  const node = menu.value.node;
  menu.value.show = false;

  if (key === 'blank-new-api') return emit('new-api', null);
  if (key === 'blank-new-folder') {
    try {
      await createFolder(null);
    } catch (err) {
      message.error(err.message);
    }
    return;
  }
  if (key === 'blank-run') return emit('run', null);
  if (key === 'blank-sync-openapi') return openSync(null);
  if (key === 'blank-share') return openShare(null);
  if (key === 'blank-toggle') return toggleExpandAll();
  if (key === 'multi-move') return openMoveTo();
  if (key === 'multi-delete') return confirmDeleteMany();
  if (!node) return;

  // 收藏只在当前项目里记（偏好里存的就是「项目 + 接口」这一对）
  if (key === 'favorite') return toggleStar({ id: node.id });

  try {
    if (key === 'folder-settings') return emit('open-folder', node.id);
    if (key === 'run') return emit('run', node.id);
    if (key === 'export-openapi') return openOpenapiExport(node.id);
    if (key === 'export-doc') return openDocExport(node.id);
    if (key === 'sync-openapi') return openSync(node.id);
    if (key === 'share') return openShare(node.id);
    if (key === 'copy-to') return openCopy(node, false);
    if (key === 'move-to') return openCopy(node, true);
    if (key === 'new-folder') return await createFolder(node.id);
    if (key === 'new-api') return emit('new-api', node.id);
    if (key === 'rename') return await rename(node);
    if (key === 'duplicate') {
      await tree.duplicateApi(node.id);
      message.success(t('app.copied'));
      return;
    }
    if (key === 'delete') {
      if (node.kind === 'folder') {
        askDeleteFolder(node);
        return;
      }
      await removeApi(node);
    }
  } catch (err) {
    message.error(err.message);
  }
}

/* ---------------- 增删改 ---------------- */

async function createFolder(parentId) {
  const name = await prompt({
    title: t('tree.newFolderTitle'),
    label: parentId ? t('tree.newFolderUnder') : t('tree.newFolderRoot'),
    placeholder: t('tree.folderNamePlaceholder'),
    confirmText: t('tree.createAction')
  });
  if (name === null || !String(name).trim()) return;

  try {
    await tree.createFolder(String(name).trim(), parentId);
    if (parentId) expandedKeys.value = Array.from(new Set(expandedKeys.value.concat(['f:' + parentId])));
    message.success(t('tree.created'));
  } catch (err) {
    message.error(err.message);
  }
}

async function rename(node) {
  const name = await prompt({
    title: node.kind === 'folder' ? t('tree.renameFolderTitle') : t('tree.renameApiTitle'),
    value: node.name,
    confirmText: t('tree.save')
  });
  if (name === null || !String(name).trim()) return;

  try {
    const trimmed = String(name).trim();
    if (node.kind === 'folder') await tree.renameFolder(node.id, trimmed);
    else await tree.renameApi(node.id, trimmed);
    // 打开着的标签页标题跟着变（只动名字，别的没保存的修改不受影响）
    tabs.applyRename(node.kind === 'folder' ? 'folder' : 'api', node.id, trimmed);
    message.success(t('tree.renamed'));
  } catch (err) {
    message.error(err.message);
  }
}

function countDescendants(node) {
  let folders = 0;
  let apis = 0;
  walkTree(node.children || [], function (child) {
    if (child.kind === 'folder') {
      folders += 1;
    } else {
      apis += 1;
    }
  });
  return { folders: folders, apis: apis };
}

function askDeleteFolder(node) {
  deleteTarget.value = { node: node, counts: countDescendants(node) };
  showDelete.value = true;
}

async function confirmDeleteFolder(mode) {
  const target = deleteTarget.value;
  showDelete.value = false;
  if (!target) return;

  try {
    await tree.removeFolder(target.node.id, mode);
    message.success(mode === 'delete' ? t('tree.folderDeletedAll') : t('tree.folderDeletedKeep'));
  } catch (err) {
    message.error(err.message);
  }
}

async function removeApi(node) {
  const name = node.name || t('tree.untitledApi');
  dialog.error({
    title: t('tree.deleteApiTitle'),
    content: t('tree.deleteApiBody', { name: name }),
    positiveText: t('app.delete'),
    negativeText: t('app.cancel'),
    onPositiveClick: async function () {
      try {
        await tree.removeApi(node.id);
        message.success(t('tree.deleted'));
      } catch (err) {
        message.error(err.message);
      }
    }
  });
}

/* ---------------- 拖拽 ---------------- */

function siblingsUnder(parentId, kind) {
  const list = parentId ? ((findNode(tree.nodes, 'f:' + parentId) || {}).children || []) : tree.nodes;
  return list.filter(function (item) { return item.kind === kind; });
}

function isDescendant(ancestor, key) {
  let found = false;
  walkTree(ancestor.children || [], function (child) {
    if (child.key === key) {
      found = true;
      return false;
    }
  });
  return found;
}

/**
 * 正在拖的节点。n-tree 调 allow-drop 时只给 `{ node, dropPosition, phase }`，**不给被拖的节点**
 * （naive-ui 2.45）—— 之前这里读 `info.dragNode.key` 直接抛错，拖拽整个不能用（2026-10-07 用户报）。
 * 所以在 dragstart 时自己记下来，dragend 清掉。
 */
const draggingKey = ref('');
/** 这次一起拖的（多选时是全部选中的；从没选中的那一行拖就只有它自己） */
const draggingKeys = ref([]);

function onDragStart(info) {
  const key = info && info.node ? info.node.key : '';
  draggingKey.value = key;
  if (isMulti.value && selectedKeys.value.indexOf(key) > -1) {
    draggingKeys.value = selectedKeys.value.slice();
  } else {
    draggingKeys.value = key ? [key] : [];
  }
}

function onDragEnd() {
  draggingKey.value = '';
  draggingKeys.value = [];
}

function allowDrop(info) {
  if (draggingKeys.value.length > 1) return allowDropMany(info);

  const drag = findNode(tree.nodes, draggingKey.value);
  const drop = findNode(tree.nodes, info.node.key);
  if (!drag || !drop) return false;

  if (info.dropPosition === 'inside') {
    // 接口不能拖进另一个接口里面；目录不能拖进自己或自己的子孙
    if (drop.kind !== 'folder') return false;
    if (drag.kind === 'folder' && (drag.key === drop.key || isDescendant(drag, drop.key))) return false;
    return true;
  }

  // 前后插入：落到 drop 所在的那一层。目录不能落进自己的子孙那一层
  if (drag.kind === 'folder' && isDescendant(drag, drop.key)) return false;
  return true;
}

/** 一起拖的那批：不能落在它们自己身上，目录不能落进自己的子孙里 */
function allowDropMany(info) {
  const drop = findNode(tree.nodes, info.node.key);
  if (!drop) return false;
  if (draggingKeys.value.indexOf(drop.key) > -1) return false;
  if (info.dropPosition === 'inside' && drop.kind !== 'folder') return false;
  return !selectedNodesInOrder(draggingKeys.value).some(function (node) {
    return node.kind === 'folder' && isDescendant(node, drop.key);
  });
}

async function onDropMany(info) {
  const drop = findNode(tree.nodes, info.node.key);
  const nodes = selectedNodesInOrder(draggingKeys.value);
  draggingKey.value = '';
  draggingKeys.value = [];
  if (!drop || !nodes.length) return;

  const moving = new Set(nodes.map(function (node) { return node.key; }));
  const payload = { items: nodes.map(function (node) { return { kind: node.kind, id: node.id }; }) };

  if (info.dropPosition === 'inside') {
    payload.parentId = drop.id;
  } else {
    payload.parentId = drop.parentId || null;
    // 落点那一类按 drop 的位置算（去掉这批之后），另一类：目录放到这一层最后、接口放到这一层最前
    const same = siblingsUnder(payload.parentId, drop.kind).filter(function (item) { return !moving.has(item.key); });
    let at = same.findIndex(function (item) { return item.key === drop.key; });
    if (at === -1) at = same.length;
    if (info.dropPosition === 'after') at += 1;
    if (drop.kind === 'folder') {
      payload.folderIndex = at;
      payload.apiIndex = 0;
    } else {
      payload.apiIndex = at;
    }
  }

  try {
    await tree.moveMany(payload);
    if (payload.parentId) expandedKeys.value = Array.from(new Set(expandedKeys.value.concat(['f:' + payload.parentId])));
  } catch (err) {
    message.error(err.message);
    await tree.refresh();
  }
}

async function onDrop(info) {
  if (draggingKeys.value.length > 1) return onDropMany(info);
  const drag = findNode(tree.nodes, info.dragNode.key);
  const drop = findNode(tree.nodes, info.node.key);
  draggingKey.value = '';
  if (!drag || !drop) return;

  const kind = drag.kind;
  let parentId;
  let index;

  if (info.dropPosition === 'inside') {
    parentId = drop.id;
    index = siblingsUnder(parentId, kind).length;
  } else if (drop.kind !== kind) {
    // 目录和接口分开排（目录在前），拖到异类旁边就挨着放：
    // 目录放到这一层目录的最后，接口放到这一层接口的最前
    parentId = drop.parentId;
    const siblings = siblingsUnder(parentId, kind).filter(function (item) { return item.key !== drag.key; });
    index = kind === 'folder' ? siblings.length : 0;
  } else {
    parentId = drop.parentId;
    const siblings = siblingsUnder(parentId, kind).slice();
    const currentIndex = siblings.findIndex(function (item) { return item.key === drag.key; });
    if (currentIndex !== -1) siblings.splice(currentIndex, 1);

    let target = siblings.findIndex(function (item) { return item.key === drop.key; });
    if (target === -1) target = siblings.length;
    if (info.dropPosition === 'after') target += 1;
    index = target;
  }

  try {
    await tree.move({ kind: kind, id: drag.id, parentId: parentId, index: index });
  } catch (err) {
    message.error(err.message);
    await tree.refresh();
  }
}

/* ---------------- 对外 ---------------- */

function expandAll() {
  expandedKeys.value = collectFolderKeys(tree.nodes);
}

function collapseAll() {
  expandedKeys.value = [];
}

/** 工具栏那一个按钮：有任何目录展开着就是「收起」，全收着才是「展开」 */
const anyExpanded = computed(function () {
  return expandedKeys.value.length > 0;
});

function toggleExpandAll() {
  if (anyExpanded.value) collapseAll();
  else expandAll();
}

function selectApi(apiId) {
  selectedKeys.value = ['a:' + apiId];
}

defineExpose({ expandAll: expandAll, refresh: tree.refresh, selectApi: selectApi });
</script>

<template>
  <div class="api-tree">
    <div class="toolbar">
      <n-input
        v-model:value="searchText"
        class="filter"
        size="small"
        clearable
        :placeholder="t('tree.filterPlaceholder')"
      >
        <template #prefix>
          <n-icon :component="Filter" />
        </template>
      </n-input>

      <!--
        按状态 / 负责人筛选（第四轮第 1 节）：和上面的文字过滤叠加。
        侧栏窄，按钮只放图标；生效时图标变成主色，悬停能看到筛的是什么。
      -->
      <n-dropdown
        trigger="click"
        :options="STATUS_FILTER_OPTIONS"
        @select="(key) => { statusFilter = key; }"
      >
        <n-button
          size="small"
          quaternary
          :type="statusFilter === FILTER_ALL ? 'default' : 'primary'"
          :title="t('tree.filterLabel') + statusFilterLabel"
        >
          <template #icon>
            <n-icon :component="Filter" />
          </template>
        </n-button>
      </n-dropdown>

      <!-- 新建：接口 / 目录 / WebSocket / Socket.IO / gRPC / MQTT / RabbitMQ 都收在这一个 ＋ 里 -->
      <n-dropdown v-if="projects.canEdit" trigger="click" :options="newOptions" @select="onNewSelect">
        <n-button size="small" quaternary :title="t('tree.newTitle')">
          <template #icon>
            <n-icon :component="Plus" />
          </template>
        </n-button>
      </n-dropdown>

      <n-button size="small" quaternary :title="t('tree.importTitle')" @click="emit('import')">
        <template #icon>
          <n-icon :component="FileImport" />
        </template>
      </n-button>

      <!-- 全部收起 / 全部展开：直接一个按钮，不再藏进「…」菜单（那里本来也只有这一项） -->
      <n-button
        size="small"
        quaternary
        :title="anyExpanded ? t('tree.collapseAll') : t('tree.expandAll')"
        @click="toggleExpandAll"
      >
        <template #icon>
          <n-icon :component="anyExpanded ? Fold : FoldDown" />
        </template>
      </n-button>
    </div>

    <!--
      收藏（第七轮第 2 节）：这个项目里收藏的接口，放在目录树最上面。
      一个收藏都没有时整块不显示 —— 空着一个「收藏」标题只是占地方。
    -->
    <div v-if="starredApis.length" class="starred">
      <div class="starred-head" @click="starredCollapsed = !starredCollapsed">
        <n-icon size="13" :component="starredCollapsed ? ChevronRight : ChevronDown" />
        <span class="starred-title">{{ t('tree.starredTitle') }}</span>
        <span class="starred-count">{{ starredApis.length }}</span>
      </div>

      <template v-if="!starredCollapsed">
        <div
          v-for="api in starredApis"
          :key="'star-' + api.id"
          class="starred-row"
          :title="api.url || ''"
          @click="emit('open', api, { preview: false })"
          @contextmenu.prevent.stop="openStarredMenu($event, api)"
        >
          <span class="starred-method" :style="{ color: methodColor(api.method) }">{{ api.method }}</span>
          <span class="starred-name">{{ api.name || t('tree.untitledApi') }}</span>
          <button class="starred-star" :title="t('layout.removeFavorite')" @click.stop="toggleStar(api)">
            <n-icon size="14" :component="Star" />
          </button>
        </div>
      </template>
    </div>

    <div class="group-title">{{ t('tree.groupTitle') }}</div>

    <div class="body" @contextmenu.prevent="openBlankMenu">
      <n-spin :show="tree.loading">
        <n-tree
          v-if="displayTree.length"
          block-line
          expand-on-click
          :indent="16"
          :theme-overrides="TREE_THEME"
          :data="displayTree"
          :expanded-keys="expandedKeys"
          :selected-keys="selectedKeys"
          multiple
          :override-default-node-click-behavior="overrideClick"
          :render-label="renderLabel"
          :render-switcher-icon="renderSwitcherIcon"
          :render-suffix="renderSuffix"
          :node-props="nodeProps"
          :draggable="projects.canEdit"
          :allow-drop="allowDrop"
          :cancelable="false"
          @update:expanded-keys="(keys) => { expandedKeys = keys; }"
          @update:selected-keys="onSelectedChange"
          @dragstart="onDragStart"
          @dragend="onDragEnd"
          @drop="onDrop"
        />
        <n-empty
          v-else
          size="small"
          :description="emptyDescription"
        />
      </n-spin>
    </div>

    <context-menu
      v-model:show="menu.show"
      :x="menu.x"
      :y="menu.y"
      :options="menu.options"
      @select="onMenuSelect"
    />

    <n-modal
      v-model:show="showDelete"
      preset="card"
      :title="deleteTarget ? t('tree.deleteFolderTitle', { name: deleteTarget.node.name }) : t('tree.deleteFolder')"
      style="width: 460px; max-width: 92vw"
    >
      <template v-if="deleteTarget">
        <p class="delete-desc">
          {{ t('tree.deleteFolderCounts', {
            folders: deleteTarget.counts.folders,
            apis: deleteTarget.counts.apis
          }) }}
        </p>
        <p class="delete-desc recycle">{{ t('tree.deleteFolderRecycle') }}</p>
        <n-space vertical size="small">
          <n-button block @click="confirmDeleteFolder('move')">
            {{ t('tree.deleteFolderKeepChildren') }}
          </n-button>
          <n-button block type="error" @click="confirmDeleteFolder('delete')">
            {{ t('tree.deleteFolderWithChildren') }}
          </n-button>
        </n-space>
      </template>

      <template #footer>
        <n-space justify="end">
          <n-button @click="showDelete = false">{{ t('app.cancel') }}</n-button>
        </n-space>
      </template>
    </n-modal>

    <!-- 多选后「移动到…」：选一个目录（或项目根）一起挪过去 -->
    <n-modal
      v-model:show="showMoveTo"
      preset="card"
      :title="t('tree.multiMoveTitle', { n: selectedKeys.length })"
      style="width: 420px; max-width: 92vw"
    >
      <n-tree-select
        v-model:value="moveToTarget"
        :options="moveToOptions"
        default-expand-all
        filterable
      />
      <template #footer>
        <n-space justify="end">
          <n-button @click="showMoveTo = false">{{ t('app.cancel') }}</n-button>
          <n-button type="primary" @click="confirmMoveTo">{{ t('tree.multiMoveAction') }}</n-button>
        </n-space>
      </template>
    </n-modal>

    <!-- 生成分享链接（第 4 节）。生成完的链接在「项目设置 → 分享链接」里撤销 -->
    <share-dialog
      v-model:show="showShare"
      :pid="projects.currentId"
      :folder-id="shareFolderId"
      :scope-name="shareScopeName"
    />

    <!-- 从 OpenAPI 同步更新（第四轮第 3 节）：目录里进就是那个目录，空白处进就是整个项目 -->
    <sync-dialog
      v-model:show="showSync"
      :pid="projects.currentId"
      :folder-id="syncFolderId"
      :folder-name="syncFolderName"
    />

    <!-- 导出为 OpenAPI（第四轮第 2 节）：目录连同子目录 -->
    <openapi-export-dialog
      v-model:show="showOpenapiExport"
      :pid="projects.currentId"
      :folder-id="exportFolderId"
      :scope-name="exportScopeName"
    />

    <!-- 导出文档（第九轮第 2 节）：Markdown / HTML / Word，默认这个目录 -->
    <export-doc-dialog
      v-model:show="showDocExport"
      :pid="projects.currentId"
      :folder-id="docFolderId"
      :scope-name="docScopeName"
    />

    <!-- 复制 / 移动到其他项目（第六轮第 3 节） -->
    <copy-node-dialog
      v-model:show="showCopy"
      :kind="copyTarget.kind"
      :node-id="copyTarget.id"
      :node-name="copyTarget.name"
      :move="copyTarget.move"
      @done="onCopied"
    />
  </div>
</template>

<style scoped>
.api-tree {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.toolbar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 6px 6px 6px 10px;
}

/* 过滤框占满剩下的宽度，图标按钮固定在右边 */
.toolbar .filter {
  flex: 1;
  min-width: 0;
}

/* 分组标题，对应 Postman 左边栏的 COLLECTIONS */
.group-title {
  flex: none;
  padding: 2px 12px 6px;
  font-size: 12px;
  letter-spacing: 0.6px;
  opacity: 0.6;
  text-transform: uppercase;
}

/* ---------------- 收藏区（第七轮第 2 节） ---------------- */

/* 收藏区自己限高：收藏多了不能把目录树挤没 */
.starred {
  flex: none;
  max-height: 30%;
  overflow: auto;
  padding: 0 4px 2px;
  border-bottom: 1px solid rgba(128, 128, 128, 0.14);
}

.starred-head {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px 6px;
  cursor: pointer;
}

.starred-title {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  letter-spacing: 0.6px;
  opacity: 0.6;
  text-transform: uppercase;
}

.starred-count {
  font-size: 11px;
  opacity: 0.4;
}

/* 和目录树的行一样高（28px），两栏连在一起看不出接缝 */
.starred-row {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 6px;
  border-radius: 5px;
  cursor: pointer;
  font-size: 13px;
}

.starred-row:hover {
  background: rgba(128, 128, 128, 0.14);
}

.starred-method {
  flex: none;
  width: 40px;
  text-align: right;
  font-size: 10px;
  font-weight: 700;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.starred-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.starred-star {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--apiloop-primary);
  opacity: 0;
  cursor: pointer;
}

.starred-row:hover .starred-star {
  opacity: 1;
}

/*
 * 已收藏：tabler 的星是描边的，填上色才像「点亮了」。
 * 要打到 **path** 上：「不填色」（fill="none"）写在 path 自己身上，只给外层 svg 设填色盖不住它，
 * 星星看起来一直是空心的（2026-10-04 用户截图）。
 */
.starred-star :deep(svg path) {
  fill: currentColor;
}

.body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 0 4px 4px;
  /* 拖动、⇧ 点击时别把行里的文字选成一片蓝（用户 2026-10-08 截图） */
  user-select: none;
  -webkit-user-select: none;
}

.delete-desc {
  margin: 0 0 12px;
  font-size: 13px;
  line-height: 1.7;
}

/* 回收站提示：比正文淡一点，紧跟在说明后面 */
.delete-desc.recycle {
  margin-top: -6px;
  opacity: 0.6;
}

:deep(.tree-label) {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  max-width: 100%;
}

:deep(.tree-label .name) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 状态小色点（第四轮第 1 节）：画在方法标签和接口名中间 */
:deep(.status-dot) {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
}

/* 已废弃的接口：名字灰掉 + 删除线，一眼能在树里扫出来 */
:deep(.tree-label .name.deprecated) {
  text-decoration: line-through;
  opacity: 0.5;
}

/* 只有文字颜色，没有边框和底色；宽度固定右对齐，各行的名字才能对齐 */
:deep(.tree-label .method) {
  flex: none;
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
  text-align: right;
  letter-spacing: 0.2px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

:deep(.folder-icon),
:deep(.switcher-icon) {
  flex: none;
  display: block;
}

:deep(.folder-icon) {
  opacity: 0.75;
}

:deep(.switcher-icon) {
  opacity: 0.55;
}

:deep(.n-tree-node-content) {
  border-radius: 4px;
}

:deep(.mock-dot) {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #0cbb52;
  margin-left: 6px;
  vertical-align: middle;
}

/* 待同步：中性灰的小点。它是常态（本机改一下就有），别做得太扎眼 */
:deep(.sync-mark.pending) {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: rgba(128, 128, 128, 0.55);
  margin-left: 6px;
  vertical-align: middle;
}

/* 冲突：红色感叹号 —— 这个是真的需要人去处理，点了直接开对话框 */
:deep(.sync-mark.conflict) {
  display: inline-block;
  width: 13px;
  height: 13px;
  margin-left: 6px;
  border-radius: 50%;
  background: #eb2013;
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  line-height: 13px;
  text-align: center;
  vertical-align: middle;
  cursor: pointer;
}

:deep(.sync-mark.conflict:hover) {
  background: #c81a0f;
}
</style>
