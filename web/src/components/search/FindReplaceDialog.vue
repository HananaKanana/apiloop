<script setup>
import { computed, nextTick, ref, watch } from 'vue';
import {
  NButton,
  NCheckbox,
  NCheckboxGroup,
  NEmpty,
  NIcon,
  NInput,
  NModal,
  NSelect,
  NSpace,
  NSpin,
  useMessage
} from 'naive-ui';
import { Search } from '@vicons/tabler';
import * as searchApi from '@/api/search';
import { useDialog } from '@/utils/dialog';
import { useProjectStore } from '@/stores/project';
import { useTreeStore } from '@/stores/tree';
import { useTabsStore } from '@/stores/tabs';
import { useUiStore } from '@/stores/ui';
import { methodColor } from '@/utils/method';
// 勾选、分组、高亮切分这些规则都在这里（纯函数，能单独跑断言）；
// 用命名空间引，免得和下面那几个「把 ref 拆开」的小包装函数撞名
import * as find from '@/utils/findReplace';

/**
 * 全局查找替换（第五轮第 2 节）。
 *
 * 后端改了版本前缀（`/api/v1` → `/api/v2`）、换了一个请求头名、某个参数改了名 ——
 * 以前只能一个个接口打开改。这里一次改完。
 *
 * 几条约定：
 *  - **输入后自动搜**（防抖 300ms），不用点按钮；
 *  - 结果**按接口分组**，每条一个勾选框（默认全勾）、每个接口一个总勾选框；
 *  - **替换框空着就是纯查找** —— 点结果打开那个接口，一样很有用；
 *  - viewer 只能查找（服务端 `POST /replace` 是 editor 权限，按钮也不显示）；
 *  - 换完之后目录树刷新、改到的标签页重新拉一遍；**有未保存修改的接口不参与替换**
 *    （通过 `skipApiIds` 告诉服务端），结果里会列出来。
 */
const projects = useProjectStore();
const tree = useTreeStore();
const tabs = useTabsStore();
const ui = useUiStore();
const message = useMessage();
const dialog = useDialog();

const FIELD_OPTIONS = [
  { label: '地址', value: 'url' },
  { label: '请求头', value: 'headers' },
  { label: 'Query / Path 参数', value: 'params' },
  { label: '请求体', value: 'body' },
  { label: '脚本', value: 'scripts' },
  { label: '名称', value: 'name' },
  { label: '说明', value: 'description' }
];

const FIELD_LABELS = {
  url: '地址',
  headers: '请求头',
  params: '参数',
  body: '请求体',
  scripts: '脚本',
  name: '名称',
  description: '说明'
};

/** 默认范围：地址 + 请求头 + 参数 + 请求体（计划里给的默认值） */
const DEFAULT_FIELDS = ['url', 'headers', 'params', 'body'];

const DEBOUNCE_MS = 300;

const visible = computed({
  get: function () { return ui.findReplaceVisible; },
  set: function (value) { ui.findReplaceVisible = value; }
});

const query = ref('');
const replacement = ref('');
const caseSensitive = ref(false);
const wholeWord = ref(false);
const regex = ref(false);
const fields = ref(DEFAULT_FIELDS.slice());
/** 目录范围：null = 整个项目 */
const folderId = ref(null);

const matches = ref([]);
const total = ref(0);
const truncated = ref(false);
const loading = ref(false);
const errorText = ref('');

/** 取消勾选的：`apiId|field|location` → true（默认全勾，所以记「取消的」比记「勾上的」小） */
const unchecked = ref({});
/** 第几次请求 —— 打字快的时候先发的可能后到，只认最后一次 */
let seq = 0;
let timer = null;

/* 下面这几个薄包装只是把 `unchecked` 这个 ref 拆开 —— 规则本身在 utils/findReplace 里 */

function isChecked(match) {
  return find.isChecked(unchecked.value, match);
}

function apiChecked(group) {
  return find.apiChecked(unchecked.value, group);
}

function apiIndeterminate(group) {
  return find.apiIndeterminate(unchecked.value, group);
}

function toggleApi(group) {
  unchecked.value = find.toggleApi(unchecked.value, group);
}

function toggleMatch(match) {
  unchecked.value = find.toggleMatch(unchecked.value, match);
}

function segments(match) {
  return find.segmentsOf(match);
}

const groups = computed(function () {
  return find.groupMatches(matches.value);
});

const selected = computed(function () {
  return matches.value.filter(isChecked);
});

/** 勾上的那些 → 提交给服务端的 targets */
const targets = computed(function () {
  return find.selectedTargets(matches.value, unchecked.value);
});

const selectedApis = computed(function () {
  const ids = new Set(targets.value.map(function (target) { return target.apiId; }));
  return Array.from(ids);
});

/** 有未保存修改的接口（替换会跳过它们），按标签页算 */
const dirtyApiIds = computed(function () {
  const ids = new Set();
  tabs.tabs.forEach(function (tab) {
    if (tab.apiId && tab.dirty) ids.add(tab.apiId);
  });
  return ids;
});

