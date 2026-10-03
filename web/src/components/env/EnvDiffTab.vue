<script setup>
import { computed, ref, watch } from 'vue';
import { NButton, NEmpty, NIcon, NInput, NSwitch, NTooltip, useMessage } from 'naive-ui';
import { Eye, EyeOff } from '@vicons/tabler';
import { useEnvStore } from '@/stores/env';
import { useProjectStore } from '@/stores/project';
import { useTabsStore } from '@/stores/tabs';

/**
 * 「环境对比」标签页（第五轮第 3 节）。
 *
 * 项目里有开发、测试、预发、生产几个环境，「测试环境少了一个变量」「两个环境的 host
 * 写成了同一个」这种问题只能一个个点开环境看 —— 这里把所有环境的变量并排放一张表。
 *
 * **纯前端**：数据从 `envs.environments` 来（打开标签页时深拷贝一份当草稿），
 * 保存时只对**改过的**环境调 `PUT /environments/:id`，走的是现有接口 ——
 * 所以保密值的读写（第三轮第 3 节）自然生效，不用另做一套。
 *
 * 草稿放在 `tab.spec` 上：和目录设置标签页一样，dirty 标记、关标签页的二次确认
 * 都是白拿的。
 */
const props = defineProps({
  tab: { type: Object, required: true }
});

const envs = useEnvStore();
const projects = useProjectStore();
const tabs = useTabsStore();
const message = useMessage();

const saving = ref(false);
/** 只看有差异的 */
const onlyDiff = ref(false);
/** 点开眼睛看保密值的那些变量名 */
const revealed = ref([]);

const spec = computed(function () { return props.tab.spec; });

const canEdit = computed(function () { return projects.canEdit; });

const envList = computed(function () { return spec.value.envs || []; });

/**
 * 变量名：所有环境的并集，按名字排序。
 * 同一个变量在某个环境里可能根本没有 —— 那一格显示「（缺少）」。
 */
const variableNames = computed(function () {
  const names = [];
  envList.value.forEach(function (env) {
    (env.variables || []).forEach(function (row) {
      const key = String((row && row.key) || '');
      if (key && names.indexOf(key) === -1) names.push(key);
    });
  });
  return names.sort(function (a, b) { return a.localeCompare(b); });
});

function rowOf(env, key) {
  return (env.variables || []).find(function (row) { return String(row.key) === key; }) || null;
}

/** 这一格的值（用于比较「是不是各环境都一样」；缺变量算一种特殊值） */
function cellSignature(env, key) {
  const row = rowOf(env, key);
  if (!row) return '\u0000missing';
  return String(row.value === undefined || row.value === null ? '' : row.value) +
    (row.enabled === false ? '\u0000off' : '');
}

/** 各环境都一样（且都存在）—— 这种行默认淡掉 */
function isUniform(key) {
  const list = envList.value;
  if (list.length < 2) return false;

  const first = cellSignature(list[0], key);
  return list.every(function (env) { return cellSignature(env, key) === first; });
}

const displayNames = computed(function () {
  return onlyDiff.value
    ? variableNames.value.filter(function (key) { return !isUniform(key); })
    : variableNames.value;
});

/* ---------------- 改 ---------------- */

/** 某一格的值有没有被改过（和打开时那份快照比） */
function isChanged(env, key) {
  const saved = savedEnv(env.id);
  if (!saved) return false;

  const now = rowOf(env, key);
  const before = rowOf(saved, key);
  if (!now && !before) return false;
  if (!now || !before) return true;

  return String(now.value || '') !== String(before.value || '') ||
    (now.enabled !== false) !== (before.enabled !== false);
}

function savedEnv(envId) {
  const saved = JSON.parse(props.tab.savedSnapshot || '{}');
  return (saved.envs || []).find(function (env) { return env.id === envId; }) || null;
}

/** 改过的环境有几个（保存按钮上的数字） */
const changedEnvCount = computed(function () {
  return envList.value.filter(function (env) { return envChanged(env); }).length;
});

function envChanged(env) {
  const saved = savedEnv(env.id);
  if (!saved) return true;
  return JSON.stringify(env.variables || []) !== JSON.stringify(saved.variables || []);
}

function onValueInput(env, key, value) {
  const row = rowOf(env, key);
  if (!row) return;
  row.value = value;
}

