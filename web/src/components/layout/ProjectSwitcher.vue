<script setup>
import { computed, nextTick, ref } from 'vue';
import { useI18n } from 'vue-i18n';
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
import {
  Api,
  ArrowDown,
  ArrowUp,
  Braces,
  ChevronDown,
  ChevronRight,
  Copy,
  DatabaseImport,
  FileText,
  Flask,
  Folder,
  Folders,
  GitCompare,
  Package,
  Pencil,
  Plus,
  Replace,
  Search,
  Settings,
  Star,
  Trash
} from '@vicons/tabler';
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
import RestoreDialog from '@/components/backup/RestoreDialog.vue';

const emit = defineEmits(['change']);

const projects = useProjectStore();
const prefs = usePrefsStore();
const tabs = useTabsStore();
const envs = useEnvStore();
const ui = useUiStore();
const message = useMessage();
const dialog = useDialog();
const { t } = useI18n();

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
      name: t('layout.ungrouped'),
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
      title: t('layout.switchProjectTitle'),
      content: t('layout.switchProjectBody'),
      positiveText: t('layout.switchAction'),
      negativeText: t('app.cancel'),
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
    message.success(t('layout.exported'));
  } catch (err) {
    message.error(err.message);
  }
}

async function submitCreate() {
  if (!form.value.name.trim()) {
    message.warning(t('layout.projectNameRequired'));
    return;
  }

  creating.value = true;
  try {
    const payload = { name: form.value.name.trim() };
    if (form.value.description.trim()) payload.description = form.value.description.trim();

    const project = await projects.create(payload);
    showCreate.value = false;
    message.success(t('layout.projectCreated'));
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
  duplicateName.value = current.name + t('layout.duplicateNameSuffix');
  showDuplicate.value = true;
}

async function submitDuplicate() {
  const name = duplicateName.value.trim();
  if (!name) {
    message.warning(t('layout.projectNameRequired'));
    return;
  }

  duplicating.value = true;
  try {
    const data = await copyApi.duplicateProject(projects.currentId, { name: name });
    await projects.load();
    showDuplicate.value = false;
    message.success(t('layout.duplicatedAs', { name: data.project.name }));
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
    message.success(t('layout.demoCreated', { name: data.project.name }));
  } catch (err) {
    message.error(err.message);
  } finally {
    creatingDemo.value = false;
  }
}

/* ---------------- 删除项目 ---------------- */

/**
 * 以前只有项目设置页右上角一个不起眼的红字按钮，用户找不到（2026-10-07），下拉里也放一个。
 * 只有 owner / 管理员能删；默认项目、根项目服务端不让删，这里干脆不显示。
 */
const canDeleteCurrent = computed(function () {
  const current = projects.current;
  return Boolean(current && projects.isOwner && !current.isDefault && !current.isRoot);
});

function deleteCurrent() {
  const current = projects.current;
  if (!current) return;
  dialog.error({
    title: t('views.psDeleteTitle'),
    content: t('views.psDeleteBody', { name: current.name }),
    positiveText: t('app.delete'),
    negativeText: t('app.cancel'),
    onPositiveClick: async function () {
      try {
        tabs.closeAll();
        await projects.remove(current.id);
        message.success(t('views.psDeleted'));
        if (projects.currentId) emit('change', projects.currentId);
      } catch (err) {
        message.error(err.message);
      }
    }
  });
}

/* ---------------- 从备份恢复成新项目（第十四轮第 2 节） ---------------- */

const showRestore = ref(false);

/**
 * 恢复完直接切过去（和「复制为新项目」一样：点这个菜单多半就是为了在新项目里接着看）。
 * 恢复出来的是一个**新项目**，目录树 / 环境 / 标签页都要换成它的。
 */
async function onRestored(data) {
  const project = data && data.project;
  await projects.load();
  if (!project) return;

  tabs.closeAll();
  projects.setCurrent(project.id);
  emit('change', project.id);
}

/* ---------------- 管理分组 ---------------- */

/*
 * 左右两栏（2026-10-07 用户选的）：左边分组列表（最后是「未分组」），右边是选中那一组里的项目。
 * 右边可以改名 / 删除分组、移出项目、从下拉里添加项目；「未分组」里每个项目可以直接放进某个分组。
 */
const UNGROUPED = '__ungrouped';

const showGroups = ref(false);
const activeGroupId = ref(UNGROUPED);
/** 左栏底下「新建分组」的输入框：点 + 才出来 */
const addingGroup = ref(false);
const newGroupName = ref('');
const newGroupRef = ref(null);
/** 右栏标题改名：null 是没在改 */
const renameDraft = ref(null);

function openGroups() {
  show.value = false;
  addingGroup.value = false;
  renameDraft.value = null;
  activeGroupId.value = prefs.projectGroups.length ? prefs.projectGroups[0].id : UNGROUPED;
  showGroups.value = true;
}

/** 这个分组里现有的项目 id（去掉已经不存在的项目） */
function groupProjectIds(groupId) {
  const group = prefs.projectGroups.find(function (item) { return item.id === groupId; });
  if (!group) return [];
  return (group.projectIds || []).filter(function (id) { return byId.value.has(id); });
}

const ungroupedProjects = computed(function () {
  return projects.projects.filter(function (project) { return !prefs.groupOf(project.id); });
});

/** 左栏：每个分组 + 项目数，最后是「未分组」 */
const groupList = computed(function () {
  return prefs.projectGroups.map(function (group) {
    return { id: group.id, name: group.name, count: groupProjectIds(group.id).length };
  });
});

const activeGroup = computed(function () {
  if (activeGroupId.value === UNGROUPED) return null;
  return prefs.projectGroups.find(function (item) { return item.id === activeGroupId.value; }) || null;
});

/** 右栏列出的项目 */
const activeProjects = computed(function () {
  if (!activeGroup.value) return ungroupedProjects.value;
  return groupProjectIds(activeGroup.value.id).map(function (id) { return byId.value.get(id); });
});

/** 右栏底下「添加项目」的选项：不在这一组的项目，在别的组的注明在哪 */
const addProjectOptions = computed(function () {
  if (!activeGroup.value) return [];
  const groupId = activeGroup.value.id;
  return projects.projects
    .filter(function (project) {
      const group = prefs.groupOf(project.id);
      return !group || group.id !== groupId;
    })
    .map(function (project) {
      const other = prefs.groupOf(project.id);
      return {
        label: other ? project.name + t('layout.inGroupSuffix', { name: other.name }) : project.name,
        value: project.id
      };
    });
});

/** 「未分组」里每个项目后面的「放到分组」下拉 */
const moveToOptions = computed(function () {
  return prefs.projectGroups.map(function (group) { return { label: group.name, value: group.id }; });
});

function selectGroup(id) {
  activeGroupId.value = id;
  renameDraft.value = null;
}

function startAddGroup() {
  addingGroup.value = true;
  newGroupName.value = '';
  nextTick(function () {
    if (newGroupRef.value) newGroupRef.value.focus();
  });
}

/** 回车之后输入框会失焦，blur 又来一次 —— 正在建的时候别再建一个 */
let creatingGroup = false;

async function createGroup() {
  if (creatingGroup) return;
  const name = newGroupName.value.trim();
  if (!name) {
    addingGroup.value = false;
    return;
  }
  creatingGroup = true;
  try {
    const list = await prefs.addGroup(name);
    const created = list[list.length - 1];
    if (created) activeGroupId.value = created.id;
    addingGroup.value = false;
    newGroupName.value = '';
  } catch (err) {
    message.error(err.message);
  } finally {
    creatingGroup = false;
  }
}

function startRename() {
  if (!activeGroup.value) return;
  renameDraft.value = activeGroup.value.name;
}

async function commitRename() {
  const group = activeGroup.value;
  const name = String(renameDraft.value || '').trim();
  renameDraft.value = null;
  if (!group || !name || name === group.name) return;
  try {
    await prefs.renameGroup(group.id, name);
  } catch (err) {
    message.error(err.message);
  }
}

function removeGroup() {
  const group = activeGroup.value;
  if (!group) return;
  dialog.warning({
    title: t('layout.deleteGroupTitle'),
    content: t('layout.deleteGroupBody', { name: group.name }),
    positiveText: t('app.delete'),
    negativeText: t('app.cancel'),
    onPositiveClick: async function () {
      try {
        await prefs.removeGroup(group.id);
        activeGroupId.value = prefs.projectGroups.length ? prefs.projectGroups[0].id : UNGROUPED;
      } catch (err) {
        message.error(err.message);
      }
    }
  });
}

/* 分组排序：右栏标题的上移 / 下移，或者在左栏里拖 */

const activeIndex = computed(function () {
  return prefs.projectGroups.findIndex(function (group) { return group.id === activeGroupId.value; });
});

async function moveGroupTo(id, index) {
  try {
    await prefs.moveGroup(id, index);
  } catch (err) {
    message.error(err.message);
  }
}

function moveActive(delta) {
  if (activeIndex.value === -1) return;
  moveGroupTo(activeGroupId.value, activeIndex.value + delta);
}

/** 拖拽：拖着的分组 id；悬停在哪一行、插到它上面还是下面 */
const dragGroupId = ref('');
const dropHint = ref({ id: '', after: false });

function onGroupDragStart(event, group) {
  dragGroupId.value = group.id;
  event.dataTransfer.effectAllowed = 'move';
  // Firefox 不 setData 就拖不起来
  event.dataTransfer.setData('text/plain', group.id);
}

function onGroupDragOver(event, group) {
  if (!dragGroupId.value) return;
  event.preventDefault();
  const rect = event.currentTarget.getBoundingClientRect();
  dropHint.value = { id: group.id, after: event.clientY > rect.top + rect.height / 2 };
}

function onGroupDrop(event, group) {
  event.preventDefault();
  const dragId = dragGroupId.value;
  const after = dropHint.value.after;
  onGroupDragEnd();
  if (!dragId || dragId === group.id) return;

  const ids = prefs.projectGroups.map(function (item) { return item.id; });
  const from = ids.indexOf(dragId);
  let to = ids.indexOf(group.id) + (after ? 1 : 0);
  // 先拿掉自己再插：原位置在目标前面时，目标下标要减一
  if (from < to) to -= 1;
  moveGroupTo(dragId, to);
}

function onGroupDragEnd() {
  dragGroupId.value = '';
  dropHint.value = { id: '', after: false };
}

/** 放进某个分组 / 移出（groupId 为 null 就是回到「未分组」） */
async function assign(projectId, groupId) {
  try {
    await prefs.assignProject(projectId, groupId || null);
  } catch (err) {
    message.error(err.message);
  }
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
        <span class="name">{{ projects.current ? projects.current.name : t('layout.selectProject') }}</span>
        <n-icon size="14" :component="ChevronDown" />
      </button>
    </template>

    <!-- 左边项目列表，右边按类别分好的操作（2026-10-07：原来十一个操作排成一长列压在列表下面，很乱） -->
    <div class="panel">
      <div class="projects-col">
        <div class="search">
          <n-input
            ref="searchRef"
            v-model:value="keyword"
            size="small"
            clearable
            :placeholder="t('layout.searchProjects')"
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
            <div class="section-title">{{ t('layout.favorites') }}</div>
            <div
              v-for="project in favoriteProjects"
              :key="'fav-' + project.id"
              class="row"
              :class="{ active: project.id === projects.currentId }"
              :title="project.description || project.name"
              @click="selectProject(project.id)"
            >
              <span class="row-name">{{ project.name }}</span>
              <button
                class="star on"
                :title="t('layout.removeFavorite')"
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
              <!-- 说明不再挤在行尾（截断后看着乱），悬停时显示 -->
              <div
                v-for="project in section.projects"
                :key="project.id"
                class="row grouped"
                :class="{ active: project.id === projects.currentId }"
                :title="project.description || project.name"
                @click="selectProject(project.id)"
              >
                <span class="row-name">{{ project.name }}</span>
                <button
                  class="star"
                  :class="{ on: prefs.isProjectFavorite(project.id) }"
                  :title="prefs.isProjectFavorite(project.id) ? t('layout.removeFavorite') : t('layout.addFavorite')"
                  @click.stop="toggleFavorite(project)"
                >
                  <n-icon size="15" :component="Star" />
                </button>
              </div>
              <div v-if="!section.projects.length" class="section-empty">{{ t('layout.emptyGroup') }}</div>
            </template>
          </div>

          <div v-if="nothingFound" class="section-empty">{{ t('layout.noMatchingProjects') }}</div>
        </div>

        <!-- 分组是整个列表的事，入口放在列表底下 -->
        <div class="list-foot">
          <div class="row action" @click="run(openGroups)">
            <n-icon class="row-icon" size="15" :component="Folders" />
            <span class="row-name">{{ t('layout.manageGroups') }}</span>
          </div>
        </div>
      </div>

      <div class="actions-col">
        <div class="action-group">
          <div class="action-title">{{ t('layout.actionsCurrent') }}</div>
          <div class="row action" @click="run(function () { emit('change', '__settings'); })">
            <n-icon class="row-icon" size="15" :component="Settings" />
            <span class="row-name">{{ t('layout.projectSettings') }}</span>
          </div>
          <!-- 环境对比（第五轮第 3 节）：环境下拉最底下也有一个入口 -->
          <div class="row action" @click="run(function () { tabs.openEnvDiff(); })">
            <n-icon class="row-icon" size="15" :component="GitCompare" />
            <span class="row-name">{{ t('layout.environmentDiff') }}</span>
          </div>
          <!-- 查找替换（第五轮第 2 节）：快捷键 ⌘⇧F / Ctrl+Shift+F -->
          <div class="row action" @click="run(function () { ui.openFindReplace(); })">
            <n-icon class="row-icon" size="15" :component="Replace" />
            <span class="row-name">{{ t('layout.findReplace') }}</span>
          </div>
          <div v-if="canDeleteCurrent" class="row action danger" @click="run(deleteCurrent)">
            <n-icon class="row-icon" size="15" :component="Trash" />
            <span class="row-name">{{ t('views.psDeleteAction') }}</span>
          </div>
        </div>

        <div class="action-group">
          <div class="action-title">{{ t('layout.actionsExport') }}</div>
          <div class="row action" @click="run(exportCollection)">
            <n-icon class="row-icon" size="15" :component="Braces" />
            <span class="row-name">{{ t('layout.exportJson') }}</span>
          </div>
          <div class="row action" @click="run(function () { showOpenapi = true; })">
            <n-icon class="row-icon" size="15" :component="Api" />
            <span class="row-name">{{ t('layout.exportOpenapi') }}</span>
          </div>
          <div class="row action" @click="run(function () { showExportDoc = true; })">
            <n-icon class="row-icon" size="15" :component="FileText" />
            <span class="row-name">{{ t('layout.exportDocument') }}</span>
          </div>
        </div>

        <div class="action-group">
          <div class="action-title">{{ t('layout.actionsCreate') }}</div>
          <div class="row action" @click="run(openCreate)">
            <n-icon class="row-icon" size="15" :component="Plus" />
            <span class="row-name">{{ t('layout.newProject') }}</span>
          </div>
          <!-- 复制为新项目（第六轮第 3 节）：拿现成的项目当模板 -->
          <div class="row action" @click="run(openDuplicate)">
            <n-icon class="row-icon" size="15" :component="Copy" />
            <span class="row-name">{{ t('layout.duplicateAsNew') }}</span>
          </div>
          <!-- 从备份恢复成新项目（第十四轮第 2 节）：拿之前下载的备份文件建一个新项目 -->
          <div class="row action" @click="run(function () { showRestore = true; })">
            <n-icon class="row-icon" size="15" :component="DatabaseImport" />
            <span class="row-name">{{ t('backup.restoreFromFileMenu') }}</span>
          </div>
          <!-- 样例项目：点一下就有一个什么都配齐了的项目，拿来试功能 -->
          <div class="row action" @click="run(createDemo)">
            <n-icon class="row-icon" size="15" :component="Flask" />
            <span class="row-name">{{ creatingDemo ? t('layout.creatingDemo') : t('layout.createDemo') }}</span>
          </div>
        </div>
      </div>
    </div>
  </n-popover>

  <!--
    管理分组：左边分组列表，右边选中分组里的项目（2026-10-07 用户选的左右两栏）。
    以前试过「分组列表 + 每个项目一个下拉」和「每组一张卡片 + 多选框」，用户都说丑。
  -->
  <n-modal
    v-model:show="showGroups"
    preset="card"
    :title="t('layout.manageGroupsTitle')"
    style="width: 640px; max-width: 94vw"
    content-style="padding: 0"
  >
    <div class="gm">
      <!-- 左栏：分组 -->
      <div class="gm-side">
        <div class="gm-side-head">
          <span>{{ t('layout.groupSection') }}</span>
          <n-button size="tiny" quaternary circle :title="t('layout.createGroupAction')" @click="startAddGroup">
            <template #icon>
              <n-icon :component="Plus" />
            </template>
          </n-button>
        </div>

        <div class="gm-side-list">
          <!-- 拖着上下换位置 -->
          <div
            v-for="group in groupList"
            :key="group.id"
            class="gm-item"
            :class="{
              active: activeGroupId === group.id,
              dragging: dragGroupId === group.id,
              'drop-before': dropHint.id === group.id && !dropHint.after,
              'drop-after': dropHint.id === group.id && dropHint.after
            }"
            draggable="true"
            :title="t('layout.dragToReorder')"
            @click="selectGroup(group.id)"
            @dragstart="onGroupDragStart($event, group)"
            @dragover="onGroupDragOver($event, group)"
            @drop="onGroupDrop($event, group)"
            @dragend="onGroupDragEnd"
          >
            <n-icon class="gm-item-icon" size="15" :component="Folder" />
            <span class="gm-item-name">{{ group.name }}</span>
            <span class="gm-item-count">{{ group.count }}</span>
          </div>

          <div v-if="addingGroup" class="gm-new">
            <n-input
              ref="newGroupRef"
              v-model:value="newGroupName"
              size="small"
              :placeholder="t('layout.newGroupNamePlaceholder')"
              @keyup.enter="createGroup"
              @keyup.esc="addingGroup = false"
              @blur="createGroup"
            />
          </div>
          <div v-else-if="!groupList.length" class="gm-hint">{{ t('layout.noGroups') }}</div>

          <div
            class="gm-item gm-ungrouped"
            :class="{ active: activeGroupId === UNGROUPED }"
            @click="selectGroup(UNGROUPED)"
          >
            <span class="gm-item-name">{{ t('layout.ungrouped') }}</span>
            <span class="gm-item-count">{{ ungroupedProjects.length }}</span>
          </div>
        </div>
      </div>

      <!-- 右栏：选中分组里的项目 -->
      <div class="gm-main">
        <div class="gm-main-head">
          <template v-if="activeGroup">
            <n-input
              v-if="renameDraft !== null"
              v-model:value="renameDraft"
              size="small"
              class="gm-rename"
              autofocus
              @keyup.enter="commitRename"
              @keyup.esc="renameDraft = null"
              @blur="commitRename"
            />
            <span v-else class="gm-title">{{ activeGroup.name }}</span>
            <span class="spacer" />
            <n-button
              size="small"
              quaternary
              circle
              :title="t('layout.moveGroupUp')"
              :disabled="activeIndex <= 0"
              @click="moveActive(-1)"
            >
              <template #icon>
                <n-icon :component="ArrowUp" />
              </template>
            </n-button>
            <n-button
              size="small"
              quaternary
              circle
              :title="t('layout.moveGroupDown')"
              :disabled="activeIndex === -1 || activeIndex >= groupList.length - 1"
              @click="moveActive(1)"
            >
              <template #icon>
                <n-icon :component="ArrowDown" />
              </template>
            </n-button>
            <n-button v-if="renameDraft === null" size="small" quaternary @click="startRename">
              <template #icon>
                <n-icon :component="Pencil" />
              </template>
              {{ t('layout.renameGroup') }}
            </n-button>
            <n-button size="small" quaternary @click="removeGroup">
              <template #icon>
                <n-icon :component="Trash" />
              </template>
              {{ t('app.delete') }}
            </n-button>
          </template>
          <template v-else>
            <span class="gm-title">{{ t('layout.ungrouped') }}</span>
          </template>
        </div>

        <div class="gm-main-list">
          <div v-for="project in activeProjects" :key="project.id" class="gm-row">
            <n-icon class="gm-item-icon" size="15" :component="Package" />
            <span class="gm-row-name" :title="project.name">{{ project.name }}</span>
            <n-button v-if="activeGroup" size="tiny" quaternary @click="assign(project.id, null)">
              {{ t('layout.removeFromGroup') }}
            </n-button>
            <n-select
              v-else-if="moveToOptions.length"
              class="gm-move"
              size="tiny"
              :value="null"
              :options="moveToOptions"
              :placeholder="t('layout.moveToGroup')"
              @update:value="(value) => assign(project.id, value)"
            />
          </div>
          <div v-if="!activeProjects.length" class="gm-hint">
            {{ activeGroup ? t('layout.emptyGroup') : t('layout.allGrouped') }}
          </div>
        </div>

        <div v-if="activeGroup" class="gm-main-foot">
          <n-select
            filterable
            size="small"
            :value="null"
            :options="addProjectOptions"
            :placeholder="t('layout.addProjectToGroup')"
            @update:value="(value) => assign(value, activeGroup.id)"
          />
        </div>
      </div>
    </div>

    <template #footer>
      <n-space justify="end">
        <n-button @click="showGroups = false">{{ t('app.close') }}</n-button>
      </n-space>
    </template>
  </n-modal>

  <n-modal
    v-model:show="showCreate"
    preset="card"
    :title="t('layout.newProject')"
    style="width: 440px; max-width: 92vw"
  >
    <n-form>
      <n-form-item :label="t('layout.name')">
        <n-input v-model:value="form.name" :placeholder="t('layout.projectNamePlaceholder')" />
      </n-form-item>
      <n-form-item :label="t('layout.description')">
        <n-input v-model:value="form.description" :placeholder="t('layout.optionalPlaceholder')" />
      </n-form-item>
    </n-form>

    <template #footer>
      <n-space justify="end">
        <n-button @click="showCreate = false">{{ t('app.cancel') }}</n-button>
        <n-button type="primary" :loading="creating" @click="submitCreate">{{ t('layout.createAction') }}</n-button>
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
    :title="t('layout.duplicateAsNew')"
    style="width: 460px; max-width: 92vw"
  >
    <n-form>
      <n-form-item :label="t('layout.newProjectName')">
        <n-input
          v-model:value="duplicateName"
          :placeholder="t('layout.newProjectName')"
          @keyup.enter="submitDuplicate"
        />
      </n-form-item>
    </n-form>
    <p class="duplicate-tip">
      {{ t('layout.duplicateBody', { name: projects.current ? projects.current.name : '' }) }}
    </p>

    <template #footer>
      <n-space justify="end">
        <n-button @click="showDuplicate = false">{{ t('app.cancel') }}</n-button>
        <n-button type="primary" :loading="duplicating" @click="submitDuplicate">{{ t('layout.duplicateAction') }}</n-button>
      </n-space>
    </template>
  </n-modal>

  <!-- 从备份恢复成新项目（第十四轮第 2 节）：预览 + 可改名，恢复完切过去 -->
  <restore-dialog
    v-model:show="showRestore"
    mode="new"
    :pid="projects.currentId"
    :project-name="projects.current ? projects.current.name : ''"
    @restored="onRestored"
  />
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
  display: flex;
  width: 500px;
  max-width: 92vw;
  font-size: 13px;
}

