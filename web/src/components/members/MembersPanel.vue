<script setup>
import { computed, onMounted, ref, watch } from 'vue';
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
  else showError(err);
}
const dialog = useDialog();

const members = ref([]);
const loading = ref(false);

const userOptions = ref([]);
const searching = ref(false);
const newUserId = ref(null);
const newRole = ref('editor');
const adding = ref(false);

let searchTimer = null;

const ROLE_OPTIONS = [
  { label: 'viewer（只读）', value: 'viewer' },
  { label: 'editor（可编辑）', value: 'editor' },
  { label: 'owner（可管理）', value: 'owner' }
];

const ROLE_LABELS = { viewer: '只读', editor: '可编辑', owner: '可管理', admin: '管理员' };

const myUserId = computed(function () {
  return (session.user && session.user.id) || '';
});

async function load() {
  loading.value = true;
  try {
    const data = await membersApi.listMembers(props.pid);
    members.value = data.members || [];
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
    message.warning('先搜索并选中一个用户');
    return;
  }

  adding.value = true;
  try {
    const data = await membersApi.setMemberRole(props.pid, newUserId.value, newRole.value);
    members.value = data.members || [];
    newUserId.value = null;
    userOptions.value = [];
    message.success('已添加');
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
    message.success('已修改角色');

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
    title: isSelf ? '退出项目' : '移除成员',
    content: isSelf
      ? '确定退出「' + projects.current.name + '」吗？退出后你就看不到这个项目了。'
      : '确定把「' + (member.displayName || member.username) + '」移出这个项目吗？',
    positiveText: isSelf ? '退出' : '移除',
    negativeText: '取消',
    onPositiveClick: async function () {
      try {
        await membersApi.removeMember(props.pid, member.userId);
        if (isSelf) {
          message.success('已退出');
          emit('left');
          return;
        }
        await load();
        message.success('已移除');
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
          placeholder="搜索用户名或显示名"
          class="search"
          @search="onSearch"
        />
        <n-select v-model:value="newRole" size="small" :options="ROLE_OPTIONS" class="role" />
        <n-button size="small" type="primary" :loading="adding" @click="addMember">添加成员</n-button>
      </div>

      <div class="table">
        <div class="row head">
          <span class="cell user">用户名</span>
          <span class="cell name">显示名</span>
          <span class="cell role">角色</span>
          <span class="cell action" />
        </div>

        <div v-for="member in members" :key="member.userId" class="row">
          <span class="cell user">
            {{ member.username }}
            <n-tag v-if="member.userId === myUserId" size="tiny" :bordered="false">我</n-tag>
            <n-tag v-if="member.disabled" size="tiny" :bordered="false" type="error">已禁用</n-tag>
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
              退出项目
            </n-button>
            <n-button
              v-else-if="projects.isOwner"
              size="tiny"
              quaternary
              type="error"
              @click="askRemove(member)"
            >
              移除
            </n-button>
          </span>
        </div>

        <n-empty v-if="!members.length && !loading" size="small" description="还没有成员" />
      </div>

      <p class="tip">
        角色：viewer 只能查看和发请求；editor 还能增删改接口、示例、期望与环境；
        owner 还能改项目名称和标识、管理成员、删除项目。系统管理员对任何项目都等同于 owner。
      </p>
      <p class="tip">项目至少要保留一个 owner，最后一个 owner 不能降级或退出。</p>
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
