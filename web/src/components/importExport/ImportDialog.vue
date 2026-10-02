<script setup>
import { computed, ref, watch } from 'vue';
import {
  NAlert,
  NButton,
  NCheckbox,
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
import { useTabsStore } from '@/stores/tabs';
import { useUiStore } from '@/stores/ui';
import { parseCurl } from '@/utils/curl';
import { methodColor } from '@/utils/method';
import { readFileAsText } from '@/utils/download';

/**
 * 导入弹窗：Postman / cURL / OpenAPI / HAR 四个页签。
 *
 * cURL 是**前端自己解析**的（`utils/curl.js`）—— 服务端那个 `/import/curl` 是给
 * 「造 mock 路由」写的，会丢请求头、丢主机端口、把 JSON 拆散，不能用来还原一次请求。
 */
const projects = useProjectStore();
const tree = useTreeStore();
const tabs = useTabsStore();
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

/**
 * 从文件读进来的内容**放在普通变量里，不进 ref**。
 *
 * 原因：它同时绑在带 `autosize` 的 textarea 上时，浏览器要把整段文本塞进 DOM，
 * naive-ui 还会复制一份到隐藏元素去量高度 —— 几十 MB 的 HAR 会让界面卡死。
 * 所以选了文件就只显示「文件名（大小）」+ 清除，文本框只留给粘贴用。
 */
let postmanFileText = null;

const postmanText = ref('');
const postmanFileInfo = ref('');
const postmanPreview = ref(null);
const postmanMode = ref('new');
const postmanBusy = ref(false);

/** 发送时取「文件内容」或「粘贴的内容」，两者只有一个会有值 */
function postmanPayload() {
  return postmanFileText === null ? postmanText.value : postmanFileText;
}

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
    postmanFileText = await readFileAsText(file);
    postmanFileInfo.value = file.name;
    postmanText.value = '';
    postmanPreview.value = null;
  } catch (err) {
    message.error(err.message);
  }
}

function clearPostmanFile() {
  postmanFileText = null;
  postmanFileInfo.value = '';
  postmanPreview.value = null;
}

