<script setup>
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { NDropdown, NTooltip } from 'naive-ui';
import { useGatewayStore } from '@/stores/gateway';
import InstallDialog from './InstallDialog.vue';

/**
 * 顶栏右侧的连接状态：一个小圆点 + 一句话。
 *
 * 四种形态：
 * - 网关上、**本机模式** → 灰点「仅本机」，点了去登录页（L1）；
 * - 网关上、云端模式、云端连得上 → 绿点「本机发送」；
 * - 网关上、云端模式、云端连不上 → 红点「云端连不上」；
 * - 直接打开云端 → 灰点「云端发送」。
 *
 * 点它的行为：
 * - 本机模式 → 去登录页（想用云端的项目就去登录）；
 * - 网关上、有新版本 → 下拉菜单「安装新版本…」；
 * - 直接打开云端 → 直接开「安装本机 apiloop」对话框。
 *
 * L1 起**不再有「云端地址…」**：地址在打包时写死，界面上不给改
 * （换地址 = 发一个新版本的安装包）。
 */
const router = useRouter();
const gateway = useGatewayStore();

const showInstall = ref(false);

/** 网关版本和云端不一致 —— 顶栏挂个「有新版本」，点开就能下载 */
const hasNewVersion = computed(function () {
  return Boolean(gateway.versionMismatch);
});

const versionHint = computed(function () {
  const mismatch = gateway.versionMismatch;
  if (!mismatch) return '';
  return '本机 apiloop 是 ' + mismatch.gatewayVersion + '，云端是 ' + mismatch.cloudVersion;
});

const indicator = computed(function () {
  if (gateway.isLocal) {
    return {
      color: '#6b7280',
      text: '仅本机',
      hint: '数据只保存在这台电脑上。登录后可以使用云端的项目'
    };
  }

  if (gateway.isGateway) {
    const reachable = Boolean(gateway.status && gateway.status.cloudReachable);
    if (reachable) {
      return {
        color: '#0cbb52',
        text: '本机发送',
        hint: '请求从这台电脑发出；数据保存在 ' + (gateway.cloudUrl || '云端')
      };
    }
    return {
      color: '#eb2013',
      text: '云端连不上',
      hint: gateway.cloudUrl ? '连不上 ' + gateway.cloudUrl : '还没设置云端地址'
    };
  }

  return {
    color: '#6b7280',
    text: '云端发送',
    hint: '请求从云端服务器发出，访问不了你电脑上和内网的地址。安装本机的 apiloop 后可以从本机发送'
  };
});

/** 本机模式下没有菜单（没有云端地址可改），点一下直接去登录页 */
const menuEnabled = computed(function () {
  return gateway.isGateway && !gateway.isLocal && hasNewVersion.value;
});

const menuOptions = computed(function () {
  return hasNewVersion.value ? [{ label: '安装新版本…', key: 'install' }] : [];
});

/** 光标要不要变成手型：点了有事发生才变 */
const clickable = computed(function () {
  return gateway.isLocal || !gateway.isGateway || hasNewVersion.value;
});

function onMenuSelect(key) {
  if (key === 'install') showInstall.value = true;
}

function onIndicatorClick() {
  if (gateway.isLocal) {
    router.push('/login');
    return;
  }
  // 网关上的点击归下拉菜单管；直接打开云端时没有菜单，点了就开安装对话框
  if (!gateway.isGateway) showInstall.value = true;
}
</script>

<template>
  <n-dropdown
    v-if="gateway.showIndicator"
    :options="menuOptions"
    trigger="click"
    :disabled="!menuEnabled"
    @select="onMenuSelect"
  >
    <n-tooltip trigger="hover">
      <template #trigger>
        <button class="conn" :class="{ clickable: clickable }" type="button" @click="onIndicatorClick">
          <span class="dot" :style="{ background: indicator.color }" />
          <span class="text">{{ indicator.text }}</span>
          <span v-if="hasNewVersion" class="new-version">有新版本</span>
        </button>
      </template>
      <!-- 原来那句提示照旧；版本不一致时再补一行说明，不替换掉它 -->
      <div>{{ indicator.hint }}</div>
      <div v-if="hasNewVersion">{{ versionHint }}</div>
    </n-tooltip>
  </n-dropdown>

  <install-dialog
    v-model:show="showInstall"
    :is-gateway="gateway.isGateway"
    :cloud-url="gateway.cloudUrl"
  />
</template>

<style scoped>
.conn {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 8px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: inherit;
  font-size: 12px;
  cursor: default;
  white-space: nowrap;
}

.conn.clickable {
  cursor: pointer;
}

.conn.clickable:hover {
  background: rgba(128, 128, 128, 0.14);
}

.dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
}

.text {
  opacity: 0.85;
}

/* 「有新版本」：黄色小胶囊，紧跟在状态文字后面 */
.new-version {
  flex: none;
  padding: 0 5px;
  border-radius: 3px;
  font-size: 11px;
  line-height: 16px;
  color: #a06a00;
  background: rgba(240, 160, 32, 0.18);
}
</style>
