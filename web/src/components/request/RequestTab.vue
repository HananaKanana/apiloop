<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  NButton,
  NForm,
  NFormItem,
  NInput,
  NModal,
  NSelect,
  NSpace,
  NTabPane,
  NTabs,
  useMessage
} from 'naive-ui';
import { useProjectStore } from '@/stores/project';
import { useEnvStore } from '@/stores/env';
import { useTabsStore, specFromApi } from '@/stores/tabs';
import { useTreeStore } from '@/stores/tree';
import * as apisApi from '@/api/apis';
import KeyValueTable from '@/components/common/KeyValueTable.vue';
import UrlBar from './UrlBar.vue';
import BodyEditor from './BodyEditor.vue';
import AuthEditor from './AuthEditor.vue';
import ScriptsView from './ScriptsView.vue';
import ResponsePanel from '@/components/response/ResponsePanel.vue';

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
const message = useMessage();

const activePane = ref('params');
const saving = ref(false);
const savingExample = ref(false);
const showSaveDialog = ref(false);
const saveForm = ref({ name: '', folderId: null });

const spec = computed(function () {
  return props.tab.spec;
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

function encodePart(text) {
  return encodeURIComponent(String(text === null || text === undefined ? '' : text));
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
    return encodePart(row.key) + '=' + encodePart(row.value);
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
      name: props.tab.spec.url || '新建接口',
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

async function saveExample() {
  const response = props.tab.result && props.tab.result.response;
  if (!response || !props.tab.apiId) return;

  savingExample.value = true;
  try {
    const data = await apisApi.createExample(props.tab.apiId, {
      name: response.status + ' 录制于 ' + stamp(),
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
      body: response.body,
      responseType: guessResponseType(response.headers),
      source: 'recorded'
    });

    props.tab.api = data.api;
    message.success('已存为示例');
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
  save();
}

onMounted(function () {
  window.addEventListener('keydown', onKeydown);
});

onBeforeUnmount(function () {
  window.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <div class="request-tab">
    <div class="head">
      <url-bar
        :method="spec.method"
        :url="spec.url"
        :sending="tab.sending"
        @update:method="(v) => { spec.method = v; }"
        @update:url="onUrlChange"
        @send="onSend"
        @cancel="onCancel"
      />

      <n-space align="center" :size="6">
        <n-button size="small" :loading="saving" @click="save">
          {{ tab.apiId ? '保存' : '另存为' }}
        </n-button>
      </n-space>
    </div>

    <div class="panes">
      <n-tabs v-model:value="activePane" type="line" size="small" animated>
        <n-tab-pane name="params" tab="Params">
          <div class="pane">
            <p class="label">查询参数</p>
            <key-value-table
              :model-value="spec.params.query"
              key-placeholder="参数名"
              @update:model-value="onQueryChange"
            />

            <p class="label">路径参数</p>
            <key-value-table
              v-model="spec.params.path"
              key-placeholder="参数名"
              value-placeholder="值"
            />
          </div>
        </n-tab-pane>

        <n-tab-pane name="headers" tab="Headers">
          <div class="pane">
            <key-value-table
              v-model="spec.params.headers"
              key-placeholder="请求头"
              value-placeholder="值"
            />
          </div>
        </n-tab-pane>

        <n-tab-pane name="body" tab="Body">
          <div class="pane">
            <body-editor :spec="spec" :project-id="projects.currentId" />
          </div>
        </n-tab-pane>

        <n-tab-pane name="auth" tab="Auth">
          <div class="pane narrow">
            <auth-editor
              :model-value="spec.auth"
              @update:model-value="(v) => { spec.auth = v; }"
            />
          </div>
        </n-tab-pane>

        <n-tab-pane name="scripts" tab="Scripts">
          <div class="pane">
            <scripts-view :scripts="(tab.api && tab.api.scripts) || []" />
          </div>
        </n-tab-pane>
      </n-tabs>
    </div>

    <div class="response">
      <response-panel
        :tab="tab"
        :saving-example="savingExample"
        @save-example="saveExample"
      />
    </div>

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
  padding: 8px;
  border-bottom: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.16));
}

.head > :first-child {
  flex: 1;
  min-width: 0;
}

.panes {
  flex: 0 0 auto;
  max-height: 46%;
  overflow: auto;
  border-bottom: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.16));
}

.pane {
  padding: 8px 2px;
}

.pane.narrow {
  max-width: 460px;
}

.label {
  margin: 0 0 6px;
  font-size: 12px;
  opacity: 0.65;
}

.pane .label + * {
  margin-bottom: 14px;
}

.response {
  flex: 1;
  min-height: 0;
  padding: 8px;
  display: flex;
  flex-direction: column;
}
</style>
