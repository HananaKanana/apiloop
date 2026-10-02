<script setup>
import { computed, h, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import {
  NBadge,
  NButton,
  NCheckbox,
  NDropdown,
  NForm,
  NFormItem,
  NIcon,
  NInput,
  NModal,
  NSpace,
  useMessage
} from 'naive-ui';
import { User } from '@vicons/tabler';
import { useDialog } from '@/utils/dialog';
import { changePassword, logout as logoutApi } from '@/api/auth';
import { isLoginRequired } from '@/api/client';
import * as gatewayApi from '@/api/gateway';
import * as usersApi from '@/api/users';
import { useSessionStore } from '@/stores/session';
import { useTabsStore } from '@/stores/tabs';
import { useGatewayStore } from '@/stores/gateway';

const emit = defineEmits(['about']);

const router = useRouter();
const session = useSessionStore();
const tabs = useTabsStore();
const gateway = useGatewayStore();
const message = useMessage();
const dialog = useDialog();

const showPassword = ref(false);
const saving = ref(false);
const form = ref({ oldPassword: '', newPassword: '', confirm: '' });

/**
 * 注册了、等审核的人数。管理员才问；头像上一个红点、菜单里写明有几个（用户 2026-10-02 加注册审核）。
 * 打开页面问一次，之后每分钟、以及每次点开菜单再问。失败不提示 —— 角标而已。
 */
const pendingUsers = ref(0);
let pendingTimer = null;

function canSeeUsers() {
  return session.isAdmin && (!gateway.isGateway || gateway.signedIn);
}

async function refreshPending() {
  if (!canSeeUsers()) {
    pendingUsers.value = 0;
    return;
  }
  try {
    const data = await usersApi.pendingCount();
    pendingUsers.value = Number(data.count) || 0;
  } catch (err) {
    // 云端暂时连不上之类：保持上一次的数
  }
}

onMounted(function () {
  refreshPending();
  pendingTimer = setInterval(refreshPending, 60 * 1000);
});
onBeforeUnmount(function () {
  if (pendingTimer) clearInterval(pendingTimer);
});

/** 头像里那个字：显示名的第一个字 */
/**
 * 本机网关上没登录（还没登录过 / 已退出）：头像显示成灰色的人形图标，不显示名字的字。
 * 退出登录后本机库里那个用户行还在（数据要留着用），session 里的名字仍是上一个账号的，
 * 照着它显示就会让人以为还登录着（用户 2026-10-02 报的 bug）。
 */
const signedOutLook = computed(function () {
  return gateway.isGateway && !gateway.signedIn;
});

const avatarTitle = computed(function () {
  if (signedOutLook.value) return '未登录';
  return session.displayName || '未登录';
});

const avatarText = computed(function () {
  const name = String(session.displayName || session.username || '').trim();
  return name ? name.charAt(0).toUpperCase() : '?';
});

/**
 * 账号菜单（设计稿第 7 节）。网关上按空间状态分三种，直接打开云端时和以前一样。
 *
 * 未绑定：还没登录过，只能去登录；
 * 已登录：改密码 / 用户管理 / 退出登录（确认框里可以勾「同时删除本机数据」）；
 * 已退出：数据还在本机、照常能用，所以给的是「登录」和「删除本机数据」。
 */
const options = computed(function () {
  if (gateway.isGateway && !gateway.signedIn) {
    if (gateway.spaceState === 'signedOut') {
      return [
        { label: '登录', key: 'login' },
        { label: '关于', key: 'about' },
        { type: 'divider', key: 'd1' },
        { label: '删除本机数据', key: 'delete' }
      ];
    }
    return [
      { label: '登录以同步到云端', key: 'login' },
      { label: '关于', key: 'about' }
    ];
  }

  const items = [
    { label: '修改密码', key: 'password' },
    { label: '关于', key: 'about' }
  ];
  // 系统设置不放这里：顶栏已经有齿轮按钮直达，两处入口重复（2026-10-01 用户反馈）
  if (session.isAdmin) {
    items.push({
      label: pendingUsers.value > 0 ? '用户管理（' + pendingUsers.value + ' 人待审核）' : '用户管理',
      key: 'users'
    });
  }
  items.push({ type: 'divider', key: 'd1' });
  // 只有一个「退出登录」：要不要顺带删本机数据，在确认框里勾（用户 2026-10-02）
  items.push({ label: '退出登录', key: 'logout' });
  return items;
});

/** 删本机数据前问一句；还有没同步的改动时要写明会丢 */
function confirmDelete(title, withLogout) {
  const pending = (gateway.sync && gateway.sync.pending) || 0;
  const base = withLogout
    ? '退出登录并删掉这台电脑上的全部数据（项目、历史、Cookie）。'
    : '删掉这台电脑上的全部数据（项目、历史、Cookie），之后会回到「仅本机」。';

  return new Promise(function (resolve) {
    dialog.warning({
      title: title,
      content: pending > 0
        ? base + '还有 ' + pending + ' 项没同步，删除后会丢失。'
        : base,
      positiveText: '删除',
      negativeText: '取消',
      onPositiveClick: function () { resolve(true); },
      onNegativeClick: function () { resolve(false); },
      onClose: function () { resolve(false); },
      onMaskClick: function () { resolve(false); }
    });
  });
}

/**
 * 本机 apiloop 上的「退出登录」确认框，带一个勾选「同时删除这台电脑上的数据」。
 * 不勾就是普通退出（数据留在本机、照常能用）；勾了走删除本机数据那条路。
 *
 * @returns {Promise<'cancel'|'logout'|'delete'>}
 */
function confirmSignOut() {
  const removeLocal = ref(false);
  const pending = (gateway.sync && gateway.sync.pending) || 0;

  return new Promise(function (resolve) {
    let settled = false;
    function done(value) {
      if (settled) return;
      settled = true;
      resolve(value);
    }

    const instance = dialog.warning({
      title: '退出登录',
      content: function () {
        return h('div', { class: 'logout-confirm' }, [
          h('p', { style: 'margin: 0 0 12px' }, '退出后不再和云端同步。本机的数据还在，照常能用，下次登录会接着同步。'),
          h(NCheckbox, {
            checked: removeLocal.value,
            'onUpdate:checked': function (value) {
              removeLocal.value = value;
              instance.positiveText = value ? '退出并删除' : '退出登录';
              instance.type = value ? 'error' : 'default';
            }
          }, { default: function () { return '同时删除这台电脑上的数据（项目、历史、Cookie）'; } }),
          removeLocal.value && pending > 0
            ? h('p', { style: 'margin: 8px 0 0 24px; color: #d03050; font-size: 12px' },
                '还有 ' + pending + ' 项没同步到云端，删除后会丢失。')
            : null
        ]);
      },
      positiveText: '退出登录',
      negativeText: '取消',
      onPositiveClick: function () { done(removeLocal.value ? 'delete' : 'logout'); },
      onNegativeClick: function () { done('cancel'); },
      onClose: function () { done('cancel'); },
      onMaskClick: function () { done('cancel'); }
    });
  });
}

/**
 * 退出登录（网关上）：只表示「不同步了」——**不跳登录页，也不关标签页**。
 * 本机的会话和数据一个都不动，页面照常能用，开着的东西就还开着。
 *
 * 所以这里**不能**用 `session.logout()`：那会把前端的 user / meta 清掉，
 * 之后随便点一下就撞上路由守卫、被弹回登录页。网关的退出本来就不动浏览器那份会话
 * （见 `lib/gateway/account.js` 的 logout），直接调接口再刷新状态就对了。
 */
async function signOut() {
  try {
    await logoutApi();
  } catch (err) {
    message.error(err.message);
  }
  await gateway.refresh();
}

/**
 * 删本机数据（可选先退出登录），删完整页刷新 —— 页面里装的都是刚被删掉的那份数据。
 * `confirmed`：退出登录的确认框里已经勾过、问过了，不再问第二遍。
 */
async function deleteLocal(withLogout, confirmed) {
  if (!confirmed && !(await confirmDelete(withLogout ? '退出并删除本机数据' : '删除本机数据', withLogout))) return;

  tabs.closeAll();
  try {
    // 先退出：顺手通知云端注销（本机的会话一会儿跟着空间一起删掉，不用管）
    if (withLogout) await logoutApi().catch(function () {});
    await gatewayApi.deleteSpace();
    window.location.reload();
  } catch (err) {
    message.error(err.message);
  }
}

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
    // 改密码是「只有云端有的功能」，没登录时返回 409 —— 那是要先登录，不是出错
    if (isLoginRequired(err)) message.warning(err.message);
    else message.error(err.message);
  } finally {
    saving.value = false;
  }
}

