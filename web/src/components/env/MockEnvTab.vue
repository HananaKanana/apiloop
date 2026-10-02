<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { NButton, NTag, useMessage } from 'naive-ui';
import { useDialog } from '@/utils/dialog';
import { MOCK_ENV_ID, useEnvStore } from '@/stores/env';
import { useProjectStore } from '@/stores/project';
import { useGatewayStore } from '@/stores/gateway';
import { collapseMockVariables, defaultMockVariables, mockBaseUrl, mockVariables } from '@/utils/mock';
import VarTable from '@/components/common/VarTable.vue';

/**
 * 内置 Mock 环境的编辑区（用户 2026-10-02：内置的也要能改，比如接口都带 /api、/v1 前缀）。
 *
 * 默认只有 `host = <这个项目的 mock 地址>`；可以随便改、加变量，改过的存在项目上
 * （`mockVariables`，跟着项目同步），「还原默认值」就是把它清掉。
 * 保存时值开头的 mock 地址会收回成占位符（utils/mock.js），云端地址变了也不会过期。
 * 名字固定叫 Mock，不能删。
 */
const envs = useEnvStore();
const projects = useProjectStore();
const gateway = useGatewayStore();
const message = useMessage();
const dialog = useDialog();

const saving = ref(false);
const keyword = ref('');
const draft = ref([]);

const project = computed(function () { return projects.current; });
const canEdit = computed(function () { return projects.canEdit; });

const saved = computed(function () { return mockVariables(project.value); });
const customized = computed(function () {
  return Boolean(project.value && Array.isArray(project.value.mockVariables));
});

function reset() {
  draft.value = JSON.parse(JSON.stringify(saved.value));
}
// 换项目、或者别处（同步）改了项目，重新起草稿
watch(saved, reset, { immediate: true });

const dirty = computed(function () {
  return JSON.stringify(draft.value) !== JSON.stringify(saved.value);
});

const isCurrent = computed(function () { return envs.selectedId === MOCK_ENV_ID; });

const count = computed(function () {
  return draft.value.filter(function (row) { return row && (row.key || row.value); }).length;
});

async function persist(value, okText) {
  if (!project.value) return;
  saving.value = true;
  try {
    await projects.update(project.value.id, { mockVariables: value });
    reset();
    message.success(okText);
  } catch (err) {
    message.error(err.message);
  } finally {
    saving.value = false;
  }
}

function save() {
  if (!dirty.value) return;
  persist(collapseMockVariables(project.value, draft.value), '已保存');
}

function restoreDefault() {
  dialog.warning({
    title: '还原默认值',
    content: '变量会恢复成只有 host = ' + mockBaseUrl(project.value) + '，你改过和加的变量都会去掉。',
    positiveText: '还原',
    negativeText: '取消',
    onPositiveClick: function () {
      if (!customized.value) {
        draft.value = defaultMockVariables(project.value);
        return;
      }
      persist(null, '已还原默认值');
    }
  });
}

function setCurrent() {
  envs.select(MOCK_ENV_ID);
  message.success('已设为当前环境');
}

function onKeydown(event) {
  if (!(event.metaKey || event.ctrlKey)) return;
  if (String(event.key).toLowerCase() !== 's') return;
  event.preventDefault();
  if (!canEdit.value) {
    message.warning('当前角色是只读，不能保存修改');
    return;
  }
  save();
}

onMounted(function () { window.addEventListener('keydown', onKeydown); });
onBeforeUnmount(function () { window.removeEventListener('keydown', onKeydown); });
</script>

<template>
  <div class="env-tab">
    <div class="head">
      <span class="title">Mock</span>
      <n-tag size="small" :bordered="false" type="warning">内置</n-tag>
      <span v-if="dirty" class="dirty-dot" title="有没保存的修改，⌘S 保存" />

      <n-tag v-if="isCurrent" size="small" :bordered="false">当前</n-tag>
      <n-button
        v-else-if="gateway.mockAvailable"
        size="small"
        quaternary
        @click="setCurrent"
      >
        设为当前
      </n-button>

      <span class="spacer" />

      <n-button
        v-if="canEdit"
        size="small"
        quaternary
        :disabled="!customized && !dirty"
        @click="restoreDefault"
      >
        还原默认值
      </n-button>
      <n-button
        v-if="canEdit"
        size="small"
        :disabled="!dirty"
        :loading="saving"
        @click="save"
      >
        保存
      </n-button>
    </div>

    <p class="intro">
      选中这个环境，请求地址写成 <code v-pre>{{host}}/路径</code> 就会打到这个项目的 Mock 上。
      默认 host 是 <code>{{ mockBaseUrl(project) }}</code>；接口都带统一前缀时可以直接改，
      比如在后面加上 <code>/api</code>。
    </p>

    <div class="toolbar">
      <span class="count">共 {{ count }} 个变量</span>
    </div>

    <div class="body">
      <var-table v-model="draft" :disabled="!canEdit" :filter="keyword" />
    </div>
  </div>
</template>

<style scoped>
.env-tab {
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

.title {
  font-size: 15px;
  font-weight: 600;
}

.dirty-dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--apiloop-primary);
}

.spacer {
  flex: 1;
}

.intro {
  flex: none;
  margin: 12px 16px 0;
  font-size: 12px;
  line-height: 1.7;
  opacity: 0.7;
}

.intro code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  padding: 0 3px;
  border-radius: 3px;
  background: rgba(128, 128, 128, 0.12);
}

.toolbar {
  flex: none;
  padding: 10px 16px 0;
}

.count {
  font-size: 12px;
  opacity: 0.6;
}

.body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 12px 16px;
}
</style>
