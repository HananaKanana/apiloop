<script setup>
import { computed, h, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import {
  NAlert,
  NButton,
  NCard,
  NDataTable,
  NForm,
  NFormItem,
  NInput,
  NModal,
  NSelect,
  NSpace,
  NSwitch,
  NTag,
  useMessage
} from 'naive-ui';
import { useDialog } from '@/utils/dialog';
import { isLoginRequired } from '@/api/client';
import * as usersApi from '@/api/users';
import { useSessionStore } from '@/stores/session';
import { copyText } from '@/utils/clipboard';

const router = useRouter();
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

const users = ref([]);
const loading = ref(false);

const showEditor = ref(false);
const saving = ref(false);
const editing = ref(null); // null 表示新建
const form = ref({ username: '', displayName: '', role: 'member', password: '' });

/** 服务端只返回一次的密码（新建用户或重置密码） */
const issuedPassword = ref(null);

const roleOptions = [
  { label: '管理员', value: 'admin' },
  { label: '普通成员', value: 'member' }
];

const isSelf = computed(function () {
  return Boolean(editing.value && session.user && editing.value.id === session.user.id);
});

/** 拉不到用户列表的原因（常见：本机 apiloop 连不上云端）。要一直留在页面上 —— 只弹一下的话表格看起来就是「无数据」 */
const loadError = ref('');

async function load() {
  loading.value = true;
  loadError.value = '';
  try {
    const data = await usersApi.listUsers();
    // 待审核的排最前面：管理员点进来就是来处理它们的
    users.value = (data.users || []).slice().sort(function (a, b) {
      return Number(Boolean(b.pending)) - Number(Boolean(a.pending));
    });
  } catch (err) {
    loadError.value = '用户列表拉不下来：' + err.message;
    showError(err);
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  editing.value = null;
  form.value = { username: '', displayName: '', role: 'member', password: '' };
  showEditor.value = true;
}

function openEdit(row) {
  editing.value = row;
  form.value = {
    username: row.username,
    displayName: row.displayName || '',
    role: row.role,
    password: ''
  };
  showEditor.value = true;
}

async function save() {
  saving.value = true;
  try {
    if (editing.value) {
      await usersApi.updateUser(editing.value.id, {
        displayName: form.value.displayName,
        role: form.value.role
      });
      message.success('已保存');
    } else {
      if (!/^[a-zA-Z0-9_.-]{2,32}$/.test(form.value.username)) {
        message.warning('用户名只能是 2–32 位的字母、数字、下划线、点或短横');
        return;
      }
      const payload = {
        username: form.value.username,
        displayName: form.value.displayName,
        role: form.value.role
      };
      if (form.value.password) payload.password = form.value.password;
      const data = await usersApi.createUser(payload);
      if (data.password) issuedPassword.value = { username: data.user.username, password: data.password };
      message.success('已创建');
    }
    showEditor.value = false;
    await load();
  } catch (err) {
    // 服务端的 400 文案（比如「不能对自己做…」）原样给用户看
    showError(err);
  } finally {
    saving.value = false;
  }
}

async function toggleDisabled(row, disabled) {
  try {
    await usersApi.updateUser(row.id, { disabled: disabled });
    message.success(disabled ? '已禁用' : '已启用');
    await load();
  } catch (err) {
    showError(err);
    await load();
  }
}

async function resetPassword(row) {
  dialog.warning({
    title: '重置密码',
    content: '将为「' + row.username + '」生成新密码，该用户当前的登录会全部失效。确定继续吗？',
    positiveText: '重置',
    negativeText: '取消',
    onPositiveClick: async function () {
      try {
        const data = await usersApi.resetPassword(row.id);
        issuedPassword.value = { username: row.username, password: data.password };
        await load();
      } catch (err) {
        showError(err);
      }
    }
  });
}

async function approve(row) {
  try {
    await usersApi.approveUser(row.id);
    message.success('已通过，「' + row.username + '」现在可以登录了');
    await load();
  } catch (err) {
    showError(err);
  }
}

/** 拒绝就是删掉这条注册：用户名空出来，对方可以换个信息重新注册 */
function reject(row) {
  dialog.error({
    title: '拒绝注册',
    content: '拒绝「' + row.username + '」的注册申请？这条申请会被删掉。',
    positiveText: '拒绝',
    negativeText: '取消',
    onPositiveClick: async function () {
      try {
        await usersApi.removeUser(row.id);
        message.success('已拒绝');
        await load();
      } catch (err) {
        showError(err);
      }
    }
  });
}

function removeUser(row) {
  dialog.error({
    title: '删除用户',
    content: '确定删除「' + row.username + '」吗？此操作不可撤销。',
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async function () {
      try {
        await usersApi.removeUser(row.id);
        message.success('已删除');
        await load();
      } catch (err) {
        showError(err);
      }
    }
  });
}

async function copyPassword() {
  const text = issuedPassword.value ? issuedPassword.value.password : '';
  try {
    await copyText(text);
    message.success('已复制');
  } catch (err) {
    message.warning('复制失败，请手动选中复制');
  }
}

/** 当前登录的这个人自己那一行：不能删除、禁用、重置密码（改自己的密码走右上角「修改密码」） */
function isSelfRow(row) {
  return Boolean(session.user && row.id === session.user.id);
}

const columns = [
  { title: '用户名', key: 'username', width: 180 },
  {
    title: '显示名',
    key: 'displayName',
    render: function (row) {
      return row.displayName || '—';
    }
  },
  {
    title: '角色',
    key: 'role',
    width: 110,
    render: function (row) {
      if (row.pending) {
        return h(NTag, { size: 'small', type: 'warning', bordered: false }, { default: () => '待审核' });
      }
      return h(
        NTag,
        { size: 'small', type: row.role === 'admin' ? 'info' : 'default', bordered: false },
        { default: () => (row.role === 'admin' ? '管理员' : '普通成员') }
      );
    }
  },
  {
    title: '启用',
    key: 'disabled',
    width: 90,
    render: function (row) {
      if (row.pending) return '—';
      // 自己不能禁用自己（服务端也拦：「不能对自己做删除、禁用或降级」），开关直接置灰
      return h(NSwitch, {
        size: 'small',
        value: !row.disabled,
        disabled: isSelfRow(row),
        'onUpdate:value': function (value) {
          toggleDisabled(row, !value);
        }
      });
    }
  },
  {
    title: '操作',
    key: 'actions',
    width: 220,
    render: function (row) {
      if (row.pending) {
        return h(NSpace, { size: 4 }, {
          default: () => [
            h(NButton, { size: 'tiny', type: 'primary', onClick: () => approve(row) }, { default: () => '通过' }),
            h(NButton, { size: 'tiny', quaternary: true, type: 'error', onClick: () => reject(row) }, { default: () => '拒绝' })
          ]
        });
      }
      return h(NSpace, { size: 4 }, {
        default: () => [
          h(NButton, { size: 'tiny', quaternary: true, onClick: () => openEdit(row) }, { default: () => '编辑' }),
          // 自己的密码不在这里重置：重置会清掉这个人的所有会话，包括自己当前这个，
          // 新密码还没显示出来人就被踢回登录页了（2026-10-01 用户遇到）。改自己的用右上角「修改密码」
          isSelfRow(row)
            ? null
            : h(NButton, { size: 'tiny', quaternary: true, onClick: () => resetPassword(row) }, { default: () => '重置密码' }),
          isSelfRow(row)
            ? null
            : h(NButton, { size: 'tiny', quaternary: true, type: 'error', onClick: () => removeUser(row) }, { default: () => '删除' })
        ]
      });
    }
  }
];

onMounted(load);
</script>

<template>
  <div class="page">
    <div class="header">
      <n-space align="center">
        <n-button quaternary size="small" @click="router.push('/workbench')">← 返回</n-button>
        <span class="title">用户管理</span>
      </n-space>
      <n-button type="primary" size="small" @click="openCreate">新建用户</n-button>
    </div>

    <div class="content">
      <n-card :bordered="false" size="small">
        <n-alert v-if="loadError" type="error" :show-icon="false" style="margin-bottom: 12px">
          {{ loadError }}
        </n-alert>
        <n-data-table
          :columns="columns"
          :data="users"
          :loading="loading"
          :bordered="false"
          :row-key="(row) => { return row.id; }"
          size="small"
        />
      </n-card>
    </div>

    <n-modal
      v-model:show="showEditor"
      preset="card"
      :title="editing ? '编辑用户' : '新建用户'"
      style="width: 440px; max-width: 92vw"
    >
      <n-form>
        <n-form-item label="用户名">
          <n-input v-model:value="form.username" :disabled="Boolean(editing)" placeholder="2–32 位字母数字" />
        </n-form-item>
        <n-form-item label="显示名">
          <n-input v-model:value="form.displayName" placeholder="可留空" />
        </n-form-item>
        <n-form-item label="角色">
          <n-select v-model:value="form.role" :options="roleOptions" :disabled="isSelf" />
        </n-form-item>
        <n-form-item v-if="!editing" label="密码">
          <n-input v-model:value="form.password" placeholder="留空则自动生成" />
        </n-form-item>
      </n-form>
      <p v-if="isSelf" class="tip">不能修改自己的角色。</p>

      <template #footer>
        <n-space justify="end">
          <n-button @click="showEditor = false">取消</n-button>
          <n-button type="primary" :loading="saving" @click="save">保存</n-button>
        </n-space>
      </template>
    </n-modal>

    <n-modal
      :show="Boolean(issuedPassword)"
      preset="card"
      title="请保存这个密码"
      style="width: 440px; max-width: 92vw"
      @update:show="issuedPassword = null"
    >
      <p class="tip">密码只会显示这一次，关掉就再也看不到了。</p>
      <div class="password-box">
        <code>{{ issuedPassword && issuedPassword.password }}</code>
      </div>
      <p class="tip">
        用户名：<b>{{ issuedPassword && issuedPassword.username }}</b>
      </p>

      <template #footer>
        <n-space justify="end">
          <n-button @click="copyPassword">复制</n-button>
          <n-button type="primary" @click="issuedPassword = null">我已保存</n-button>
        </n-space>
      </template>
    </n-modal>
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
  border-bottom: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.24));
}

.title {
  font-size: 15px;
  font-weight: 600;
}

.content {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 12px;
}

.tip {
  margin: 8px 0 0;
  font-size: 12px;
  opacity: 0.65;
  line-height: 1.6;
}

.password-box {
  margin-top: 12px;
  padding: 10px 12px;
  border-radius: 6px;
  background: rgba(128, 128, 128, 0.12);
  word-break: break-all;
}

.password-box code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 14px;
}
</style>