.projects-col {
  flex: 1;
  min-width: 0;
}

/* 右边的操作栏：浅底色和左边的项目列表分开 */
.actions-col {
  flex: none;
  width: 172px;
  padding: 6px;
  border-left: 1px solid rgba(128, 128, 128, 0.14);
  background: rgba(128, 128, 128, 0.04);
}

.action-group + .action-group {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid rgba(128, 128, 128, 0.12);
}

.action-title {
  padding: 4px 8px;
  font-size: 11px;
  opacity: 0.5;
}

.search {
  padding: 8px 8px 6px;
}

/* 项目多的时候面板别顶到屏幕外 */
.list {
  max-height: 60vh;
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

/* 分组里的项目往里缩，和分组名对齐 */
.row.grouped {
  padding-left: 23px;
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

/* 删除项目：红字 */
.row.danger {
  color: var(--n-error-color, #d03050);
}

.row.danger .row-icon {
  opacity: 0.8;
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

/*
 * 已收藏：tabler 的星是描边的，填上色才像「点亮了」。
 * 要打到 **path** 上：「不填色」（fill="none"）写在 path 自己身上，只给外层 svg 设填色盖不住它，
 * 星星看起来一直是空心的（2026-10-04 用户截图）。
 */
.star.on :deep(svg path) {
  fill: currentColor;
}

.actions-col .row,
.list-foot .row {
  height: 28px;
}

.list-foot {
  padding: 4px 6px 6px;
  border-top: 1px solid rgba(128, 128, 128, 0.14);
}



/* ---------------- 管理分组弹窗 ---------------- */

.gm {
  display: flex;
  height: 420px;
  max-height: 64vh;
  border-top: 1px solid rgba(128, 128, 128, 0.14);
  border-bottom: 1px solid rgba(128, 128, 128, 0.14);
}

.gm-side {
  flex: none;
  width: 200px;
  display: flex;
  flex-direction: column;
  border-right: 1px solid rgba(128, 128, 128, 0.14);
  background: rgba(128, 128, 128, 0.04);
}

.gm-side-head,
.gm-main-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 44px;
  padding: 0 12px;
}

.gm-side-head {
  justify-content: space-between;
  font-size: 12px;
  opacity: 0.75;
}

.gm-side-list,
.gm-main-list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 0 8px 8px;
}

.gm-item {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 32px;
  padding: 0 8px;
  border-radius: 6px;
  font-size: 13px;
  cursor: pointer;
}

.gm-item:hover {
  background: rgba(128, 128, 128, 0.1);
}

.gm-item.active {
  background: rgba(255, 108, 55, 0.1);
  color: var(--apiloop-primary);
  font-weight: 500;
}

.gm-item.dragging {
  opacity: 0.4;
}

/* 插入位置：上 / 下一条橙线 */
.gm-item.drop-before {
  box-shadow: inset 0 2px 0 var(--apiloop-primary);
}

.gm-item.drop-after {
  box-shadow: inset 0 -2px 0 var(--apiloop-primary);
}

.gm-ungrouped {
  margin-top: 6px;
  border-top: 1px dashed rgba(128, 128, 128, 0.2);
  border-radius: 0 0 6px 6px;
}

.gm-item-icon {
  flex: none;
  opacity: 0.55;
}

.gm-item-name,
.gm-row-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gm-item-count {
  flex: none;
  font-size: 12px;
  opacity: 0.45;
}

.gm-new {
  padding: 4px 0;
}

.gm-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.gm-main-head {
  border-bottom: 1px solid rgba(128, 128, 128, 0.12);
  padding: 0 16px;
}

.gm-title {
  font-size: 15px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gm-rename {
  max-width: 240px;
}

.gm-main-list {
  padding: 6px 8px;
}

.gm-row {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 36px;
  padding: 0 8px;
  border-radius: 6px;
  font-size: 13px;
}

.gm-row:hover {
  background: rgba(128, 128, 128, 0.06);
}

.gm-move {
  flex: none;
  width: 140px;
}

.gm-main-foot {
  flex: none;
  padding: 10px 16px;
  border-top: 1px solid rgba(128, 128, 128, 0.12);
}

.gm-hint {
  padding: 16px 8px;
  font-size: 12px;
  text-align: center;
  opacity: 0.45;
}
</style>
