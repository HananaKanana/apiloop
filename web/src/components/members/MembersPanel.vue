<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  NButton,
  NEmpty,
  NSelect,
  NSpace,
  NSpin,
  NTag,
  useMessage
} from 'naive-ui';
import { useDialog } from '@/utils/dialog';
import { isLoginRequired } from '@/api/client';
import * as membersApi from '@/api/members';
import { setMembers } from '@/utils/projectMembers';
import { useProjectStore } from '@/stores/project';
import { useSessionStore } from '@/stores/session';

/**
 * 项目成员。owner 能改角色、移除别人；每个人都能退出项目。
 *
 * 「至少保留一个 owner」这条规则由服务端判定（要在事务里看），这里只管把
 * 服务端返回的 400 原样提示出来，不在前端自己猜。
 */
const props = defineProps({
  pid: { type: String, required: true }
});

const emit = defineEmits(['left']);

const projects = useProjectStore();
const session = useSessionStore();
const message = useMessage();

/**
 * 这些接口都是「只有云端有的功能」：没登录时网关返回 409 + LOGIN_REQUIRED。
 * 那是「要先登录」，不是出错，所以用提示语气，也别跳登录页（客户端只在 401 时跳）。
 */
function showError(err) {
  if (isLoginRequired(err)) message.warning(err.message);
  else message.error(err.message);
}
const dialog = useDialog();
const { t } = useI18n();

const members = ref([]);
const loading = ref(false);

const userOptions = ref([]);
const searching = ref(false);
const newUserId = ref(null);
const newRole = ref('editor');
const adding = ref(false);

let searchTimer = null;

/** 角色下拉和表格里的角色名。用 computed 包住，切语言后跟着变 */
const ROLE_OPTIONS = computed(function () {
  return [
    { label: t('members.roleOption', { role: 'viewer', desc: t('members.roleViewer') }), value: 'viewer' },
    { label: t('members.roleOption', { role: 'editor', desc: t('members.roleEditor') }), value: 'editor' },
    { label: t('members.roleOption', { role: 'owner', desc: t('members.roleOwner') }), value: 'owner' }
  ];
});

const ROLE_LABELS = computed(function () {
  return {
    viewer: t('members.roleViewer'),
    editor: t('members.roleEditor'),
    owner: t('members.roleOwner'),
    admin: t('members.roleAdmin')
  };
});

const myUserId = computed(function () {
  return (session.user && session.user.id) || '';
});

async function load() {
  loading.value = true;
  try {
    const data = await membersApi.listMembers(props.pid);
    members.value = data.members || [];
    // 顺手塞进共用缓存：「负责人」下拉读的就是它（utils/projectMembers.js）
    setMembers(props.pid, members.value);
  } catch (err) {
    showError(err);
  } finally {
    loading.value = false;
  }
}

onMounted(load);
watch(function () { return props.pid; }, load);

function onSearch(keyword) {
  if (searchTimer) clearTimeout(searchTimer);
  const text = String(keyword || '').trim();
  if (!text) {
    userOptions.value = [];
    return;
  }

  searchTimer = setTimeout(async function () {
    searching.value = true;
    try {
      const data = await membersApi.lookupUsers(text);
      userOptions.value = (data.users || []).map(function (user) {
        return {
          label: user.displayName ? user.displayName + '（' + user.username + '）' : user.username,
          value: user.id
        };
      });
    } catch (err) {
      showError(err);
    } finally {
      searching.value = false;
    }
  }, 250);
}

async function addMember() {
  if (!newUserId.value) {
    message.warning(t('members.pickUserFirst'));
    return;
  }

  adding.value = true;
  try {
    const data = await membersApi.setMemberRole(props.pid, newUserId.value, newRole.value);
    members.value = data.members || [];
    setMembers(props.pid, members.value);
    newUserId.value = null;
    userOptions.value = [];
    message.success(t('members.added'));
  } catch (err) {
    showError(err);
  } finally {
    adding.value = false;
  }
}

async function changeRole(member, role) {
  try {
    const data = await membersApi.setMemberRole(props.pid, member.userId, role);
    members.value = data.members || [];
    setMembers(props.pid, members.value);
    message.success(t('members.roleChanged'));

    // 改的是自己的话，myRole 已经变了 —— 重新拉一遍项目列表，
    // 否则界面上的 owner 控件要等刷新页面才消失
    if (member.userId === myUserId.value) await projects.refresh();
  } catch (err) {
    // 把自己降级成最后一个 owner 这种情况，原因由服务端说清楚
    showError(err);
    await load();
  }
}

