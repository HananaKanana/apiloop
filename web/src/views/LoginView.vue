<script setup>
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { NAlert, NButton, NCard, NForm, NFormItem, NInput } from 'naive-ui';
import { useSessionStore } from '@/stores/session';

const route = useRoute();
const router = useRouter();
const session = useSessionStore();

const username = ref('');
const password = ref('');
const loading = ref(false);
const errorText = ref('');

/** 只接受 #/ 开头的 next，其余一律回首页 */
function targetAfterLogin() {
  const next = route.query.next;
  if (typeof next === 'string' && next.indexOf('#/') === 0) return next.slice(1);
  return '/workbench';
}

async function submit() {
  errorText.value = '';

  if (!username.value || !password.value) {
    errorText.value = '请填写用户名和密码';
    return;
  }

  loading.value = true;
  try {
    await session.login(username.value, password.value);
    router.replace(targetAfterLogin());
  } catch (err) {
    errorText.value = err.message;
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="login-page">
    <n-card class="login-card" :bordered="false">
      <h1 class="brand">{{ session.appName }}</h1>
      <p class="subtitle">登录管理台</p>

      <n-alert v-if="errorText" type="error" :show-icon="false" class="alert">
        {{ errorText }}
      </n-alert>

      <n-form @submit.prevent="submit">
        <n-form-item label="用户名">
          <n-input
            v-model:value="username"
            placeholder="用户名"
            autofocus
            @keyup.enter="submit"
          />
        </n-form-item>
        <n-form-item label="密码">
          <n-input
            v-model:value="password"
            type="password"
            show-password-on="click"
            placeholder="密码"
            @keyup.enter="submit"
          />
        </n-form-item>
      </n-form>

      <n-button type="primary" block :loading="loading" @click="submit">
        登录
      </n-button>

      <p class="hint">
        忘记密码？请联系管理员在服务器上执行 <code>./deploy.sh user reset-password &lt;用户名&gt;</code> 重置。
      </p>
    </n-card>
  </div>
</template>

<style scoped>
.login-page {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  box-sizing: border-box;
}

.login-card {
  width: 380px;
  max-width: 100%;
}

.brand {
  margin: 0 0 4px;
  font-size: 24px;
  font-weight: 600;
  text-align: center;
}

.subtitle {
  margin: 0 0 20px;
  text-align: center;
  opacity: 0.6;
  font-size: 13px;
}

.alert {
  margin-bottom: 16px;
}

.hint {
  margin: 16px 0 0;
  font-size: 12px;
  opacity: 0.55;
  text-align: center;
  line-height: 1.6;
}

.hint code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
</style>
