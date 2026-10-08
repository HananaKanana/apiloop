<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import {
  NAlert,
  NButton,
  NEmpty,
  NIcon,
  NInput,
  NPopconfirm,
  NSelect,
  NSpin,
  NTag,
  useMessage
} from 'naive-ui';
import { Folders, Search, Trash, UserPlus } from '@vicons/tabler';
import { isLoginRequired } from '@/api/client';
import * as adminProjectsApi from '@/api/adminProjects';
import { useSessionStore } from '@/stores/session';
import { useProjectStore } from '@/stores/project';

/**
 * 项目总览（管理员，2026-10-08）。
 *
 * 管理员不再自动看到所有项目（只看自己是成员的），所以这里给一个总的入口：
 * 左边是全部项目（接口数、成员数），右边是选中项目的成员，可以加人、改角色、移除 ——
 * 也包括把自己加进去（加完回到工作台，项目下拉里就有它了）。
 */

const router = useRouter();
const message = useMessage();
const session = useSessionStore();
const projectStore = useProjectStore();
const { t } = useI18n();

const loading = ref(false);
const loadError = ref('');
const projects = ref([]);
const users = ref([]);
const keyword = ref('');
const activeId = ref(null);
const busy = ref(false);

const addUserId = ref(null);
const addRole = ref('editor');

const ROLES = ['viewer', 'editor', 'owner'];

const roleOptions = computed(function () {
  return ROLES.map(function (role) {
    return { label: roleLabel(role), value: role };
  });
});

function roleLabel(role) {
  if (role === 'owner') return t('views.poRoleOwner');
  if (role === 'editor') return t('views.poRoleEditor');
  return t('views.poRoleViewer');
}

function showError(err) {
  if (isLoginRequired(err)) message.warning(err.message);
  else message.error(err.message);
}

async function load() {
  loading.value = true;
  loadError.value = '';
  try {
    const data = await adminProjectsApi.overview();
    projects.value = data.projects || [];
    users.value = data.users || [];
    if (!activeId.value || !projects.value.some(function (p) { return p.id === activeId.value; })) {
      activeId.value = projects.value.length ? projects.value[0].id : null;
    }
  } catch (err) {
    loadError.value = err.message;
  } finally {
    loading.value = false;
  }
}

onMounted(load);

const filteredProjects = computed(function () {
  const word = keyword.value.trim().toLowerCase();
  if (!word) return projects.value;
  return projects.value.filter(function (project) {
    if (String(project.name || '').toLowerCase().indexOf(word) > -1) return true;
    return (project.members || []).some(function (m) {
      return String(m.username || '').toLowerCase().indexOf(word) > -1 ||
        String(m.displayName || '').toLowerCase().indexOf(word) > -1;
    });
  });
});

const active = computed(function () {
  return projects.value.find(function (p) { return p.id === activeId.value; }) || null;
});

const totals = computed(function () {
  return {
    projects: projects.value.length,
    users: users.value.filter(function (u) { return !u.pending; }).length,
    noMember: projects.value.filter(function (p) { return !(p.members || []).length; }).length
  };
});

/** 还不在这个项目里的用户（待审核的不算） */
const addableUsers = computed(function () {
  if (!active.value) return [];
  const inProject = new Set((active.value.members || []).map(function (m) { return m.userId; }));
  return users.value
    .filter(function (u) { return !u.pending && !inProject.has(u.id); })
    .map(function (u) {
      const name = u.displayName ? u.displayName + '（' + u.username + '）' : u.username;
      return {
        label: (u.id === (session.user && session.user.id) ? t('views.poMe') + ' · ' : '') + name +
          (u.disabled ? ' · ' + t('views.poDisabled') : ''),
        value: u.id
      };
    });
});

const amMember = computed(function () {
  if (!active.value || !session.user) return false;
  return (active.value.members || []).some(function (m) { return m.userId === session.user.id; });
});

function memberName(member) {
  return member.displayName ? member.displayName + '（' + member.username + '）' : member.username;
}

function replaceProject(next) {
  projects.value = projects.value.map(function (p) { return p.id === next.id ? next : p; });
}

async function afterMembershipChange(touchedSelf) {
  // 自己的成员身份变了：项目下拉要跟着变
  if (touchedSelf) {
    try { await projectStore.refresh(); } catch (err) { /* 下拉刷新失败不影响这里 */ }
  }
}

