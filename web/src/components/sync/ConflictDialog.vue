<script setup>
import { computed, ref } from 'vue';
import { NButton, NModal, NSpace, NSpin, useMessage } from 'naive-ui';
import { useDialog } from '@/utils/dialog';
import * as apisApi from '@/api/apis';
import * as gatewayApi from '@/api/gateway';
import { useGatewayStore } from '@/stores/gateway';
import { useTabsStore } from '@/stores/tabs';
import { useTreeStore } from '@/stores/tree';
import { useUiStore } from '@/stores/ui';

/**
 * 冲突处理对话框（设计稿 5.3、第 7 节）。
 *
 * 左「我的」右「云端的」，**只列冲突的字段**（服务端只返回不一致的那几列）。
 * 三个选择：用我的、用云端的、另存为副本（另存只对接口有意义）。
 *
 * 打开哪一条由 `ui.conflictTarget` 决定 —— 入口有三个（顶栏的冲突列表、目录树、
 * 请求标签页顶部），所以挂在这里、由 ui store 传话。
 */
const gateway = useGatewayStore();
const tabs = useTabsStore();
const tree = useTreeStore();
const ui = useUiStore();
const message = useMessage();
const dialog = useDialog();

const saving = ref(false);

const visible = computed({
  get: function () { return Boolean(ui.conflictTarget); },
  set: function (value) { if (!value) ui.closeConflict(); }
});

const ENTITY_LABEL = {
  project: '项目',
  environment: '环境',
  folder: '目录',
  api: '接口',
  example: '示例',
  expectation: '期望'
};

const target = computed(function () {
  if (!ui.conflictTarget) return null;
  return gateway.findConflict(ui.conflictTarget.entity, ui.conflictTarget.id);
});

const entityLabel = computed(function () {
  const entity = ui.conflictTarget && ui.conflictTarget.entity;
  return ENTITY_LABEL[entity] || '内容';
});

/** 另存为副本只有接口有意义（服务端也这么说） */
const canCopy = computed(function () {
  return Boolean(ui.conflictTarget && ui.conflictTarget.entity === 'api');
});

/**
 * 冲突字段的值。JSON 列（`variables`、`auth`、`scripts`…）在接口里是**字符串**，
 * 直接显示是一坨压紧的 JSON，先解析再缩进；不是 JSON 就原样显示。
 */
function showValue(value) {
  if (value === null || value === undefined) return '（空）';

  const text = String(value);
  const trimmed = text.trim();
  const head = trimmed.charAt(0);
  if (head !== '{' && head !== '[') return text;

  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch (err) {
    return text;
  }
}

const rows = computed(function () {
  const conflict = target.value;
  if (!conflict) return [];
  return (conflict.fields || []).map(function (item) {
    return {
      field: item.field,
      mine: showValue(item.mine),
      theirs: showValue(item.theirs)
    };
  });
});

/** 打开着的、属于这条冲突的标签页（普通接口和 WebSocket 都算，按 `apiId` 认） */
function findTab() {
  const conflict = ui.conflictTarget;
  if (!conflict || conflict.entity !== 'api') return null;
  return tabs.tabs.find(function (tab) { return tab.apiId === conflict.id; }) || null;
}

/**
 * 「用云端的」「另存为副本」会把这个接口的标签页换成库里的新样子，
 * 标签页里没保存的修改就没了 —— 先问一句。
 *
 * 「用我的」不会碰标签页，不用问。
 */
function confirmDiscard() {
  const tab = findTab();
  if (!tab || !tab.dirty) return Promise.resolve(true);

  return new Promise(function (resolve) {
    dialog.warning({
      title: '标签页里有没保存的修改',
      content: '标签页里还有没保存的修改，选这一项会丢掉它们。要继续吗？',
      positiveText: '继续',
      negativeText: '取消',
      onPositiveClick: function () { resolve(true); },
      onNegativeClick: function () { resolve(false); },
      onClose: function () { resolve(false); },
      onMaskClick: function () { resolve(false); }
    });
  });
}

