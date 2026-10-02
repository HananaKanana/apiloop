<script setup>
import { computed, ref } from 'vue';
import { NButton, NDropdown, NEmpty, NIcon, useMessage } from 'naive-ui';
import { useDialog } from '@/utils/dialog';
import { Check, Dots, Plus } from '@vicons/tabler';
import { useEnvStore } from '@/stores/env';
import { useProjectStore } from '@/stores/project';
import ContextMenu from '@/components/common/ContextMenu.vue';

/**
 * 侧栏「环境」页（Task 7）。每个环境一行：单击在右边的环境编辑区里打开，双击设为当前环境；
 * 当前正在用的那个前面打勾；鼠标悬停时右边出现「…」菜单。
 */
const envs = useEnvStore();
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
  message.success('已切换到「' + env.name + '」');
}

async function createEnv() {
  try {
    const env = await envs.create({ name: '新环境', variables: [] });
    envs.edit(env.id);
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
      envs.edit(created.id);
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
        <span v-if="envs.isDirty(env.id)" class="dirty-dot" title="有没保存的修改" />

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

.dirty-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--apiloop-primary);
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
