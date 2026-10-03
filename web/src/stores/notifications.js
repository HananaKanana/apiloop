import { defineStore } from 'pinia';
import { ref } from 'vue';
import * as commentsApi from '@/api/comments';

/**
 * @ 提醒（第五轮第 4 节）。
 *
 * 未读数**每 60 秒**问一次云端（`start` / `stop` 由铃铛组件挂在自己的生命周期上）。
 * 切到后台时跳过这一轮、回到前台立刻问一次 —— 一直挂着轮询没意义，回来时数据又必须是新的。
 *
 * 提醒数据只在云端（评论和提醒两张表都不同步），所以铃铛也只在能用云端时出现。
 */

const POLL_MS = 60 * 1000;
const LIST_LIMIT = 50;

export const useNotificationsStore = defineStore('notifications', function () {
  const unread = ref(0);
  const items = ref([]);
  const loading = ref(false);
  /** 列表拉过一次了没有（没拉过时下拉里显示「加载中」，不是「没有提醒」） */
  const loaded = ref(false);

  let timer = null;

  async function refreshUnread() {
    try {
      const data = await commentsApi.unreadCount();
      unread.value = Number(data.count) || 0;
    } catch (err) {
      // 云端暂时连不上之类：保持上一次的数，下个周期自己会重试
    }
  }

  async function load() {
    loading.value = true;
    try {
      const data = await commentsApi.listNotifications(LIST_LIMIT);
      items.value = data.items || [];
      loaded.value = true;
      // 列表比未读数新，直接用列表算，省一次请求
      unread.value = items.value.filter(function (item) { return !item.read; }).length;
    } catch (err) {
      // 同上：拉不到就不动，界面显示上一次的
    } finally {
      loading.value = false;
    }
  }

  async function markAll() {
    try {
      const data = await commentsApi.markRead({ all: true });
      unread.value = Number(data.count) || 0;
      items.value = items.value.map(function (item) {
        return Object.assign({}, item, { read: true });
      });
    } catch (err) {
      // 标不上就还是未读，用户再点一次
    }
  }

  async function markOne(id) {
    try {
      const data = await commentsApi.markRead({ ids: [id] });
      unread.value = Number(data.count) || 0;
      items.value = items.value.map(function (item) {
        return item.id === id ? Object.assign({}, item, { read: true }) : item;
      });
    } catch (err) {
      // 同上
    }
  }

  /** 切到后台的那一轮跳过；回到前台立刻问一次 */
  function onVisibilityChange() {
    if (!document.hidden) refreshUnread();
  }

  function tick() {
    if (document.hidden) return;
    refreshUnread();
  }

  function start() {
    stop();
    refreshUnread();
    timer = setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', onVisibilityChange);
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    document.removeEventListener('visibilitychange', onVisibilityChange);
  }

  return {
    unread: unread,
    items: items,
    loading: loading,
    loaded: loaded,
    refreshUnread: refreshUnread,
    load: load,
    markAll: markAll,
    markOne: markOne,
    start: start,
    stop: stop
  };
});
