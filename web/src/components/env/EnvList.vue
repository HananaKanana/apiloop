<script setup>
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { NButton, NDropdown, NIcon, useMessage } from 'naive-ui';
import { useDialog } from '@/utils/dialog';
import { Check, Dots, Plus } from '@vicons/tabler';
import { MOCK_ENV_ID, MOCK_LOCAL_ENV_ID, useEnvStore } from '@/stores/env';
import { useGatewayStore } from '@/stores/gateway';
import { useProjectStore } from '@/stores/project';
import ContextMenu from '@/components/common/ContextMenu.vue';

/**
 * 侧栏「环境」页（Task 7）。每个环境一行：单击在右边的环境编辑区里打开，双击设为当前环境；
 * 当前正在用的那个前面打勾；鼠标悬停时右边出现「…」菜单。
 */
const envs = useEnvStore();
const gateway = useGatewayStore();
const { t } = useI18n();

/**
 * 内置 Mock 环境排在真实环境下面、颜色浅一点（用户 2026-10-08）：单击编辑变量，双击设为当前。
 * 客户端里有两个（本机 / 云端，2026-10-08），网页版只有云端那个。
 */
const mockItems = computed(function () {
  const list = [];
  if (gateway.isGateway) list.push({ id: MOCK_LOCAL_ENV_ID, name: t('layout.mockLocal') });
  list.push({ id: MOCK_ENV_ID, name: gateway.isGateway ? t('layout.mockCloud') : 'Mock' });
  return list;
});

function openMock(id) {
  envs.edit(id);
}

function useMock(id) {
  if (envs.selectedId === id || !envs.mockUsable(id)) return;
  envs.select(id);
  message.success(t('env.switchedToMock'));
}
const projects = useProjectStore();
const message = useMessage();
const dialog = useDialog();

/** 哪一行的「…」菜单开着 */
const openMenuId = ref('');

/** 右键菜单：和「…」同一份选项 */
const ctx = ref({ show: false, x: 0, y: 0, env: null });

function openContextMenu(event, env) {
  // 没有能用的项（viewer 右键当前环境）就不弹，弹一个空菜单更让人困惑
  if (!menuOptions(env).length) return;
  ctx.value = { show: true, x: event.clientX, y: event.clientY, env: env };
}

function onContextSelect(key) {
  const env = ctx.value.env;
  ctx.value.show = false;
  if (env) onMenuSelect(env, key);
}

const list = computed(function () {
  return envs.environments || [];
});

const canEdit = computed(function () {
  return projects.canEdit;
});

function openEnv(env) {
  envs.edit(env.id);
}

/** 双击：设为当前环境（单击只是在右边打开编辑） */
function useEnv(env) {
  if (env.id === envs.selectedId) return;
  envs.select(env.id);
  message.success(t('env.switchedTo', { name: env.name }));
}

async function createEnv() {
  try {
    const env = await envs.create({ name: t('env.newEnvName'), variables: [] });
    envs.edit(env.id);
    message.success(t('env.created'));
  } catch (err) {
    message.error(err.message);
  }
}

function menuOptions(env) {
  const items = [];
  if (env.id !== envs.selectedId) items.push({ label: t('env.setCurrent'), key: 'use' });
  if (canEdit.value) {
    items.push({ label: t('env.duplicate'), key: 'duplicate' });
    items.push({ type: 'divider', key: 'd1' });
    items.push({ label: t('app.delete'), key: 'delete', props: { style: 'color: #eb2013' } });
  }
  return items;
}

async function onMenuSelect(env, key) {
  openMenuId.value = '';

  if (key === 'use') {
    envs.select(env.id);
    message.success(t('env.setCurrentDone'));
    return;
  }

  if (key === 'duplicate') {
    try {
      const created = await envs.create({
        name: env.name + t('env.copySuffix'),
        variables: env.variables || []
      });
      envs.edit(created.id);
      message.success(t('app.copied'));
    } catch (err) {
      message.error(err.message);
    }
    return;
  }

  if (key === 'delete') {
    dialog.error({
      title: t('env.deleteTitle'),
      content: t('env.deleteBody', { name: env.name }),
      positiveText: t('app.delete'),
      negativeText: t('app.cancel'),
      onPositiveClick: async function () {
        try {
          await envs.remove(env.id);
          message.success(t('mock.deleted'));
        } catch (err) {
          message.error(err.message);
        }
      }
    });
  }
}
</script>

