<script setup>
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
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
import { useGatewayStore } from '@/stores/gateway';
import { parseCurl } from '@/utils/curl';
import { methodColor } from '@/utils/method';
import { readFileAsText } from '@/utils/download';
import ExternalImportPanel from '@/components/importExport/ExternalImportPanel.vue';

/**
 * 导入弹窗：JSON 文件（集合 / 环境）/ cURL / OpenAPI / HAR 四个页签。
 *
 * cURL 是**前端自己解析**的（`utils/curl.js`）—— 服务端那个 `/import/curl` 是给
 * 「造 mock 路由」写的，会丢请求头、丢主机端口、把 JSON 拆散，不能用来还原一次请求。
 */
const projects = useProjectStore();
const tree = useTreeStore();
const tabs = useTabsStore();
const ui = useUiStore();
const message = useMessage();
const { t } = useI18n();

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
    message.warning(t('importExport.pasteOrPickJson'));
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

    message.success(t('importExport.done'));
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

/** cURL 解析结果里「请求体 / 鉴权」那两行的取值。用 computed 包住，切语言后跟着变 */
const BODY_LABELS = computed(function () {
  return {
    none: t('importExport.none'),
    urlencoded: t('importExport.form'),
    formdata: t('importExport.form'),
    binary: t('importExport.file'),
    graphql: 'GraphQL'
  };
});

const curlBodyLabel = computed(function () {
  const result = curlResult.value;
  if (!result) return '';
  const body = result.body || {};

  if (body.mode === 'raw') {
    if (body.language === 'json') return 'JSON';
    if (body.language === 'xml') return 'XML';
    return t('importExport.text');
  }
  return BODY_LABELS.value[body.mode] || t('importExport.none');
});