async function addMember() {
  if (!active.value || !addUserId.value) return;
  busy.value = true;
  try {
    const userId = addUserId.value;
    const data = await adminProjectsApi.setMember(active.value.id, userId, addRole.value);
    replaceProject(data.project);
    addUserId.value = null;
    message.success(t('views.poAdded'));
    await afterMembershipChange(session.user && userId === session.user.id);
  } catch (err) {
    showError(err);
  } finally {
    busy.value = false;
  }
}

async function addMe() {
  if (!session.user) return;
  addUserId.value = session.user.id;
  addRole.value = 'owner';
  await addMember();
}

async function changeRole(member, role) {
  if (!active.value || role === member.role) return;
  busy.value = true;
  try {
    const data = await adminProjectsApi.setMember(active.value.id, member.userId, role);
    replaceProject(data.project);
    await afterMembershipChange(session.user && member.userId === session.user.id);
  } catch (err) {
    showError(err);
  } finally {
    busy.value = false;
  }
}

async function removeMember(member) {
  if (!active.value) return;
  busy.value = true;
  try {
    const data = await adminProjectsApi.removeMember(active.value.id, member.userId);
    replaceProject(data.project);
    message.success(t('views.poRemoved'));
    await afterMembershipChange(session.user && member.userId === session.user.id);
  } catch (err) {
    showError(err);
  } finally {
    busy.value = false;
  }
}

function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  const pad = function (n) { return String(n).padStart(2, '0'); };
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
}
</script>

<template>
  <div class="page">
    <div class="header">
      <div class="header-left">
        <n-button quaternary size="small" @click="router.push('/workbench')">{{ t('views.psBack') }}</n-button>
        <span class="title">{{ t('views.poTitle') }}</span>
        <span v-if="!loading && !loadError" class="totals">
          {{ t('views.poTotals', { projects: totals.projects, users: totals.users }) }}
          <template v-if="totals.noMember"> · <span class="warn">{{ t('views.poNoMemberCount', { n: totals.noMember }) }}</span></template>
        </span>
      </div>
      <n-button size="small" :loading="loading" @click="load">{{ t('views.poRefresh') }}</n-button>
    </div>

    <div class="body">
      <n-alert v-if="loadError" type="error" :show-icon="false" class="error">{{ loadError }}</n-alert>

      <div v-else class="split">
        <!-- 左：全部项目 -->
        <aside class="side">
          <div class="search">
            <n-input v-model:value="keyword" size="small" clearable :placeholder="t('views.poSearch')">
              <template #prefix><n-icon :component="Search" /></template>
            </n-input>
          </div>
          <n-spin :show="loading" class="list-spin">
            <div class="list">
              <button
                v-for="project in filteredProjects"
                :key="project.id"
                class="item"
                :class="{ active: project.id === activeId }"
                @click="activeId = project.id"
              >
                <n-icon :component="Folders" class="item-icon" />
                <span class="item-main">
                  <span class="item-name">{{ project.name }}</span>
                  <span class="item-meta">
                    {{ t('views.poApiCount', { n: project.apiCount }) }} ·
                    <span :class="{ warn: !project.members.length }">{{ t('views.poMemberCount', { n: project.members.length }) }}</span>
                  </span>
                </span>
              </button>
              <n-empty v-if="!loading && !filteredProjects.length" size="small" :description="t('views.poEmpty')" class="empty" />
            </div>
          </n-spin>
        </aside>

        <!-- 右：选中项目的成员 -->
        <section class="main">
          <template v-if="active">
            <div class="main-head">
              <div>
                <div class="main-title">
                  {{ active.name }}
                  <n-tag v-if="active.isRoot" size="small" :bordered="false">{{ t('views.poRoot') }}</n-tag>
                </div>
                <div class="main-sub">
                  {{ t('views.poApiCount', { n: active.apiCount }) }} · {{ t('views.poFolderCount', { n: active.folderCount }) }} ·
                  {{ t('views.poCreatedAt', { date: formatDate(active.createdAt) }) }}
                </div>
                <div v-if="active.description" class="main-desc">{{ active.description }}</div>
              </div>
              <n-button v-if="!amMember" size="small" :loading="busy" @click="addMe">{{ t('views.poAddMe') }}</n-button>
            </div>

            <div class="section-title">{{ t('views.poMembers') }}</div>
            <div v-if="!active.members.length" class="no-member">{{ t('views.poNoMember') }}</div>
            <div v-for="member in active.members" :key="member.userId" class="member">
              <span class="avatar">{{ (member.displayName || member.username || '?').slice(0, 1).toUpperCase() }}</span>
              <span class="member-name">
                {{ memberName(member) }}
                <n-tag v-if="session.user && member.userId === session.user.id" size="tiny" :bordered="false" type="info">{{ t('views.poMe') }}</n-tag>
                <n-tag v-if="member.disabled" size="tiny" :bordered="false">{{ t('views.poDisabled') }}</n-tag>
              </span>
              <n-select
                class="member-role"
                size="small"
                :value="member.role"
                :options="roleOptions"
                :disabled="busy"
                @update:value="(role) => changeRole(member, role)"
              />
              <n-popconfirm @positive-click="removeMember(member)">
                <template #trigger>
                  <n-button quaternary circle size="small" :disabled="busy" :title="t('views.poRemove')">
                    <template #icon><n-icon :component="Trash" /></template>
                  </n-button>
                </template>
                {{ t('views.poRemoveConfirm', { name: memberName(member) }) }}
              </n-popconfirm>
            </div>

            <div class="add-row">
              <n-select
                v-model:value="addUserId"
                size="small"
                filterable
                clearable
                class="add-user"
                :options="addableUsers"
                :placeholder="addableUsers.length ? t('views.poAddPlaceholder') : t('views.poAllIn')"
                :disabled="!addableUsers.length || busy"
              />
              <n-select v-model:value="addRole" size="small" class="add-role" :options="roleOptions" :disabled="busy" />
              <n-button size="small" type="primary" :disabled="!addUserId" :loading="busy" @click="addMember">
                <template #icon><n-icon :component="UserPlus" /></template>
                {{ t('views.poAdd') }}
              </n-button>
            </div>
            <p class="tip">{{ t('views.poTip') }}</p>
          </template>
          <n-empty v-else-if="!loading" :description="t('views.poPick')" class="empty" />
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page {
  height: 100%;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
}

