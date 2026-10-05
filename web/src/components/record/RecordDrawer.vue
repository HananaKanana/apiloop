<script setup>
import { computed, ref, watch } from 'vue';
import {
  NAlert,
  NButton,
  NCheckbox,
  NDrawer,
  NDrawerContent,
  NEmpty,
  NInput,
  NInputNumber,
  NSelect,
  NSpace,
  NSwitch,
  NTag,
  useMessage
} from 'naive-ui';
import { copyText } from '@/utils/clipboard';
import { useDialog } from '@/utils/dialog';
import { useEnvStore } from '@/stores/env';
import { useProjectStore } from '@/stores/project';
import { useRecordStore } from '@/stores/record';
import { useTreeStore } from '@/stores/tree';
import RecordDetail from './RecordDetail.vue';
import RecordSaveDialog from './RecordSaveDialog.vue';

/**
 * Mock 录制抽屉。
 *
 * 流程：填目标地址 → 开始录制 → 把前端 / App 的接口地址改成代理地址 → 请求一边转发一边记下来
 * → 勾几条「保存所选」存成示例（没对上接口的顺手新建）。
 *
 * 抽屉本身由 `TopBar.vue` 渲染（不去动 `WorkbenchView.vue`）；轮询的启停也在 TopBar 里管，
 * 这里只在打开时做一次全量刷新。
 */
const props = defineProps({
  show: { type: Boolean, default: false }
});

const emit = defineEmits(['update:show']);

const projects = useProjectStore();
const envs = useEnvStore();
const tree = useTreeStore();
const record = useRecordStore();
const message = useMessage();
const dialog = useDialog();

const visible = computed({
  get: function () { return props.show; },
  set: function (value) { emit('update:show', value); }
});

const canEdit = computed(function () { return projects.canEdit; });

/* ---------------- 开始录制的表单 ---------------- */

const target = ref('');
const port = ref(null);
const lan = ref(false);
const pathPrefix = ref('');
const skipStatic = ref(true);
const starting = ref(false);
/** 环境变量下拉的选中值：填完就清掉，方便重复选 */
const varPick = ref(null);

/** 当前环境里「值是 http(s) 地址」的变量，一键填成 `{{host}}` 这种 */
const httpVariables = computed(function () {
  const environment = envs.selected;
  if (!environment) return [];

  return (environment.variables || []).filter(function (row) {
    if (!row || row.enabled === false) return false;
    const key = String(row.key || '');
    const value = String(row.value || '');
    return key && /^https?:\/\//i.test(value);
  }).map(function (row) {
    return { label: '{{' + row.key + '}}  ' + row.value, value: String(row.key) };
  });
});

function useVariable(key) {
  if (key) target.value = '{{' + key + '}}';
  // 选完清掉下拉的选中值：不然再选同一个变量不会触发 change
  varPick.value = null;
}

async function start() {
  const url = String(target.value || '').trim();
  if (!url) {
    message.warning('先填目标地址');
    return;
  }

  starting.value = true;
  try {
    await record.start(projects.currentId, {
      target: url,
      environmentId: envs.selectedId || undefined,
      port: Number(port.value) || 0,
      lan: lan.value,
      pathPrefix: String(pathPrefix.value || '').trim(),
      skipStatic: skipStatic.value
    });
    message.success('开始录制，把接口地址改成下面的代理地址');
  } catch (err) {
    message.error(err.message);
  } finally {
    starting.value = false;
  }
}

async function stop() {
  try {
    await record.stop(projects.currentId);
    message.success('已停止录制，记录还留着，可以继续挑着保存');
  } catch (err) {
    message.error(err.message);
  }
}

/* ---------------- 记录列表 ---------------- */

const keyword = ref('');
const onlyUnmatched = ref(false);
const dedupe = ref(false);
const selected = ref([]);
const expandedId = ref(null);

