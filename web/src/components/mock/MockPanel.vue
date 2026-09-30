<script setup>
import { computed, ref, watch } from 'vue';
import {
  NButton,
  NEmpty,
  NFormItem,
  NInput,
  NInputNumber,
  NSpace,
  NSwitch,
  NTag,
  useDialog,
  useMessage
} from 'naive-ui';
import * as apisApi from '@/api/apis';
import { useProjectStore } from '@/stores/project';
import { useSessionStore } from '@/stores/session';
import { usePrompt } from '@/utils/prompt';
import ExampleEditor from './ExampleEditor.vue';

/**
 * Mock 页签：mock 配置 + 示例列表 + 示例编辑器。
 *
 * 所有写操作都走 PUT /apis/:id 的 mock 字段，改完用服务端返回的 api 覆盖本地的，
 * 不在前端自己拼状态。
 */
const props = defineProps({
  tab: { type: Object, required: true }
});

const projects = useProjectStore();
const session = useSessionStore();
const message = useMessage();
const dialog = useDialog();
const prompt = usePrompt();

const selectedId = ref('');
/** mock.path 单独存一份草稿：mock 是 computed，直接绑它改的是临时对象 */
const draftPath = ref('');

const api = computed(function () {
  return props.tab.api;
});

const mock = computed(function () {
  const value = api.value && api.value.mock;
  return {
    enabled: Boolean(value && value.enabled),
    path: (value && value.path) || '',
    delay: (value && value.delay) || 0,
    cors: Boolean(value && value.cors),
    exampleId: (value && value.exampleId) || null
  };
});

const examples = computed(function () {
  return (api.value && api.value.examples) || [];
});

const selectedExample = computed(function () {
  return examples.value.find(function (item) { return item.id === selectedId.value; }) || null;
});

const mockUrl = computed(function () {
  const project = projects.current;
  const prefix = project && project.isRoot ? '' : '/mock/' + (project ? project.slug : '');
  return window.location.origin + prefix + mock.path;
});

watch(
  function () { return mock.value.path; },
  function (value) { draftPath.value = value; },
  { immediate: true }
);

watch(
  function () { return api.value && api.value.id; },
  function () {
    const list = examples.value;
    if (!list.length) {
      selectedId.value = '';
      return;
    }
    if (list.some(function (item) { return item.id === selectedId.value; })) return;
    selectedId.value = mock.value.exampleId || list[0].id;
  },
  { immediate: true }
);

/* ---------------- 配置 ---------------- */

async function refreshApi() {
  if (!props.tab.apiId) return;
  const data = await apisApi.getApi(props.tab.apiId);
  props.tab.api = data.api;
}

async function patchMock(patch) {
  if (!props.tab.apiId) return;

  const next = Object.assign({}, mock.value, patch);
  try {
    const data = await apisApi.updateApi(props.tab.apiId, { api: { mock: next } });
    props.tab.api = data.api;
    message.success('已保存');
  } catch (err) {
    // 服务端的 400（比如「请先保存一个示例」）原样提示，并把界面退回真实状态
    message.error(err.message);
    try {
      await refreshApi();
    } catch (refreshError) {
      // 拉不回来就先这样，下一次操作会再拉
    }
  }
}

/* ---------------- 示例 ---------------- */

const SOURCE_LABELS = {
  manual: { text: '手工', type: 'default' },
  recorded: { text: '录制', type: 'success' },
  imported: { text: '导入', type: 'info' }
};

async function createExample() {
  try {
    const data = await apisApi.createExample(props.tab.apiId, {
      name: '新示例',
      status: 200,
      responseType: 'json',
      headers: [],
      body: '{\n  "code": 0,\n  "msg": "ok",\n  "data": {}\n}',
      source: 'manual'
    });
    props.tab.api = data.api;
    selectedId.value = data.example.id;
    message.success('已新建示例');
  } catch (err) {
    message.error(err.message);
  }
}

async function renameExample(example) {
  const name = await prompt({ title: '重命名示例', value: example.name, confirmText: '保存' });
  if (name === null || !String(name).trim()) return;

  try {
    const data = await apisApi.updateExample(example.id, { name: String(name).trim() });
    emitSaved(data.example);
    message.success('已重命名');
  } catch (err) {
    message.error(err.message);
  }
}

async function removeExample(example) {
  dialog.error({
    title: '删除示例',
    content: '确定删除「' + example.name + '」吗？',
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async function () {
      try {
        const data = await apisApi.removeExample(example.id);
        props.tab.api = data.api;
        selectedId.value = '';
        message.success('已删除');
      } catch (err) {
        message.error(err.message);
      }
    }
  });
}

/** 编辑器自动保存后，把最新的示例并回列表里 */
function emitSaved(example) {
  const list = ((api.value && api.value.examples) || []).slice();
  const index = list.findIndex(function (item) { return item.id === example.id; });
  if (index !== -1) list[index] = example;
  if (api.value) api.value.examples = list;
}

