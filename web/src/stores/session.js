import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { request } from '@/api/client';
import * as authApi from '@/api/auth';

/**
 * 登录态 + /meta 里的公共信息（品牌名、版本、库路径、占位符、模板）。
 *
 * /meta 一次就能把「有没有登录」和「这个进程长什么样」都拿到，所以用它做启动探测：
 * 401 时抛错（noAuthRedirect），调用方据此判断未登录，而不是被跳转逻辑挂住。
 */
export const useSessionStore = defineStore('session', function () {
  const user = ref(null);
  const meta = ref(null);
  const ready = ref(false);

  const isAdmin = computed(function () {
    return Boolean(user.value && user.value.role === 'admin');
  });

  const displayName = computed(function () {
    if (!user.value) return '';
    return user.value.displayName || user.value.username;
  });

  const appName = computed(function () {
    return (meta.value && meta.value.appName) || 'apiloop';
  });

  async function load() {
    try {
      const data = await request('GET', '/meta', null, { noAuthRedirect: true });
      meta.value = data;
      user.value = data.user || null;
    } catch (err) {
      user.value = null;
    }
    ready.value = true;
    return user.value;
  }

  /** 重新拉一次 /meta（改完项目、导入了集合之后，占位符和模板可能没变，但项目信息会变） */
  async function refreshMeta() {
    try {
      const data = await request('GET', '/meta', null, { noAuthRedirect: true });
      meta.value = data;
      if (data.user) user.value = data.user;
    } catch (err) {
      // 刷新失败就先沿用旧的，不打断操作
    }
  }

  async function login(username, password) {
    const data = await authApi.login(username, password);
    user.value = data.user;
    await refreshMeta();
    return data.user;
  }

  async function logout() {
    try {
      await authApi.logout();
    } catch (err) {
      // 服务端删不掉 session 也要让用户退出，本地状态清掉就行
    }
    user.value = null;
    meta.value = null;
    ready.value = false;
  }

  function setUser(next) {
    user.value = next;
  }

  return {
    user: user,
    meta: meta,
    ready: ready,
    isAdmin: isAdmin,
    displayName: displayName,
    appName: appName,
    load: load,
    refreshMeta: refreshMeta,
    login: login,
    logout: logout,
    setUser: setUser
  };
});
