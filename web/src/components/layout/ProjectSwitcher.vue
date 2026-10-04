<script setup>
import { computed, nextTick, ref } from 'vue';
import {
  NButton,
  NForm,
  NFormItem,
  NIcon,
  NInput,
  NModal,
  NPopover,
  NSelect,
  NSpace,
  useMessage
} from 'naive-ui';
import { useDialog } from '@/utils/dialog';
import { ChevronDown, ChevronRight, Package, Plus, Search, Settings, Star } from '@vicons/tabler';
import * as importExportApi from '@/api/importExport';
import { useProjectStore } from '@/stores/project';
import { usePrefsStore } from '@/stores/prefs';
import { useTabsStore } from '@/stores/tabs';
import { useUiStore } from '@/stores/ui';
import { downloadJson } from '@/utils/download';
import OpenapiExportDialog from '@/components/importExport/OpenapiExportDialog.vue';
import ExportDocDialog from '@/components/importExport/ExportDocDialog.vue';
import * as copyApi from '@/api/copy';
import * as projectsApi from '@/api/projects';
import { useEnvStore } from '@/stores/env';
import { mockOrigin } from '@/utils/mock';

const emit = defineEmits(['change']);

const projects = useProjectStore();
const prefs = usePrefsStore();
const tabs = useTabsStore();
const envs = useEnvStore();
const ui = useUiStore();
const message = useMessage();
const dialog = useDialog();

const show = ref(false);
const keyword = ref('');
const searchRef = ref(null);

const showCreate = ref(false);
const creating = ref(false);
/* 导出 OpenAPI 的小弹窗（第四轮第 2 节）：范围是整个项目 */
const showOpenapi = ref(false);
/// 导出文档（第九轮第 2 节）：Markdown / HTML / Word，范围是整个项目
const showExportDoc = ref(false);
// 没有「标识」这一项了：mock 地址改成 /mock-<项目ID>/，标识不再用于 mock（L1）。
// 服务端仍然会自动生成一个唯一标识，只是界面上不用管它。
const form = ref({ name: '', description: '' });

/* ---------------- 下拉里的项目列表 ---------------- */

const byId = computed(function () {
  const map = new Map();
  projects.projects.forEach(function (project) { map.set(project.id, project); });
  return map;
});

/** 按名字 / 说明过滤（搜索框） */
const matched = computed(function () {
  const query = keyword.value.trim().toLowerCase();
  if (!query) return projects.projects;
  return projects.projects.filter(function (project) {
    const name = String(project.name || '').toLowerCase();
    const desc = String(project.description || '').toLowerCase();
    return name.indexOf(query) > -1 || desc.indexOf(query) > -1;
  });
});

const matchedIds = computed(function () {
  const set = new Set();
  matched.value.forEach(function (project) { set.add(project.id); });
  return set;
});

const searching = computed(function () { return Boolean(keyword.value.trim()); });

/** 收藏区：按收藏的先后排 */
const favoriteProjects = computed(function () {
  return prefs.favoriteProjectIds
    .map(function (id) { return byId.value.get(id); })
    .filter(function (project) { return project && matchedIds.value.has(project.id); });
});

/** 「未分组」折叠状态：没有存在偏好里（那三项是固定的），只在这个组件里记着 */
const ungroupedCollapsed = ref(false);

/**
 * 分组区。数组顺序就是分组顺序，和「管理分组」里看到的一致。
 *
 * 搜索时不折叠 —— 找东西的时候还要再点一下展开太别扭；空的分组也不显示。
 */
