<script setup>
import { computed, ref } from 'vue';
import { NButton, NDropdown, NEmpty, NIcon, useDialog, useMessage } from 'naive-ui';
import { Check, Dots, Plus } from '@vicons/tabler';
import { useEnvStore } from '@/stores/env';
import { useProjectStore } from '@/stores/project';
import { useTabsStore } from '@/stores/tabs';

/**
 * 侧栏「环境」页（Task 7）。每个环境一行：点它打开对应的标签页；
 * 当前正在用的那个前面打勾；鼠标悬停时右边出现「…」菜单。
 */
const envs = useEnvStore();
const projects = useProjectStore();
const tabs = useTabsStore();
const message = useMessage();
const dialog = useDialog();

/** 哪一行的「…」菜单开着 */
const openMenuId = ref('');

const list = computed(function () {
  return envs.environments || [];
});

const canEdit = computed(function () {
  return projects.canEdit;
});

function openEnv(env) {
  tabs.openEnv(env.id);
}

async function createEnv() {
  try {
    const env = await envs.create({ name: '新环境', variables: [] });
    await tabs.openEnv(env.id);
    message.success('已创建');
  } catch (err) {
    message.error(err.message);
  }
}

function menuOptions(env) {
  const items = [];
  if (env.id !== envs.selectedId) items.push({ label: '设为当前', key: 'use' });
  if (canEdit.value) {
    items.push({ label: '复制', key: 'duplicate' });
    items.push({ type: 'divider', key: 'd1' });
    items.push({ label: '删除', key: 'delete', props: { style: 'color: #eb2013' } });
  }
  return items;
}

async function onMenuSelect(env, key) {
  openMenuId.value = '';

  if (key === 'use') {
    envs.select(env.id);
    message.success('已设为当前环境');
    return;
  }

  if (key === 'duplicate') {
    try {
      const created = await envs.create({
        name: env.name + ' 副本',
        variables: env.variables || []
      });
      await tabs.openEnv(created.id);
      message.success('已复制');
    } catch (err) {
      message.error(err.message);
    }
    return;
  }

  if (key === 'delete') {
    dialog.error({
      title: '删除环境',
      content: '确定删除「' + env.name + '」吗？用了它里面变量的请求会变成未定义。',
      positiveText: '删除',
      negativeText: '取消',
      onPositiveClick: async function () {
        try {
          await envs.remove(env.id);
          message.success('已删除');
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
      <span class="group-title">环境</span>
      <n-button v-if="canEdit" size="tiny" quaternary @click="createEnv">
        <template #icon>
          <n-icon :component="Plus" />
        </template>
        新建环境
      </n-button>
    </div>

    <div class="list">
      <div
        v-for="env in list"
        :key="env.id"
        class="item"
        :class="{ active: env.id === envs.selectedId }"
        @click="openEnv(env)"
      >
        <!-- 当前正在用的那个打勾，其余留空（不给常态留占位） -->
        <span class="tick">
          <n-icon v-if="env.id === envs.selectedId" size="14" :component="Check" />
        </span>
        <span class="name">{{ env.name }}</span>
        <span class="count">{{ (env.variables || []).length }}</span>

        <n-dropdown
          trigger="click"
          :options="menuOptions(env)"
          :show="openMenuId === env.id"
          @update:show="(v) => { openMenuId = v ? env.id : ''; }"
          @select="(key) => onMenuSelect(env, key)"
        >
          <button class="more" title="更多" @click.stop>
            <n-icon size="15" :component="Dots" />
          </button>
        </n-dropdown>
      </div>

      <n-empty
        v-if="!list.length"
        size="small"
        description="还没有环境，点右上角「新建环境」"
      />
    </div>
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
  color: #0cbb52;
}

.name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.count {
  flex: none;
  font-size: 11px;
  opacity: 0.55;
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
