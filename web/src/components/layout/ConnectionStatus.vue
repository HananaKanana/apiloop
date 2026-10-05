<script setup>
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { NDropdown, NTooltip } from 'naive-ui';
import { useGatewayStore } from '@/stores/gateway';
import { useUiStore } from '@/stores/ui';
import InstallDialog from './InstallDialog.vue';
import ConflictDialog from '@/components/sync/ConflictDialog.vue';

/**
 * 顶栏右侧的状态点（设计稿第 7 节）。
 *
 * 网关上的状态优先级从高到低：
 * 登录过期 → 有冲突 → 正在同步 → N 项待同步（连不上云端时是「离线 · N 项待同步」）
 * → 已同步 → 未绑定 / 已退出。
 * 直接打开云端时还是那句「云端发送」，和以前一样。
 *
 * 点它：
 * - 有冲突 → 下拉菜单是冲突列表，点一项开冲突对话框；
 * - 有新版本 → 下拉菜单「安装新版本…」；
 * - 未绑定 / 已退出 / 登录过期 → 去登录页；
 * - 其余状态点了没事发生。
 */
const router = useRouter();
const gateway = useGatewayStore();
const ui = useUiStore();
const { t } = useI18n();

/** 冲突列表里那个后缀：说清楚冲突的是接口还是目录 */
const ENTITY_LABEL = computed(function () {
  return {
    project: t('layout.entityProject'),
    environment: t('layout.entityEnvironment'),
    folder: t('layout.entityFolder'),
    api: t('layout.entityApi'),
    example: t('layout.entityExample'),
    expectation: t('layout.entityExpectation')
  };
});

const showInstall = ref(false);

/** 网关版本和云端不一致 —— 顶栏挂个「有新版本」，点开就能下载 */
const hasNewVersion = computed(function () {
  return Boolean(gateway.versionMismatch);
});

const versionHint = computed(function () {
  const mismatch = gateway.versionMismatch;
  if (!mismatch) return '';
  return t('layout.versionMismatch', {
    local: mismatch.gatewayVersion,
    cloud: mismatch.cloudVersion
  });
});

/** 同步时间戳：数字当毫秒、字符串按 ISO 解析，认不出来就不显示 */
function formatSyncTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (isNaN(date.getTime())) return '';
  function pad(number) { return String(number).padStart(2, '0'); }
  return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
}

const indicator = computed(function () {
  // 直接打开云端：没有空间、没有同步，就是「请求从云端发出」这一件事。
  // 点开是「安装本机 apiloop」——装完请求就能从自己电脑发出
  if (!gateway.isGateway) {
    // 云端关掉了「替用户发请求」（SERVER_SEND=0，接口多在内网时推荐这么部署）：网页版发不了请求
    if (gateway.cloudSendBlocked) {
      return {
        color: '#f59e0b',
        text: t('layout.cloudSendBlocked'),
        hint: t('layout.cloudSendBlockedHint'),
        action: 'install'
      };
    }
    return {
      color: '#6b7280',
      text: t('layout.cloudSend'),
      hint: t('layout.cloudSendHint'),
      action: 'install'
    };
  }

  // 网关还没实现同步引擎时 sync 是 null，按「没有同步信息」处理
  const sync = gateway.sync || {};

  /*
   * 同步相关的状态只在**已登录**时才有意义。
   *
   * 未绑定 / 已退出时 `sync` 里也可能带着数字（本机库有自己的变更流水，
   * 实测未绑定状态下 `pending` 就是 1），但那些改动没有云端可去，
   * 显示成「N 项待同步」是错的 —— 设计稿第 7 节这两种状态分别是「仅本机」和「未登录 · 不同步」。
   */
  if (gateway.signedIn) {
    if (sync.conflicts > 0) {
      return {
        color: '#eb2013',
        text: t('layout.conflictCount', { n: sync.conflicts }),
        hint: t('layout.conflictHint'),
        action: 'conflicts'
      };
    }

    if (sync.running) {
      return {
        color: '#0cbb52',
        text: t('layout.syncing'),
        hint: t('layout.syncingHint'),
        action: '',
        spin: true
      };
    }

    if (sync.pending > 0) {
      const offline = sync.online === false;
      return {
        color: '#f0a020',
        text: (offline ? t('layout.offlinePendingPrefix') : '') + t('layout.pendingCount', { n: sync.pending }),
        hint: offline
          ? t('layout.offlinePendingHint')
          : t('layout.pendingHint'),
        action: ''
      };
    }

    // 连不上云端时不能说「已同步」（2026-10-01：云端早就不在了，顶栏还是绿的「已同步」）
    if (sync.online === false) {
      return {
        color: '#f0a020',
        text: t('layout.offline'),
        hint: sync.lastError || t('layout.offlineHint'),
        action: ''
      };
    }

    const at = formatSyncTime(sync.lastSyncAt);
    return {
      color: '#0cbb52',
      text: t('layout.synced'),
      hint: at ? t('layout.syncedAt', { time: at }) : t('layout.syncedHint'),
      action: ''
    };
  }

  if (gateway.spaceState === 'signedOut') {
    /*
     * 「登录已过期」和「自己退出登录」在状态上是同一个值。
     *
     * 网关的 `markExpired()`（space.js）会删掉 `session.json` 同时置 `expired`，
     * 所以 `state` 也变成 `signedOut` —— **只能靠 `sync.expired` 区分这两件事**。
     * 早先把这一支写在 `signedIn` 里，结果永远显示不出来（审阅第 8 轮 B2）。
     *
     * `sync` 要等同步引擎才有，没有时按 false 处理。
     */
    if (sync.expired) {
      return {
        color: '#eb2013',
        text: t('layout.loginExpired'),
        hint: t('layout.loginExpiredHint'),
        action: 'login'
      };
    }

    return {
      color: '#6b7280',
      text: t('layout.notSyncing'),
      hint: t('layout.notSyncingHint'),
      action: 'login'
    };
  }

  return {
    color: '#6b7280',
    text: t('layout.localOnly'),
    hint: t('layout.localOnlyHint'),
    action: 'login'
  };
});

