<script setup>
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  NAlert,
  NButton,
  NCheckbox,
  NIcon,
  NInput,
  NModal,
  NRadioButton,
  NRadioGroup,
  NSpace,
  useMessage
} from 'naive-ui';
import { ChevronDown, ChevronRight } from '@vicons/tabler';
import * as openapiApi from '@/api/openapi';
import { useTreeStore } from '@/stores/tree';
import { useGatewayStore } from '@/stores/gateway';
import { methodColor } from '@/utils/method';

/**
 * 「从 OpenAPI 同步更新」弹窗（第四轮第 3 节）。
 *
 * 后端用 Swagger 维护接口、接口一改，以前只能整个重新导入（重复出一套，或者把自己写的
 * 脚本 / 示例 / Mock 覆盖掉）。这里列出三组让人挑：**只更新变了的部分**。
 *
 * 弹窗自己**不判断怎么合并** —— 那是服务端 `lib/openapi-sync.js` 的事，「检查更新」和
 * 「同步所选」用的是同一份计算。这里只负责勾选和显示；同步时只把「选了哪些」发回去，
 * 服务端会重新拉一次重新算一次（中间文档可能又变了）。
 */
const props = defineProps({
  show: { type: Boolean, default: false },
  pid: { type: String, default: '' },
  /** 空 = 整个项目 */
  folderId: { type: String, default: null },
  /** 范围的名字（目录名），只用来显示 */
  folderName: { type: String, default: '' }
});

const emit = defineEmits(['update:show']);

const tree = useTreeStore();
const message = useMessage();
const { t } = useI18n();

const show = computed({
  get: function () { return props.show; },
  set: function (value) { emit('update:show', value); }
});

/** 地址 / 粘贴内容两种来源 */
const mode = ref('url');
/** 网页版而且云端不发请求（SERVER_SEND=0）：云端也不替人拉地址，只能粘贴 */
const urlFetchBlocked = computed(function () { return useGatewayStore().cloudSendBlocked; });
const url = ref('');
const text = ref('');

const checking = ref(false);
const applying = ref(false);
const errorText = ref('');
/** 服务端算出来的三组（null = 还没检查过） */
const diff = ref(null);

/** 勾选：新增按 route key，改动 / 删除按接口 id */
const selected = ref({ added: [], changed: [], removed: [] });
/** 展开了前后对比的那几行 */
const expanded = ref([]);

const scopeText = computed(function () {
  return props.folderId
    ? t('openapi.scopeFolder', { name: props.folderName })
    : t('openapi.scopeProject');
});

const isEmpty = computed(function () {
  const data = diff.value;
  if (!data) return false;
  return !data.added.length && !data.changed.length && !data.removed.length;
});

/**
 * 「记住上次用的地址」：按项目 + 范围存一份在浏览器里（服务端也记了一份，
 * 换台电脑打开时 `检查更新` 不带地址也能用 —— 见 lib/api/openapi.js 的注释）。
 */
function storageKey() {
  return 'apiloop.openapi.url.' + props.pid + '.' + (props.folderId || 'root');
}

function readSavedUrl() {
  try {
    return localStorage.getItem(storageKey()) || '';
  } catch (err) {
    return '';
  }
}

function saveUrl(value) {
  try {
    if (value) localStorage.setItem(storageKey(), value);
    else localStorage.removeItem(storageKey());
  } catch (err) {
    // 存不下就这次会话里用，不影响功能
  }
}

// 每次打开都回到初始态：上次的勾选和结果不该带到下一次
watch(
  function () { return props.show; },
  function (value) {
    if (!value) return;
    mode.value = urlFetchBlocked.value ? 'text' : 'url';
    url.value = readSavedUrl();
    text.value = '';
    checking.value = false;
    applying.value = false;
    errorText.value = '';
    diff.value = null;
    selected.value = { added: [], changed: [], removed: [] };
    expanded.value = [];
  }
);