async function useAsMock(example) {
  await patchMock({ exampleId: example.id });
}

async function copyMockUrl() {
  try {
    await navigator.clipboard.writeText(mockUrl.value);
    message.success('已复制 mock 地址');
  } catch (err) {
    message.warning('复制失败，请手动选中复制');
  }
}
</script>

<template>
  <div class="mock-panel">
    <n-empty
      v-if="!api"
      class="placeholder"
      description="临时标签页要先保存成接口，才能配置 mock"
    />

    <template v-else>
      <div class="config">
        <n-space align="center" :size="10" :wrap="false">
          <n-form-item label="启用 mock" :show-feedback="false" class="inline">
            <n-switch
              size="small"
              :value="mock.enabled"
              @update:value="(v) => patchMock({ enabled: v })"
            />
          </n-form-item>

          <n-form-item label="路径" :show-feedback="false" class="path">
            <n-input
              size="small"
              :value="draftPath"
              placeholder="/api/users"
              @update:value="(v) => { draftPath = v; }"
              @blur="draftPath !== mock.path && patchMock({ path: draftPath })"
            />
          </n-form-item>

          <n-form-item label="延迟(ms)" :show-feedback="false" class="delay">
            <n-input-number
              size="small"
              :value="mock.delay"
              :min="0"
              :max="60000"
              @update:value="(v) => patchMock({ delay: v || 0 })"
            />
          </n-form-item>

          <n-form-item label="CORS" :show-feedback="false" class="inline">
            <n-switch
              size="small"
              :value="mock.cors"
              @update:value="(v) => patchMock({ cors: v })"
            />
          </n-form-item>
        </n-space>

        <div class="url-row">
          <span class="url-label">mock 地址</span>
          <code class="url">{{ mockUrl }}</code>
          <n-button size="tiny" quaternary @click="copyMockUrl">复制</n-button>
        </div>
      </div>

      <div class="body">
        <aside class="list">
          <div class="list-head">
            <span>示例</span>
            <n-button size="tiny" quaternary type="primary" @click="createExample">新建</n-button>
          </div>

          <div class="list-body">
            <div
              v-for="example in examples"
              :key="example.id"
              class="list-item"
              :class="{ active: example.id === selectedId }"
              @click="selectedId = example.id"
            >
              <div class="item-main">
                <span class="item-name">{{ example.name }}</span>
                <n-tag
                  v-if="mock.exampleId === example.id"
                  size="tiny"
                  :bordered="false"
                  type="success"
                >
                  mock 使用中
                </n-tag>
                <n-tag
                  size="tiny"
                  :bordered="false"
                  :type="(SOURCE_LABELS[example.source] || SOURCE_LABELS.manual).type"
                >
                  {{ (SOURCE_LABELS[example.source] || SOURCE_LABELS.manual).text }}
                </n-tag>
              </div>
              <div class="item-actions">
                <n-button size="tiny" quaternary @click.stop="useAsMock(example)">设为 mock</n-button>
                <n-button size="tiny" quaternary @click.stop="renameExample(example)">改名</n-button>
                <n-button size="tiny" quaternary type="error" @click.stop="removeExample(example)">
                  删除
                </n-button>
              </div>
            </div>

            <n-empty v-if="!examples.length" size="small" description="还没有示例" />
          </div>
        </aside>

        <section class="editor">
          <example-editor
            v-if="selectedExample"
            :key="selectedExample.id"
            :example="selectedExample"
            :placeholders="(session.meta && session.meta.placeholders) || []"
            :templates="(session.meta && session.meta.templates) || []"
            @saved="emitSaved"
          />
          <n-empty v-else description="左边选一个示例，或者新建一个" />
        </section>
      </div>
    </template>
  </div>
</template>

<style scoped>
.mock-panel {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.placeholder {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

.config {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.inline {
  width: auto;
}

.path {
  flex: 1;
  min-width: 200px;
}

.delay {
  width: 160px;
}

.url-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.url-label {
  opacity: 0.6;
  flex: none;
}

.url {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  opacity: 0.85;
}

.body {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 10px;
}

.list {
  flex: none;
  width: 240px;
  border: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.24));
  border-radius: 6px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  font-size: 12px;
  opacity: 0.75;
  border-bottom: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.16));
}

.list-body {
  flex: 1;
  overflow: auto;
  padding: 4px;
}

.list-item {
  padding: 6px 8px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
}

.list-item:hover {
  background: rgba(128, 128, 128, 0.12);
}

.list-item.active {
  background: rgba(32, 128, 240, 0.14);
}

.item-main {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.item-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 120px;
}

.item-actions {
  display: none;
  gap: 2px;
  margin-top: 4px;
}

.list-item:hover .item-actions,
.list-item.active .item-actions {
  display: flex;
}

.editor {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
</style>