async function onSelect(key) {
  if (key === 'login') return router.push('/login');
  if (key === 'password') return openPassword();
  if (key === 'users') return router.push('/users');
  if (key === 'about') return emit('about');
  if (key === 'delete') return deleteLocal(false);

  if (key === 'logout') {
    // 标签页里揣着这个用户正在编辑的请求和上一次的响应（很可能带 token），
    // 不清掉的话，换个人在同一个浏览器登录还能看见。
    // closeAll 顺带会 abort 在飞的请求、销毁服务端的 WebSocket 会话。
    if (gateway.isGateway) {
      const choice = await confirmSignOut();
      if (choice === 'delete') return deleteLocal(true, true);
      if (choice === 'logout') return signOut();
      return;
    }

    tabs.closeAll();
    await session.logout();
    router.replace('/login');
  }
}
</script>

<template>
  <n-dropdown
    :options="options"
    trigger="click"
    @select="onSelect"
    @update:show="(open) => { if (open) refreshPending(); }"
  >
    <n-badge :show="pendingUsers > 0" dot :offset="[-3, 3]">
      <button class="avatar" :class="{ anonymous: signedOutLook }" :title="avatarTitle">
        <n-icon v-if="signedOutLook" size="16" :component="User" />
        <template v-else>{{ avatarText }}</template>
      </button>
    </n-badge>
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

<style scoped>
/* 头像：主色圆底 + 白字，取显示名的第一个字 */
.avatar {
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: var(--apiloop-primary);
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.avatar.anonymous {
  background: rgba(128, 128, 128, 0.22);
  color: inherit;
}

.avatar:hover {
  opacity: 0.88;
}
</style>