/**
 * 处理完之后把打开的标签页换成库里的新样子。
 *
 * **必须用 `apisApi.getApi` 拿完整接口，不能用 `tree.apiById`** ——
 * 目录树里的接口是 `dto.toApiSummary` 摘要，只有 id / 目录 / 名字 / 方法 / 地址 /
 * 位置 / mock 开关，**没有 params / body / auth / scripts**。拿它去 `markSaved`，
 * 标签页会被刷成空的那几项，用户再一保存就写进库里、还会被推到云端，
 * 两边的数据都没了（审阅第 11 轮 B11）。`getApi` 就是打开标签页用的那个。
 *
 * 「用我的」本机那一行根本没变，**不动标签页** —— 免得把用户没保存的修改丢掉。
 */
async function reloadTabs(entity, id, choice) {
  if (entity !== 'api' || choice === 'mine') return;

  const data = await apisApi.getApi(id);
  tabs.tabs.forEach(function (tab) {
    // 按 apiId 判断：普通接口标签页和 WebSocket 标签页都要刷（审阅第 11 轮 N6）
    if (tab.apiId === id) tabs.markSaved(tab, data.api);
  });
}

async function resolve(choice) {
  const conflict = ui.conflictTarget;
  if (!conflict) return;

  // 会刷新标签页的那两项，先确认没保存的修改可以被丢掉
  if (choice !== 'mine' && !(await confirmDiscard())) return;

  saving.value = true;
  try {
    const data = await gatewayApi.resolveConflict(conflict.entity, conflict.id, choice);
    ui.closeConflict();

    // 清单变了，先重新拉一次；目录树的小点 / 感叹号都靠它
    await gateway.refreshSyncDetails();
    await tree.refresh();
    await reloadTabs(conflict.entity, conflict.id, choice);

    if (choice === 'copy' && data.copyId) {
      message.success('已经另存为副本');
    } else {
      message.success(choice === 'mine' ? '已经用你的版本' : '已经用云端的版本');
    }
  } catch (err) {
    message.error(err.message);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <n-modal
    v-model:show="visible"
    preset="card"
    title="处理冲突"
    style="width: 780px; max-width: 94vw"
  >
    <n-spin :show="saving">
      <template v-if="target">
        <p class="lead">
          这个{{ entityLabel }}在本机和云端都改过。选一份用，另一份的改动会被覆盖。
        </p>

        <div class="compare">
          <div class="head">
            <span class="field">字段</span>
            <span class="side mine">我的</span>
            <span class="side theirs">云端的</span>
          </div>

          <div v-for="row in rows" :key="row.field" class="row">
            <span class="field">{{ row.field }}</span>
            <pre class="cell mine">{{ row.mine }}</pre>
            <pre class="cell theirs">{{ row.theirs }}</pre>
          </div>
        </div>
      </template>

      <p v-else class="lead">这条冲突已经处理过了。</p>
    </n-spin>

    <template #footer>
      <n-space justify="end">
        <n-button :disabled="saving" @click="ui.closeConflict()">关闭</n-button>
        <n-button
          v-if="canCopy"
          :disabled="!target || saving"
          @click="resolve('copy')"
        >
          另存为副本
        </n-button>
        <n-button :disabled="!target || saving" @click="resolve('theirs')">用云端的</n-button>
        <n-button type="primary" :disabled="!target || saving" @click="resolve('mine')">用我的</n-button>
      </n-space>
    </template>
  </n-modal>
</template>

<style scoped>
.lead {
  margin: 0 0 12px;
  font-size: 13px;
  opacity: 0.75;
  line-height: 1.7;
}

.compare {
  max-height: 52vh;
  overflow: auto;
  border: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.24));
  border-radius: 6px;
}

/* 字段 / 我的 / 云端的：三列等宽，长内容自己滚 */
.head,
.row {
  display: grid;
  grid-template-columns: 120px 1fr 1fr;
  gap: 10px;
  padding: 6px 10px;
}

.head {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--n-color, rgba(128, 128, 128, 0.08));
  font-size: 12px;
  font-weight: 600;
  opacity: 0.75;
}

.row + .row {
  border-top: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.16));
}

.field {
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  opacity: 0.8;
  word-break: break-all;
}

.side {
  font-size: 12px;
}

.cell {
  margin: 0;
  max-height: 220px;
  overflow: auto;
  font-size: 12px;
  line-height: 1.6;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: pre-wrap;
  word-break: break-all;
}

/* 「我的」那一列给一点底色，一眼能分出左右 */
.cell.mine {
  background: rgba(128, 128, 128, 0.06);
  border-radius: 4px;
  padding: 2px 6px;
}

.cell.theirs {
  padding: 2px 6px;
}
</style>
