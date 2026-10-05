<script setup>
import { computed, ref, watch } from 'vue';
import {
  NButton,
  NCheckbox,
  NIcon,
  NInputNumber,
  NModal,
  NSelect,
  NSpace,
  NTag,
  NTree,
  useMessage
} from 'naive-ui';
import { ChevronDown, ChevronRight, Plus, Trash } from '@vicons/tabler';
import AssertionsPane from '@/components/assertions/AssertionsPane.vue';
import { useProjectStore } from '@/stores/project';
import { useTabsStore } from '@/stores/tabs';
import { useTreeStore } from '@/stores/tree';
import { buildTree } from '@/utils/tree';
import { methodColor } from '@/utils/method';

/**
 * 测试集的「步骤」页签（第八轮第 1 节）。
 *
 * 一张可拖动排序的列表：启用 · 序号 · 方法 + 接口名（灰字目录）· 失败时 · 等待 · 删除。
 * 点开一行是这个步骤**额外的**断言和提取变量（复用接口「断言」页签那个组件）——
 * 接口自己的断言照样会跑，这里的是在它之后追加的。
 */
const props = defineProps({
  suite: { type: Object, required: true },
  disabled: { type: Boolean, default: false }
});

const emit = defineEmits(['change']);

const projects = useProjectStore();
const tabs = useTabsStore();
const tree = useTreeStore();
const message = useMessage();

const steps = computed(function () { return props.suite.steps || []; });

const canEdit = computed(function () { return projects.canEdit && !props.disabled; });

function update(next) {
  emit('change', { steps: next });
}

/* ---------------- 接口信息（方法 / 名字 / 所在目录） ---------------- */

const apiById = computed(function () {
  const map = {};
  tree.apis.forEach(function (api) { map[api.id] = api; });
  return map;
});

const folderById = computed(function () {
  const map = {};
  tree.folders.forEach(function (folder) { map[folder.id] = folder; });
  return map;
});

function apiOf(step) {
  return apiById.value[step.apiId] || null;
}

function folderPath(api) {
  if (!api || !api.folderId) return '';

  const names = [];
  let current = folderById.value[api.folderId];
  let guard = 0;
  while (current && guard < 32) {
    guard += 1;
    names.unshift(current.name);
    current = current.parentId ? folderById.value[current.parentId] : null;
  }
  return names.join(' / ');
}

/* ---------------- 增删改 ---------------- */

const expandedId = ref('');

function toggleExpand(step) {
  expandedId.value = expandedId.value === step.id ? '' : step.id;
}

function patchStep(index, patch) {
  const next = steps.value.slice();
  next[index] = Object.assign({}, next[index], patch);
  update(next);
}

function removeStep(index) {
  const next = steps.value.slice();
  next.splice(index, 1);
  update(next);
}

/* ---------------- 拖动排序 ---------------- */

const dragId = ref('');
const dropId = ref('');

function onDragStart(step) {
  dragId.value = step.id;
}

function onDragOver(step) {
  if (!dragId.value || dragId.value === step.id) return;
  dropId.value = step.id;
}

function onDrop() {
  const from = dragId.value;
  const to = dropId.value;
  dragId.value = '';
  dropId.value = '';
  if (!from || !to || from === to) return;

  const next = steps.value.slice();
  const fromAt = next.findIndex(function (step) { return step.id === from; });
  const toAt = next.findIndex(function (step) { return step.id === to; });
  if (fromAt === -1 || toAt === -1) return;

  next.splice(toAt, 0, next.splice(fromAt, 1)[0]);
  update(next);
}

/* ---------------- 添加接口 ---------------- */

const showAdd = ref(false);
const checkedKeys = ref([]);

/** 目录树（WebSocket / Socket.IO / gRPC 接口不能加进测试集）：勾目录会连它下面的接口一起勾上 */
const pickerNodes = computed(function () {
  const apis = tree.apis.filter(function (api) {
    const method = String(api.method || '').toUpperCase();
    return method !== 'WS' && method !== 'SIO' && method !== 'GRPC';
  });

  const nodes = buildTree(tree.folders, apis);

  function decorate(list) {
    list.forEach(function (node) {
      if (node.kind === 'api') {
        // 方法在 node.api 上（buildTree 的接口节点只带 name / label / api），
        // 以前读的是 node.method —— 永远是 undefined，于是全都显示成 GET
        const api = node.api || {};
        node.label = (api.method || 'GET') + ' ' + (node.name || api.url || '');
        node.children = null;
      } else if (node.children) {
        decorate(node.children);
      }
    });
  }
  decorate(nodes);

  return nodes;
});

