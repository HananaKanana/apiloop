<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { NButton, NDropdown, NIcon, NInput, NTag, useDialog, useMessage } from 'naive-ui';
import { Dots } from '@vicons/tabler';
import { useEnvStore } from '@/stores/env';
import { useProjectStore } from '@/stores/project';
import * as importExportApi from '@/api/importExport';
import { downloadJson } from '@/utils/download';
import VarTable from '@/components/common/VarTable.vue';

/**
 * 环境编辑区。侧栏切到「环境」时，右边整块就是它 —— 不再和接口挤在同一排标签页里
 * （用户 2026-09-30）。名字可以直接点着改，变量表占满整屏。
 *
 * 编辑的是**一份草稿**，放在 env store 的 `drafts` 里：保存前不动服务端返回的那份，
 * 切回目录、换一个环境再回来，改了一半的内容都还在。
 */
const props = defineProps({
  envId: { type: String, required: true }
});

const envs = useEnvStore();
const projects = useProjectStore();
const message = useMessage();
const dialog = useDialog();

const saving = ref(false);
const keyword = ref('');

const canEdit = computed(function () {
  return projects.canEdit;
});

const env = computed(function () {
  return envs.environments.find(function (item) { return item.id === props.envId; }) || null;
});

const isCurrent = computed(function () {
  return envs.selectedId === props.envId;
});

/** 服务端那份的深拷贝，当作草稿的起点 */
function freshDraft(saved) {
  return { name: saved.name, variables: JSON.parse(JSON.stringify(saved.variables || [])) };
}

// 还没有草稿就按服务端那份建一份（放在 watch 里建，别在 computed 的 getter 里改 store）
watch(env, function (saved) {
  if (saved && !envs.drafts[props.envId]) envs.drafts[props.envId] = freshDraft(saved);
}, { immediate: true });

function draft() {
  return envs.drafts[props.envId] || null;
}

const draftName = computed({
  get: function () { const d = draft(); return d ? d.name : ''; },
  set: function (value) { const d = draft(); if (d) d.name = value; }
});

const draftVariables = computed({
  get: function () { const d = draft(); return d ? d.variables : []; },
  set: function (value) { const d = draft(); if (d) d.variables = value; }
});

const dirty = computed(function () {
  return envs.isDirty(props.envId);
});

const count = computed(function () {
  return draftVariables.value.filter(function (row) {
    return row && (row.key || row.value);
  }).length;
});

/* ---------------- 保存 ---------------- */

async function save() {
  const saved = env.value;
  if (!saved || !dirty.value) return;

  const name = draftName.value.trim();
  if (!name) {
    message.warning('环境名不能为空');
    return;
  }

  saving.value = true;
  try {
    const updated = await envs.update(saved.id, { name: name, variables: draftVariables.value });
    // 用服务端返回的那份重建草稿（它会丢掉没填名字的空行），「未保存」随之消失
    envs.drafts[props.envId] = freshDraft(updated);
    message.success('已保存');
  } catch (err) {
    message.error(err.message);
  } finally {
    saving.value = false;
  }
}

function onKeydown(event) {
  if (!(event.metaKey || event.ctrlKey)) return;
  if (String(event.key).toLowerCase() !== 's') return;
  event.preventDefault();

  if (!canEdit.value) {
    message.warning('当前角色是只读，不能保存修改');
    return;
  }
  save();
}

onMounted(function () {
  window.addEventListener('keydown', onKeydown);
});

onBeforeUnmount(function () {
  window.removeEventListener('keydown', onKeydown);
});

/* ---------------- 设为当前 / 复制 / 导出 / 删除 ---------------- */

function setCurrent() {
  envs.select(props.envId);
  message.success('已设为当前环境');
}

async function duplicate() {
  const saved = env.value;
  if (!saved) return;

  try {
    const created = await envs.create({
      name: draftName.value.trim() + ' 副本',
      variables: draftVariables.value
    });
    envs.edit(created.id);
    message.success('已复制');
  } catch (err) {
    message.error(err.message);
  }
}

async function exportEnv() {
  const saved = env.value;
  if (!saved) return;

  try {
    const data = await importExportApi.exportEnvironment(saved.id);
    downloadJson(data.filename, data.json);
    message.success('已导出');
  } catch (err) {
    message.error(err.message);
  }
}

function removeEnv() {
  const saved = env.value;
  if (!saved) return;

  dialog.error({
    title: '删除环境',
    content: '确定删除「' + saved.name + '」吗？用了它里面变量的请求会变成未定义。',
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async function () {
      try {
        await envs.remove(saved.id);
        message.success('已删除');
      } catch (err) {
        message.error(err.message);
      }
    }
  });
}

const menuOptions = computed(function () {
  const exportItem = { label: '导出为 Postman 环境', key: 'export' };
  // viewer 只读，但导出是看数据、不改数据 —— 原来那个弹窗里 viewer 也是能导出的
  if (!canEdit.value) return [exportItem];

  return [
    { label: '复制环境', key: 'duplicate' },
    exportItem,
    { type: 'divider', key: 'd1' },
    { label: '删除环境', key: 'delete', props: { style: 'color: #eb2013' } }
  ];
});

function onMenuSelect(key) {
  if (key === 'duplicate') return duplicate();
  if (key === 'export') return exportEnv();
  if (key === 'delete') return removeEnv();
}
</script>

<template>
  <div class="env-tab">
    <div class="head">
      <n-input
        class="name"
        size="small"
        :value="draftName"
        :readonly="!canEdit"
        placeholder="环境名"
        @update:value="(v) => { draftName = v; }"
      />
      <span v-if="dirty" class="dirty-dot" title="有没保存的修改，⌘S 保存" />

      <n-tag v-if="isCurrent" size="small" :bordered="false">当前</n-tag>
      <n-button v-else-if="canEdit" size="small" quaternary @click="setCurrent">设为当前</n-button>

      <span class="spacer" />

      <n-button
        v-if="canEdit"
        size="small"
        :disabled="!dirty"
        :loading="saving"
        @click="save"
      >
        保存
      </n-button>

      <n-dropdown trigger="click" :options="menuOptions" @select="onMenuSelect">
        <n-button size="small" quaternary title="更多">
          <template #icon>
            <n-icon :component="Dots" />
          </template>
        </n-button>
      </n-dropdown>
    </div>

    <div class="toolbar">
      <n-input
        v-model:value="keyword"
        class="filter"
        size="small"
        clearable
        placeholder="过滤变量"
      />
      <span class="count">共 {{ count }} 个变量</span>
    </div>

    <div class="body">
      <var-table
        v-if="env"
        v-model="draftVariables"
        :disabled="!canEdit"
        :filter="keyword"
      />
      <p v-else class="gone">这个环境已经被删掉了。</p>
    </div>
  </div>
</template>

<style scoped>
.env-tab {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.16));
}

.head .name {
  flex: none;
  width: 260px;
}

.dirty-dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--apiloop-primary);
}

.spacer {
  flex: 1;
}

.toolbar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px 0;
}

.toolbar .filter {
  flex: none;
  width: 240px;
}

.count {
  font-size: 12px;
  opacity: 0.6;
}

.body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 12px 16px;
}

.gone {
  font-size: 13px;
  opacity: 0.6;
}
</style>