const curlAuthLabel = computed(function () {
  const result = curlResult.value;
  if (!result || !result.auth) return t('importExport.none');
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
    message.warning(t('importExport.pickProjectFirst'));
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
    message.success(t('importExport.importedInto', { where: t(tree.selectedFolderId ? 'importExport.selectedFolder' : 'importExport.rootFolder') }));
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

/**
 * 三种来源（用户 2026-10-02：swagger 常常是个地址，也可能是文件）：
 * 填了地址就按地址拉（客户端里由本机去拉，内网的也行）；否则用选的文件或粘贴的文本。
 * OpenAPI / Swagger 只有 JSON 和 YAML 两种写法，没有 XML 版。
 */
const openapiUrl = ref('');
/** 网页版而且云端不发请求（SERVER_SEND=0）：云端也不替人拉地址，只能选文件或粘贴 */
const urlFetchBlocked = computed(function () { return useGatewayStore().cloudSendBlocked; });
const openapiFileInput = ref(null);
const openapiFileName = ref('');

function pickOpenapiFile() {
  if (!openapiFileInput.value) return;
  openapiFileInput.value.value = '';
  openapiFileInput.value.click();
}

async function onOpenapiFile(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  try {
    openapiText.value = await readFileAsText(file);
    openapiFileName.value = file.name;
    openapiUrl.value = '';
    openapiRoutes.value = null;
    parseOpenapi();
  } catch (err) {
    message.error(err.message);
  }
}

async function parseOpenapi() {
  const url = openapiUrl.value.trim();
  // 网页版而且云端不替人拉地址：地址输入框本来就不渲染，这里再兜一次
  // （探测回来之前先填了地址的话，输入框会被藏起来，但值还在）
  if (url && urlFetchBlocked.value) {
    message.warning(t('importExport.urlBlockedShort'));
    return;
  }
  if (!url && !openapiText.value.trim()) {
    message.warning(t('importExport.urlOrFileOrPaste'));
    return;
  }
  openapiBusy.value = true;
  try {
    const data = await importExportApi.parseOpenapi(url ? { url: url } : { text: openapiText.value });
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
    message.warning(t('importExport.pickProjectFirst'));
    return;
  }

  try {
    const data = await importExportApi.importRoutes(
      projects.currentId,
      routes,
      tree.selectedFolderId
    );
    await tree.refresh();
    // 这段提示只服务 OpenAPI 页签（importParsed 只有它在调）：导入之后最常问的就是
    // 「后端改了接口怎么办」，顺手把「从 OpenAPI 同步更新」这条路指出来
    message.success(t('importExport.importedApis', { n: (data.apis && data.apis.length) || 0 }), { duration: 8000 });
    visible.value = false;
    openapiRoutes.value = null;
    openapiText.value = '';
    openapiUrl.value = '';
    openapiFileName.value = '';
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
    message.error(t('importExport.harTooBig', { size: formatBytes(file.size) }));
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
    message.warning(t('importExport.pasteOrPickHar'));
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

    message.success(t('importExport.done'));
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
    :title="t('importExport.importAction')"
    style="width: 820px; max-width: 94vw"
  >
    <n-tabs v-model:value="activeTab" type="line" size="small" animated>
      <n-tab-pane name="postman" :tab="t('importExport.jsonFileTab')">
        <div class="pane">
          <n-space align="center" :size="8">
            <n-button size="small" @click="pickPostmanFile">{{ t('importExport.pickFile') }}</n-button>
            <template v-if="postmanFileInfo">
              <span class="hint">{{ postmanFileInfo }}</span>
              <n-button size="small" quaternary @click="clearPostmanFile">{{ t('importExport.clear') }}</n-button>
            </template>
            <span v-else class="hint">{{ t('importExport.orPasteJson') }}</span>
          </n-space>

          <!-- 选了文件就不再渲染文本框：整段文件内容塞进带 autosize 的 textarea 时，
               浏览器要把它放进 DOM，naive-ui 还会复制一份到隐藏元素去量高度 ——
               几十 MB 的文件足以让界面卡死。 -->
          <n-input
            v-if="!postmanFileInfo"
            v-model:value="postmanText"
            type="textarea"
            :autosize="{ minRows: 6, maxRows: 12 }"
            :placeholder="t('importExport.collectionPlaceholder')"
            @update:value="postmanPreview = null"
          />

          <n-space align="center" :size="8">
            <n-button size="small" secondary :loading="postmanBusy" @click="parsePostman">
              {{ t('importExport.preview') }}
            </n-button>
          </n-space>

          <template v-if="postmanPreview">
            <n-alert type="info" :show-icon="false" class="notice">
              <div>{{ t('importExport.typeLine', { type: postmanPreview.kind }) }}</div>
              <!-- 认出来的是哪种文件（第九轮第 1 节）：YApi / Apifox 的文件贴到这一页也能导，
                   这里要如实说一句，免得用户以为认错了 -->
              <div v-if="postmanPreview.format && postmanPreview.format !== 'postman'">
                {{ t('importExport.detectedLine', { format: postmanPreview.format === 'yapi' ? 'YApi' : 'Apifox' }) }}
              </div>
              <div>{{ t('importExport.nameLine', { name: postmanPreview.name }) }}</div>
              <div v-if="postmanPreview.stats">
                {{ t('importExport.stats', { folders: postmanPreview.stats.folders, apis: postmanPreview.stats.apis, examples: postmanPreview.stats.examples }) }}{{ t('importExport.statsScripts', { n: postmanPreview.stats.scripts }) }}
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
                <n-radio-button value="new">{{ t('importExport.newProjectFromCollection') }}</n-radio-button>
                <n-radio-button value="into">
                  {{ t('importExport.intoCurrent') }}{{ projects.current ? t('importExport.quoted', { name: projects.current.name }) : '' }}
                </n-radio-button>
              </n-space>
            </n-radio-group>
            <p v-else-if="postmanPreview.kind === 'collection'" class="hint">
              {{ t('importExport.readonlyHint') }}
            </p>
            <p v-else class="hint">{{ t('importExport.globalsHint') }}</p>

            <n-space justify="end" align="center">
              <n-button
                v-if="canImportPostman"
                size="small"
                type="primary"
                :loading="postmanBusy"
                @click="runPostmanImport"
              >
                {{ t('importExport.importAction') }}
              </n-button>
              <span v-else class="hint">{{ t('importExport.needEditor') }}</span>
            </n-space>
          </template>
        </div>
      </n-tab-pane>

      <!--
        YApi / Apifox（第九轮第 1 节）：两个页签用的是同一个面板 —— 流程和「JSON 文件」
        那个页签一模一样，而且**服务端会自动认格式**，所以界面上不需要各写一套。
        页签本身还是要分开：用户是从这两个工具迁过来的，得能一眼看到入口。
      -->
      <n-tab-pane name="yapi" tab="YApi">
        <external-import-panel format="yapi" />
      </n-tab-pane>

      <n-tab-pane name="apifox" tab="Apifox">
        <external-import-panel format="apifox" />
      </n-tab-pane>

      <n-tab-pane name="curl" tab="cURL">
        <div class="pane">
          <n-input
            v-model:value="curlText"
            type="textarea"
            :autosize="{ minRows: 6, maxRows: 12 }"
            :placeholder="t('importExport.curlPlaceholder')"
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
              {{ t('importExport.curlStats', { headers: curlResult.params.headers.length, query: curlResult.params.query.length, body: curlBodyLabel, auth: curlAuthLabel }) }}
            </p>

            <div v-if="curlResult.warnings.length" class="warnings">
              <div v-for="(warning, index) in curlResult.warnings" :key="index">{{ warning }}</div>
            </div>

            <n-space justify="end" align="center">
              <span class="hint">
                {{ tree.selectedFolderId ? t('importExport.intoSelected') : t('importExport.intoRoot') }}
              </span>
              <n-button size="small" @click="openCurlInTab">{{ t('importExport.openInNewTab') }}</n-button>
              <n-button
                v-if="canEdit"
                size="small"
                type="primary"
                :loading="curlOpening"
                @click="importCurlToFolder"
              >
                {{ t('importExport.intoCurrentFolder') }}
              </n-button>
            </n-space>
          </template>
        </div>
      </n-tab-pane>

      <n-tab-pane name="openapi" tab="OpenAPI">
        <div class="pane">
          <p v-if="urlFetchBlocked" class="url-blocked">
            {{ t('importExport.urlBlockedHint') }}
          </p>
          <n-input
            v-else
            v-model:value="openapiUrl"
            size="small"
            clearable
            :placeholder="t('importExport.openapiUrlPlaceholder')"
            @update:value="openapiRoutes = null"
            @keyup.enter="parseOpenapi"
          />

          <n-space align="center" :size="8">
            <n-button size="small" @click="pickOpenapiFile">{{ t('importExport.pickFile') }}</n-button>
            <span class="hint">{{ openapiFileName ? t('importExport.loaded', { name: openapiFileName }) : t('importExport.openapiFileHint') }}</span>
          </n-space>

          <n-input
            v-model:value="openapiText"
            type="textarea"
            :autosize="{ minRows: 6, maxRows: 12 }"
            :placeholder="t('importExport.openapiPastePlaceholder')"
            @update:value="openapiRoutes = null; openapiFileName = ''"
          />

          <n-space align="center" :size="8">
            <n-button size="small" secondary :loading="openapiBusy" @click="parseOpenapi">
              {{ openapiUrl.trim() ? t('importExport.fetchAndParse') : t('importExport.parse') }}
            </n-button>
            <span v-if="tree.selectedFolderId" class="hint">{{ t('importExport.intoSelectedImport') }}</span>
            <span v-else class="hint">{{ t('importExport.intoByGroup') }}</span>
          </n-space>

          <template v-if="openapiRoutes">
            <n-alert type="info" :show-icon="false" class="notice">
              {{ t('importExport.parsedCount', { n: openapiRoutes.length }) }}
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
                {{ t('importExport.importAction') }}
              </n-button>
              <span v-else class="hint">{{ t('importExport.needEditor') }}</span>
            </n-space>
          </template>
        </div>
      </n-tab-pane>
      <n-tab-pane name="har" tab="HAR">
        <div class="pane">
          <n-space align="center" :size="8">
            <n-button size="small" @click="pickHarFile">{{ t('importExport.pickFile') }}</n-button>
            <template v-if="harFileInfo">
              <span class="hint">{{ harFileInfo }}</span>
              <n-button size="small" quaternary @click="clearHarFile">{{ t('importExport.clear') }}</n-button>
            </template>
            <span v-else class="hint">{{ t('importExport.orPasteHar') }}</span>
          </n-space>

          <!-- 选了文件就不再渲染文本框，理由同 Postman 页签：HAR 常有几十 MB，
               绑到带 autosize 的 textarea 上会把界面卡死。 -->
          <n-input
            v-if="!harFileInfo"
            v-model:value="harText"
            type="textarea"
            :autosize="{ minRows: 6, maxRows: 12 }"
            :placeholder="t('importExport.harPlaceholder')"
            @update:value="harPreview = null"
          />

          <n-space align="center" :size="8">
            <n-checkbox v-model:checked="harKeepCredentials">{{ t('importExport.keepCredentials') }}</n-checkbox>
            <span v-if="harKeepCredentials" class="danger">
              {{ t('importExport.keepCredentialsWarn') }}
            </span>
          </n-space>

          <n-space align="center" :size="8">
            <n-button size="small" secondary :loading="harBusy" @click="parseHar">{{ t('importExport.preview') }}</n-button>
          </n-space>

          <template v-if="harPreview">
            <n-alert type="info" :show-icon="false" class="notice">
              <div>{{ t('importExport.typeLine', { type: 'HAR' }) }}</div>
              <div>{{ t('importExport.nameLine', { name: harPreview.name }) }}</div>
              <div v-if="harPreview.stats">
                {{ t('importExport.harStats', { hosts: harPreview.stats.hosts, apis: harPreview.stats.apis, examples: harPreview.stats.examples }) }}
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
                <n-radio-button value="new">{{ t('importExport.newProjectFromHar') }}</n-radio-button>
                <n-radio-button value="into">
                  {{ t('importExport.intoCurrent') }}{{ projects.current ? t('importExport.quoted', { name: projects.current.name }) : '' }}
                </n-radio-button>
              </n-space>
            </n-radio-group>
            <p v-else class="hint">
              {{ t('importExport.readonlyHint') }}
            </p>

            <n-space justify="end">
              <n-button size="small" type="primary" :loading="harBusy" @click="runHarImport">
                {{ t('importExport.importAction') }}
              </n-button>
            </n-space>
          </template>
        </div>
      </n-tab-pane>
    </n-tabs>

    <input ref="fileInput" type="file" accept=".json,application/json" class="hidden-input" @change="onPostmanFile" />
    <input
      ref="openapiFileInput"
      type="file"
      accept=".json,.yaml,.yml,application/json,application/yaml,text/yaml"
      class="hidden-input"
      @change="onOpenapiFile"
    />
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
.url-blocked {
  margin: 0;
  font-size: 12px;
  opacity: 0.65;
}
</style>