/** 「（缺少）」那一格：点一下给这个环境加上这个变量（值为空） */
function addVariable(env, key) {
  if (!canEdit.value || rowOf(env, key)) return;
  env.variables = (env.variables || []).concat([{ key: key, value: '', enabled: true }]);
}

/** 把所有环境缺的变量都加上（值为空），加完是未保存状态 */
function fillMissing() {
  let added = 0;
  envList.value.forEach(function (env) {
    variableNames.value.forEach(function (key) {
      if (rowOf(env, key)) return;
      env.variables = (env.variables || []).concat([{ key: key, value: '', enabled: true }]);
      added += 1;
    });
  });

  if (!added) message.info('没有缺的变量');
  else message.success('补齐了 ' + added + ' 处，填好值再保存');
}

function toggleReveal(key) {
  const list = revealed.value.slice();
  const at = list.indexOf(key);
  if (at === -1) list.push(key);
  else list.splice(at, 1);
  revealed.value = list;
}

function isSecret(key) {
  return envList.value.some(function (env) {
    const row = rowOf(env, key);
    return Boolean(row && row.secret);
  });
}

/* ---------------- 保存 / 放弃 ---------------- */

/**
 * 保存：**只发改过的环境**，一个一个 PUT。
 *
 * 中间有失败的**不回滚已经成功的那些** —— 用户改了十个环境，因为其中一个重名
 * 就把另外九个回退，等于白改。失败的留在未保存状态（格子还是黄的），并说清楚是哪个。
 */
async function save() {
  const pending = envList.value.filter(function (env) { return envChanged(env); });
  if (!pending.length) return;

  saving.value = true;
  const failedIds = [];
  const failedText = [];

  for (const env of pending) {
    try {
      await envs.update(env.id, {
        name: env.name,
        variables: JSON.parse(JSON.stringify(env.variables || []))
      });
    } catch (err) {
      failedIds.push(env.id);
      failedText.push('「' + env.name + '」' + err.message);
    }
  }

  // 成功的写回快照：失败的那一列继续标黄、标签页继续是「未保存」
  const saved = JSON.parse(props.tab.savedSnapshot || '{"envs":[]}');
  envList.value.forEach(function (env) {
    if (failedIds.indexOf(env.id) > -1) return;

    const target = (saved.envs || []).find(function (item) { return item.id === env.id; });
    if (target) target.variables = JSON.parse(JSON.stringify(env.variables || []));
  });
  props.tab.savedSnapshot = JSON.stringify(saved);
  tabs.touch(props.tab);

  saving.value = false;
  if (failedText.length) message.error('这些环境没保存成功：' + failedText.join('；'));
  else message.success('已保存 ' + pending.length + ' 个环境');
}

/** 放弃修改：退回打开时（或上次保存时）那一份 */
function discard() {
  const saved = JSON.parse(props.tab.savedSnapshot || '{"envs":[]}');
  spec.value.envs = (saved.envs || []).map(function (env) {
    return {
      id: env.id,
      name: env.name,
      variables: JSON.parse(JSON.stringify(env.variables || []))
    };
  });
  message.info('已放弃修改');
}

watch(
  function () { return props.tab.spec; },
  function () { tabs.touch(props.tab); },
  { deep: true }
);

// 打开的时候环境可能还没拉完（或者刚被别处改过）：草稿是空的重建一份
watch(
  function () { return envs.environments; },
  function (list) {
    if (envList.value.length || !list.length) return;
    spec.value.envs = list.map(function (env) {
      return {
        id: env.id,
        name: env.name,
        variables: JSON.parse(JSON.stringify(env.variables || []))
      };
    });
    props.tab.savedSnapshot = JSON.stringify({ envs: spec.value.envs });
  }
);
</script>