/** 有新版本时才给菜单；有冲突时菜单换成冲突列表 */
const menuEnabled = computed(function () {
  if (indicator.value.action === 'conflicts') return conflictOptions.value.length > 0;
  return gateway.isGateway && hasNewVersion.value;
});

const conflictOptions = computed(function () {
  return gateway.conflicts.map(function (item) {
    return {
      label: item.name + '（' + (ENTITY_LABEL.value[item.entity] || item.entity) + '）',
      key: item.entity + ':' + item.id
    };
  });
});

const menuOptions = computed(function () {
  if (indicator.value.action === 'conflicts') return conflictOptions.value;
  return hasNewVersion.value ? [{ label: t('layout.installNewVersionMenu'), key: 'install' }] : [];
});

/** 光标要不要变成手型：点了有事发生才变 */
const clickable = computed(function () {
  return menuEnabled.value || indicator.value.action !== '';
});

function onMenuSelect(key) {
  if (key === 'install') {
    showInstall.value = true;
    return;
  }

  // 冲突列表：key 是 `entity:id`
  const index = key.indexOf(':');
  if (index > 0) ui.openConflict(key.slice(0, index), key.slice(index + 1));
}

function onIndicatorClick() {
  // 菜单能用时这一下归下拉菜单管
  if (menuEnabled.value) return;

  const action = indicator.value.action;
  if (action === 'login') router.push('/login');
  if (action === 'install') showInstall.value = true;
  // action === 'conflicts' 走菜单
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
          <!-- 同步中转圈；其余状态是一个实心圆点 -->
          <span v-if="indicator.spin" class="spinner" />
          <span v-else class="dot" :style="{ background: indicator.color }" />
          <span class="text">{{ indicator.text }}</span>
          <span v-if="hasNewVersion" class="new-version">{{ t('layout.hasNewVersion') }}</span>
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

  <!-- 冲突对话框挂在这里：顶栏一直在，三个入口（顶栏列表、目录树、标签页）都靠 ui store 传话 -->
  <conflict-dialog />
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

/* 「同步中」转圈：一个小小的旋转圆环，和圆点同宽高 */
.spinner {
  flex: none;
  width: 11px;
  height: 11px;
  box-sizing: border-box;
  border: 2px solid rgba(12, 187, 82, 0.25);
  border-top-color: #0cbb52;
  border-radius: 50%;
  animation: conn-spin 0.8s linear infinite;
}

@keyframes conn-spin {
  to { transform: rotate(360deg); }
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