.header {
  height: 48px;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px;
  border-bottom: 1px solid var(--apiloop-divider, rgba(128, 128, 128, 0.2));
}

.header-left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.title {
  font-size: 15px;
  font-weight: 600;
}

.totals {
  font-size: 12px;
  opacity: 0.6;
}

.warn {
  color: #d97706;
}

.body {
  flex: 1;
  min-height: 0;
  padding: 12px;
  box-sizing: border-box;
}

.error {
  max-width: 640px;
}

.split {
  height: 100%;
  display: flex;
  border: 1px solid var(--apiloop-divider, rgba(128, 128, 128, 0.2));
  border-radius: 8px;
  overflow: hidden;
}

.side {
  width: 280px;
  flex: none;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--apiloop-divider, rgba(128, 128, 128, 0.2));
}

.search {
  padding: 10px;
}

.list-spin {
  flex: 1;
  min-height: 0;
}

.list {
  height: 100%;
  overflow: auto;
  padding: 0 6px 8px;
  box-sizing: border-box;
}

.item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.item:hover {
  background: rgba(128, 128, 128, 0.1);
}

.item.active {
  background: rgba(255, 108, 55, 0.12);
}

.item-icon {
  flex: none;
  opacity: 0.6;
}

.item-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.item-name {
  font-size: 13px;
  font-weight: 500;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.item-meta {
  font-size: 12px;
  opacity: 0.6;
}

.main {
  flex: 1;
  min-width: 0;
  overflow: auto;
  padding: 16px 20px;
}

.main-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 18px;
}

.main-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 16px;
  font-weight: 600;
}

.main-sub {
  margin-top: 4px;
  font-size: 12px;
  opacity: 0.6;
}

.main-desc {
  margin-top: 6px;
  font-size: 13px;
  opacity: 0.8;
  white-space: pre-wrap;
}

.section-title {
  font-size: 12px;
  font-weight: 600;
  opacity: 0.6;
  margin-bottom: 6px;
}

.no-member {
  padding: 10px 0;
  font-size: 13px;
  color: #d97706;
}

.member {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 0;
  border-bottom: 1px solid var(--apiloop-divider, rgba(128, 128, 128, 0.2));
}

.avatar {
  width: 26px;
  height: 26px;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: rgba(128, 128, 128, 0.18);
  font-size: 12px;
  font-weight: 600;
}

.member-name {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}

.member-role {
  width: 120px;
  flex: none;
}

.add-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 14px;
}

.add-user {
  flex: 1;
  min-width: 0;
}

.add-role {
  width: 120px;
  flex: none;
}

.tip {
  margin: 10px 0 0;
  font-size: 12px;
  opacity: 0.55;
  line-height: 1.6;
}

.empty {
  margin-top: 40px;
}
</style>