/** 去重：同「方法 + 路径 + 状态码」只留最新的一条（列表是新的在前） */
const rows = computed(function () {
  const list = record.entries;

  if (!dedupe.value) return list;

  const seen = new Set();
  return list.filter(function (entry) {
    const key = entry.method + ' ' + entry.path + ' ' + entry.status;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
});

const visibleRows = computed(function () {
  const text = String(keyword.value || '').trim().toLowerCase();

  return rows.value.filter(function (entry) {
    if (onlyUnmatched.value && entry.match) return false;
    if (!text) return true;
    const path = (entry.path + (entry.query ? '?' + entry.query : '')).toLowerCase();
    return path.indexOf(text) > -1;
  });
});

const selectedRows = computed(function () {
  const byId = new Map();
  rows.value.forEach(function (entry) { byId.set(entry.id, entry); });
  return selected.value.map(function (id) { return byId.get(id); }).filter(Boolean);
});

const allChecked = computed(function () {
  return visibleRows.value.length > 0 && visibleRows.value.every(function (entry) {
    return selected.value.indexOf(entry.id) > -1;
  });
});

const indeterminate = computed(function () {
  if (!selected.value.length) return false;
  return !allChecked.value;
});

function toggleAll(checked) {
  if (checked) {
    const merged = selected.value.slice();
    visibleRows.value.forEach(function (entry) {
      if (merged.indexOf(entry.id) === -1) merged.push(entry.id);
    });
    selected.value = merged;
    return;
  }
  const ids = visibleRows.value.map(function (entry) { return entry.id; });
  selected.value = selected.value.filter(function (id) { return ids.indexOf(id) === -1; });
}

function toggleRow(entry) {
  const at = selected.value.indexOf(entry.id);
  if (at === -1) selected.value = selected.value.concat([entry.id]);
  else selected.value = selected.value.filter(function (id) { return id !== entry.id; });
}

function toggleDetail(entry) {
  expandedId.value = expandedId.value === entry.id ? null : entry.id;
}

function formatTime(at) {
  const date = new Date(at);
  function pad(num) { return num < 10 ? '0' + num : String(num); }
  return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
}

function pathText(entry) {
  return entry.path + (entry.query ? '?' + entry.query : '');
}

/** 2xx 绿 / 4xx 橙 / 5xx 和 0（连不上）红 */
function statusType(entry) {
  const status = Number(entry.status) || 0;
  if (status >= 200 && status < 300) return 'success';
  if (status >= 400 && status < 500) return 'warning';
  return 'error';
}

/* ---------------- 保存 / 清空 ---------------- */

const saveVisible = ref(false);
const saving = ref(false);

const matchedSelected = computed(function () {
  return selectedRows.value.filter(function (entry) { return !!entry.match; });
});

const unmatchedSelected = computed(function () {
  return selectedRows.value.filter(function (entry) { return !entry.match; });
});

function openSave() {
  if (!selected.value.length) {
    message.warning('先勾几条要保存的记录');
    return;
  }
  saveVisible.value = true;
}

async function save(options) {
  const matched = matchedSelected.value;
  const unmatched = unmatchedSelected.value;

  const items = matched.map(function (entry) {
    return { entryId: entry.id, apiId: entry.match.apiId };
  });
  unmatched.forEach(function (entry) {
    items.push({ entryId: entry.id, folderId: options.folderId });
  });

  if (!items.length) return;

  saving.value = true;
  try {
    const data = await record.save(projects.currentId, {
      items: items,
      paramize: options.paramize,
      setMock: options.setMock,
      environmentId: envs.selectedId || undefined
    });

    saveVisible.value = false;

    const created = data.created || {};
    message.success('新建了 ' + (created.apis || 0) + ' 个接口，加了 ' + (created.examples || 0) + ' 个示例');

    const results = data.results || [];
    const failed = results.filter(function (item) { return item.error; });

    // 存成功的从选中里去掉，失败的留着让用户能重来
    const done = {};
    results.forEach(function (item) { if (!item.error) done[item.entryId] = true; });
    selected.value = selected.value.filter(function (id) { return !done[id]; });

    if (failed.length) {
      const byId = new Map();
      rows.value.forEach(function (entry) { byId.set(entry.id, entry); });
      const lines = failed.map(function (item) {
        const entry = byId.get(item.entryId);
        return (entry ? entry.method + ' ' + pathText(entry) : item.entryId) + '：' + item.error;
      });
      dialog.warning({
        title: '有 ' + failed.length + ' 条没保存成功',
        content: lines.join('\n'),
        positiveText: '知道了',
        style: 'width: 520px; max-width: calc(100vw - 32px)'
      });
    }

    // 新建了接口，目录树要跟着刷新
    if (created.apis) await tree.refresh();
  } catch (err) {
    message.error(err.message);
  } finally {
    saving.value = false;
  }
}

function clearAll() {
  dialog.warning({
    title: '清空记录',
    content: '清掉这个项目录到的全部记录（不影响已经保存的接口和示例）。',
    positiveText: '清空',
    negativeText: '取消',
    onPositiveClick: async function () {
      try {
        await record.clear(projects.currentId);
        selected.value = [];
        expandedId.value = null;
        message.success('已清空');
      } catch (err) {
        message.error(err.message);
      }
    }
  });
}

/* ---------------- 复制 ---------------- */

async function copy(text) {
  try {
    await copyText(text);
    message.success('已复制');
  } catch (err) {
    message.warning('复制失败，请手动选中复制');
  }
}

/* ---------------- 打开时刷新一次 ---------------- */

watch(
  function () { return props.show; },
  function (open) {
    if (!open) return;
    selected.value = [];
    expandedId.value = null;
    record.load(projects.currentId);
  }
);
</script>

<template>
  <n-drawer v-model:show="visible" :width="960" placement="right">
    <n-drawer-content title="Mock 录制" closable :native-scrollbar="false">
      <div class="record">
        <!-- 别的项目正在录：同一个网关只能录一个项目 -->
        <n-alert v-if="!record.isRecording && record.busy" type="warning" :show-icon="false">
          正在录制项目「{{ record.busy.projectName }}」，同一时间只能录一个项目。
          切到那个项目去停止，或者等它停掉。
        </n-alert>

        <!-- 没在录：开始表单 -->
        <div v-else-if="!record.isRecording" class="form">
          <div class="field">
            <span class="field-label">目标地址</span>
            <div class="field-body">
              <n-input v-model:value="target" placeholder="http://localhost:8080/api" />
              <n-select
                v-if="httpVariables.length"
                v-model:value="varPick"
                class="var-select"
                size="small"
                placeholder="用环境变量"
                :options="httpVariables"
                @update:value="useVariable"
              />
            </div>
          </div>
          <p class="tip">请求会转发到这个地址（可以带路径前缀），同时记下来。</p>

          <div class="field">
            <span class="field-label">端口</span>
            <div class="field-body">
              <n-input-number
                v-model:value="port"
                class="port"
                size="small"
                :min="0"
                :max="65535"
                :show-button="false"
                placeholder="自动"
              />
              <span class="tip">留空 / 0 表示自动（从 47400 起找空闲端口）</span>
            </div>
          </div>

          <div class="field">
            <span class="field-label">只录这个前缀</span>
            <div class="field-body">
              <n-input v-model:value="pathPrefix" size="small" placeholder="留空表示全录，比如 /api" />
            </div>
          </div>

          <div class="field">
            <span class="field-label">选项</span>
            <div class="field-body column">
              <div class="option">
                <n-switch v-model:value="lan" size="small" />
                <span>允许局域网访问（手机、其他电脑）</span>
              </div>
              <p v-if="lan" class="warn">同一网络里的人都能通过这个地址访问你的目标服务，注意别把内网服务暴露出去。</p>
              <div class="option">
                <n-switch v-model:value="skipStatic" size="small" />
                <span>跳过静态资源（js / css / 图片 / 页面）</span>
              </div>
            </div>
          </div>

          <n-space justify="end">
            <n-button type="primary" :disabled="!canEdit" :loading="starting" @click="start">
              开始录制
            </n-button>
          </n-space>
        </div>

        <!-- 录制中 -->
        <div v-else class="status-block">
          <div class="line">
            <span class="field-label">代理地址</span>
            <code class="addr">{{ record.status.localUrl }}</code>
            <n-button size="tiny" quaternary @click="copy(record.status.localUrl)">复制</n-button>
          </div>
          <div v-for="url in record.status.lanUrls" :key="url" class="line">
            <span class="field-label">局域网</span>
            <code class="addr">{{ url }}</code>
            <n-button size="tiny" quaternary @click="copy(url)">复制</n-button>
          </div>
          <div class="line">
            <span class="field-label">转发到</span>
            <code class="addr">{{ record.status.target }}</code>
          </div>
          <p class="tip">
            把前端 / App 的接口地址改成上面的代理地址，请求会转发到 {{ record.status.target }}，响应自动记在下面。
          </p>
          <n-space justify="end">
            <n-button size="small" type="error" secondary :disabled="!canEdit" @click="stop">停止</n-button>
          </n-space>
        </div>

        <!-- 记录列表 -->
        <div class="toolbar">
          <n-checkbox
            :checked="allChecked"
            :indeterminate="indeterminate"
            :disabled="!visibleRows.length"
            @update:checked="toggleAll"
          >
            全选
          </n-checkbox>
          <span class="count">{{ visibleRows.length }} / {{ rows.length }} 条</span>

          <n-input
            v-model:value="keyword"
            class="search"
            size="small"
            clearable
            placeholder="按路径搜"
          />
          <n-checkbox v-model:checked="onlyUnmatched">只看没对上接口的</n-checkbox>
          <n-checkbox v-model:checked="dedupe">去重</n-checkbox>
        </div>

        <div class="list">
          <div
            v-for="entry in visibleRows"
            :key="entry.id"
            class="item"
            :class="{ failed: !!entry.error }"
          >
            <div class="row">
              <n-checkbox
                :checked="selected.indexOf(entry.id) > -1"
                @update:checked="toggleRow(entry)"
              />
              <span class="time">{{ formatTime(entry.at) }}</span>
              <span class="method">{{ entry.method }}</span>
              <span class="path" :title="pathText(entry)" @click="toggleDetail(entry)">
                {{ entry.path }}<span v-if="entry.query" class="query">?{{ entry.query }}</span>
              </span>
              <n-tag size="tiny" :bordered="false" :type="statusType(entry)">
                {{ entry.status || '连不上' }}
              </n-tag>
              <span class="ms">{{ entry.durationMs }}ms</span>
              <span class="match" :class="{ none: !entry.match }">
                {{ entry.match ? entry.match.apiName : '新接口' }}
              </span>
              <button class="toggle" @click="toggleDetail(entry)">
                {{ expandedId === entry.id ? '收起' : '详情' }}
              </button>
            </div>

            <record-detail v-if="expandedId === entry.id" :entry="entry" />
          </div>

          <n-empty v-if="record.loaded && !visibleRows.length" description="还没有记录" class="empty">
            <template #extra>
              <p class="tip">
                {{ record.isRecording
                  ? '把接口地址改成上面的代理地址，访问一次就会出现在这里。'
                  : '开始录制之后，访问代理地址的请求会出现在这里。' }}
              </p>
            </template>
          </n-empty>

          <div v-if="!record.loaded" class="loading">加载中…</div>
        </div>

        <div class="footer">
          <n-space align="center">
            <n-button
              type="primary"
              :disabled="!canEdit || !selected.length"
              @click="openSave"
            >
              保存所选（{{ selected.length }}）
            </n-button>
            <n-button :disabled="!canEdit || !record.entries.length" @click="clearAll">清空记录</n-button>
          </n-space>
          <span v-if="!canEdit" class="tip">只读成员只能看记录</span>
        </div>
      </div>
    </n-drawer-content>
  </n-drawer>

  <record-save-dialog
    v-model:show="saveVisible"
    :matched="matchedSelected"
    :unmatched="unmatchedSelected"
    :saving="saving"
    @confirm="save"
  />
</template>

<style scoped>
.record {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.field {
  display: flex;
  gap: 10px;
}

.field-label {
  flex: none;
  width: 96px;
  padding-top: 6px;
  font-size: 12px;
  opacity: 0.7;
}

.field-body {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

.field-body.column {
  flex-direction: column;
  align-items: stretch;
  gap: 6px;
}

.var-select {
  flex: none;
  width: 200px;
}

.port {
  width: 140px;
}

.option {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}

.tip {
  margin: 0;
  font-size: 12px;
  opacity: 0.6;
  line-height: 1.6;
}

.warn {
  margin: 0;
  font-size: 12px;
  color: #d97706;
  line-height: 1.6;
}

.status-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border-radius: 6px;
  background: rgba(128, 128, 128, 0.1);
}

.line {
  display: flex;
  align-items: center;
  gap: 8px;
}

.addr {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
  word-break: break-all;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--apiloop-divider);
}

.count {
  font-size: 12px;
  opacity: 0.6;
}

.search {
  width: 180px;
}

.list {
  display: flex;
  flex-direction: column;
}

.item {
  border-bottom: 1px solid var(--apiloop-divider);
}

.item.failed .path,
.item.failed .ms {
  color: #d03050;
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 2px;
  font-size: 12px;
}

.time {
  flex: none;
  width: 62px;
  opacity: 0.6;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.method {
  flex: none;
  width: 52px;
  font-weight: 600;
}

.path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.query {
  opacity: 0.5;
}

.ms {
  flex: none;
  width: 56px;
  text-align: right;
  opacity: 0.6;
}

.match {
  flex: none;
  width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.8;
}

.match.none {
  opacity: 0.45;
}

.toggle {
  flex: none;
  padding: 0 4px;
  border: none;
  background: transparent;
  color: var(--apiloop-primary);
  font-size: 12px;
  cursor: pointer;
}

.empty {
  padding: 40px 0;
}

.loading {
  padding: 20px 0;
  text-align: center;
  font-size: 12px;
  opacity: 0.6;
}

.footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--apiloop-divider);
}
</style>
