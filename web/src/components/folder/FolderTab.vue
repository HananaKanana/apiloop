<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { NAlert, NButton, NIcon, NInput, NTab, NTabs, useMessage } from 'naive-ui';
import { ChevronRight, Folder } from '@vicons/tabler';
import { useProjectStore } from '@/stores/project';
import { useTreeStore } from '@/stores/tree';
import { useTabsStore } from '@/stores/tabs';
import VarTable from '@/components/common/VarTable.vue';
import KeyValueTable from '@/components/common/KeyValueTable.vue';
import InlineRename from '@/components/common/InlineRename.vue';
import AuthEditor from '@/components/request/AuthEditor.vue';
import ScriptEditor from '@/components/scripts/ScriptEditor.vue';
import PreflightPanel from '@/components/preflight/PreflightPanel.vue';
import { folderChain } from '@/utils/tree';
import { authTypeName, inheritHint, isConfiguredAuth } from '@/utils/auth';

/**
 * 目录设置：名称 / 描述 / 目录变量 / 目录级鉴权（+ 只读的脚本）。
 *
 * 2026-10-07 改成和 Postman 一样「先看介绍、再切页签配置」：点开目录先是「概览」
 * （描述、接口数、配置了哪些），鉴权 / 变量 / 请求头 / 脚本 / 前置接口各占一个页签。
 * 以前一点开就是一整页表单，用户说「不能直接点开就配置吧」。
 *
 * 以前目录的鉴权在界面上根本没有入口，接口选了「继承父级」也没人知道继承到了什么；
 * 目录变量更是存下来了却不参与替换（那一半由 F1 在后端修）。这个标签页补的是入口。
 *
 * 可编辑的内容放在 `tab.spec` 上，和接口标签页共用「和快照比出 dirty」那套机制，
 * 所以未保存标记、切换项目时的提醒都不用另外写。
 */
const props = defineProps({
  tab: { type: Object, required: true }
});

/** 「运行」：打开这个目录的批量运行标签页（第 2 节），由工作台去开 */
const emit = defineEmits(['run']);

const projects = useProjectStore();
const tree = useTreeStore();
const tabs = useTabsStore();
const message = useMessage();
const { t } = useI18n();

const saving = ref(false);

const spec = computed(function () {
  return props.tab.spec;
});

const canEdit = computed(function () {
  return projects.canEdit;
});

/** 服务端那一份（算路径用），和正在编辑的 spec 分开 */
const folder = computed(function () {
  return tree.folderById.get(props.tab.folderId) || null;
});

/** 「位置：A / B」——只显示上级，自己那一级已经在标题上了 */
const parentPath = computed(function () {
  const parents = folderChain(tree.folders, folder.value ? folder.value.parentId : null);
  return parents.reverse().map(function (item) { return item.name; }).join(' / ');
});

/**
 * 「继承父级」实际会用到哪一级（契约第 5 节第 2 步）：
 * 从**父目录**开始往上找，最后是项目。自己那一级不算 —— 要继承的就是它。
 */
const authLevels = computed(function () {
  const levels = folderChain(tree.folders, folder.value ? folder.value.parentId : null)
    .map(function (item) {
      return { auth: item.auth, label: t('folder.authLevelFolder', { name: item.name }) };
    });

  levels.push({
    auth: projects.current ? projects.current.auth : null,
    label: t('folder.authLevelProject')
  });
  return levels;
});

const authHint = computed(function () {
  return inheritHint(authLevels.value);
});

/* ---------------- 页签 ---------------- */

/**
 * 当前页签记在标签页对象上：切到别的标签页再切回来（组件会重新挂载）还停在原来那一页。
 * 每次新打开一个目录都从「概览」开始。
 */
const view = computed({
  get: function () { return props.tab.folderView || 'overview'; },
  set: function (value) { props.tab.folderView = value; }
});

function filledRows(rows) {
  return (rows || []).filter(function (row) { return row && String(row.key || '').trim(); });
}

const varCount = computed(function () { return filledRows(spec.value.variables).length; });
const headerCount = computed(function () { return filledRows(spec.value.headers).length; });

const scriptKinds = computed(function () {
  const list = spec.value.scripts || [];
  function has(listen) {
    return list.some(function (item) { return item && item.listen === listen && String(item.exec || '').trim(); });
  }
  return { pre: has('prerequest'), post: has('test') };
});