async function parsePostman() {
  if (!postmanPayload().trim()) {
    message.warning('请粘贴 JSON，或者选择一个文件');
    return;
  }

  postmanBusy.value = true;
  try {
    postmanPreview.value = await importExportApi.previewPostman(postmanPayload());
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
    const data = await importExportApi.importPostman(postmanPayload(), {
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
    clearPostmanFile();
    postmanText.value = '';
  } catch (err) {
    message.error(err.message);
  } finally {
    postmanBusy.value = false;
  }
}

/* ---------------- cURL ---------------- */

/** 停止输入 300ms 后自动解析 */
const CURL_PARSE_DELAY = 300;

const curlText = ref('');
const curlResult = ref(null);
const curlError = ref('');
const curlOpening = ref(false);

let curlTimer = null;

const BODY_LABELS = {
  none: '无',
  urlencoded: '表单',
  formdata: '表单',
  binary: '文件',
  graphql: 'GraphQL'
};

const curlBodyLabel = computed(function () {
  const result = curlResult.value;
  if (!result) return '';
  const body = result.body || {};

  if (body.mode === 'raw') {
    if (body.language === 'json') return 'JSON';
    if (body.language === 'xml') return 'XML';
    return '文本';
  }
  return BODY_LABELS[body.mode] || '无';
});

const curlAuthLabel = computed(function () {
  const result = curlResult.value;
  if (!result || !result.auth) return '无';
  return result.auth.type === 'basic' ? 'Basic' : String(result.auth.type);
});

function runCurlParse(text) {
  try {
    curlResult.value = parseCurl(text);
    curlError.value = '';
  } catch (err) {
    // 解析失败只在这里说，不弹全局报错 —— 用户还在打字，弹窗是噪音
    curlResult.value = null;
    curlError.value = err.message;
  }
}

watch(curlText, function (value) {
  if (curlTimer) clearTimeout(curlTimer);
  curlResult.value = null;
  curlError.value = '';

  const text = String(value || '').trim();
  if (!text) return;
  curlTimer = setTimeout(function () { runCurlParse(text); }, CURL_PARSE_DELAY);
});

/** 解析结果 → RequestSpec */
function curlSpec(result) {
  return {
    method: result.method,
    url: result.url,
    params: result.params,
    body: result.body,
    auth: result.auth,
    scripts: []
  };
}

function resetCurl() {
  curlText.value = '';
  curlResult.value = null;
  curlError.value = '';
}

/** 在新标签页打开：只填内容，不写库，用户自己决定要不要保存 */
function openCurlInTab() {
  const result = curlResult.value;
  if (!result) return;

  const tab = tabs.openDraft(tree.selectedFolderId, curlSpec(result));
  if (tab) tab.title = result.name;

  visible.value = false;
  resetCurl();
}

/** 导入到当前目录：直接建成接口，然后打开它 */
async function importCurlToFolder() {
  const result = curlResult.value;
  if (!result) return;
  if (!projects.currentId) {
    message.warning('先选一个项目');
    return;
  }

  curlOpening.value = true;
  try {
    const api = await tree.createApi(Object.assign(curlSpec(result), {
      name: result.name,
      folderId: tree.selectedFolderId
    }));

    visible.value = false;
    resetCurl();
    await tabs.openApi(api.id);
    message.success('已导入到' + (tree.selectedFolderId ? '选中的目录' : '根目录'));
  } catch (err) {
    message.error(err.message);
  } finally {
    curlOpening.value = false;
  }
}

/* ---------------- OpenAPI ---------------- */

const openapiText = ref('');
const openapiRoutes = ref(null);
const openapiBusy = ref(false);

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
    openapiRoutes.value = null;
    openapiText.value = '';
  } catch (err) {
    message.error(err.message);
  }
}

/* ---------------- HAR ---------------- */

/** 服务端给 /import/har 放宽到 50MB；比这更大的就不发了，省得白传一趟 */
const HAR_MAX_BYTES = 50 * 1024 * 1024;

/**
 * 从文件读进来的 HAR 文本**放在普通变量里，不进 ref**（理由见上面 Postman 那段）：
 * 几十 MB 的文本一旦绑到带 autosize 的 textarea 上，界面就会卡死。
 * 选中文件之后文本框整个隐藏，只显示「文件名（大小）」和清除按钮。
 */
let harFileText = null;

const harText = ref('');
const harFileInfo = ref('');
const harPreview = ref(null);
const harMode = ref('new');
const harBusy = ref(false);
const harKeepCredentials = ref(false);
const harFileInput = ref(null);

