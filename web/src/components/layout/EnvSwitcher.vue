<script setup>
import { computed, ref, watch } from 'vue';
import { NIcon, NPopover } from 'naive-ui';
import { Check, ChevronDown } from '@vicons/tabler';
import { useProjectStore } from '@/stores/project';
import { useEnvStore } from '@/stores/env';
import { useUiStore } from '@/stores/ui';
import { useTabsStore } from '@/stores/tabs';

/**
 * 标签行最右边的环境按钮。点开是一个面板：上半截切换环境，下半截是当前环境的变量
 * （secret 遮住）。原来「快速查看」是旁边单独一个眼睛按钮，用户觉得应该合在一起，
 * 2026-09-30 合并进来，EnvQuickView 删掉。
 */
const projects = useProjectStore();
const envs = useEnvStore();
const ui = useUiStore();
const tabs = useTabsStore();

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

// 环境被删掉之后，把它的标签页收掉。放在这里是因为切换器一直挂着（标签行常驻），
// 而侧栏的「环境」页只有停在那页时才在。
watch(
  function () { return envs.environments; },
  function (list) {
    tabs.syncWithEnvs((list || []).map(function (item) { return item.id; }));
  },
  { deep: true }
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

function editCurrent() {
  if (!envs.selected) return;
  tabs.openEnv(envs.selected.id);
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
          <a class="link" @click="editCurrent">编辑</a>
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