<template>
  <div class="env-diff">
    <div class="head">
      <span class="title">环境对比</span>
      <span class="count">{{ envList.length }} 个环境 · {{ displayNames.length }} 个变量</span>
      <span class="spacer" />

      <label class="switch">
        <n-switch v-model:value="onlyDiff" size="small" />
        <span>只看有差异的</span>
      </label>

      <n-button v-if="canEdit" size="small" secondary @click="fillMissing">补齐缺少的变量</n-button>
      <n-button v-if="canEdit" size="small" :disabled="!changedEnvCount" @click="discard">
        放弃修改
      </n-button>
      <n-button
        v-if="canEdit"
        size="small"
        type="primary"
        :loading="saving"
        :disabled="!changedEnvCount"
        @click="save"
      >
        保存（{{ changedEnvCount }} 处修改）
      </n-button>
      <span v-else class="hint">当前角色是只读</span>
    </div>

    <div class="body">
      <n-empty
        v-if="!envList.length"
        class="empty"
        description="这个项目还没有环境。先在左侧「环境」里新建几个，再回来对比。"
      />

      <table v-else-if="displayNames.length" class="grid">
        <thead>
          <tr>
            <th class="name-col">变量名</th>
            <th v-for="env in envList" :key="env.id">{{ env.name }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="key in displayNames" :key="key" :class="{ uniform: isUniform(key) }">
            <td class="name-col">
              <span class="var-name">{{ key }}</span>
              <button
                v-if="isSecret(key)"
                class="eye"
                :title="revealed.indexOf(key) > -1 ? '遮住' : '看自己的值'"
                @click="toggleReveal(key)"
              >
                <n-icon size="14" :component="revealed.indexOf(key) > -1 ? EyeOff : Eye" />
              </button>
            </td>

            <td
              v-for="env in envList"
              :key="env.id"
              class="cell"
              :class="{
                changed: isChanged(env, key),
                disabled: rowOf(env, key) && rowOf(env, key).enabled === false
              }"
            >
              <n-tooltip v-if="!rowOf(env, key)" trigger="hover" :disabled="!canEdit">
                <template #trigger>
                  <button class="missing" @click="addVariable(env, key)">（缺少）</button>
                </template>
                点一下给这个环境加上
              </n-tooltip>

              <n-input
                v-else
                size="tiny"
                :bordered="false"
                :disabled="!canEdit"
                :type="isSecret(key) && revealed.indexOf(key) === -1 ? 'password' : 'text'"
                :value="rowOf(env, key).value"
                @update:value="(value) => onValueInput(env, key, value)"
              />
            </td>
          </tr>
        </tbody>
      </table>

      <n-empty
        v-else
        class="empty"
        :description="onlyDiff ? '所有环境都一样，没有差异' : '这些环境里还没有变量'"
      />
    </div>
  </div>
</template>

<style scoped>
.env-diff {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.16));
}

.title {
  font-size: 14px;
  font-weight: 600;
}

.count {
  font-size: 12px;
  opacity: 0.6;
}

.spacer {
  flex: 1;
}

.switch {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  opacity: 0.8;
  cursor: pointer;
}

.hint {
  font-size: 12px;
  opacity: 0.6;
}

.body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 0 16px 16px;
}

.empty {
  padding: 40px 0;
}

.grid {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  font-size: 12px;
}

.grid th,
.grid td {
  padding: 0;
  border-bottom: 1px solid rgba(128, 128, 128, 0.12);
}

.grid th {
  position: sticky;
  top: 0;
  z-index: 1;
  padding: 8px 10px;
  text-align: left;
  font-weight: 500;
  font-size: 12px;
  opacity: 0.65;
  background: var(--apiloop-surface);
  border-bottom: 1px solid var(--apiloop-divider);
}

.name-col {
  width: 220px;
  min-width: 140px;
  padding: 4px 10px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.var-name {
  vertical-align: middle;
}

/* 各环境都一样的行淡掉：不用看的就别抢注意力 */
.grid tr.uniform td {
  opacity: 0.55;
}

.cell {
  padding: 2px 6px;
}

/* 改过的格子标黄 */
.cell.changed {
  background: rgba(240, 160, 32, 0.18);
}

/* 停用的变量：值加删除线 */
.cell.disabled :deep(.n-input__input-el) {
  text-decoration: line-through;
  opacity: 0.7;
}

.missing {
  padding: 2px 4px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  font-size: 12px;
  opacity: 0.4;
  cursor: pointer;
}

.missing:hover {
  opacity: 0.85;
  background: rgba(128, 128, 128, 0.12);
}

.eye {
  margin-left: 6px;
  padding: 0 2px;
  border: none;
  border-radius: 3px;
  background: transparent;
  color: inherit;
  opacity: 0.45;
  cursor: pointer;
  vertical-align: middle;
}

.eye:hover {
  opacity: 1;
  color: var(--apiloop-primary);
}
</style>
