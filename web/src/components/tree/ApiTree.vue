<script setup>
import { computed, h, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { NButton, NDropdown, NEmpty, NIcon, NInput, NModal, NSpace, NSpin, NTree, useMessage } from 'naive-ui';
import { FileImport, Filter, Fold, FoldDown, Plus } from '@vicons/tabler';
import { useProjectStore } from '@/stores/project';
import { useTreeStore } from '@/stores/tree';
import { useGatewayStore } from '@/stores/gateway';
import { useTabsStore } from '@/stores/tabs';
import { useUiStore } from '@/stores/ui';
import { collectFolderKeys, filterTree, findNode, walkTree } from '@/utils/tree';
import { usePrompt } from '@/utils/prompt';
import { useDialog } from '@/utils/dialog';
import { METHOD_LABEL_WIDTH, methodColor } from '@/utils/method';
import ContextMenu from '@/components/common/ContextMenu.vue';
import ShareDialog from '@/components/share/ShareDialog.vue';

const emit = defineEmits(['open', 'new-api', 'new-ws', 'open-folder', 'run', 'import']);

const projects = useProjectStore();
const router = useRouter();
const tree = useTreeStore();
const gateway = useGatewayStore();
const tabs = useTabsStore();
const ui = useUiStore();
const message = useMessage();
const prompt = usePrompt();
const dialog = useDialog();

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

/** 工具条上「＋」和「…」两个菜单 */
const newOptions = [
  { label: '接口', key: 'api' },
  { label: '目录', key: 'folder' },
  { label: 'WebSocket', key: 'ws' }
];

function onNewSelect(key) {
  if (key === 'api') {
    emit('new-api', null);
    return;
  }
  if (key === 'ws') {
    emit('new-ws');
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
    (folder && folder.name) || (projects.current && projects.current.name) || '项目';
  showShare.value = true;
}

const displayTree = computed(function () {
  return filterTree(tree.nodes, searchText.value);
});

// 搜索时自动展开命中节点所在的目录
watch(searchText, function (value) {
  if (!value.trim()) return;
  const keys = collectFolderKeys(displayTree.value);
  expandedKeys.value = Array.from(new Set(expandedKeys.value.concat(keys)));
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

  const method = String((node.api && node.api.method) || 'GET').toUpperCase();
  const name = node.name || '(未命名接口)';

  return h('span', { class: 'tree-label api', title: name }, [
    h('span', { class: 'method', style: { color: methodColor(method), width: methodWidth } }, method),
    h('span', { class: 'name' }, name)
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
      title: '和云端有冲突，点这里处理',
      onClick: function (event) {
        // 别把点击透给节点本身：否则还会顺带展开目录 / 打开接口
        event.stopPropagation();
        ui.openConflict(node.kind, node.id);
      }
    }, '!'));
  } else if (gateway.isPending(node.kind, node.id)) {
    marks.push(h('span', { class: 'sync-mark pending', title: '还没同步到云端' }));
  }

  if (node.kind === 'api' && node.api && node.api.mockEnabled) {
    marks.push(h('span', { class: 'mock-dot', title: 'mock 已启用' }));
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
    onClick: function (event) {
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

/* ---------------- 选中与右键 ---------------- */

function onSelectedChange(keys) {
  selectedKeys.value = keys;
  const key = keys[keys.length - 1];
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
  // viewer 没有任何写权限，但「目录设置」是能看的（打开后只读），所以目录上只给它这一项。
  // 接口节点上没有任何 viewer 能用的项，那就不弹 —— 弹一个全是灰项的菜单比不弹更让人困惑
  if (!projects.canEdit && node.kind !== 'folder') return;

  menu.value = {
    show: true,
    x: event.clientX,
    y: event.clientY,
    node: node,
    options: node.kind === 'folder' ? folderMenuOptions() : apiMenuOptions()
  };
}

/**
 * 在目录树的空白处右键：项目根这一层的操作（第 2 节的「运行全部」就在这里）、
 * 新建、全部收起 / 展开（节点上的右键会 stopPropagation，不会走到这里）
 */
function openBlankMenu(event) {
  // 「运行全部」放最上面：发请求 viewer 也能做（服务端 /send 就是 viewer 权限）
  const options = [{ label: '运行全部', key: 'blank-run' }];

  if (canShare.value) {
    options.push({ label: '分享整个项目的文档', key: 'blank-share' });
  }
  // 已生成的分享链接在项目设置里看、撤销；viewer 也能看列表
  if (gateway.cloudFeaturesAvailable) {
    options.push({ label: '管理分享链接', key: 'blank-shares' });
  }

  if (projects.canEdit) {
    options.push({ type: 'divider', key: 'blank-d' });
    options.push({ label: '新建接口', key: 'blank-new-api' });
    options.push({ label: '新建目录', key: 'blank-new-folder' });
  }
  options.push({ type: 'divider', key: 'blank-d2' });
  options.push({ label: anyExpanded.value ? '全部收起' : '全部展开', key: 'blank-toggle' });

  menu.value = { show: true, x: event.clientX, y: event.clientY, node: null, options: options };
}

function folderMenuOptions() {
  // viewer 也能「运行」：发请求本来就是只读角色要做的事（服务端 /send 是 viewer 权限）
  if (!projects.canEdit) {
    return [
      { label: '目录设置', key: 'folder-settings' },
      { label: '运行', key: 'run' }
    ];
  }

  const options = [
    { label: '目录设置', key: 'folder-settings' },
    { type: 'divider', key: 'd0' },
    { label: '运行', key: 'run' }
  ];
  if (canShare.value) options.push({ label: '分享文档', key: 'share' });

  return options.concat([
    { type: 'divider', key: 'd1' },
    { label: '新建子目录', key: 'new-folder' },
    { label: '新建接口', key: 'new-api' },
    { type: 'divider', key: 'd2' },
    { label: '重命名', key: 'rename' },
    { label: '删除', key: 'delete', props: { style: 'color: #d03050' } }
  ]);
}

function apiMenuOptions() {
  return [
    { label: '复制', key: 'duplicate' },
    { label: '重命名', key: 'rename' },
    { type: 'divider', key: 'd2' },
    { label: '删除', key: 'delete', props: { style: 'color: #d03050' } }
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
  if (key === 'blank-share') return openShare(null);
  if (key === 'blank-shares') {
    return router.push({ path: '/projects/' + projects.currentId + '/settings', query: { tab: 'shares' } });
  }
  if (key === 'blank-toggle') return toggleExpandAll();
  if (!node) return;

  try {
    if (key === 'folder-settings') return emit('open-folder', node.id);
    if (key === 'run') return emit('run', node.id);
    if (key === 'share') return openShare(node.id);
    if (key === 'new-folder') return await createFolder(node.id);
    if (key === 'new-api') return emit('new-api', node.id);
    if (key === 'rename') return await rename(node);
    if (key === 'duplicate') {
      await tree.duplicateApi(node.id);
      message.success('已复制');
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
    title: '新建目录',
    label: parentId ? '会建在选中的目录下面' : '会建在根目录下',
    placeholder: '目录名称',
    confirmText: '创建'
  });
  if (name === null || !String(name).trim()) return;

  try {
    await tree.createFolder(String(name).trim(), parentId);
    if (parentId) expandedKeys.value = Array.from(new Set(expandedKeys.value.concat(['f:' + parentId])));
    message.success('已创建');
  } catch (err) {
    message.error(err.message);
  }
}

async function rename(node) {
  const name = await prompt({
    title: node.kind === 'folder' ? '重命名目录' : '重命名接口',
    value: node.name,
    confirmText: '保存'
  });
  if (name === null || !String(name).trim()) return;

  try {
    const trimmed = String(name).trim();
    if (node.kind === 'folder') await tree.renameFolder(node.id, trimmed);
    else await tree.renameApi(node.id, trimmed);
    // 打开着的标签页标题跟着变（只动名字，别的没保存的修改不受影响）
    tabs.applyRename(node.kind === 'folder' ? 'folder' : 'api', node.id, trimmed);
    message.success('已重命名');
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
    message.success(mode === 'delete' ? '已删除目录及其子项' : '已删除目录，子项已移到上一级');
  } catch (err) {
    message.error(err.message);
  }
}

async function removeApi(node) {
  const name = node.name || '未命名接口';
  dialog.error({
    title: '删除接口',
    content: '删除「' + name + '」后可以在回收站里恢复（保留 30 天）。确定删除吗？',
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async function () {
      try {
        await tree.removeApi(node.id);
        message.success('已删除');
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

function allowDrop(info) {
  const drag = findNode(tree.nodes, info.dragNode.key);
  const drop = findNode(tree.nodes, info.node.key);
  if (!drag || !drop) return false;

  if (info.dropPosition === 'inside') {
    // 接口不能拖进另一个接口里面；目录不能拖进自己或自己的子孙
    if (drop.kind !== 'folder') return false;
    if (drag.kind === 'folder' && (drag.key === drop.key || isDescendant(drag, drop.key))) return false;
    return true;
  }

  // 前后插入只允许同类之间，免得目录和接口混排
  return drag.kind === drop.kind;
}

async function onDrop(info) {
  const drag = findNode(tree.nodes, info.dragNode.key);
  const drop = findNode(tree.nodes, info.node.key);
  if (!drag || !drop) return;

  const kind = drag.kind;
  let parentId;
  let index;

  if (info.dropPosition === 'inside') {
    parentId = drop.id;
    index = siblingsUnder(parentId, kind).length;
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
        placeholder="过滤"
      >
        <template #prefix>
          <n-icon :component="Filter" />
        </template>
      </n-input>

      <!-- 新建：接口 / 目录 / WebSocket 都收在这一个 ＋ 里 -->
      <n-dropdown v-if="projects.canEdit" trigger="click" :options="newOptions" @select="onNewSelect">
        <n-button size="small" quaternary title="新建">
          <template #icon>
            <n-icon :component="Plus" />
          </template>
        </n-button>
      </n-dropdown>

      <n-button size="small" quaternary title="导入" @click="emit('import')">
        <template #icon>
          <n-icon :component="FileImport" />
        </template>
      </n-button>

      <!-- 全部收起 / 全部展开：直接一个按钮，不再藏进「…」菜单（那里本来也只有这一项） -->
      <n-button
        size="small"
        quaternary
        :title="anyExpanded ? '全部收起' : '全部展开'"
        @click="toggleExpandAll"
      >
        <template #icon>
          <n-icon :component="anyExpanded ? Fold : FoldDown" />
        </template>
      </n-button>
    </div>

    <div class="group-title">目录</div>

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
          :render-label="renderLabel"
          :render-switcher-icon="renderSwitcherIcon"
          :render-suffix="renderSuffix"
          :node-props="nodeProps"
          :draggable="projects.canEdit"
          :allow-drop="allowDrop"
          :cancelable="false"
          @update:expanded-keys="(keys) => { expandedKeys = keys; }"
          @update:selected-keys="onSelectedChange"
          @drop="onDrop"
        />
        <n-empty
          v-else
          size="small"
          :description="searchText
            ? '没有匹配的接口'
            : (projects.canEdit ? '还没有接口，右键目录或点右上角 ＋ 新建' : '这个项目还没有接口')"
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
      :title="deleteTarget ? '删除目录「' + deleteTarget.node.name + '」' : '删除目录'"
      style="width: 460px; max-width: 92vw"
    >
      <template v-if="deleteTarget">
        <p class="delete-desc">
          该目录下有 {{ deleteTarget.counts.folders }} 个子目录、{{ deleteTarget.counts.apis }} 个接口。请选择如何处理这些子项：
        </p>
        <p class="delete-desc recycle">删除后可以在回收站里恢复（保留 30 天）。</p>
        <n-space vertical size="small">
          <n-button block @click="confirmDeleteFolder('move')">
            仅删除目录（子项移到上一级）
          </n-button>
          <n-button block type="error" @click="confirmDeleteFolder('delete')">
            连同子项一起删除
          </n-button>
        </n-space>
      </template>

      <template #footer>
        <n-space justify="end">
          <n-button @click="showDelete = false">取消</n-button>
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

.body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 0 4px 4px;
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