const sections = computed(function () {
  const list = [];
  const grouped = new Set();

  prefs.projectGroups.forEach(function (group) {
    const ids = group.projectIds || [];
    ids.forEach(function (id) { if (byId.value.has(id)) grouped.add(id); });

    const items = [];
    if (!searching.value) {
      ids.forEach(function (id) {
        const project = byId.value.get(id);
        if (project) items.push(project);
      });
    } else {
      ids.forEach(function (id) {
        const project = byId.value.get(id);
        if (project && matchedIds.value.has(project.id)) items.push(project);
      });
      if (!items.length) return;
    }

    list.push({
      id: group.id,
      name: group.name,
      collapsed: searching.value ? false : group.collapsed === true,
      projects: items,
      empty: items.length === 0
    });
  });

  const rest = matched.value.filter(function (project) { return !grouped.has(project.id); });
  // 一个分组都没有的时候不显示「未分组」这一栏：整屏项目全挂在一个假组下面很怪
  if (prefs.projectGroups.length || rest.length) {
    list.push({
      id: '__ungrouped',
      name: '未分组',
      collapsed: searching.value ? false : ungroupedCollapsed.value,
      projects: rest,
      empty: rest.length === 0,
      ungrouped: true
    });
  }

  return list;
});

const nothingFound = computed(function () {
  return searching.value && !favoriteProjects.value.length &&
    sections.value.every(function (section) { return !section.projects.length; });
});

function toggleSection(section) {
  if (section.ungrouped) {
    ungroupedCollapsed.value = !ungroupedCollapsed.value;
    return;
  }
  prefs.toggleGroupCollapsed(section.id).catch(function (err) { message.error(err.message); });
}

/** 星标：收藏 / 取消收藏一个项目（不切项目） */
async function toggleFavorite(project) {
  try {
    await prefs.toggleProjectFavorite(project.id);
  } catch (err) {
    message.error(err.message);
  }
}

/* ---------------- 打开 / 关闭 ---------------- */

function onShowChange(value) {
  show.value = value;
  if (!value) return;
  keyword.value = '';
  nextTick(function () {
    if (searchRef.value) searchRef.value.focus();
  });
}

/* ---------------- 切换项目 ---------------- */

/** 切项目会把标签页全清掉，有没保存的修改就先问一句 */
function selectProject(id) {
  if (!id || id === projects.currentId) {
    show.value = false;
    return;
  }

  show.value = false;

  if (tabs.hasDirty) {
    dialog.warning({
      title: '切换项目',
      content: '当前有没保存的标签页，切换项目会全部关掉，未保存的修改会丢失。确定切换吗？',
      positiveText: '切换',
      negativeText: '取消',
      onPositiveClick: function () {
        tabs.closeAll();
        projects.setCurrent(id);
        emit('change', id);
      }
    });
    return;
  }

  tabs.closeAll();
  projects.setCurrent(id);
  emit('change', id);
}

/* ---------------- 底部那几个动作 ---------------- */

function run(action) {
  show.value = false;
  action();
}

function openCreate() {
  form.value = { name: '', description: '' };
  showCreate.value = true;
}

async function exportCollection() {
  if (!projects.currentId) return;
  try {
    const data = await importExportApi.exportCollection(projects.currentId);
    downloadJson(data.filename, data.json);
    message.success('已导出');
  } catch (err) {
    message.error(err.message);
  }
}

async function submitCreate() {
  if (!form.value.name.trim()) {
    message.warning('请填写项目名称');
    return;
  }

  creating.value = true;
  try {
    const payload = { name: form.value.name.trim() };
    if (form.value.description.trim()) payload.description = form.value.description.trim();

    const project = await projects.create(payload);
    showCreate.value = false;
    message.success('项目已创建');
    emit('change', project.id);
  } catch (err) {
    message.error(err.message);
  } finally {
    creating.value = false;
  }
}

/* ---------------- 复制为新项目（第六轮第 3 节） ---------------- */

const showDuplicate = ref(false);
const duplicateName = ref('');
const duplicating = ref(false);

/** 默认名字「原名 副本」（和「新建项目」一样只填名字，别的都从源项目带） */
function openDuplicate() {
  const current = projects.current;
  if (!current) return;
  duplicateName.value = current.name + ' 副本';
  showDuplicate.value = true;
}

