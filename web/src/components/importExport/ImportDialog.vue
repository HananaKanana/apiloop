<script setup>
import { computed, ref } from 'vue';
import {
  NAlert,
  NButton,
  NInput,
  NModal,
  NRadioButton,
  NRadioGroup,
  NSpace,
  NTabPane,
  NTabs,
  useMessage
} from 'naive-ui';
import * as importExportApi from '@/api/importExport';
import { useProjectStore } from '@/stores/project';
import { useTreeStore } from '@/stores/tree';
import { useUiStore } from '@/stores/ui';
import { readFileAsText } from '@/utils/download';

/**
 * 导入弹窗：Postman / cURL / OpenAPI 三个页签。
 * Postman 先预览（不写库）再确认导入；cURL 和 OpenAPI 先解析出 routes 再落进当前项目。
 */
const projects = useProjectStore();
const tree = useTreeStore();
const ui = useUiStore();
const message = useMessage();

/** 往当前项目里写数据要 editor 及以上；只读角色只剩「新建项目」这一条路 */
const canEdit = computed(function () {
  return projects.canEdit;
});

const canImportPostman = computed(function () {
  const kind = postmanPreview.value && postmanPreview.value.kind;
  return canEdit.value || kind === 'collection';
});

const visible = computed({
  get: function () { return ui.importVisible; },
  set: function (value) { ui.importVisible = value; }
});

const activeTab = ref('postman');
const fileInput = ref(null);

/* ---------------- Postman ---------------- */

const postmanText = ref('');
const postmanPreview = ref(null);
const postmanMode = ref('new');
const postmanBusy = ref(false);

async function pickPostmanFile() {
  if (fileInput.value) {
    fileInput.value.value = '';
    fileInput.value.click();
  }
}

async function onPostmanFile(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  try {
    postmanText.value = await readFileAsText(file);
    postmanPreview.value = null;
  } catch (err) {
    message.error(err.message);
  }
}

async function parsePostman() {
  if (!postmanText.value.trim()) {
    message.warning('请粘贴 JSON，或者选择一个文件');
    return;
  }

  postmanBusy.value = true;
  try {
    postmanPreview.value = await importExportApi.previewPostman(postmanText.value);
    postmanMode.value = 'new';
  } catch (err) {
    postmanPreview.value = null;
    message.error(err.message);
  } finally {
    postmanBusy.value = false;
  }
}

async function runPostmanImport() {
  postmanBusy.value = true;
  try {
    const data = await importExportApi.importPostman(postmanText.value, {
      mode: postmanMode.value,
      projectId: postmanMode.value === 'into' ? projects.currentId : undefined
    });

    if (postmanMode.value === 'new' && data.project) {
      await projects.load();
      projects.setCurrent(data.project.id);
      await tree.load(data.project.id);
    } else {
      await tree.refresh();
    }

    message.success('导入完成');
    visible.value = false;
    postmanText.value = '';
    postmanPreview.value = null;
  } catch (err) {
    message.error(err.message);
  } finally {
    postmanBusy.value = false;
  }
}

/* ---------------- cURL / OpenAPI ---------------- */

const curlText = ref('');
const curlRoutes = ref(null);
const curlBusy = ref(false);

const openapiText = ref('');
const openapiRoutes = ref(null);
const openapiBusy = ref(false);

async function parseCurl() {
  curlBusy.value = true;
  try {
    const data = await importExportApi.parseCurl(curlText.value);
    curlRoutes.value = data.routes || [];
  } catch (err) {
    curlRoutes.value = null;
    message.error(err.message);
  } finally {
    curlBusy.value = false;
  }
}

async function parseOpenapi() {
  openapiBusy.value = true;
  try {
    const data = await importExportApi.parseOpenapi(openapiText.value);
    openapiRoutes.value = data.routes || [];
  } catch (err) {
    openapiRoutes.value = null;
    message.error(err.message);
  } finally {
    openapiBusy.value = false;
  }
}

async function importParsed(routes) {
  if (!projects.currentId) {
    message.warning('先选一个项目');
    return;
  }

  try {
    const data = await importExportApi.importRoutes(
      projects.currentId,
      routes,
      tree.selectedFolderId
    );
    await tree.refresh();
    message.success('已导入 ' + ((data.apis && data.apis.length) || 0) + ' 个接口');
    visible.value = false;
    curlRoutes.value = null;
    openapiRoutes.value = null;
    curlText.value = '';
    openapiText.value = '';
  } catch (err) {
    message.error(err.message);
  }
}

function routeLabel(route) {
  return (route.method || 'GET') + ' ' + (route.path || route.url || route.name || '');
}
</script>