const apiNodeKeys = computed(function () {
  const keys = [];
  function walk(list) {
    list.forEach(function (node) {
      if (node.kind === 'api') keys.push(node.key);
      if (node.children) walk(node.children);
    });
  }
  walk(pickerNodes.value);
  return keys;
});

/** 按树的顺序收集勾中的接口（父目录在前，和树上看到的顺序一致） */
function checkedApisInOrder() {
  const checked = {};
  checkedKeys.value.forEach(function (key) { checked[key] = true; });

  const out = [];
  function walk(list) {
    list.forEach(function (node) {
      if (node.kind === 'api') {
        if (checked[node.key]) out.push(node.api);
        return;
      }
      if (node.children) walk(node.children);
    });
  }
  walk(pickerNodes.value);
  return out;
}

function openAdd() {
  checkedKeys.value = [];
  showAdd.value = true;
  if (!tree.folders.length) tree.load().catch(function () {});
}

function confirmAdd() {
  const picked = checkedApisInOrder();
  if (!picked.length) {
    message.warning('先勾几个接口');
    return;
  }

  const next = steps.value.concat(picked.map(function (api) {
    return {
      id: 'st_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      apiId: api.id,
      enabled: true,
      onFail: 'continue',
      delayMs: 0,
      assertions: [],
      extracts: []
    };
  }));

  update(next);
  showAdd.value = false;
  message.success('加了 ' + picked.length + ' 个接口');
}

// 步骤里引用的接口不在当前项目的目录树里（被删了）：拉一次树，好判断哪些标红
watch(
  function () { return steps.value.length; },
  function (value) { if (value && !tree.apis.length) tree.load().catch(function () {}); },
  { immediate: true }
);
</script>