async function submitDuplicate() {
  const name = duplicateName.value.trim();
  if (!name) {
    message.warning('请填写项目名称');
    return;
  }

  duplicating.value = true;
  try {
    const data = await copyApi.duplicateProject(projects.currentId, { name: name });
    await projects.load();
    showDuplicate.value = false;
    message.success('已复制为新项目「' + data.project.name + '」');
    // 直接切过去：用户点这个菜单多半就是为了在新项目里接着改
    tabs.closeAll();
    projects.setCurrent(data.project.id);
    emit('change', data.project.id);
  } catch (err) {
    message.error(err.message);
  } finally {
    duplicating.value = false;
  }
}

/* ---------------- 创建样例项目（试功能用，见 lib/demo-project.js） ---------------- */

const creatingDemo = ref(false);

/**
 * 建一个什么都配齐了的样例项目，切过去并选中「样例环境」—— 接口都打到它自己的 Mock 上，
 * 点开就能发。客户端里刚建的项目要先同步到云端，Mock 才有（通常几秒）。
 */
async function createDemo() {
  if (creatingDemo.value) return;
  creatingDemo.value = true;
  try {
    const data = await projectsApi.createDemoProject(mockOrigin());
    await projects.load();
    tabs.closeAll();
    projects.setCurrent(data.project.id);
    // 先把「样例环境」记成这个项目选中的环境，切过去时环境列表一加载就是它
    await envs.load(data.project.id);
    if (data.environmentId) envs.select(data.environmentId);
    emit('change', data.project.id);
    message.success('已创建「' + data.project.name + '」，项目说明里写了可以怎么试');
  } catch (err) {
    message.error(err.message);
  } finally {
    creatingDemo.value = false;
  }
}

/* ---------------- 管理分组 ---------------- */

const showGroups = ref(false);
/** 弹窗里编辑中的副本：改名只在失焦 / 回车时提交，不要每敲一个字就写一次 */
const draftGroups = ref([]);
const newGroupName = ref('');

function openGroups() {
  show.value = false;
  syncDraft();
  showGroups.value = true;
}

function syncDraft() {
  draftGroups.value = prefs.projectGroups.map(function (group) {
    return { id: group.id, name: group.name };
  });
}

/** 分组下拉的选项：第一个是「未分组」（值为空字符串） */
const groupOptions = computed(function () {
  return [{ label: '未分组', value: '' }].concat(prefs.projectGroups.map(function (group) {
    return { label: group.name, value: group.id };
  }));
});

function groupValueOf(projectId) {
  const group = prefs.groupOf(projectId);
  return group ? group.id : '';
}

async function commitRename(group) {
  const name = String(group.name || '').trim();
  const original = prefs.projectGroups.find(function (item) { return item.id === group.id; });
  if (!original || original.name === name || !name) {
    syncDraft();
    return;
  }
  try {
    await prefs.renameGroup(group.id, name);
  } catch (err) {
    message.error(err.message);
  }
  syncDraft();
}

async function createGroup() {
  const name = newGroupName.value.trim();
  if (!name) {
    message.warning('请填写分组名称');
    return;
  }
  try {
    await prefs.addGroup(name);
    newGroupName.value = '';
  } catch (err) {
    message.error(err.message);
  }
  syncDraft();
}

function removeGroup(group) {
  dialog.warning({
    title: '删除分组',
    content: '删除「' + group.name + '」后，里面的项目会回到「未分组」，项目本身不受影响。',
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async function () {
      try {
        await prefs.removeGroup(group.id);
      } catch (err) {
        message.error(err.message);
      }
      syncDraft();
    }
  });
}

async function assign(projectId, groupId) {
  try {
    await prefs.assignProject(projectId, groupId || null);
  } catch (err) {
    message.error(err.message);
  }
  syncDraft();
}
</script>

