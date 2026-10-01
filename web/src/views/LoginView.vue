<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { NAlert, NButton, NCard, NForm, NFormItem, NInput, useDialog } from 'naive-ui';
import { useSessionStore } from '@/stores/session';
import { useGatewayStore } from '@/stores/gateway';
import { markChosen } from '@/utils/firstRun';
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
 * 网关上登录之后要走这一条：所有 store 里装的还是登录前那个空间的数据，
 * 只有重新加载才会按新空间重新取数。
 */
function reloadTo(path) {
  // 用 replaceState 改地址，**不要**直接赋 location.hash：那会先触发一次路由跳转，
  // 工作台挂载、装上「有没保存的修改，确定离开吗」的拦截，接着刷新就弹浏览器的确认框
  //（2026-10-01 用户遇到）。replaceState 不触发路由，刷新之后才按新地址进页面。
  window.history.replaceState(window.history.state, '', '#' + path);
  window.location.reload();
}

/**
 * 登录会切空间、整页刷新，没保存的标签页就没了 —— 先问一句，
 * 用页面自己的对话框，而不是让浏览器弹那个看不懂的「确定离开此页面吗」。
 *
 * @returns {Promise<boolean>} 用户同意继续
 */
function confirmDiscardDirty() {
  if (!gateway.isGateway || !tabs.hasDirty) return Promise.resolve(true);
  return new Promise(function (resolve) {
    dialog.warning({
      title: '有没保存的修改',
      content: '登录之后，没保存的标签页会关闭，里面的修改会丢失。要继续吗？',
      positiveText: '继续',
      negativeText: '取消',
      onPositiveClick: function () { resolve(true); },
      onNegativeClick: function () { resolve(false); },
      onClose: function () { resolve(false); },
      onMaskClick: function () { resolve(false); }
    });
  });
}

/** 网关上连不上云端：登录必须联网，先说清楚，再给一条能走的路 */
const cloudDown = computed(function () {
  return gateway.isGateway && Boolean(gateway.status) && !gateway.status.cloudReachable;
});

/** 还没登录过（未绑定空间）：本机现在的项目登录后都会同步过去 */
const unbound = computed(function () {
  return gateway.isGateway && gateway.spaceState === 'unbound';
});

// 直接落到登录页时（比如云端停了、/meta 拿不到），工作台还没来得及探测网关状态，
// 提示就不会出现。这里自己探一次（2026-10-01 用户遇到）
onMounted(function () {
  if (!gateway.loaded) gateway.load().catch(function () {});
});

/** 「不登录，继续在本机使用」：回工作台就行，不用调接口（本机空间本来就是打开的） */
async function continueLocal() {
  if (!(await confirmDiscardDirty())) return;
  // 记下「这台电脑选过了」，以后打开直接进工作台（utils/firstRun.js）
  markChosen();
  router.replace('/workbench');
}

async function submit() {
  errorText.value = '';

  if (!username.value || !password.value) {
    errorText.value = '请填写用户名和密码';
    return;
  }

  // 登录成功网关就切空间了，所以要在登录**之前**问
  if (!(await confirmDiscardDirty())) return;

  loading.value = true;
  try {
    await session.login(username.value, password.value);
    markChosen();
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
        连不上云端，登录需要联网。不登录也可以继续在本机使用。
      </n-alert>

      <p v-if="unbound" class="local-note">
        登录后，本机的项目会自动同步到这个账号。
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

      <!-- 网关上才给这条路：回工作台，数据都在本机，不登录也能用 -->
      <n-button
        v-if="gateway.isGateway"
        class="skip"
        block
        quaternary
        @click="continueLocal"
      >
        不登录，继续在本机使用
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