<template>
  <div class="pane">
    <div class="toolbar">
      <span class="hint">按顺序执行；点开一行可以给这一步<b>追加</b>断言和提取变量。</span>
      <span class="spacer" />
      <n-button size="small" :disabled="!canEdit" @click="openAdd">
        <template #icon><n-icon :component="Plus" /></template>
        添加接口
      </n-button>
    </div>

    <p v-if="!steps.length" class="empty">
      还没有步骤。点「添加接口」从目录树里挑几个 —— 同一个接口可以加多次。
    </p>

    <div v-else class="grid">
      <div
        v-for="(step, index) in steps"
        :key="step.id"
        class="item"
        :class="{ dragging: dragId === step.id, dropping: dropId === step.id }"
        draggable="true"
        @dragstart="onDragStart(step)"
        @dragover.prevent="onDragOver(step)"
        @drop.prevent="onDrop"
        @dragend="dragId = ''; dropId = ''"
      >
        <div class="row">
          <n-checkbox
            :checked="step.enabled !== false"
            :disabled="!canEdit"
            @update:checked="(value) => patchStep(index, { enabled: value })"
          />

          <span class="seq">{{ index + 1 }}</span>

          <button class="toggle" @click="toggleExpand(step)">
            <n-icon size="13" :component="expandedId === step.id ? ChevronDown : ChevronRight" />
          </button>

          <template v-if="apiOf(step)">
            <span class="method" :style="{ color: methodColor(apiOf(step).method) }">
              {{ apiOf(step).method }}
            </span>
            <span class="name" :title="apiOf(step).url">{{ apiOf(step).name || apiOf(step).url }}</span>
            <span class="folder">{{ folderPath(apiOf(step)) }}</span>
          </template>
          <template v-else>
            <span class="method gone">—</span>
            <span class="name gone">接口已删除</span>
          </template>

          <span class="spacer" />

          <n-select
            class="onfail"
            size="tiny"
            :disabled="!canEdit"
            :value="step.onFail || 'continue'"
            :options="[
              { label: '失败时继续', value: 'continue' },
              { label: '失败时跳过本轮', value: 'skipIteration' }
            ]"
            @update:value="(value) => patchStep(index, { onFail: value })"
          />

          <n-input-number
            class="delay"
            size="tiny"
            :disabled="!canEdit"
            :min="0"
            :value="step.delayMs || 0"
            @update:value="(value) => patchStep(index, { delayMs: value === null ? 0 : value })"
          >
            <template #suffix>ms</template>
          </n-input-number>

          <n-button size="tiny" quaternary :disabled="!canEdit" title="删除这一步" @click="removeStep(index)">
            <template #icon><n-icon :component="Trash" /></template>
          </n-button>
        </div>

        <div v-if="expandedId === step.id" class="detail">
          <p class="detail-hint">
            接口自己的断言照样会跑，这里的是在它之后追加的。
            <button v-if="apiOf(step)" class="link" @click="tabs.openApi(step.apiId)">打开接口</button>
          </p>

          <assertions-pane
            :assertions="step.assertions || []"
            :extracts="step.extracts || []"
            :disabled="!canEdit"
            :has-environment="true"
            @update:assertions="(value) => patchStep(index, { assertions: value })"
            @update:extracts="(value) => patchStep(index, { extracts: value })"
          />
        </div>
      </div>
    </div>

    <!-- 添加接口：目录树多选（勾目录 = 它下面的接口按树的顺序全加进来） -->
    <n-modal v-model:show="showAdd" preset="card" title="添加接口" style="width: 520px; max-width: 94vw">
      <p class="pick-hint">勾目录会把它下面的接口按树的顺序一起加进来；WebSocket 接口不能加。</p>
      <div class="pick-tree">
        <n-tree
          v-if="pickerNodes.length"
          checkable
          cascade
          block-line
          :data="pickerNodes"
          :checked-keys="checkedKeys"
          :selectable="false"
          @update:checked-keys="(keys) => { checkedKeys = keys.filter((k) => apiNodeKeys.indexOf(k) > -1); }"
        />
        <p v-else class="empty">这个项目还没有接口。</p>
      </div>
      <template #footer>
        <n-space justify="end">
          <n-button size="small" @click="showAdd = false">取消</n-button>
          <n-button size="small" type="primary" @click="confirmAdd">添加</n-button>
        </n-space>
      </template>
    </n-modal>
  </div>
</template>

<style scoped>
.pane {
  padding: 10px 14px 16px;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.hint {
  font-size: 12px;
  opacity: 0.6;
}

.spacer {
  flex: 1;
}

.empty {
  margin: 10px 0;
  font-size: 12px;
  opacity: 0.55;
}

.grid {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.item {
  border-radius: 5px;
}

.item:hover {
  background: rgba(128, 128, 128, 0.07);
}

.item.dragging {
  opacity: 0.5;
}

.item.dropping {
  box-shadow: inset 0 2px 0 var(--apiloop-primary);
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 6px;
  font-size: 12px;
}

.seq {
  flex: none;
  width: 18px;
  text-align: right;
  opacity: 0.45;
}

.toggle {
  flex: none;
  display: flex;
  padding: 0 2px;
  border: none;
  background: transparent;
  color: inherit;
  opacity: 0.5;
  cursor: pointer;
}

.toggle:hover {
  opacity: 1;
}

.method {
  flex: none;
  width: 52px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-weight: 600;
}

.method.gone {
  color: #d03050;
}

.name {
  min-width: 0;
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.name.gone {
  color: #d03050;
}

.folder {
  min-width: 0;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  opacity: 0.45;
}

.onfail {
  flex: none;
  width: 150px;
}

.delay {
  flex: none;
  width: 108px;
}

.detail {
  margin: 0 6px 10px 40px;
  padding: 10px 12px;
  border-radius: 6px;
  background: rgba(128, 128, 128, 0.06);
}

.detail-hint {
  margin: 0 0 8px;
  font-size: 12px;
  opacity: 0.6;
}

.link {
  margin-left: 6px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--apiloop-primary);
  font-size: 12px;
  cursor: pointer;
}

.link:hover {
  text-decoration: underline;
}

.pick-hint {
  margin: 0 0 8px;
  font-size: 12px;
  opacity: 0.6;
}

.pick-tree {
  max-height: 320px;
  overflow: auto;
}
</style>
