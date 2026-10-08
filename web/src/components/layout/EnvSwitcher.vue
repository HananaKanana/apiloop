<script setup>
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { NIcon, NPopover } from 'naive-ui';
import { Bolt, Check, ChevronDown, Pencil, Server, Settings, Table } from '@vicons/tabler';
import { useProjectStore } from '@/stores/project';
import { useEnvStore, MOCK_ENV_ID, MOCK_LOCAL_ENV_ID } from '@/stores/env';
import { useGatewayStore } from '@/stores/gateway';
import { useTabsStore } from '@/stores/tabs';
import { useUiStore } from '@/stores/ui';

/**
 * 标签行最右边的环境按钮。点开是一个面板：上半截切换环境，下半截是当前环境的变量
 * （secret 遮住）。原来「快速查看」是旁边单独一个眼睛按钮，用户觉得应该合在一起，
 * 2026-09-30 合并进来，EnvQuickView 删掉。
 *
 * 列表里除了「无环境」和真实环境，还有一项**内置的 Mock 环境**（带「内置」小标签）：
 * 选中后 `host` 变量就是本项目的 mock 地址（变量可以改，存在项目上）；本机模式下用不了（置灰）。
 */
const projects = useProjectStore();
const envs = useEnvStore();
const gateway = useGatewayStore();
const ui = useUiStore();
const { t } = useI18n();

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

/**
 * 内置的两个 Mock 环境（2026-10-08）：客户端里「本机」排前面、「云端」在后；
 * 网页版只有云端那个（网页版没有本机网关）。
 */
const mockItems = computed(function () {
  const list = [];
  if (gateway.isGateway) {
    list.push({ id: MOCK_LOCAL_ENV_ID, name: t('layout.mockLocal'), hint: t('layout.mockLocalHint'), usable: true });
  }
  // 云端关了 Mock（默认关）就不显示云端那个，只剩本机的
  if (gateway.cloudMockOff) return list;
  list.push({
    id: MOCK_ENV_ID,
    name: gateway.isGateway ? t('layout.mockCloud') : 'Mock',
    hint: gateway.mockAvailable ? t('layout.mockCloudHint') : t('layout.signInToUse'),
    usable: gateway.mockAvailable
  });
  return list;
});

function selectMock(item) {
  if (!item.usable) return;
  envs.select(item.id);
}

function editCurrent() {
  // 内置的 Mock 环境也能编辑（用户 2026-10-02），它的 id 就是 MOCK_ENV_ID，编辑区是 MockEnvTab
  if (!envs.selected) return;
  envs.edit(envs.selected.id);
  ui.setSidebarTab('env');
  show.value = false;
}

function manage() {
  // 环境管理没有弹窗：切到侧栏的「环境」页，在那里点开某个环境
  ui.setSidebarTab('env');
  show.value = false;
}

