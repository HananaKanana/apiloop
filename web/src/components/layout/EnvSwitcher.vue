<script setup>
import { computed, ref, watch } from 'vue';
import { NIcon, NPopover } from 'naive-ui';
import { Check, ChevronDown } from '@vicons/tabler';
import { useProjectStore } from '@/stores/project';
import { useEnvStore, MOCK_ENV_ID } from '@/stores/env';
import { useGatewayStore } from '@/stores/gateway';
import { useUiStore } from '@/stores/ui';

/**
 * 标签行最右边的环境按钮。点开是一个面板：上半截切换环境，下半截是当前环境的变量
 * （secret 遮住）。原来「快速查看」是旁边单独一个眼睛按钮，用户觉得应该合在一起，
 * 2026-09-30 合并进来，EnvQuickView 删掉。
 *
 * 列表里除了「无环境」和真实环境，还有一项**内置的 Mock 环境**（带「内置」小标签）：
 * 选中后 `host` 变量就是本项目的 mock 地址。它不存库，本机模式下用不了（置灰）。
 */
const projects = useProjectStore();
const envs = useEnvStore();
const gateway = useGatewayStore();
const ui = useUiStore();

const show = ref(false);

// 项目一换，这个项目的环境就重新拉一遍（每个项目各自记着自己上次选的那个）
watch(
  function () { return projects.currentId; },
  async function (pid) {
    try {
      await envs.load(pid);
    } catch (err) {
      // 环境拉不到不该挡住主流程，切项目时静默失败即可
    }
  },
  { immediate: true }
);

/** 当前环境的变量，secret 遮住 */
const rows = computed(function () {
  const env = envs.selected;
  if (!env) return [];
  return (env.variables || []).filter(function (row) {
    return row && row.key;
  }).map(function (row) {
    return {
      key: row.key,
      secret: row.secret === true,
      off: row.enabled === false,
      value: row.secret === true ? '••••' : String(row.value === undefined || row.value === null ? '' : row.value)
    };
  });
});

/** 选完不收起：面板下半截马上换成新环境的变量，用户要看一眼确认（点外面再关） */
function select(id) {
  envs.select(id);
}

/** 内置 Mock 环境：本机模式下用不了（mock 服务在云端） */
function selectMock() {
  if (!gateway.mockAvailable) return;
  envs.select(MOCK_ENV_ID);
}

function editCurrent() {
  // 内置的 Mock 环境不存库，没有可编辑的东西
  if (!envs.selected || envs.selected.builtin) return;
  envs.edit(envs.selected.id);
  ui.setSidebarTab('env');
  show.value = false;
}

function manage() {
  // 环境管理没有弹窗：切到侧栏的「环境」页，在那里点开某个环境
  ui.setSidebarTab('env');
  show.value = false;
}
</script>

<template>
  <n-popover
    v-model:show="show"
    trigger="click"
    placement="bottom-end"
    :show-arrow="false"
    style="padding: 0"
  >
    <template #trigger>
      <button class="switcher" :class="{ open: show }">
        <span class="name">{{ envs.selected ? envs.selected.name : '无环境' }}</span>
        <n-icon size="14" :component="ChevronDown" />
      </button>
    </template>

    <div class="panel">
      <!-- 上半截：切换环境 -->
      <div class="section">
        <div class="item" :class="{ active: !envs.selectedId }" @click="select('')">
          <span class="tick"><n-icon v-if="!envs.selectedId" size="14" :component="Check" /></span>
          <span class="item-name">无环境</span>
        </div>

        <!-- 内置的 Mock 环境：不存库，固定在这里；本机模式下用不了 -->
        <div
          class="item"
          :class="{ active: envs.selectedId === MOCK_ENV_ID, disabled: !gateway.mockAvailable }"
          :title="!gateway.mockAvailable ? '登录后可用' : ''"
          @click="selectMock"
        >
          <span class="tick">
            <n-icon v-if="envs.selectedId === MOCK_ENV_ID" size="14" :component="Check" />
          </span>
          <span class="item-name">{{ !gateway.mockAvailable ? 'Mock（登录后可用）' : 'Mock' }}</span>
          <span class="tag">内置</span>
        </div>

        <div
          v-for="env in envs.environments"
          :key="env.id"
          class="item"
          :class="{ active: env.id === envs.selectedId }"
          @click="select(env.id)"
        >
          <span class="tick"><n-icon v-if="env.id === envs.selectedId" size="14" :component="Check" /></span>
          <span class="item-name">{{ env.name }}</span>
        </div>
      </div>

      <!-- 下半截：当前环境里的变量（只看，改去环境标签页） -->
      <div v-if="envs.selected" class="section vars">
        <div class="vars-head">
          <span>变量</span>
          <!-- 内置的 Mock 环境不存库，没有「编辑」 -->
          <a v-if="!envs.selected.builtin" class="link" @click="editCurrent">编辑</a>
        </div>
        <div v-if="rows.length" class="rows">
          <div v-for="row in rows" :key="row.key" class="row" :class="{ off: row.off }">
            <span class="key">{{ row.key }}</span>
            <span class="value" :class="{ secret: row.secret }" :title="row.secret ? '' : row.value">{{ row.value }}</span>
          </div>
        </div>
        <div v-else class="empty">这个环境里还没有变量</div>
      </div>

      <div class="section foot">
        <div class="item" @click="manage">
          <span class="tick" />
          <span class="item-name">管理环境…</span>
        </div>
      </div>
    </div>
  </n-popover>
</template>

<style scoped>
.switcher {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 26px;
  padding: 0 8px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: inherit;
  font-size: 12px;
  cursor: pointer;
}

.switcher:hover,
.switcher.open {
  background: rgba(128, 128, 128, 0.14);
}

.switcher .name {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.panel {
  width: 320px;
  max-width: 90vw;
  font-size: 13px;
}

.section {
  padding: 4px;
}

.section + .section {
  border-top: 1px solid rgba(128, 128, 128, 0.16);
}

.item {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 8px;
  border-radius: 4px;
  cursor: pointer;
}

.item:hover {
  background: rgba(128, 128, 128, 0.12);
}

.item.active {
  font-weight: 600;
}

/* 用不了的项（本机模式下的 Mock）：灰掉、不响应点击 */
.item.disabled {
  opacity: 0.45;
  cursor: default;
}

.item.disabled:hover {
  background: transparent;
}

/* 「内置」小标签：中性灰底，别和状态色打架 */
.tag {
  flex: none;
  padding: 0 5px;
  border-radius: 3px;
  font-size: 11px;
  line-height: 16px;
  font-weight: 400;
  opacity: 0.75;
  background: rgba(128, 128, 128, 0.16);
}

.tick {
  flex: none;
  width: 14px;
  display: flex;
  align-items: center;
  color: var(--apiloop-primary);
}

.item-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.vars {
  padding: 8px 12px;
}

.vars-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 4px;
  font-size: 12px;
  opacity: 0.6;
}

.link {
  color: var(--apiloop-primary);
  cursor: pointer;
}

.rows {
  max-height: 40vh;
  overflow: auto;
}

.row {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 2px 0;
  font-size: 12px;
}

.row.off {
  opacity: 0.45;
}

.key {
  flex: none;
  max-width: 45%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.value {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.75;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.value.secret {
  letter-spacing: 1px;
}

.empty {
  font-size: 12px;
  opacity: 0.5;
  padding: 4px 0;
}
</style>
