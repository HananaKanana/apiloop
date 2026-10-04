<script setup>
import { computed } from 'vue';
import { NButton, NCheckbox, NInput, NSelect } from 'naive-ui';
import {
  PHASE_OPTIONS,
  SCOPE_OPTIONS,
  connectionOptions,
  newDbExtract,
  newDbOp,
  opProblem,
  pathPlaceholder,
  splitByPhase,
  statementPlaceholder,
  typeLabel
} from '@/utils/db';

/**
 * 接口的「数据库」页签（第九轮第 3 节）。
 *
 * 两组：请求前 / 响应后。执行顺序在服务端（`lib/send-core.js`）：
 * 请求前的操作 → 请求前脚本 → 发请求 → 响应后的操作 → 断言/提取 → 响应后脚本。
 *
 * 和「断言」页签一样，这张表住在 `spec` 上：改了就算接口有未保存的修改、按「保存」落库；
 * **没保存的改动发送时同样生效**（服务端从请求体里读）。
 *
 * 连接表是项目级的，所以这一页只负责挑连接（下拉），新增连接在项目设置里。
 */
const props = defineProps({
  dbOps: { type: Array, default: function () { return []; } },
  /** 项目里配好的连接（`projects.current.databases`） */
  databases: { type: Array, default: function () { return []; } },
  /** 只读角色（viewer）：一个都不能改 */
  disabled: { type: Boolean, default: false },
  /** 当前选了环境没有 —— 没选时「存到环境」的提取不会保存，先把话说在前面 */
  hasEnvironment: { type: Boolean, default: true },
  /** 只有本机客户端才跑得动数据库操作（网页版会跳过） */
  localAllowed: { type: Boolean, default: true }
});

const emit = defineEmits(['update:dbOps']);

const dbOps = computed(function () { return props.dbOps || []; });
const groups = computed(function () { return splitByPhase(dbOps.value); });
const options = computed(function () { return connectionOptions(props.databases); });

/** 这个操作指向的连接（用来决定语句和路径的提示文案） */
function connectionOf(op) {
  return props.databases.filter(function (item) { return item.id === op.connectionId; })[0] || null;
}

function connectionLabel(op) {
  const connection = connectionOf(op);
  return connection ? typeLabel(connection.type) : '';
}

function replace(next) {
  emit('update:dbOps', next);
}

function patchOp(id, changes) {
  replace(dbOps.value.map(function (row) {
    return row.id === id ? Object.assign({}, row, changes) : row;
  }));
}

function removeOp(id) {
  replace(dbOps.value.filter(function (row) { return row.id !== id; }));
}

function addOp(phase) {
  replace(dbOps.value.concat([newDbOp({ phase: phase })]));
}

/* ---------------- 提取 ---------------- */

function addExtract(op) {
  patchOp(op.id, { extracts: (op.extracts || []).concat([newDbExtract()]) });
}

function patchExtract(op, id, changes) {
  patchOp(op.id, {
    extracts: (op.extracts || []).map(function (row) {
      return row.id === id ? Object.assign({}, row, changes) : row;
    })
  });
}

function removeExtract(op, id) {
  patchOp(op.id, {
    extracts: (op.extracts || []).filter(function (row) { return row.id !== id; })
  });
}
</script>

