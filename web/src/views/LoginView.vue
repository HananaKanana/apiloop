<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { NAlert, NButton, NCard, NForm, NFormItem, NInput, useDialog } from 'naive-ui';
import * as gatewayApi from '@/api/gateway';
import { useSessionStore } from '@/stores/session';
import { useGatewayStore } from '@/stores/gateway';
import { useTabsStore } from '@/stores/tabs';

const route = useRoute();
const router = useRouter();
const session = useSessionStore();
const gateway = useGatewayStore();
const tabs = useTabsStore();
const dialog = useDialog();

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
  // 用 replaceState 改地址，**不要**直接赋 location.hash：那会先触发一次路由跳转，
  // 工作台挂载、装上「有没保存的修改，确定离开吗」的拦截，接着刷新就弹浏览器的确认框
  //（2026-10-01 用户遇到）。replaceState 不触发路由，刷新之后才按新地址进页面。
  window.history.replaceState(window.history.state, '', '#' + path);
  window.location.reload();
}

/**
 * 切换空间（登录云端 / 跳过登录）会整页刷新，没保存的标签页就没了 ——
 * 先问一句，用页面自己的对话框，而不是让浏览器弹那个看不懂的「确定离开此页面吗」。
 *
 * @returns {Promise<boolean>} 用户同意继续
 */
function confirmDiscardDirty() {
  if (!gateway.isGateway || !tabs.hasDirty) return Promise.resolve(true);
  return new Promise(function (resolve) {
    dialog.warning({
      title: '有没保存的修改',
      content: '切换之后，没保存的标签页会关闭，里面的修改会丢失。要继续吗？',
      positiveText: '继续',
      negativeText: '取消',
      onPositiveClick: function () { resolve(true); },
      onNegativeClick: function () { resolve(false); },
      onClose: function () { resolve(false); },
      onMaskClick: function () { resolve(false); }
    });
  });
}

/**
 * 网关上、连不上云端：直接说清楚，并指一条能走的路（跳过登录在本机用）。
 * 本机模式下从菜单进来的不提示 —— 那是用户自己想去登录。
 */
const cloudDown = computed(function () {
  return gateway.isGateway && !gateway.isLocal && Boolean(gateway.status) &&
    !gateway.status.cloudReachable;
});

// 直接落到登录页时（比如云端停了、/meta 拿不到），工作台还没来得及探测「是不是在网关上」，
// 「跳过登录」按钮就不会出现。这里自己探一次（2026-10-01 用户遇到）
onMounted(function () {
  if (!gateway.loaded) gateway.load().catch(function () {});
});

/**
 * 跳过登录，先在本机用（L1）。网关打开本机空间并记住 mode = local，
 * 之后页面读写的都是本机库。
 */
async function skipLogin() {
  errorText.value = '';
  if (!(await confirmDiscardDirty())) return;
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

  // 登录成功网关就切到云端模式了，所以要在登录**之前**问
  if (!(await confirmDiscardDirty())) return;

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
      <n-alert v-if="cloudDown" type="warning" :show-icon="false" class="alert">
        连不上云端（{{ gateway.cloudUrl }}）。可以先点下面的「跳过登录」，在本机使用，数据只保存在这台电脑上。
      </n-alert>

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