function payload() {
  const body = { folderId: props.folderId || null };
  if (mode.value === 'url' && url.value.trim()) body.url = url.value.trim();
  if (mode.value === 'text' && text.value.trim()) body.text = text.value;
  return body;
}

async function check() {
  if (!props.pid) return;
  // 网页版而且云端不替人拉地址：「地址」那一栏本来就被禁掉了，这里再兜一次
  // （探测回来之前先切到「地址」的话，模式还停在 url）
  if (mode.value === 'url' && urlFetchBlocked.value) {
    message.warning(t('openapi.urlBlockedCheck'));
    return;
  }
  if (mode.value === 'url' && !url.value.trim() && !readSavedUrl()) {
    message.warning(t('openapi.urlRequired'));
    return;
  }
  if (mode.value === 'text' && !text.value.trim()) {
    message.warning(t('openapi.textRequired'));
    return;
  }

  checking.value = true;
  errorText.value = '';
  try {
    const data = await openapiApi.diffOpenapi(props.pid, payload());
    diff.value = {
      added: data.added || [],
      changed: data.changed || [],
      removed: data.removed || []
    };
    // 默认：新增和有改动全勾，删除一个都不勾（删东西要人主动选）
    selected.value = {
      added: diff.value.added.map(function (item) { return item.key; }),
      changed: diff.value.changed.map(function (item) { return item.apiId; }),
      removed: []
    };
    expanded.value = [];
    if (data.source && data.source.url) {
      url.value = data.source.url;
      saveUrl(data.source.url);
    }
  } catch (err) {
    diff.value = null;
    errorText.value = err.message;
  } finally {
    checking.value = false;
  }
}

function selectedCount() {
  return selected.value.added.length + selected.value.changed.length + selected.value.removed.length;
}

async function apply() {
  if (!selectedCount()) {
    message.warning(t('openapi.nothingSelected'));
    return;
  }

  applying.value = true;
  errorText.value = '';
  try {
    const data = await openapiApi.applyOpenapi(props.pid, Object.assign(payload(), {
      add: selected.value.added,
      update: selected.value.changed,
      remove: selected.value.removed
    }));

    message.success(t('openapi.applyResult', {
      added: data.added || 0,
      updated: data.updated || 0,
      removed: data.removed || 0
    }));
    await tree.refresh();
    show.value = false;
  } catch (err) {
    errorText.value = err.message;
  } finally {
    applying.value = false;
  }
}

/* ---------------- 勾选 ---------------- */

function isChecked(group, key) {
  return selected.value[group].indexOf(key) > -1;
}

function setChecked(group, key, value) {
  const list = selected.value[group].slice();
  const at = list.indexOf(key);
  if (value && at === -1) list.push(key);
  if (!value && at > -1) list.splice(at, 1);
  selected.value = Object.assign({}, selected.value, { [group]: list });
}

function groupKeys(group) {
  const data = diff.value;
  if (!data) return [];
  if (group === 'added') return data.added.map(function (item) { return item.key; });
  if (group === 'changed') return data.changed.map(function (item) { return item.apiId; });
  return data.removed.map(function (item) { return item.apiId; });
}

function allChecked(group) {
  const keys = groupKeys(group);
  return keys.length > 0 && selected.value[group].length === keys.length;
}

function toggleGroup(group, value) {
  selected.value = Object.assign({}, selected.value, { [group]: value ? groupKeys(group) : [] });
}

function toggleExpand(key) {
  const list = expanded.value.slice();
  const at = list.indexOf(key);
  if (at === -1) list.push(key);
  else list.splice(at, 1);
  expanded.value = list;
}

/** 一行改动在收起来时显示的那句话：「地址；参数：新增 page」 */
function changeSummary(item) {
  return (item.changes || []).map(function (change) {
    return change.label + (change.summary ? '：' + change.summary : '');
  }).join('；');
}
</script>