<template>
  <div class="pane">
    <p class="label">
      数据库操作
      <span class="note">
        请求前的先跑（可以往库里造数据、把值填进这次请求）；响应后的排在断言之前
        （断言能用刚查出来的变量）
      </span>
    </p>

    <div v-if="localAllowed && !databases.length" class="notice">
      这个项目还没有数据库连接。先到「项目设置 → 数据库连接」里加一个，这里才能选。
    </div>
    <div v-if="!localAllowed" class="notice">
      网页版连不了数据库：数据库操作只能在客户端里新增、修改和执行。这里只能看，发送时会被跳过。
    </div>
    <div v-if="!hasEnvironment" class="notice warn">
      当前没有选环境（或者选的是内置的 Mock 环境），提取到「环境」的变量不会保存。
    </div>

    <template v-for="phase in PHASE_OPTIONS" :key="phase.value">
      <p class="group">{{ phase.label }}</p>

      <div class="ops">
        <div
          v-for="op in groups[phase.value]"
          :key="op.id"
          class="op"
          :class="{ off: op.enabled === false }"
        >
          <div class="op-head">
            <n-checkbox
              :checked="op.enabled !== false"
              :disabled="disabled"
              @update:checked="(v) => patchOp(op.id, { enabled: v })"
            />

            <n-select
              class="pick"
              size="small"
              :value="op.connectionId || null"
              :options="options"
              :disabled="disabled"
              placeholder="选连接"
              @update:value="(v) => patchOp(op.id, { connectionId: v || '' })"
            />

            <span v-if="connectionLabel(op)" class="kind">{{ connectionLabel(op) }}</span>
            <span v-if="opProblem(op)" class="problem">{{ opProblem(op) }}</span>

            <div class="op-tools">
              <n-button v-if="!disabled" size="tiny" quaternary @click="addExtract(op)">+ 提取</n-button>
              <n-button v-if="!disabled" size="tiny" quaternary type="error" @click="removeOp(op.id)">删除</n-button>
            </div>
          </div>

          <n-input
            class="statement"
            type="textarea"
            size="small"
            :value="op.statement"
            :disabled="disabled"
            :autosize="{ minRows: 2, maxRows: 6 }"
            :placeholder="statementPlaceholder(connectionOf(op) && connectionOf(op).type)"
            @update:value="(v) => patchOp(op.id, { statement: v })"
          />

          <div v-if="(op.extracts || []).length" class="extracts">
            <div v-for="row in op.extracts" :key="row.id" class="extract">
              <n-checkbox
                :checked="row.enabled !== false"
                :disabled="disabled"
                @update:checked="(v) => patchExtract(op, row.id, { enabled: v })"
              />
              <n-input
                size="small"
                :value="row.path"
                :disabled="disabled"
                :placeholder="pathPlaceholder(connectionOf(op))"
                @update:value="(v) => patchExtract(op, row.id, { path: v })"
              />
              <n-select
                size="small"
                :value="row.scope"
                :options="SCOPE_OPTIONS"
                :disabled="disabled"
                @update:value="(v) => patchExtract(op, row.id, { scope: v })"
              />
              <n-input
                size="small"
                :value="row.name"
                :disabled="disabled"
                placeholder="变量名"
                @update:value="(v) => patchExtract(op, row.id, { name: v })"
              />
              <n-button v-if="!disabled" size="tiny" quaternary type="error" @click="removeExtract(op, row.id)">
                删除
              </n-button>
              <span v-else />
            </div>
          </div>
        </div>

        <div v-if="!groups[phase.value].length" class="empty">
          {{ phase.value === 'pre' ? '还没有请求前的操作。' : '还没有响应后的操作。' }}
        </div>
      </div>

      <div v-if="!disabled" class="tools">
        <n-button size="small" @click="addOp(phase.value)">+ 添加{{ phase.label }}操作</n-button>
      </div>
    </template>

    <p class="label tail">
      结果去哪儿看
      <span class="note">每次操作在响应面板的「控制台」里占一行（连了什么库、语句、耗时、返回几行）</span>
    </p>
  </div>
</template>

<style scoped>
.pane {
  padding: 12px 16px;
}

.label {
  margin: 0 0 6px;
  font-size: 13px;
  font-weight: 600;
  opacity: 0.85;
}

.label.tail {
  margin-top: 18px;
}

.note {
  margin-left: 6px;
  font-weight: 400;
  font-size: 12px;
  opacity: 0.55;
}

.group {
  margin: 14px 0 6px;
  font-size: 12px;
  font-weight: 600;
  opacity: 0.7;
}

.notice {
  margin: 6px 0;
  padding: 5px 10px;
  border-radius: 4px;
  font-size: 12px;
  opacity: 0.8;
  background: rgba(128, 128, 128, 0.12);
}

.notice.warn {
  color: #f0a020;
  background: rgba(240, 160, 32, 0.12);
}

.ops {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.op {
  padding: 8px;
  border: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.24));
  border-radius: 4px;
}

.op.off {
  opacity: 0.55;
}

.op-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.pick {
  width: 260px;
  flex: none;
}

.kind {
  flex: none;
  font-size: 11px;
  padding: 0 5px;
  border-radius: 4px;
  opacity: 0.6;
  background: rgba(128, 128, 128, 0.16);
}

.problem {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: #f0a020;
}

.op-tools {
  margin-left: auto;
  display: flex;
  gap: 2px;
}

.extracts {
  margin-top: 6px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.extract {
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr) 96px 160px 56px;
  gap: 6px;
  align-items: center;
  padding-left: 18px;
}

.empty {
  padding: 8px 10px;
  font-size: 12px;
  opacity: 0.5;
  border: 1px dashed var(--n-border-color, rgba(128, 128, 128, 0.24));
  border-radius: 4px;
}

.tools {
  margin-top: 8px;
}
</style>