/** 这次会被跳过的接口名 —— 只说「本来会改到、但因为有未保存修改跳过了」的那些 */
const skippedNames = computed(function () {
  return find.skippedNames(groups.value, unchecked.value, dirtyApiIds.value);
});

const folderOptions = computed(function () {
  const options = [{ label: '整个项目', value: null }];

  (function walk(nodes, depth) {
    (nodes || []).forEach(function (node) {
      if (node.kind !== 'folder') return;
      options.push({ label: '　'.repeat(depth) + node.name, value: node.id });
      walk(node.children, depth + 1);
    });
  })(tree.nodes, 0);

  return options;
});

function reset() {
  matches.value = [];
  total.value = 0;
  truncated.value = false;
  errorText.value = '';
  unchecked.value = {};
}

async function run() {
  const current = ++seq;
  const keyword = String(query.value || '').trim();
  if (!projects.currentId || !keyword) {
    reset();
    return;
  }

  loading.value = true;
  try {
    const data = await searchApi.search(projects.currentId, {
      query: query.value,
      caseSensitive: caseSensitive.value,
      wholeWord: wholeWord.value,
      regex: regex.value,
      fields: fields.value,
      folderId: folderId.value || undefined,
      // 每条结果的「替换后的样子」是服务端按这个值算的，所以替换框也要一起传
      // （不传的话它按空串算，那一列会显示成「命中被删掉」而不是替换结果）
      replacement: replacement.value
    });
    if (current !== seq) return;

    matches.value = data.matches || [];
    total.value = data.total || 0;
    truncated.value = Boolean(data.truncated);
    errorText.value = '';
    unchecked.value = {};
  } catch (err) {
    if (current !== seq) return;
    matches.value = [];
    total.value = 0;
    truncated.value = false;
    errorText.value = err.message;
  } finally {
    if (current === seq) loading.value = false;
  }
}

/** 输入变了就重搜（防抖）。清空查找框时立刻清结果，不要等 300ms */
function schedule() {
  if (timer) clearTimeout(timer);
  if (!String(query.value || '').trim()) {
    seq += 1;
    loading.value = false;
    reset();
    return;
  }
  timer = setTimeout(run, DEBOUNCE_MS);
}

// 选项变了要重搜：范围、目录、大小写、替换框（要重算「替换后的样子」）都会改结果
watch([query, replacement, caseSensitive, wholeWord, regex, fields, folderId], schedule, { deep: true });
watch(function () { return projects.currentId; }, function () { reset(); });

// 每次打开都按当前内容搜一次（关掉再打开时内容还在，结果得跟上）
watch(visible, function (value) {
  if (!value) return;
  nextTick(function () {
    if (String(query.value || '').trim()) run();
  });
});

/** 点一条结果 → 打开那个接口（纯查找也很有用） */
async function openApi(match) {
  visible.value = false;
  try {
    await tabs.openApi(match.apiId);
  } catch (err) {
    message.error(err.message);
  }
}

function runReplace() {
  if (!targets.value.length) return;

  const apiIds = selectedApis.value.slice();
  const skipApiIds = apiIds.filter(function (id) { return dirtyApiIds.value.has(id); });
  const skipped = skippedNames.value;
  const count = targets.value.length;

  dialog.warning({
    title: '替换',
    content: '将修改 ' + (apiIds.length - skipApiIds.length) + ' 个接口里的 ' + count + ' 处。' +
      '替换会直接保存，不能撤销，确定吗？' +
      (skipped.length ? '另外这些接口有未保存的修改，不会替换：' + skipped.join('、') + '。' : ''),
    positiveText: '替换',
    negativeText: '取消',
    onPositiveClick: function () { return doReplace(skipApiIds, skipped); }
  });
}

