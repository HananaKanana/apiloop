<script setup>
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import {
  NButton,
  NDropdown,
  NForm,
  NFormItem,
  NInput,
  NModal,
  NSpace,
  useMessage
} from 'naive-ui';
import { changePassword } from '@/api/auth';
import { useSessionStore } from '@/stores/session';
import { useTabsStore } from '@/stores/tabs';

const emit = defineEmits(['about']);

const router = useRouter();
const session = useSessionStore();
const tabs = useTabsStore();
const message = useMessage();

const showPassword = ref(false);
const saving = ref(false);
const form = ref({ oldPassword: '', newPassword: '', confirm: '' });

const options = computed(function () {
  const items = [
    { label: '修改密码', key: 'password' },
    { label: '关于', key: 'about' }
  ];
  if (session.isAdmin) {
    items.push({ label: '用户管理', key: 'users' });
    items.push({ label: '系统设置', key: 'settings' });
  }
  items.push({ type: 'divider', key: 'd1' });
  items.push({ label: '退出登录', key: 'logout' });
  return items;
});

function openPassword() {
  form.value = { oldPassword: '', newPassword: '', confirm: '' };
  showPassword.value = true;
}

async function submitPassword() {
  if (form.value.newPassword.length < 6) {
    message.warning('新密码至少 6 位');
    return;
  }
  if (form.value.newPassword !== form.value.confirm) {
    message.warning('两次输入的新密码不一致');
    return;
  }

  saving.value = true;
  try {
    await changePassword(form.value.oldPassword, form.value.newPassword);
    showPassword.value = false;
    message.success('密码已修改，其他设备上的登录已失效');
  } catch (err) {
    message.error(err.message);
  } finally {
    saving.value = false;
  }
}

async function onSelect(key) {
  if (key === 'password') return openPassword();
  if (key === 'users') return router.push('/users');
  if (key === 'settings') return router.push('/settings');
  if (key === 'about') return emit('about');
  if (key === 'logout') {
    // 标签页里揣着这个用户正在编辑的请求和上一次的响应（很可能带 token），
    // 不清掉的话，换个人在同一个浏览器登录还能看见。
    // closeAll 顺带会 abort 在飞的请求、销毁服务端的 WebSocket 会话。
    tabs.closeAll();
    await session.logout();
    router.replace('/login');
  }
}
</script>

<template>
  <n-dropdown :options="options" trigger="click" @select="onSelect">
    <n-button quaternary size="small">{{ session.displayName || '未登录' }}</n-button>
  </n-dropdown>

  <n-modal
    v-model:show="showPassword"
    preset="card"
    title="修改密码"
    style="width: 420px; max-width: 92vw"
  >
    <n-form>
      <n-form-item label="当前密码">
        <n-input v-model:value="form.oldPassword" type="password" show-password-on="click" />
      </n-form-item>
      <n-form-item label="新密码">
        <n-input
          v-model:value="form.newPassword"
          type="password"
          show-password-on="click"
          placeholder="至少 6 位"
        />
      </n-form-item>
      <n-form-item label="确认新密码">
        <n-input v-model:value="form.confirm" type="password" show-password-on="click" />
      </n-form-item>
    </n-form>

    <template #footer>
      <n-space justify="end">
        <n-button @click="showPassword = false">取消</n-button>
        <n-button type="primary" :loading="saving" @click="submitPassword">确定</n-button>
      </n-space>
    </template>
  </n-modal>
</template>