/** 页签上的小数字 / 圆点：一眼看出哪几页配过东西 */
const VIEWS = computed(function () {
  return [
    { name: 'overview', label: t('folder.tabOverview'), mark: '' },
    { name: 'auth', label: t('folder.tabAuth'), mark: isConfiguredAuth(spec.value.auth) ? '•' : '' },
    { name: 'variables', label: t('folder.tabVars'), mark: varCount.value ? String(varCount.value) : '' },
    { name: 'headers', label: t('folder.tabHeaders'), mark: headerCount.value ? String(headerCount.value) : '' },
    { name: 'scripts', label: t('folder.tabScripts'), mark: scriptKinds.value.pre || scriptKinds.value.post ? '•' : '' },
    { name: 'preflight', label: t('folder.tabPreflight'), mark: spec.value.preflight ? '•' : '' }
  ];
});

/* ---------------- 概览 ---------------- */

/** 这个目录（含子孙目录）下一共多少接口，直接子目录多少个 */
const stats = computed(function () {
  const id = props.tab.folderId;
  const inside = new Set([id]);
  let changed = true;
  while (changed) {
    changed = false;
    tree.folders.forEach(function (item) {
      if (!inside.has(item.id) && inside.has(item.parentId)) {
        inside.add(item.id);
        changed = true;
      }
    });
  }
  return {
    apis: tree.apis.filter(function (api) { return inside.has(api.folderId); }).length,
    folders: tree.folders.filter(function (item) { return item.parentId === id; }).length
  };
});

/** 概览里「配置」那几行：点一下跳到对应页签 */
const summary = computed(function () {
  const notSet = t('folder.sumNotSet');

  let auth = isConfiguredAuth(spec.value.auth) ? authTypeName(spec.value.auth) : t('folder.sumInherit');

  const scripts = [];
  if (scriptKinds.value.pre) scripts.push(t('folder.sumScriptPre'));
  if (scriptKinds.value.post) scripts.push(t('folder.sumScriptPost'));

  let preflight;
  const pf = spec.value.preflight;
  if (!pf) preflight = t('folder.sumPreflightFollow');
  else if (!pf.apiId) preflight = t('folder.sumPreflightOff');
  else {
    const api = tree.apis.find(function (item) { return item.id === pf.apiId; });
    preflight = api ? api.name : t('folder.sumApiGone');
  }

  return [
    { view: 'auth', label: t('folder.tabAuth'), value: auth, set: isConfiguredAuth(spec.value.auth) },
    { view: 'variables', label: t('folder.tabVars'), value: varCount.value ? t('folder.sumCount', { n: varCount.value }) : notSet, set: varCount.value > 0 },
    { view: 'headers', label: t('folder.tabHeaders'), value: headerCount.value ? t('folder.sumCount', { n: headerCount.value }) : notSet, set: headerCount.value > 0 },
    { view: 'scripts', label: t('folder.tabScripts'), value: scripts.length ? scripts.join(' · ') : notSet, set: scripts.length > 0 },
    { view: 'preflight', label: t('folder.tabPreflight'), value: preflight, set: Boolean(pf && pf.apiId) }
  ];
});

/** 描述平时只是一段文字，点「编辑」才变成输入框；「完成」时直接保存 */
const editingDesc = ref(false);

function startEditDesc() {
  if (!canEdit.value) return;
  editingDesc.value = true;
}

async function finishEditDesc() {
  editingDesc.value = false;
  if (props.tab.dirty) await save();
}

watch(
  function () { return props.tab.spec; },
  function () { tabs.touch(props.tab); },
  { deep: true }
);

/** 标题上双击改名：只改名字、立刻存（`applyRename` 会把保存快照里的名字一起换掉，dirty 不变） */
async function renameTitle(name) {
  try {
    await tree.renameFolder(props.tab.folderId, name);
    tabs.applyRename('folder', props.tab.folderId, name);
    message.success(t('tree.renamed'));
  } catch (err) {
    message.error(err.message);
  }
}

