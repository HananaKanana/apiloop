<script setup>
import { computed, h, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
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
const { t } = useI18n();

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

const roleOptions = computed(function () {
  return [
    { label: t('views.roleAdmin'), value: 'admin' },
    { label: t('views.roleMember'), value: 'member' }
  ];
});

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
    loadError.value = t('views.usersLoadFailed', { message: err.message });
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
      message.success(t('views.psSaved'));
    } else {
      if (!/^[a-zA-Z0-9_.-]{2,32}$/.test(form.value.username)) {
        message.warning(t('views.usersNameRule'));
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
      message.success(t('views.usersCreated'));
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
    message.success(disabled ? t('views.usersDisabled') : t('views.usersEnabled'));
    await load();
  } catch (err) {
    showError(err);
    await load();
  }
}

async function resetPassword(row) {
  dialog.warning({
    title: t('views.usersResetTitle'),
    content: t('views.usersResetBody', { name: row.username }),
    positiveText: t('views.usersResetAction'),
    negativeText: t('app.cancel'),
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
    message.success(t('views.usersApproved', { name: row.username }));
    await load();
  } catch (err) {
    showError(err);
  }
}

/** 拒绝就是删掉这条注册：用户名空出来，对方可以换个信息重新注册 */
function reject(row) {
  dialog.error({
    title: t('views.usersRejectTitle'),
    content: t('views.usersRejectBody', { name: row.username }),
    positiveText: t('views.usersRejectAction'),
    negativeText: t('app.cancel'),
    onPositiveClick: async function () {
      try {
        await usersApi.removeUser(row.id);
        message.success(t('views.usersRejected'));
        await load();
      } catch (err) {
        showError(err);
      }
    }
  });
}

function removeUser(row) {
  dialog.error({
    title: t('views.usersDeleteTitle'),
    content: t('views.usersDeleteBody', { name: row.username }),
    positiveText: t('app.delete'),
    negativeText: t('app.cancel'),
    onPositiveClick: async function () {
      try {
        await usersApi.removeUser(row.id);
        message.success(t('views.psDeleted'));
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
    message.success(t('app.copied'));
  } catch (err) {
    message.warning(t('app.copyFailed'));
  }
}

/** 当前登录的这个人自己那一行：不能删除、禁用、重置密码（改自己的密码走右上角「修改密码」） */
function isSelfRow(row) {
  return Boolean(session.user && row.id === session.user.id);
}

const columns = computed(function () { return [
  { title: t('views.usernameLabel'), key: 'username', width: 180 },
  {
    title: t('views.displayNameLabel'),
    key: 'displayName',
    render: function (row) {
      return row.displayName || '—';
    }
  },
  {
    title: t('views.roleLabel'),
    key: 'role',
    width: 110,
    render: function (row) {
      if (row.pending) {
        return h(NTag, { size: 'small', type: 'warning', bordered: false }, { default: function () { return t('views.usersPending'); } });
      }
      return h(
        NTag,
        { size: 'small', type: row.role === 'admin' ? 'info' : 'default', bordered: false },
        { default: function () { return row.role === 'admin' ? t('views.roleAdmin') : t('views.roleMember'); } }
      );
    }
  },
  {
    title: t('views.usersColEnabled'),
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
    title: t('views.usersColActions'),
    key: 'actions',
    width: 220,
    render: function (row) {
      if (row.pending) {
        return h(NSpace, { size: 4 }, {
          default: () => [
            h(NButton, { size: 'tiny', type: 'primary', onClick: function () { approve(row); } }, { default: function () { return t('views.usersApprove'); } }),
            h(NButton, { size: 'tiny', quaternary: true, type: 'error', onClick: function () { reject(row); } }, { default: function () { return t('views.usersRejectAction'); } })
          ]
        });
      }
      return h(NSpace, { size: 4 }, {
        default: () => [
          h(NButton, { size: 'tiny', quaternary: true, onClick: function () { openEdit(row); } }, { default: function () { return t('views.usersEdit'); } }),
          // 自己的密码不在这里重置：重置会清掉这个人的所有会话，包括自己当前这个，
          // 新密码还没显示出来人就被踢回登录页了（2026-10-01 用户遇到）。改自己的用右上角「修改密码」
          isSelfRow(row)
            ? null
            : h(NButton, { size: 'tiny', quaternary: true, onClick: function () { resetPassword(row); } }, { default: function () { return t('views.usersResetAction2'); } }),
          isSelfRow(row)
            ? null
            : h(NButton, { size: 'tiny', quaternary: true, type: 'error', onClick: function () { removeUser(row); } }, { default: function () { return t('app.delete'); } })
        ]
      });
    }
  }
]; });

onMounted(load);
</script>

<template>
  <div class="page">
    <div class="header">
      <n-space align="center">
        <n-button quaternary size="small" @click="router.push('/workbench')">{{ t('views.psBack') }}</n-button>
        <span class="title">{{ t('views.usersTitle') }}</span>
      </n-space>
      <n-button type="primary" size="small" @click="openCreate">{{ t('views.usersCreate') }}</n-button>
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
      :title="editing ? t('views.usersEditTitle') : t('views.usersCreateTitle')"
      style="width: 440px; max-width: 92vw"
    >
      <n-form>
        <n-form-item :label="t('views.usernameLabel')">
          <n-input v-model:value="form.username" :disabled="Boolean(editing)" :placeholder="t('views.usersNamePlaceholder')" />
        </n-form-item>
        <n-form-item :label="t('views.displayNameLabel')">
          <n-input v-model:value="form.displayName" :placeholder="t('views.usersDisplayNamePlaceholder')" />
        </n-form-item>
        <n-form-item :label="t('views.roleLabel')">
          <n-select v-model:value="form.role" :options="roleOptions" :disabled="isSelf" />
        </n-form-item>
        <n-form-item v-if="!editing" :label="t('views.passwordLabel')">
          <n-input v-model:value="form.password" :placeholder="t('views.usersPasswordPlaceholder')" />
        </n-form-item>
      </n-form>
      <p v-if="isSelf" class="tip">{{ t('views.usersSelfRoleTip') }}</p>

      <template #footer>
        <n-space justify="end">
          <n-button @click="showEditor = false">{{ t('app.cancel') }}</n-button>
          <n-button type="primary" :loading="saving" @click="save">{{ t('views.psSave') }}</n-button>
        </n-space>
      </template>
    </n-modal>

    <n-modal
      :show="Boolean(issuedPassword)"
      preset="card"
      :title="t('views.usersPasswordTitle')"
      style="width: 440px; max-width: 92vw"
      @update:show="issuedPassword = null"
    >
      <p class="tip">{{ t('views.usersPasswordTip') }}</p>
      <div class="password-box">
        <code>{{ issuedPassword && issuedPassword.password }}</code>
      </div>
      <p class="tip">
        {{ t('views.usersPasswordUsername') }}<b>{{ issuedPassword && issuedPassword.username }}</b>
      </p>

      <template #footer>
        <n-space justify="end">
          <n-button @click="copyPassword">{{ t('views.usersCopy') }}</n-button>
          <n-button type="primary" @click="issuedPassword = null">{{ t('views.usersSavedIt') }}</n-button>
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