function askRemove(member) {
  const isSelf = member.userId === myUserId.value;
  dialog.error({
    title: isSelf ? t('members.leaveTitle') : t('members.removeTitle'),
    content: isSelf
      ? t('members.leaveBody', { name: projects.current.name })
      : t('members.removeBody', { name: member.displayName || member.username }),
    positiveText: isSelf ? t('members.leaveAction') : t('members.removeAction'),
    negativeText: t('app.cancel'),
    onPositiveClick: async function () {
      try {
        await membersApi.removeMember(props.pid, member.userId);
        if (isSelf) {
          message.success(t('members.left'));
          emit('left');
          return;
        }
        await load();
        message.success(t('members.removed'));
      } catch (err) {
        showError(err);
      }
    }
  });
}
</script>

<template>
  <div class="members">
    <n-spin :show="loading">
      <div v-if="projects.isOwner" class="add-row">
        <n-select
          v-model:value="newUserId"
          size="small"
          filterable
          remote
          clearable
          :options="userOptions"
          :loading="searching"
          :placeholder="t('members.searchPlaceholder')"
          class="search"
          @search="onSearch"
        />
        <n-select v-model:value="newRole" size="small" :options="ROLE_OPTIONS" class="role" />
        <n-button size="small" type="primary" :loading="adding" @click="addMember">{{ t('members.add') }}</n-button>
      </div>

      <div class="table">
        <div class="row head">
          <span class="cell user">{{ t('members.colUsername') }}</span>
          <span class="cell name">{{ t('members.colDisplayName') }}</span>
          <span class="cell role">{{ t('members.colRole') }}</span>
          <span class="cell action" />
        </div>

        <div v-for="member in members" :key="member.userId" class="row">
          <span class="cell user">
            {{ member.username }}
            <n-tag v-if="member.userId === myUserId" size="tiny" :bordered="false">{{ t('members.me') }}</n-tag>
            <n-tag v-if="member.disabled" size="tiny" :bordered="false" type="error">{{ t('members.disabled') }}</n-tag>
          </span>
          <span class="cell name">{{ member.displayName || '—' }}</span>
          <span class="cell role">
            <n-select
              v-if="projects.isOwner"
              size="small"
              :value="member.role"
              :options="ROLE_OPTIONS"
              @update:value="(v) => changeRole(member, v)"
            />
            <span v-else class="role-text">
              {{ ROLE_LABELS[member.role] || member.role }}
            </span>
          </span>
          <span class="cell action">
            <n-button
              v-if="member.userId === myUserId"
              size="tiny"
              quaternary
              type="error"
              @click="askRemove(member)"
            >
              {{ t('members.leaveTitle') }}
            </n-button>
            <n-button
              v-else-if="projects.isOwner"
              size="tiny"
              quaternary
              type="error"
              @click="askRemove(member)"
            >
              {{ t('members.removeAction') }}
            </n-button>
          </span>
        </div>

        <n-empty v-if="!members.length && !loading" size="small" :description="t('members.empty')" />
      </div>

      <p class="tip">
        {{ t('members.rolesTip') }}
      </p>
      <p class="tip">{{ t('members.keepOwnerTip') }}</p>
    </n-spin>
  </div>
</template>

<style scoped>
.members {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.add-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.search {
  flex: 1;
  min-width: 0;
  max-width: 320px;
}

.role {
  flex: none;
  width: 160px;
}

.table {
  border: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.24));
  border-radius: 6px;
  overflow: hidden;
  font-size: 13px;
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.16));
}

.row:last-child {
  border-bottom: none;
}

.row.head {
  font-size: 12px;
  opacity: 0.65;
  background: rgba(128, 128, 128, 0.08);
}

.cell {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
}

.cell.user {
  flex: 1.2;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cell.name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cell.role {
  flex: none;
  width: 160px;
}

.cell.action {
  flex: none;
  width: 84px;
  justify-content: flex-end;
}

.role-text {
  opacity: 0.8;
}

.tip {
  margin: 10px 0 0;
  font-size: 12px;
  opacity: 0.6;
  line-height: 1.7;
}
</style>