<template>
  <n-popover
    :show="show"
    trigger="click"
    placement="bottom-start"
    :show-arrow="false"
    style="padding: 0"
    @update:show="onShowChange"
  >
    <template #trigger>
      <button class="switcher" :class="{ open: show }">
        <n-icon size="15" :component="Package" />
        <span class="name">{{ projects.current ? projects.current.name : '选择项目' }}</span>
        <n-icon size="14" :component="ChevronDown" />
      </button>
    </template>

    <div class="panel">
      <div class="search">
        <n-input
          ref="searchRef"
          v-model:value="keyword"
          size="small"
          clearable
          placeholder="搜索项目"
          @keydown.esc="show = false"
        >
          <template #prefix>
            <n-icon :component="Search" />
          </template>
        </n-input>
      </div>

      <div class="list">
        <!-- 收藏：排在最上面 -->
        <div v-if="favoriteProjects.length" class="section">
          <div class="section-title">收藏</div>
          <div
            v-for="project in favoriteProjects"
            :key="'fav-' + project.id"
            class="row"
            :class="{ active: project.id === projects.currentId }"
            @click="selectProject(project.id)"
          >
            <span class="row-name">{{ project.name }}</span>
            <button
              class="star on"
              :title="'取消收藏'"
              @click.stop="toggleFavorite(project)"
            >
              <n-icon size="15" :component="Star" />
            </button>
          </div>
        </div>

        <div v-for="section in sections" :key="section.id" class="section">
          <div class="section-head" @click="toggleSection(section)">
            <n-icon size="13" :component="section.collapsed ? ChevronRight : ChevronDown" />
            <span class="section-title flat">{{ section.name }}</span>
            <span class="count">{{ section.projects.length }}</span>
          </div>

          <template v-if="!section.collapsed">
            <div
              v-for="project in section.projects"
              :key="project.id"
              class="row"
              :class="{ active: project.id === projects.currentId }"
              @click="selectProject(project.id)"
            >
              <span class="row-name">{{ project.name }}</span>
              <span v-if="project.description" class="row-desc">{{ project.description }}</span>
              <button
                class="star"
                :class="{ on: prefs.isProjectFavorite(project.id) }"
                :title="prefs.isProjectFavorite(project.id) ? '取消收藏' : '收藏'"
                @click.stop="toggleFavorite(project)"
              >
                <n-icon size="15" :component="Star" />
              </button>
            </div>
            <div v-if="!section.projects.length" class="section-empty">这个分组里还没有项目</div>
          </template>
        </div>

        <div v-if="nothingFound" class="section-empty">没有匹配的项目</div>
      </div>

      <div class="section foot">
        <div class="row action" @click="run(openGroups)">
          <n-icon class="row-icon" size="15" :component="Settings" />
          <span class="row-name">管理分组…</span>
        </div>
        <div class="row action" @click="run(function () { emit('change', '__settings'); })">
          <span class="row-name">项目设置</span>
        </div>
        <div class="row action" @click="run(exportCollection)">
          <span class="row-name">导出为 JSON</span>
        </div>
        <div class="row action" @click="run(function () { showOpenapi = true; })">
          <span class="row-name">导出为 OpenAPI</span>
        </div>
        <div class="row action" @click="run(function () { showExportDoc = true; })">
          <span class="row-name">导出文档…</span>
        </div>
        <!-- 环境对比（第五轮第 3 节）：环境下拉最底下也有一个入口 -->
        <div class="row action" @click="run(function () { tabs.openEnvDiff(); })">
          <span class="row-name">环境对比</span>
        </div>
        <!-- 查找替换（第五轮第 2 节）：快捷键 ⌘⇧F / Ctrl+Shift+F -->
        <div class="row action" @click="run(function () { ui.openFindReplace(); })">
          <span class="row-name">查找替换</span>
        </div>
        <!-- 复制为新项目（第六轮第 3 节）：拿现成的项目当模板 -->
        <div class="row action" @click="run(openDuplicate)">
          <span class="row-name">复制为新项目…</span>
        </div>
        <div class="row action" @click="run(openCreate)">
          <span class="row-name">新建项目</span>
        </div>
        <!-- 样例项目：点一下就有一个什么都配齐了的项目，拿来试功能 -->
        <div class="row action" @click="run(createDemo)">
          <span class="row-name">{{ creatingDemo ? '正在创建样例项目…' : '创建样例项目' }}</span>
        </div>
      </div>
    </div>
  </n-popover>

  <!-- 管理分组：新建 / 改名 / 删除，以及每个项目挑一个分组 -->
  <n-modal
    v-model:show="showGroups"
    preset="card"
    title="管理分组"
    style="width: 520px; max-width: 92vw"
  >
    <div class="manage-section">
      <div class="manage-title">分组</div>

      <div v-for="group in draftGroups" :key="group.id" class="manage-row">
        <n-input
          v-model:value="group.name"
          size="small"
          placeholder="分组名称"
          @blur="commitRename(group)"
          @keyup.enter="commitRename(group)"
        />
        <n-button size="small" quaternary @click="removeGroup(group)">删除</n-button>
      </div>
      <div v-if="!draftGroups.length" class="manage-empty">还没有分组</div>

      <n-space class="manage-add" align="center">
        <n-input
          v-model:value="newGroupName"
          size="small"
          placeholder="新分组名称"
          @keyup.enter="createGroup"
        />
        <n-button size="small" @click="createGroup">
          <template #icon>
            <n-icon :component="Plus" />
          </template>
          新建分组
        </n-button>
      </n-space>
    </div>

    <div class="manage-section">
      <div class="manage-title">项目分组</div>
      <div v-for="project in projects.projects" :key="project.id" class="manage-row">
        <span class="manage-name" :title="project.name">{{ project.name }}</span>
        <n-select
          class="manage-select"
          size="small"
          :value="groupValueOf(project.id)"
          :options="groupOptions"
          @update:value="(value) => assign(project.id, value)"
        />
      </div>
    </div>

    <template #footer>
      <n-space justify="end">
        <n-button @click="showGroups = false">关闭</n-button>
      </n-space>
    </template>
  </n-modal>

  <n-modal
    v-model:show="showCreate"
    preset="card"
    title="新建项目"
    style="width: 440px; max-width: 92vw"
  >
    <n-form>
      <n-form-item label="名称">
        <n-input v-model:value="form.name" placeholder="项目名称" />
      </n-form-item>
      <n-form-item label="说明">
        <n-input v-model:value="form.description" placeholder="可留空" />
      </n-form-item>
    </n-form>

    <template #footer>
      <n-space justify="end">
        <n-button @click="showCreate = false">取消</n-button>
        <n-button type="primary" :loading="creating" @click="submitCreate">创建</n-button>
      </n-space>
    </template>
  </n-modal>

  <!-- 导出 OpenAPI（第四轮第 2 节）：默认 YAML，下载 <项目名>.openapi.yaml -->
  <openapi-export-dialog
    v-model:show="showOpenapi"
    :pid="projects.currentId"
    :folder-id="null"
    :scope-name="projects.current ? projects.current.name : ''"
  />

  <!-- 导出文档（第九轮第 2 节）：整个项目，三种格式 -->
  <export-doc-dialog
    v-model:show="showExportDoc"
    :pid="projects.currentId"
    :folder-id="null"
    :scope-name="projects.current ? projects.current.name : ''"
  />

  <!-- 复制为新项目（第六轮第 3 节） -->
  <n-modal
    v-model:show="showDuplicate"
    preset="card"
    title="复制为新项目"
    style="width: 460px; max-width: 92vw"
  >
    <n-form>
      <n-form-item label="新项目名称">
        <n-input v-model:value="duplicateName" placeholder="新项目名称" @keyup.enter="submitDuplicate" />
      </n-form-item>
    </n-form>
    <p class="duplicate-tip">
      会把「{{ projects.current ? projects.current.name : '' }}」的目录、接口、示例、Mock 期望、
      环境、项目变量、公共请求头、鉴权和脚本都复制一份。成员、历史、评论和分享链接不复制
      （新项目里只有你一个 owner）；保密变量只复制名字，值是空的。
    </p>

    <template #footer>
      <n-space justify="end">
        <n-button @click="showDuplicate = false">取消</n-button>
        <n-button type="primary" :loading="duplicating" @click="submitDuplicate">复制</n-button>
      </n-space>
    </template>
  </n-modal>