/** 发送时取「文件内容」或「粘贴的内容」，两者只有一个会有值 */
function harPayload() {
  return harFileText === null ? harText.value : harFileText;
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

function pickHarFile() {
  if (harFileInput.value) {
    harFileInput.value.value = '';
    harFileInput.value.click();
  }
}

async function onHarFile(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  if (file.size > HAR_MAX_BYTES) {
    harFileInfo.value = '';
    message.error('这个 HAR 有 ' + formatBytes(file.size) + '，超过了 50MB 的上限');
    return;
  }

  try {
    // FileReader 直接读成文本。**不要先 parse 成对象再序列化一遍** ——
    // 几十 MB 的对象走一遍 JSON.stringify 会明显卡住界面，而那份对象没有任何用处。
    harFileText = await readFileAsText(file);
    harFileInfo.value = file.name + '（' + formatBytes(file.size) + '）';
    harText.value = '';
    harPreview.value = null;
  } catch (err) {
    message.error(err.message);
  }
}

function clearHarFile() {
  harFileText = null;
  harFileInfo.value = '';
  harPreview.value = null;
}

async function parseHar() {
  if (!harPayload().trim()) {
    message.warning('请粘贴 HAR 内容，或者选择一个文件');
    return;
  }

  harBusy.value = true;
  try {
    harPreview.value = await importExportApi.previewHar(harPayload(), {
      keepCredentials: harKeepCredentials.value
    });
    harMode.value = 'new';
  } catch (err) {
    harPreview.value = null;
    message.error(err.message);
  } finally {
    harBusy.value = false;
  }
}

function resetHar() {
  harFileText = null;
  harText.value = '';
  harFileInfo.value = '';
  harPreview.value = null;
}

async function runHarImport() {
  harBusy.value = true;
  try {
    const data = await importExportApi.importHar(harPayload(), {
      mode: harMode.value,
      projectId: harMode.value === 'into' ? projects.currentId : undefined,
      options: { keepCredentials: harKeepCredentials.value }
    });

    if (harMode.value === 'new' && data.project) {
      await projects.load();
      projects.setCurrent(data.project.id);
      await tree.load(data.project.id);
    } else {
      await tree.refresh();
    }

    message.success('导入完成');
    visible.value = false;
    resetHar();
  } catch (err) {
    message.error(err.message);
  } finally {
    harBusy.value = false;
  }
}

// 「保留凭据」一改，stats.credentialsStripped 就不一样了，已经预览过的要重新预览一次
watch(harKeepCredentials, function () {
  if (harPreview.value) parseHar();
});

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
      <n-tab-pane name="postman" tab="JSON 文件">
        <div class="pane">
          <n-space align="center" :size="8">
            <n-button size="small" @click="pickPostmanFile">选择文件…</n-button>
            <template v-if="postmanFileInfo">
              <span class="hint">{{ postmanFileInfo }}</span>
              <n-button size="small" quaternary @click="clearPostmanFile">清除</n-button>
            </template>
            <span v-else class="hint">或者直接把 JSON 粘在下面</span>
          </n-space>

          <!-- 选了文件就不再渲染文本框：整段文件内容塞进带 autosize 的 textarea 时，
               浏览器要把它放进 DOM，naive-ui 还会复制一份到隐藏元素去量高度 ——
               几十 MB 的文件足以让界面卡死。 -->
          <n-input
            v-if="!postmanFileInfo"
            v-model:value="postmanText"
            type="textarea"
            :autosize="{ minRows: 6, maxRows: 12 }"
            placeholder="粘贴集合、环境或全局变量的 JSON（Collection v2.1 格式）"
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
            placeholder="把浏览器的 Copy as cURL 粘到这里，粘完自动解析"
          />

          <!-- 解析失败只在这里说一句，不弹全局报错：用户可能还在打字 -->
          <p v-if="curlError" class="curl-error">{{ curlError }}</p>

          <template v-if="curlResult">
            <div class="curl-line">
              <span class="curl-method" :style="{ color: methodColor(curlResult.method) }">
                {{ curlResult.method }}
              </span>
              <span class="curl-url">{{ curlResult.url }}</span>
            </div>

            <p class="hint">
              请求头 {{ curlResult.params.headers.length }} 个 ·
              查询参数 {{ curlResult.params.query.length }} 个 ·
              请求体：{{ curlBodyLabel }} ·
              鉴权：{{ curlAuthLabel }}
            </p>

            <div v-if="curlResult.warnings.length" class="warnings">
              <div v-for="(warning, index) in curlResult.warnings" :key="index">{{ warning }}</div>
            </div>

            <n-space justify="end" align="center">
              <span class="hint">
                {{ tree.selectedFolderId ? '会落到目录树里选中的目录' : '没有选中目录，会落到根目录' }}
              </span>
              <n-button size="small" @click="openCurlInTab">在新标签页打开</n-button>
              <n-button
                v-if="canEdit"
                size="small"
                type="primary"
                :loading="curlOpening"
                @click="importCurlToFolder"
              >
                导入到当前目录
              </n-button>
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
      <n-tab-pane name="har" tab="HAR">
        <div class="pane">
          <n-space align="center" :size="8">
            <n-button size="small" @click="pickHarFile">选择文件…</n-button>
            <template v-if="harFileInfo">
              <span class="hint">{{ harFileInfo }}</span>
              <n-button size="small" quaternary @click="clearHarFile">清除</n-button>
            </template>
            <span v-else class="hint">或者直接把 JSON 粘在下面（50MB 以内）</span>
          </n-space>

          <!-- 选了文件就不再渲染文本框，理由同 Postman 页签：HAR 常有几十 MB，
               绑到带 autosize 的 textarea 上会把界面卡死。 -->
          <n-input
            v-if="!harFileInfo"
            v-model:value="harText"
            type="textarea"
            :autosize="{ minRows: 6, maxRows: 12 }"
            placeholder="浏览器开发者工具 Network 面板 → 右键 Save all as HAR with content"
            @update:value="harPreview = null"
          />

          <n-space align="center" :size="8">
            <n-checkbox v-model:checked="harKeepCredentials">保留凭据</n-checkbox>
            <span v-if="harKeepCredentials" class="danger">
              Cookie、Authorization 会原样写进项目，项目里的所有成员都能看到
            </span>
          </n-space>

          <n-space align="center" :size="8">
            <n-button size="small" secondary :loading="harBusy" @click="parseHar">解析预览</n-button>
          </n-space>

          <template v-if="harPreview">
            <n-alert type="info" :show-icon="false" class="notice">
              <div>类型：HAR</div>
              <div>名称：{{ harPreview.name }}</div>
              <div v-if="harPreview.stats">
                主机 {{ harPreview.stats.hosts }} 个、接口 {{ harPreview.stats.apis }} 个、
                示例 {{ harPreview.stats.examples }} 个
              </div>
            </n-alert>

            <n-alert
              v-for="(warning, index) in harPreview.warnings || []"
              :key="index"
              type="warning"
              :show-icon="false"
              class="notice"
            >
              {{ warning }}
            </n-alert>

            <n-radio-group v-if="canEdit" v-model:value="harMode">
              <n-space vertical size="small">
                <n-radio-button value="new">新建项目（名字取 HAR 里的页面标题）</n-radio-button>
                <n-radio-button value="into">
                  导入到当前项目{{ projects.current ? '「' + projects.current.name + '」' : '' }}
                </n-radio-button>
              </n-space>
            </n-radio-group>
            <p v-else class="hint">
              当前角色是只读，只能导入成新项目（导入后你就是它的 owner）。
            </p>

            <n-space justify="end">
              <n-button size="small" type="primary" :loading="harBusy" @click="runHarImport">
                导入
              </n-button>
            </n-space>
          </template>
        </div>
      </n-tab-pane>
    </n-tabs>

    <input ref="fileInput" type="file" accept=".json,application/json" class="hidden-input" @change="onPostmanFile" />
    <input
      ref="harFileInput"
      type="file"
      accept=".har,application/json"
      class="hidden-input"
      @change="onHarFile"
    />
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

/* 「保留凭据」的后果要用警告色写出来，别让人顺手就勾了 */
.danger {
  font-size: 12px;
  color: #d03050;
}

.notice {
  font-size: 12px;
}

/* cURL 预览：方法带色 + 完整地址，和地址栏一个观感 */
.curl-line {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.curl-method {
  flex: none;
  font-size: 12px;
  font-weight: 700;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.curl-url {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  word-break: break-all;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

/* 解析失败：一行红字，不打断输入 */
.curl-error {
  margin: 0;
  font-size: 12px;
  color: #d03050;
}

/* 跳过的参数：灰色小字，说明一下就好，别抢眼 */
.warnings {
  font-size: 12px;
  opacity: 0.55;
  line-height: 1.7;
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
