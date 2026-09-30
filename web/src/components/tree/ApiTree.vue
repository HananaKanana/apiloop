<script setup>
import { computed, h, ref, watch } from 'vue';
import { NButton, NDropdown, NEmpty, NIcon, NInput, NModal, NSpace, NSpin, NTree, useMessage } from 'naive-ui';
import { Dots, FileImport, Filter, Plus } from '@vicons/tabler';
import { useProjectStore } from '@/stores/project';
import { useTreeStore } from '@/stores/tree';
import { collectFolderKeys, filterTree, findNode, walkTree } from '@/utils/tree';
import { usePrompt } from '@/utils/prompt';
import { METHOD_LABEL_WIDTH, methodColor } from '@/utils/method';
import TreeContextMenu from './TreeContextMenu.vue';

const emit = defineEmits(['open', 'new-api', 'new-ws', 'open-folder', 'import']);

const projects = useProjectStore();
const tree = useTreeStore();
const message = useMessage();
const prompt = usePrompt();

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

const moreOptions = computed(function () {
  return [{ label: anyExpanded.value ? '全部收起' : '全部展开', key: 'toggle' }];
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
  if (key === 'folder') {
    // 建在当前选中的目录下（和导入的落点规则一致）
    createFolder(tree.selectedFolderId || null);
  }
}

function onMoreSelect(key) {
  if (key === 'toggle') toggleExpandAll();
}

const searchText = ref('');
const expandedKeys = ref([]);
const selectedKeys = ref([]);

const menu = ref({ show: false, x: 0, y: 0, node: null, options: [] });

const deleteTarget = ref(null);
const showDelete = ref(false);

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
      expandedKeys.value = collectFolderKeys(tree.nodes);
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

/** 展开 / 收起的小三角，n-tree 自己不会给自定义图标加旋转，所以这里按状态画两个方向 */
function renderSwitcherIcon(info) {
  const path = info.expanded ? 'M3.5 6 8 10.5 12.5 6' : 'M6 3.5 10.5 8 6 12.5';
  return h('svg', Object.assign({ class: 'switcher-icon' }, SVG_ATTRS, { width: '14', height: '14' }), [
    h('path', { d: path, 'stroke-linecap': 'round' })
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

function renderSuffix(info) {
  const node = info.option;
  if (node.kind !== 'api' || !node.api || !node.api.mockEnabled) return null;
  return h('span', { class: 'mock-dot', title: 'mock 已启用' });
}

function nodeProps(info) {
  return {
    onContextmenu: function (event) {
      event.preventDefault();
      event.stopPropagation();
      openMenu(event, info.option);
    }
  };
}

/* ---------------- 选中与右键 ---------------- */

function onSelectedChange(keys) {
  selectedKeys.value = keys;
  const key = keys[keys.length - 1];
  if (!key) return;

  const node = findNode(tree.nodes, key);
  if (node && node.kind === 'api') {
    tree.setSelectedFolder(node.parentId);
    emit('open', node.api);
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

function folderMenuOptions() {
  if (!projects.canEdit) return [{ label: '目录设置', key: 'folder-settings' }];

  return [
    { label: '目录设置', key: 'folder-settings' },
    { type: 'divider', key: 'd0' },
    { label: '新建子目录', key: 'new-folder' },
    { label: '新建接口', key: 'new-api' },
    { type: 'divider', key: 'd1' },
    { label: '重命名', key: 'rename' },
    { label: '删除', key: 'delete', props: { style: 'color: #d03050' } }
  ];
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
  if (!node) return;

  try {
    if (key === 'folder-settings') return emit('open-folder', node.id);
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
    if (node.kind === 'folder') await tree.renameFolder(node.id, String(name).trim());
    else await tree.renameApi(node.id, String(name).trim());
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
  try {
    await tree.removeApi(node.id);
    message.success('已删除');
  } catch (err) {
    message.error(err.message);
  }
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

      <n-dropdown trigger="click" :options="moreOptions" @select="onMoreSelect">
        <n-button size="small" quaternary title="更多">
          <template #icon>
            <n-icon :component="Dots" />
          </template>
        </n-button>
      </n-dropdown>
    </div>

    <div class="group-title">目录</div>

    <div class="body">
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

    <tree-context-menu
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
</style>