</template>

<style scoped>
/* 「复制为新项目」弹窗里那段说明 */
.duplicate-tip {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  opacity: 0.6;
}

/* 项目切换：图标 + 名字 + ▾（只读标签由顶栏紧跟在后面） */
.switcher {
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: 220px;
  height: 28px;
  padding: 0 8px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: inherit;
  font-size: 13px;
  cursor: pointer;
}

.switcher:hover,
.switcher.open {
  background: rgba(128, 128, 128, 0.14);
}

.switcher .name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---------------- 面板 ---------------- */

.panel {
  width: 320px;
  max-width: 90vw;
  font-size: 13px;
}

.search {
  padding: 8px 8px 6px;
}

/* 项目多的时候面板别顶到屏幕外 */
.list {
  max-height: 46vh;
  overflow: auto;
}

.section {
  padding: 4px 6px;
}

.section + .section {
  border-top: 1px solid rgba(128, 128, 128, 0.14);
}

.section-head {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 6px;
  border-radius: 5px;
  cursor: pointer;
}

.section-head:hover {
  background: rgba(128, 128, 128, 0.08);
}

/* 小标题：灰色小字，和下面的条目拉开层级 */
.section-title {
  padding: 4px 8px 6px;
  font-size: 11px;
  letter-spacing: 0.02em;
  opacity: 0.5;
}