<template>
  <n-modal
    v-model:show="show"
    preset="card"
    :title="t('openapi.dialogTitle')"
    style="width: 780px; max-width: 94vw"
  >
    <div class="scope">{{ t('openapi.scope', { scope: scopeText }) }}</div>

    <n-radio-group v-model:value="mode" size="small" class="mode">
      <n-radio-button value="url" :disabled="urlFetchBlocked">{{ t('openapi.modeUrl') }}</n-radio-button>
      <n-radio-button value="text">{{ t('openapi.modeText') }}</n-radio-button>
    </n-radio-group>

    <p v-if="urlFetchBlocked" class="url-blocked">
      {{ t('openapi.urlBlockedHint') }}
    </p>
    <n-input
      v-if="mode === 'url'"
      v-model:value="url"
      size="small"
      clearable
      :placeholder="t('openapi.urlPlaceholder')"
      @keyup.enter="check"
    />
    <n-input
      v-else
      v-model:value="text"
      type="textarea"
      :autosize="{ minRows: 5, maxRows: 10 }"
      :placeholder="t('openapi.textPlaceholder')"
    />

    <n-space align="center" :size="10" class="actions">
      <n-button size="small" type="primary" :loading="checking" @click="check">
        {{ t('openapi.check') }}
      </n-button>
      <span class="hint">{{ t('openapi.urlRemembered') }}</span>
    </n-space>

    <n-alert v-if="errorText" type="error" :show-icon="false" class="notice">
      {{ errorText }}
    </n-alert>

    <template v-if="diff">
      <p v-if="isEmpty" class="latest">{{ t('openapi.upToDate') }}</p>

      <template v-else>
        <!-- 新增 -->
        <section v-if="diff.added.length" class="group">
          <div class="group-head">
            <n-checkbox
              :checked="allChecked('added')"
              @update:checked="(value) => toggleGroup('added', value)"
            />
            <span class="group-title">{{ t('openapi.groupAdded', { n: diff.added.length }) }}</span>
          </div>
          <div v-for="item in diff.added" :key="item.key" class="row">
            <n-checkbox
              :checked="isChecked('added', item.key)"
              @update:checked="(value) => setChecked('added', item.key, value)"
            />
            <span class="method" :style="{ color: methodColor(item.method) }">{{ item.method }}</span>
            <span class="path">{{ item.path }}</span>
            <span class="name">{{ item.name || t('openapi.unnamed') }}</span>
            <span class="where">→ {{ item.folderName || t('openapi.rootFolder') }}</span>
          </div>
        </section>

        <!-- 有改动 -->
        <section v-if="diff.changed.length" class="group">
          <div class="group-head">
            <n-checkbox
              :checked="allChecked('changed')"
              @update:checked="(value) => toggleGroup('changed', value)"
            />
            <span class="group-title">{{ t('openapi.groupChanged', { n: diff.changed.length }) }}</span>
          </div>
          <div v-for="item in diff.changed" :key="item.apiId" class="row-wrap">
            <div class="row">
              <n-checkbox
                :checked="isChecked('changed', item.apiId)"
                @update:checked="(value) => setChecked('changed', item.apiId, value)"
              />
              <n-icon
                class="caret"
                size="14"
                :component="expanded.indexOf(item.apiId) > -1 ? ChevronDown : ChevronRight"
                @click="toggleExpand(item.apiId)"
              />
              <span class="method" :style="{ color: methodColor(item.method) }">{{ item.method }}</span>
              <span class="path">{{ item.url }}</span>
              <span class="name">{{ item.name || t('openapi.unnamed') }}</span>
              <span class="summary">{{ changeSummary(item) }}</span>
            </div>

            <div v-if="expanded.indexOf(item.apiId) > -1" class="detail">
              <div v-for="(change, index) in item.changes" :key="index" class="change">
                <div class="change-label">
                  {{ change.label }}<span v-if="change.summary" class="change-summary">（{{ change.summary }}）</span>
                </div>
                <div class="change-body">
                  <pre class="side before">{{ change.before || t('openapi.empty') }}</pre>
                  <pre class="side after">{{ change.after || t('openapi.empty') }}</pre>
                </div>
              </div>
            </div>
          </div>
        </section>

        <!-- 文档里已删除 -->
        <section v-if="diff.removed.length" class="group">
          <div class="group-head">
            <n-checkbox
              :checked="allChecked('removed')"
              @update:checked="(value) => toggleGroup('removed', value)"
            />
            <span class="group-title">{{ t('openapi.groupRemoved', { n: diff.removed.length }) }}</span>
            <span class="group-note">{{ t('openapi.groupRemovedNote') }}</span>
          </div>
          <div v-for="item in diff.removed" :key="item.apiId" class="row">
            <n-checkbox
              :checked="isChecked('removed', item.apiId)"
              @update:checked="(value) => setChecked('removed', item.apiId, value)"
            />
            <span class="method" :style="{ color: methodColor(item.method) }">{{ item.method }}</span>
            <span class="path">{{ item.url }}</span>
            <span class="name">{{ item.name || t('openapi.unnamed') }}</span>
          </div>
        </section>

        <p class="tip">
          {{ t('openapi.applyTip') }}
        </p>
      </template>
    </template>

    <template #footer>
      <n-space justify="end" align="center">
        <span v-if="diff && !isEmpty" class="hint">{{ t('openapi.selectedCount', { n: selectedCount() }) }}</span>
        <n-button size="small" @click="show = false">{{ t('app.cancel') }}</n-button>
        <n-button
          size="small"
          type="primary"
          :disabled="!diff || isEmpty"
          :loading="applying"
          @click="apply"
        >
          {{ t('openapi.apply') }}
        </n-button>
      </n-space>
    </template>
  </n-modal>