async function doReplace(skipApiIds, skipped) {
  loading.value = true;
  try {
    const result = await searchApi.replace(projects.currentId, {
      query: query.value,
      caseSensitive: caseSensitive.value,
      wholeWord: wholeWord.value,
      regex: regex.value,
      fields: fields.value,
      replacement: replacement.value,
      targets: targets.value,
      skipApiIds: skipApiIds
    });

    // 目录树先刷新（名字/地址变了），再把改到的标签页重新拉一遍
    await tree.refresh();
    await tabs.reloadApis(targets.value.map(function (target) { return target.apiId; }));

    message.success('已修改 ' + result.changedApis + ' 个接口');
    if (skipped.length) {
      message.warning('这些接口有未保存的修改，没有替换：' + skipped.join('、'));
    }

    // 结果已经过期了，重搜一遍（用户接着看到的是替换之后的样子）
    await run();
  } catch (err) {
    message.error(err.message);
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <n-modal
    v-model:show="visible"
    preset="card"
    title="查找替换"
    style="width: 860px; max-width: 96vw"
  >
    <div class="box">
      <div class="inputs">
        <n-input v-model:value="query" placeholder="查找" clearable>
          <template #prefix>
            <n-icon :component="Search" />
          </template>
        </n-input>
        <n-input
          v-model:value="replacement"
          placeholder="替换为（留空就是只查找）"
          :disabled="!projects.canEdit"
          clearable
        />
      </div>

      <div class="options">
        <n-space align="center" :size="14">
          <n-checkbox v-model:checked="caseSensitive">区分大小写</n-checkbox>
          <n-checkbox v-model:checked="wholeWord">全字匹配</n-checkbox>
          <n-checkbox v-model:checked="regex">正则</n-checkbox>
        </n-space>

        <n-select
          class="scope"
          size="small"
          :value="folderId"
          :options="folderOptions"
          title="搜索范围"
          @update:value="(value) => { folderId = value; }"
        />
      </div>

      <div class="fields">
        <span class="fields-label">范围</span>
        <n-checkbox-group v-model:value="fields">
          <n-space :size="12">
            <n-checkbox
              v-for="option in FIELD_OPTIONS"
              :key="option.value"
              :value="option.value"
            >{{ option.label }}</n-checkbox>
          </n-space>
        </n-checkbox-group>
      </div>

      <p v-if="errorText" class="error">{{ errorText }}</p>

      <div class="results">
        <n-spin :show="loading">
          <p v-if="!matches.length && !loading && String(query).trim()" class="empty-line">
            没有匹配的内容
          </p>
          <n-empty v-else-if="!String(query).trim()" size="small" description="输入要查找的内容" />

          <template v-else>
            <p class="summary">
              共 {{ total }} 处匹配，{{ groups.length }} 个接口<span v-if="truncated">（只列出前 500 处）</span>
            </p>

            <div v-for="group in groups" :key="group.apiId" class="group">
              <div class="group-head">
                <n-checkbox
                  :checked="apiChecked(group)"
                  :indeterminate="apiIndeterminate(group)"
                  @update:checked="() => toggleApi(group)"
                />
                <span class="method" :style="{ color: methodColor(group.method) }">{{ group.method }}</span>
                <span class="api-name" :title="'打开这个接口'" @click="openApi(group.items[0])">
                  {{ group.name }}
                </span>
                <span class="count">{{ group.items.length }} 处</span>
              </div>

              <div v-for="(match, index) in group.items" :key="index" class="match">
                <n-checkbox
                  :checked="isChecked(match)"
                  @update:checked="() => toggleMatch(match)"
                />
                <span class="field">{{ FIELD_LABELS[match.field] || match.field }}</span>
                <div class="texts">
                  <div class="line">
                    <span
                      v-for="(part, i) in segments(match)"
                      :key="i"
                      :class="{ hit: part.hit }"
                    >{{ part.text }}</span>
                  </div>
                  <div v-if="projects.canEdit && replacement !== ''" class="after">
                    → {{ match.preview }}
                  </div>
                </div>
              </div>
            </div>
          </template>
        </n-spin>
      </div>
    </div>

    <template #footer>
      <n-space justify="space-between" align="center" style="width: 100%">
        <span class="hint">
          <template v-if="projects.canEdit">替换会直接保存，不能撤销。</template>
          <template v-else>当前角色是只读，只能查找。</template>
        </span>
        <n-space :size="8">
          <n-button @click="visible = false">关闭</n-button>
          <n-button
            v-if="projects.canEdit"
            type="primary"
            :disabled="!selected.length"
            :loading="loading"
            @click="runReplace"
          >
            替换所选（{{ selected.length }} 处）
          </n-button>
        </n-space>
      </n-space>
    </template>
  </n-modal>
</template>

<style scoped>
.box {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.inputs {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.options {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.scope {
  width: 200px;
  flex: none;
}

.fields {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.fields-label {
  flex: none;
  font-size: 12px;
  opacity: 0.6;
}

.error {
  margin: 0;
  font-size: 12px;
  color: #eb2013;
}

.results {
  max-height: 48vh;
  overflow: auto;
  border-top: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.16));
  padding-top: 8px;
}

.summary {
  margin: 0 0 6px;
  font-size: 12px;
  opacity: 0.6;
}

.empty-line {
  margin: 12px 0;
  font-size: 13px;
  opacity: 0.6;
}

.group {
  margin-bottom: 10px;
}

.group-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  font-size: 13px;
}

.method {
  flex: none;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.2px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.api-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}

.api-name:hover {
  color: var(--apiloop-primary);
  text-decoration: underline;
}

.count {
  flex: none;
  font-size: 11px;
  opacity: 0.5;
}

.match {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 3px 0 3px 24px;
  font-size: 12px;
}

.field {
  flex: none;
  width: 48px;
  opacity: 0.6;
}

.texts {
  flex: 1;
  min-width: 0;
}

.line,
.after {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: pre-wrap;
  word-break: break-all;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.line .hit {
  color: var(--apiloop-primary);
  font-weight: 600;
  background: rgba(255, 108, 55, 0.14);
  border-radius: 2px;
}

/* 替换之后的样子：绿色系，和「现在」区分开 */
.after {
  margin-top: 1px;
  color: #0c8a4a;
}

.hint {
  font-size: 12px;
  opacity: 0.6;
}
</style>