async function save() {
  if (!String(spec.value.name || '').trim()) {
    message.warning(t('folder.nameRequired'));
    return;
  }

  saving.value = true;
  try {
    const saved = await tree.saveFolder(props.tab.folderId, {
      name: String(spec.value.name).trim(),
      description: spec.value.description,
      auth: spec.value.auth,
      variables: spec.value.variables,
      headers: spec.value.headers,
      scripts: spec.value.scripts,
      // 前置接口（第十轮第 3 节）：整份提交；null 是「跟着上层走」，{ apiId: null } 是「这里不用」
      preflight: spec.value.preflight
    });
    tabs.markFolderSaved(props.tab, saved);
    message.success(t('mock.saved'));
  } catch (err) {
    message.error(err.message);
  } finally {
    saving.value = false;
  }
}

function onKeydown(event) {
  if (!(event.metaKey || event.ctrlKey)) return;
  if (String(event.key).toLowerCase() !== 's') return;
  event.preventDefault();

  // 只读角色连快捷键也要挡住，并说清楚为什么
  if (!canEdit.value) {
    message.warning(t('env.readonly'));
    return;
  }
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
  <div class="folder-tab">
    <div class="head">
      <!-- 双击改名（参考 Postman）：立刻存，只改名字，下面表单里别的没保存的修改不受影响 -->
      <span class="title">
        <inline-rename :value="spec.name" :placeholder="t('folder.settingsTitle')" :editable="canEdit" @commit="renameTitle" />
      </span>
      <span v-if="parentPath" class="path">{{ t('folder.location', { path: parentPath }) }}</span>
      <span class="spacer" />
      <!-- 只读角色也能运行：发请求本来就是 viewer 要做的事 -->
      <n-button
        size="small"
        secondary
        :disabled="!folder"
        :title="t('folder.runHint')"
        @click="emit('run', tab.folderId)"
      >
        {{ t('tree.run') }}
      </n-button>
      <n-button
        v-if="canEdit"
        size="small"
        type="primary"
        :loading="saving"
        :disabled="!folder"
        @click="save"
      >
        {{ t('mock.save') }}
      </n-button>
    </div>

    <div v-if="folder" class="views">
      <n-tabs :value="view" type="line" size="small" @update:value="(value) => { view = value; }">
        <n-tab v-for="item in VIEWS" :key="item.name" :name="item.name">
          {{ item.label }}<span v-if="item.mark" class="mark">{{ item.mark }}</span>
        </n-tab>
      </n-tabs>
    </div>

    <div class="content">
      <n-alert v-if="!folder" type="warning" :show-icon="false" class="alert">
        {{ t('folder.gone') }}
      </n-alert>

      <template v-else>
        <n-alert v-if="!canEdit && view !== 'overview'" type="info" :show-icon="false" class="alert">
          {{ t('folder.readonlyHint') }}
        </n-alert>

        <!-- 概览：名字、统计、描述、配置一览 -->
        <div v-if="view === 'overview'" class="overview">
          <div class="ov-title">
            <n-icon size="22" :component="Folder" />
            <span>{{ spec.name }}</span>
          </div>
          <div class="ov-stats">
            <span>{{ t('folder.statApis', { n: stats.apis }) }}</span>
            <span class="dot">·</span>
            <span>{{ t('folder.statFolders', { n: stats.folders }) }}</span>
          </div>

          <div class="ov-desc">
            <template v-if="editingDesc">
              <n-input
                v-model:value="spec.description"
                type="textarea"
                :autosize="{ minRows: 3, maxRows: 12 }"
                :placeholder="t('folder.descPlaceholder')"
                autofocus
              />
              <div class="ov-desc-actions">
                <n-button size="small" type="primary" :loading="saving" @click="finishEditDesc">{{ t('folder.doneEdit') }}</n-button>
              </div>
            </template>
            <template v-else-if="spec.description && spec.description.trim()">
              <p class="desc-text">{{ spec.description }}</p>
              <a v-if="canEdit" class="link" @click="startEditDesc">{{ t('folder.editDesc') }}</a>
            </template>
            <template v-else>
              <a v-if="canEdit" class="desc-empty link" @click="startEditDesc">{{ t('folder.descEmptyEdit') }}</a>
              <span v-else class="desc-empty">{{ t('folder.descEmpty') }}</span>
            </template>
          </div>

          <div class="ov-section">{{ t('folder.summaryTitle') }}</div>
          <div class="summary">
            <div v-for="row in summary" :key="row.view" class="sum-row" @click="view = row.view">
              <span class="sum-label">{{ row.label }}</span>
              <span class="sum-value" :class="{ muted: !row.set }">{{ row.value }}</span>
              <n-icon class="sum-go" size="14" :component="ChevronRight" />
            </div>
          </div>
        </div>

        <div v-else-if="view === 'auth'">
          <p class="tip">{{ t('folder.authTip') }}</p>
          <auth-editor v-model="spec.auth" :disabled="!canEdit" :inherit-hint="authHint" />
        </div>

        <div v-else-if="view === 'variables'">
          <p class="tip">{{ t('folder.varsTip') }}</p>
          <var-table v-model="spec.variables" :disabled="!canEdit" />
        </div>

        <!--
          公共请求头（第五轮第 1 节）：这个目录下的接口发送时都会带上。
          内层目录 / 接口自己写了同名的，以更靠近接口的那一层为准。
        -->
        <div v-else-if="view === 'headers'">
          <p class="tip">{{ t('folder.headersTip') }}</p>
          <key-value-table
            v-model="spec.headers"
            :disabled="!canEdit"
            kind="common-headers"
            :key-placeholder="t('folder.headerNamePlaceholder')"
            :value-placeholder="t('folder.headerValuePlaceholder')"
          />
        </div>

        <div v-else-if="view === 'scripts'">
          <p class="tip">{{ t('folder.scriptsTip') }}</p>
          <script-editor v-model="spec.scripts" :disabled="!canEdit" min-height="240px" />
        </div>

        <!--
          前置接口（第十轮第 3 节）：这个目录下的接口发送前先自动调一遍它（通常是登录接口）。
          没设就是「跟着外层走」；设了「不使用」就挡住往上找。
        -->
        <div v-else-if="view === 'preflight'">
          <p class="tip">{{ t('folder.preflightTip') }}</p>
          <preflight-panel
            v-model="spec.preflight"
            :apis="tree.apis"
            allow-inherit
            :disabled="!canEdit"
          />
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.folder-tab {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.16));
}

