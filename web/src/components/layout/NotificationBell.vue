<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { NBadge, NButton, NIcon, NPopover } from 'naive-ui';
import { Bell } from '@vicons/tabler';
import { useDialog } from '@/utils/dialog';
import { useNotificationsStore } from '@/stores/notifications';
import { useGatewayStore } from '@/stores/gateway';
import { useProjectStore } from '@/stores/project';
import { useTabsStore } from '@/stores/tabs';
import { useUiStore } from '@/stores/ui';
import { formatFullTime, formatRelativeTime } from '@/utils/comment';

/**
 * @ 提醒的铃铛（第五轮第 4 节），挂在顶栏头像左边。
 *
 * 提醒只在云端（`notifications` 表不同步），所以**没登录时整个不显示**。
 * 未读数由 `stores/notifications.js` 每 60 秒问一次（切到后台跳过，回来立刻问）。
 *
 * 点一条要「切到那个项目、打开那个接口、展开评论面板并滚到那条」，这三件事分别落在
 * project store / tabs store / ui store 上 —— 评论面板挂在请求标签页里，
 * 靠 `ui.openComments(apiId, commentId)` 告诉它「打开，并滚到这一条」。
 */
const notifications = useNotificationsStore();
const gateway = useGatewayStore();
const projects = useProjectStore();
const tabs = useTabsStore();
const ui = useUiStore();
const dialog = useDialog();
const { t } = useI18n();

const show = ref(false);
/** 下拉里的相对时间要跟着刷新，打开时算一次就够 */
const now = ref(Date.now());

const available = computed(function () {
  return gateway.cloudFeaturesAvailable;
});

const unread = computed(function () { return notifications.unread; });

function onUpdateShow(value) {
  show.value = value;
  if (!value) return;
  now.value = Date.now();
  notifications.load();
}

/** 切项目会清掉标签页，有没保存的修改就先问一句（和 ProjectSwitcher 一个口径） */
function confirmSwitch() {
  return new Promise(function (resolve) {
    dialog.warning({
      title: t('layout.switchProjectTitle'),
      content: t('layout.switchProjectBody'),
      positiveText: t('layout.switchAction'),
      negativeText: t('app.cancel'),
      onPositiveClick: function () { resolve(true); },
      onNegativeClick: function () { resolve(false); },
      onClose: function () { resolve(false); },
      onMaskClick: function () { resolve(false); }
    });
  });
}

async function openItem(item) {
  show.value = false;
  await notifications.markOne(item.id);

  if (item.projectId && item.projectId !== projects.currentId) {
    if (tabs.hasDirty && !(await confirmSwitch())) return;
    tabs.closeAll();
    projects.setCurrent(item.projectId);
  }

  try {
    await tabs.openApi(item.apiId);
  } catch (err) {
    return;
  }
  // 请求标签页会 watch 这个，打开评论面板并滚到那一条
  ui.openComments(item.apiId, item.commentId);
}

watch(available, function (value) {
  if (value) notifications.start();
  else notifications.stop();
});

onMounted(function () {
  if (available.value) notifications.start();
});

onBeforeUnmount(function () {
  notifications.stop();
});
</script>

<template>
  <n-popover
    v-if="available"
    v-model:show="show"
    trigger="click"
    placement="bottom-end"
    :show-arrow="false"
    style="padding: 0"
    @update:show="onUpdateShow"
  >
    <template #trigger>
      <n-badge :value="unread" :max="99" :show="unread > 0" :offset="[-2, 2]">
        <button class="bell" :class="{ active: show }" :title="t('layout.notifications')">
          <n-icon size="18" :component="Bell" />
        </button>
      </n-badge>
    </template>

    <div class="panel">
      <div class="head">
        <span class="title">{{ t('layout.notifications') }}</span>
        <button v-if="unread > 0" class="text-button" @click="notifications.markAll()">
          {{ t('layout.markAllRead') }}
        </button>
      </div>

      <div class="list">
        <div v-if="!notifications.items.length" class="empty">
          {{ notifications.loaded ? t('layout.noNotifications') : t('layout.loading') }}
        </div>

        <button
          v-for="item in notifications.items"
          :key="item.id"
          class="item"
          :class="{ unread: !item.read }"
          @click="openItem(item)"
        >
          <span class="dot" :class="{ on: !item.read }" />
          <span class="text">
            <span class="actor">{{ item.actorName }}</span>{{ t('layout.mentionedIn', { api: item.apiName || t('layout.apiFallback') }) }}<span class="summary">{{ item.summary || t('layout.deletedContent') }}</span>
          </span>
          <span class="time" :title="formatFullTime(item.createdAt)">
            {{ formatRelativeTime(item.createdAt, now) }}
          </span>
        </button>
      </div>
    </div>
  </n-popover>
</template>

<style scoped>
.bell {
  position: relative;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0.75;
}

.bell:hover,
.bell.active {
  background: rgba(128, 128, 128, 0.14);
  opacity: 1;
}

.panel {
  width: 360px;
  max-width: 92vw;
  font-size: 13px;
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid rgba(128, 128, 128, 0.14);
}

.title {
  font-weight: 600;
}

.text-button {
  padding: 2px 6px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  font-size: 12px;
  opacity: 0.65;
  cursor: pointer;
}

.text-button:hover {
  opacity: 1;
  color: var(--apiloop-primary);
}

.list {
  max-height: 60vh;
  overflow: auto;
  padding: 4px;
}

.empty {
  padding: 20px 12px;
  text-align: center;
  font-size: 12px;
  opacity: 0.5;
}

.item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  width: 100%;
  padding: 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}

.item:hover {
  background: rgba(128, 128, 128, 0.1);
}

.dot {
  flex: none;
  width: 6px;
  height: 6px;
  margin-top: 6px;
  border-radius: 50%;
  background: transparent;
}

.dot.on {
  background: #eb2013;
}

.text {
  flex: 1;
  min-width: 0;
  line-height: 1.6;
}

.actor {
  font-weight: 600;
}

.summary {
  opacity: 0.75;
}

.time {
  flex: none;
  font-size: 12px;
  opacity: 0.5;
}
</style>