<template>
  <n-modal
    v-model:show="visible"
    preset="card"
    title="导入"
    style="width: 820px; max-width: 94vw"
  >
    <n-tabs v-model:value="activeTab" type="line" size="small" animated>
      <n-tab-pane name="postman" tab="Postman">
        <div class="pane">
          <n-space align="center" :size="8">
            <n-button size="small" @click="pickPostmanFile">选择文件…</n-button>
            <span class="hint">或者直接把 JSON 粘在下面</span>
          </n-space>

          <n-input
            v-model:value="postmanText"
            type="textarea"
            :autosize="{ minRows: 6, maxRows: 12 }"
            placeholder="Postman Collection / Environment / Globals 的 JSON"
            @update:value="postmanPreview = null"
          />

          <n-space align="center" :size="8">
            <n-button size="small" secondary :loading="postmanBusy" @click="parsePostman">
              解析预览
            </n-button>
          </n-space>

          <template v-if="postmanPreview">
            <n-alert type="info" :show-icon="false" class="notice">
              <div>类型：{{ postmanPreview.kind }}</div>
              <div>名称：{{ postmanPreview.name }}</div>
              <div v-if="postmanPreview.stats">
                目录 {{ postmanPreview.stats.folders }} 个、接口 {{ postmanPreview.stats.apis }} 个、
                示例 {{ postmanPreview.stats.examples }} 个、脚本 {{ postmanPreview.stats.scripts }} 个
              </div>
            </n-alert>

            <n-alert
              v-for="(warning, index) in postmanPreview.warnings || []"
              :key="index"
              type="warning"
              :show-icon="false"
              class="notice"
            >
              {{ warning }}
            </n-alert>

            <n-radio-group
              v-if="postmanPreview.kind === 'collection' && canEdit"
              v-model:value="postmanMode"
            >
              <n-space vertical size="small">
                <n-radio-button value="new">新建项目（名字取集合名）</n-radio-button>
                <n-radio-button value="into">
                  导入到当前项目{{ projects.current ? '「' + projects.current.name + '」' : '' }}
                </n-radio-button>
              </n-space>
            </n-radio-group>
            <p v-else-if="postmanPreview.kind === 'collection'" class="hint">
              当前角色是只读，只能导入成新项目（导入后你就是它的 owner）。
            </p>
            <p v-else class="hint">环境与 Globals 会导入到当前项目。</p>

            <n-space justify="end" align="center">
              <n-button
                v-if="canImportPostman"
                size="small"
                type="primary"
                :loading="postmanBusy"
                @click="runPostmanImport"
              >
                导入
              </n-button>
              <span v-else class="hint">导入到当前项目需要 editor 及以上权限。</span>
            </n-space>
          </template>
        </div>
      </n-tab-pane>

      <n-tab-pane name="curl" tab="cURL">
        <div class="pane">
          <n-input
            v-model:value="curlText"
            type="textarea"
            :autosize="{ minRows: 6, maxRows: 12 }"
            placeholder="把浏览器的 Copy as cURL 粘到这里"
            @update:value="curlRoutes = null"
          />

          <n-space align="center" :size="8">
            <n-button size="small" secondary :loading="curlBusy" @click="parseCurl">解析</n-button>
            <span v-if="tree.selectedFolderId" class="hint">会导入到目录树里选中的目录</span>
            <span v-else class="hint">没有选中目录，会按分组建顶层目录</span>
          </n-space>

          <template v-if="curlRoutes">
            <n-alert type="info" :show-icon="false" class="notice">
              解析出 {{ curlRoutes.length }} 个接口
            </n-alert>
            <div class="routes">
              <div v-for="(route, index) in curlRoutes" :key="index" class="route">
                {{ routeLabel(route) }}
              </div>
            </div>
            <n-space justify="end" align="center">
              <n-button
                v-if="canEdit"
                size="small"
                type="primary"
                @click="importParsed(curlRoutes)"
              >
                导入
              </n-button>
              <span v-else class="hint">导入到当前项目需要 editor 及以上权限。</span>
            </n-space>
          </template>
        </div>
      </n-tab-pane>

      <n-tab-pane name="openapi" tab="OpenAPI">
        <div class="pane">
          <n-input
            v-model:value="openapiText"
            type="textarea"
            :autosize="{ minRows: 6, maxRows: 12 }"
            placeholder="粘贴 OpenAPI / Swagger 定义（JSON 或 YAML）"
            @update:value="openapiRoutes = null"
          />

          <n-space align="center" :size="8">
            <n-button size="small" secondary :loading="openapiBusy" @click="parseOpenapi">解析</n-button>
            <span v-if="tree.selectedFolderId" class="hint">会导入到目录树里选中的目录</span>
            <span v-else class="hint">没有选中目录，会按分组建顶层目录</span>
          </n-space>

          <template v-if="openapiRoutes">
            <n-alert type="info" :show-icon="false" class="notice">
              解析出 {{ openapiRoutes.length }} 个接口
            </n-alert>
            <div class="routes">
              <div v-for="(route, index) in openapiRoutes" :key="index" class="route">
                {{ routeLabel(route) }}
              </div>
            </div>
            <n-space justify="end" align="center">
              <n-button
                v-if="canEdit"
                size="small"
                type="primary"
                @click="importParsed(openapiRoutes)"
              >
                导入
              </n-button>
              <span v-else class="hint">导入到当前项目需要 editor 及以上权限。</span>
            </n-space>
          </template>
        </div>
      </n-tab-pane>
    </n-tabs>

    <input ref="fileInput" type="file" accept=".json,application/json" class="hidden-input" @change="onPostmanFile" />
  </n-modal>
</template>

<style scoped>
.pane {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-top: 4px;
}

.hint {
  font-size: 12px;
  opacity: 0.6;
}

.notice {
  font-size: 12px;
}

.routes {
  max-height: 220px;
  overflow: auto;
  border: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.24));
  border-radius: 6px;
  padding: 6px 10px;
}

.route {
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  padding: 2px 0;
}

.hidden-input {
  display: none;
}
</style>