/** 对比所有环境：开一个「环境对比」标签页（同一个项目只开一个） */
function compareAll() {
  useTabsStore().openEnvDiff();
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
      <button class="switcher" :class="{ open: show, empty: !envs.selected }">
        <span class="name">{{ envs.selected ? envs.selected.name : t('layout.noEnvironment') }}</span>
        <n-icon size="14" :component="ChevronDown" />
      </button>
    </template>

    <div class="panel">
      <!-- 上半截：切换环境 -->
      <div class="section">
        <div class="section-title">{{ t('layout.environmentSection') }}</div>

        <div class="item" :class="{ active: !envs.selectedId }" @click="select('')">
          <span class="item-icon none" />
          <span class="item-name">{{ t('layout.noEnvironment') }}</span>
          <n-icon v-if="!envs.selectedId" class="tick" size="16" :component="Check" />
        </div>

        <div
          v-for="env in envs.environments"
          :key="env.id"
          class="item"
          :class="{ active: env.id === envs.selectedId }"
          @click="select(env.id)"
        >
          <n-icon class="item-icon" size="15" :component="Server" />
          <span class="item-name">{{ env.name }}</span>
          <n-icon v-if="env.id === envs.selectedId" class="tick" size="16" :component="Check" />
        </div>

        <!-- 内置的 Mock 环境：不存库，排在真实环境下面、颜色浅一点（用户 2026-10-08）。本机的只在客户端里有；云端的未绑定时用不了 -->
        <div
          v-for="item in mockItems"
          :key="item.id"
          class="item"
          :class="['builtin', { active: envs.selectedId === item.id, disabled: !item.usable }]"
          :title="item.hint"
          @click="selectMock(item)"
        >
          <n-icon class="item-icon" size="15" :component="Bolt" />
          <span class="item-name">{{ item.name }}</span>
          <span class="tag">{{ item.usable ? t('layout.builtin') : t('layout.signInToUse') }}</span>
          <n-icon v-if="envs.selectedId === item.id" class="tick" size="16" :component="Check" />
        </div>
      </div>

      <!-- 下半截：当前环境里的变量（只看，改去环境标签页） -->
      <div v-if="envs.selected" class="section vars">
        <div class="vars-head">
          <span class="section-title flat">{{ t('layout.envVarsTitle', { name: envs.selected.name }) }}</span>
          <button class="text-button" @click="editCurrent">
            <n-icon size="13" :component="Pencil" />
            {{ t('layout.edit') }}
          </button>
        </div>
        <div v-if="rows.length" class="rows">
          <div v-for="row in rows" :key="row.key" class="row" :class="{ off: row.off }">
            <span class="key" :title="row.key">{{ row.key }}</span>
            <span class="value" :class="{ secret: row.secret }" :title="row.secret ? '' : row.value">{{ row.value || t('layout.emptyValue') }}</span>
          </div>
        </div>
        <div v-else class="empty">{{ t('layout.noVariables') }}</div>
      </div>

      <div class="section foot">
        <!-- 环境对比（第五轮第 3 节）：所有环境的变量并排看，找「少了一个变量」这种问题 -->
        <div class="item" @click="compareAll">
          <n-icon class="item-icon" size="15" :component="Table" />
          <span class="item-name">{{ t('layout.compareAllEnvs') }}</span>
        </div>
        <div class="item" @click="manage">
          <n-icon class="item-icon" size="15" :component="Settings" />
          <span class="item-name">{{ t('layout.manageEnvs') }}</span>
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

.switcher.empty .name {
  opacity: 0.6;
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
  width: 300px;
  max-width: 90vw;
  font-size: 13px;
}

.section {
  padding: 6px;
}

.section + .section {
  border-top: 1px solid rgba(128, 128, 128, 0.14);
}

/* 小标题：灰色小字，和下面的条目拉开层级 */
.section-title {
  padding: 4px 8px 6px;
  font-size: 11px;
  letter-spacing: 0.02em;
  opacity: 0.5;
}

.section-title.flat {
  padding: 0;
}

.item {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 32px;
  padding: 0 8px;
  border-radius: 6px;
  cursor: pointer;
}

.item:hover {
  background: rgba(128, 128, 128, 0.1);
}

/* 选中：浅橙底 + 橙字，右边一个勾，一眼能看出来 */
.item.active {
  background: rgba(255, 108, 55, 0.1);
  color: var(--apiloop-primary);
  font-weight: 500;
}

.item-icon {
  flex: none;
  width: 15px;
  opacity: 0.55;
}

.item.active .item-icon {
  opacity: 1;
}

.item-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tick {
  flex: none;
  color: var(--apiloop-primary);
}

/* 内置的 Mock 环境：比真实环境浅一档，选中时恢复 */
.item.builtin:not(.active):not(.disabled) {
  opacity: 0.6;
}

.item.builtin:not(.active):not(.disabled):hover {
  opacity: 0.85;
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
  padding: 0 6px;
  border-radius: 4px;
  font-size: 11px;
  line-height: 18px;
  font-weight: 400;
  color: inherit;
  opacity: 0.7;
  background: rgba(128, 128, 128, 0.14);
}

/* 变量区：浅灰底的一块，像「这个环境的名片」 */
.vars {
  padding: 10px 12px 12px;
  background: rgba(128, 128, 128, 0.04);
}

.vars-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}

.text-button {
  display: inline-flex;
  align-items: center;
  gap: 3px;
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
  background: rgba(255, 108, 55, 0.08);
}

.rows {
  max-height: 40vh;
  overflow: auto;
  border: 1px solid rgba(128, 128, 128, 0.14);
  border-radius: 6px;
  background: var(--n-color, transparent);
}

.row {
  display: grid;
  grid-template-columns: minmax(60px, 38%) 1fr;
  gap: 10px;
  padding: 6px 10px;
  font-size: 12px;
}

.row + .row {
  border-top: 1px solid rgba(128, 128, 128, 0.1);
}

.row.off {
  opacity: 0.4;
}

.key {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}

.value {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.6;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.value.secret {
  letter-spacing: 1px;
}

.empty {
  padding: 8px 0 2px;
  font-size: 12px;
  opacity: 0.5;
}

.foot .item {
  opacity: 0.8;
}

.foot .item:hover {
  opacity: 1;
}
</style>
