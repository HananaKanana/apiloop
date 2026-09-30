<script setup>
import { computed, h, ref, watch } from 'vue';
import { NButton, NEmpty, NInput, NModal, NSpace, NSpin, NTree, useMessage } from 'naive-ui';
import { useProjectStore } from '@/stores/project';
import { useTreeStore } from '@/stores/tree';
import { collectFolderKeys, filterTree, findNode, walkTree } from '@/utils/tree';
import { usePrompt } from '@/utils/prompt';
import TreeContextMenu from './TreeContextMenu.vue';

const emit = defineEmits(['open', 'new-api']);

const projects = useProjectStore();
const tree = useTreeStore();
const message = useMessage();
const prompt = usePrompt();

const METHOD_COLORS = {
  GET: '#18a058',
  POST: '#f0a020',
  PUT: '#2080f0',
  PATCH: '#8a2be2',
  DELETE: '#d03050',
  HEAD: '#909399',
  OPTIONS: '#909399'
};

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

function renderLabel(info) {
  const node = info.option;

  if (node.kind === 'folder') {
    return h('span', { class: 'tree-label folder' }, [
      h('span', { class: 'name' }, node.name)
    ]);
  }

  const method = String((node.api && node.api.method) || 'GET').toUpperCase();
  const color = METHOD_COLORS[method] || '#909399';

  return h('span', { class: 'tree-label api' }, [
    h('span', { class: 'method', style: { color: color, borderColor: color } }, method),
    h('span', { class: 'name' }, node.name || '(未命名接口)')
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
  // viewer 的右键菜单里没有任何能点的项（新建 / 重命名 / 删除 / 复制都要写权限），
  // 索性不弹出来 —— 弹一个全是灰项的菜单比不弹更让人困惑
  if (!projects.canEdit) return;

  menu.value = {
    show: true,
    x: event.clientX,
    y: event.clientY,
    node: node,
    options: node.kind === 'folder'
      ? [
          { label: '新建子目录', key: 'new-folder' },
          { label: '新建接口', key: 'new-api' },
          { type: 'divider', key: 'd1' },
          { label: '重命名', key: 'rename' },
          { label: '删除', key: 'delete', props: { style: 'color: #d03050' } }
        ]
      : [
          { label: '复制', key: 'duplicate' },
          { label: '重命名', key: 'rename' },
          { type: 'divider', key: 'd2' },
          { label: '删除', key: 'delete', props: { style: 'color: #d03050' } }
        ]
  };
}

async function onMenuSelect(key) {
  const node = menu.value.node;
  menu.value.show = false;
  if (!node) return;

  try {
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
        size="small"
        clearable
        placeholder="搜索名称或 url"
      />
      <n-button size="small" quaternary title="全部展开" @click="expandAll">展开</n-button>
      <n-button
        v-if="projects.canEdit"
        size="small"
        quaternary
        title="新建接口"
        @click="emit('new-api', null)"
      >
        ＋
      </n-button>
    </div>

    <div class="body">
      <n-spin :show="tree.loading">
        <n-tree
          v-if="displayTree.length"
          block-line
          :data="displayTree"
          :expanded-keys="expandedKeys"
          :selected-keys="selectedKeys"
          :render-label="renderLabel"
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
  gap: 4px;
  padding: 8px;
  border-bottom: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.16));
}

.body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 4px 0;
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
}

:deep(.tree-label .name) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

:deep(.tree-label .method) {
  flex: none;
  font-size: 10px;
  font-weight: 700;
  line-height: 14px;
  padding: 0 3px;
  border: 1px solid;
  border-radius: 3px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

:deep(.mock-dot) {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #18a058;
  margin-left: 6px;
  vertical-align: middle;
}
</style>
