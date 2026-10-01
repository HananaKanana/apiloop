<script setup>
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { NAlert, NButton, NCard, NForm, NFormItem, NInput } from 'naive-ui';
import * as gatewayApi from '@/api/gateway';
import { useSessionStore } from '@/stores/session';
import { useGatewayStore } from '@/stores/gateway';

const route = useRoute();
const router = useRouter();
const session = useSessionStore();
const gateway = useGatewayStore();

const username = ref('');
const password = ref('');
const loading = ref(false);
const skipping = ref(false);
const errorText = ref('');

/** 只接受 #/ 开头的 next，其余一律回首页 */
function targetAfterLogin() {
  const next = route.query.next;
  if (typeof next === 'string' && next.indexOf('#/') === 0) return next.slice(1);
  return '/workbench';
}

/**
 * 整页刷新到某个 hash 路由。
 *
 * 网关上「登录」和「跳过登录」之后都要走这一条：所有 store 里装的还是切换前那个库的
 * 数据（本机的或云端的），只有重新加载才会按新模式重新取数。
 */
function reloadTo(path) {
  window.location.hash = '#' + path;
  window.location.reload();
}

/**
 * 跳过登录，先在本机用（L1）。网关打开本机空间并记住 mode = local，
 * 之后页面读写的都是本机库。
 */
async function skipLogin() {
  errorText.value = '';
  skipping.value = true;
  try {
    await gatewayApi.enterLocal();
    reloadTo('/workbench');
  } catch (err) {
    errorText.value = err.message;
    skipping.value = false;
  }
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
    if (gateway.isGateway) {
      reloadTo(targetAfterLogin());
      return;
    }
    router.replace(targetAfterLogin());
  } catch (err) {
    errorText.value = err.message;
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

      <!-- 已经在本机模式、又从菜单进到登录页：先说清楚登录之后会看到什么 -->
      <p v-if="gateway.isLocal" class="local-note">
        登录后看到的是云端的项目。本机的项目会留在这台电脑上，同步功能上线后会自动上传。
      </p>

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

      <!-- 网关上才给这条路：直接进本机空间，不用账号 -->
      <n-button
        v-if="gateway.isGateway"
        class="skip"
        block
        quaternary
        :loading="skipping"
        @click="skipLogin"
      >
        跳过登录，先在本机用
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

/* 本机模式下的说明：一行灰字，别抢表单的注意力 */
.local-note {
  margin: 0 0 16px;
  padding: 8px 10px;
  border-radius: 4px;
  font-size: 12px;
  line-height: 1.7;
  opacity: 0.65;
  background: rgba(128, 128, 128, 0.1);
}

.skip {
  margin-top: 8px;
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