.title {
  font-size: 14px;
  font-weight: 600;
}

.path {
  font-size: 12px;
  opacity: 0.6;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.spacer {
  flex: 1;
}

.content {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 12px 16px;
  max-width: 760px;
  width: 100%;
  box-sizing: border-box;
}

.views {
  flex: none;
  padding: 0 16px;
}

.mark {
  margin-left: 4px;
  font-size: 11px;
  color: var(--apiloop-primary);
}

/* ---------------- 概览 ---------------- */

.overview {
  padding: 12px 4px;
}

.ov-title {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 22px;
  font-weight: 600;
}

.ov-title .n-icon {
  opacity: 0.6;
}

.ov-stats {
  margin-top: 8px;
  font-size: 12px;
  opacity: 0.55;
}

.ov-stats .dot {
  margin: 0 6px;
}

.ov-desc {
  margin-top: 18px;
  padding-top: 16px;
  border-top: 1px solid rgba(128, 128, 128, 0.14);
}

.desc-text {
  margin: 0 0 6px;
  font-size: 13px;
  line-height: 1.8;
  white-space: pre-wrap;
  word-break: break-word;
}

.desc-empty {
  font-size: 13px;
  opacity: 0.5;
}

.link {
  font-size: 12px;
  color: var(--apiloop-primary);
  cursor: pointer;
}

.desc-empty.link {
  font-size: 13px;
  opacity: 0.8;
}

.ov-desc-actions {
  margin-top: 8px;
  display: flex;
  justify-content: flex-end;
}

.ov-section {
  margin: 28px 0 8px;
  font-size: 12px;
  opacity: 0.55;
}

.summary {
  border: 1px solid rgba(128, 128, 128, 0.18);
  border-radius: 6px;
}

.sum-row {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 38px;
  padding: 0 12px;
  font-size: 13px;
  cursor: pointer;
}

.sum-row + .sum-row {
  border-top: 1px solid rgba(128, 128, 128, 0.12);
}

.sum-row:hover {
  background: rgba(128, 128, 128, 0.06);
}

.sum-label {
  flex: none;
  width: 96px;
  opacity: 0.7;
}

.sum-value {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sum-value.muted {
  opacity: 0.45;
}

.sum-go {
  flex: none;
  opacity: 0.35;
}

.alert {
  margin-bottom: 12px;
}

.tip {
  margin: 0 0 10px;
  font-size: 12px;
  opacity: 0.6;
  line-height: 1.6;
}
</style>