<template>
  <div class="env-list">
    <div class="head">
      <span class="group-title">{{ t('env.title') }}</span>
      <n-button v-if="canEdit" size="tiny" quaternary @click="createEnv">
        <template #icon>
          <n-icon :component="Plus" />
        </template>
        {{ t('env.newEnv') }}
      </n-button>
    </div>

    <div class="list">
      <div
        v-for="env in list"
        :key="env.id"
        class="item"
        :class="{ active: envs.editing && env.id === envs.editing.id }"
        @click="openEnv(env)"
        @dblclick="useEnv(env)"
        @contextmenu.prevent="openContextMenu($event, env)"
      >
        <!-- 当前正在用的那个打勾，其余留空（不给常态留占位） -->
        <span class="tick">
          <n-icon v-if="env.id === envs.selectedId" size="14" :component="Check" />
        </span>
        <span class="name">{{ env.name }}</span>
        <span v-if="envs.isDirty(env.id)" class="dirty-dot" :title="t('env.dirtyTitle')" />

        <n-dropdown
          trigger="click"
          :options="menuOptions(env)"
          :show="openMenuId === env.id"
          @update:show="(v) => { openMenuId = v ? env.id : ''; }"
          @select="(key) => onMenuSelect(env, key)"
        >
          <button class="more" :title="t('env.more')" @click.stop>
            <n-icon size="15" :component="Dots" />
          </button>
        </n-dropdown>
      </div>

      <div
        v-for="item in mockItems"
        :key="item.id"
        class="item builtin-env"
        :class="{ active: envs.editing && envs.editing.id === item.id }"
        @click="openMock(item.id)"
        @dblclick="useMock(item.id)"
      >
        <span class="tick">
          <n-icon v-if="envs.selectedId === item.id" size="14" :component="Check" />
        </span>
        <span class="name">{{ item.name }}</span>
        <span class="builtin">{{ t('env.builtin') }}</span>
      </div>
    </div>

    <context-menu
      v-model:show="ctx.show"
      :x="ctx.x"
      :y="ctx.y"
      :options="ctx.env ? menuOptions(ctx.env) : []"
      @select="onContextSelect"
    />
  </div>
</template>

<style scoped>
.env-list {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.head {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 10px 6px 12px;
}

/* 和目录页的分组标题一个样式（对应 Postman 的 COLLECTIONS） */
.group-title {
  font-size: 12px;
  letter-spacing: 0.6px;
  opacity: 0.6;
  text-transform: uppercase;
}

.list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 0 6px 8px;
}

.item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 6px 5px 8px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
}

.builtin {
  flex: none;
  font-size: 11px;
  padding: 0 5px;
  border-radius: 3px;
  color: var(--apiloop-primary);
  background: rgba(255, 108, 55, 0.12);
}

.dirty-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--apiloop-primary);
}

/* 内置的 Mock 环境：比真实环境浅一档，选中时恢复 */
.item.builtin-env:not(.active) {
  opacity: 0.6;
}

.item.builtin-env:not(.active):hover {
  opacity: 0.85;
}

.item:hover {
  background: rgba(128, 128, 128, 0.12);
}

.item.active {
  background: rgba(128, 128, 128, 0.18);
}

.tick {
  flex: none;
  width: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--apiloop-primary);
}

.name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 「…」平时不显示，鼠标到这一行才出来 */
.more {
  flex: none;
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  opacity: 0;
}

.item:hover .more {
  opacity: 0.7;
}

.more:hover {
  background: rgba(128, 128, 128, 0.2);
  opacity: 1;
}
</style>