.section-title.flat {
  flex: 1;
  min-width: 0;
  padding: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}

.count {
  flex: none;
  font-size: 11px;
  opacity: 0.4;
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 30px;
  padding: 0 8px;
  border-radius: 6px;
  cursor: pointer;
}

.row:hover {
  background: rgba(128, 128, 128, 0.1);
}

/* 当前项目：浅橙底 + 橙字，一眼能看出来 */
.row.active {
  background: rgba(255, 108, 55, 0.1);
  color: var(--apiloop-primary);
  font-weight: 500;
}

.row-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-desc {
  flex: none;
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  opacity: 0.45;
}

.row-icon {
  flex: none;
  opacity: 0.55;
}

.section-empty {
  padding: 4px 10px 8px;
  font-size: 12px;
  opacity: 0.45;
}

/* 星标：平时藏起来（悬停或已收藏才出现），免得一屏全是星星 */
.star {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: inherit;
  opacity: 0;
  cursor: pointer;
}

.row:hover .star {
  opacity: 0.45;
}

.star:hover {
  opacity: 0.9 !important;
}

.star.on {
  opacity: 1;
  color: var(--apiloop-primary);
}

/* 已收藏：tabler 的星是描边的，填上色才像「点亮了」 */
.star.on :deep(svg) {
  fill: currentColor;
}

.foot .row {
  height: 28px;
}

/* ---------------- 管理分组弹窗 ---------------- */

.manage-section + .manage-section {
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px solid rgba(128, 128, 128, 0.14);
}

.manage-title {
  margin-bottom: 8px;
  font-size: 12px;
  opacity: 0.55;
}

.manage-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.manage-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}

.manage-select {
  flex: none;
  width: 160px;
}

.manage-add {
  margin-top: 10px;
}

.manage-empty {
  padding: 4px 0;
  font-size: 12px;
  opacity: 0.45;
}
</style>