</template>

<style scoped>
.scope {
  margin-bottom: 10px;
  font-size: 12px;
  opacity: 0.65;
}

.mode {
  margin-bottom: 8px;
}

.actions {
  margin-top: 10px;
}

.notice {
  margin-top: 10px;
}

.latest {
  margin: 14px 0 4px;
  font-size: 13px;
  opacity: 0.7;
}

.group {
  margin-top: 14px;
}

.group-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.group-title {
  font-size: 12px;
  font-weight: 600;
  opacity: 0.7;
}

.group-note {
  font-size: 12px;
  opacity: 0.5;
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 6px;
  border-radius: 4px;
  font-size: 12px;
}

.row:hover {
  background: rgba(128, 128, 128, 0.08);
}

.caret {
  flex: none;
  opacity: 0.45;
  cursor: pointer;
}

.method {
  flex: none;
  width: 44px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.2px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.path {
  flex: none;
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  opacity: 0.85;
}

.name {
  flex: none;
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.summary {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.6;
}

.where {
  flex: 1;
  min-width: 0;
  text-align: right;
  opacity: 0.55;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.detail {
  margin: 2px 0 8px 46px;
}

.change + .change {
  margin-top: 8px;
}

.change-label {
  font-size: 12px;
  opacity: 0.75;
}

.change-summary {
  opacity: 0.7;
}

.change-body {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}

.side {
  flex: 1;
  min-width: 0;
  margin: 0;
  padding: 6px 8px;
  border-radius: 4px;
  background: rgba(128, 128, 128, 0.09);
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 160px;
  overflow: auto;
}

.side.before {
  opacity: 0.7;
}

.tip {
  margin: 14px 0 0;
  font-size: 12px;
  line-height: 1.7;
  opacity: 0.6;
}

.hint {
  font-size: 12px;
  opacity: 0.6;
}
.url-blocked {
  margin: 8px 0 0;
  font-size: 12px;
  opacity: 0.65;
}
</style>
