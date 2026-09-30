<script setup>
import { computed, ref, watch } from 'vue';
import { NButton, NEmpty, NInput, NModal, NSpace, useDialog, useMessage } from 'naive-ui';
import { useEnvStore } from '@/stores/env';
import * as importExportApi from '@/api/importExport';
import { downloadJson } from '@/utils/download';
import VarTable from '@/components/common/VarTable.vue';

const props = defineProps({
  show: { type: Boolean, default: false }
});

const emit = defineEmits(['update:show']);

const envs = useEnvStore();
const message = useMessage();
const dialog = useDialog();

const activeId = ref('');
const draftName = ref('');
const draftVariables = ref([]);

let saveTimer = null;

const active = computed(function () {
  return envs.environments.find(function (item) { return item.id === activeId.value; }) || null;
});

// 变量用一份独立的草稿，别直接绑 store 里的对象：
// 保存成功后 store 会换成服务端返回的新对象，直接绑的话会把正在输入的内容顶掉。
watch(activeId, function (id) {
  const env = envs.environments.find(function (item) { return item.id === id; });
  draftVariables.value = env ? JSON.parse(JSON.stringify(env.variables || [])) : [];
  draftName.value = env ? env.name : '';
});

watch(
  function () { return props.show; },
  function (visible) {
    if (!visible) return;
    if (envs.environments.length) {
      activeId.value = envs.selectedId || envs.environments[0].id;
    } else {
      activeId.value = '';
    }
  },
  { immediate: true }
);

function onVariablesChange(rows) {
  draftVariables.value = rows;
  const env = active.value;
  if (!env) return;

  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async function () {
    try {
      await envs.update(env.id, { variables: rows });
    } catch (err) {
      message.error(err.message);
    }
  }, 400);
}

async function createEnv() {
  try {
    const env = await envs.create({ name: '新环境', variables: [] });
    activeId.value = env.id;
    message.success('已创建');
  } catch (err) {
    message.error(err.message);
  }
}

async function renameEnv() {
  const env = active.value;
  if (!env) return;

  const name = draftName.value.trim();
  if (!name || name === env.name) {
    draftName.value = env.name;
    return;
  }

  try {
    await envs.update(env.id, { name: name });
    message.success('已改名');
  } catch (err) {
    message.error(err.message);
    draftName.value = env.name;
  }
}

async function exportEnv() {
  const env = active.value;
  if (!env) return;

  try {
    const data = await importExportApi.exportEnvironment(env.id);
    downloadJson(data.filename, data.json);
    message.success('已导出');
  } catch (err) {
    message.error(err.message);
  }
}

function removeEnv() {
  const env = active.value;
  if (!env) return;
  dialog.error({
    title: '删除环境',
    content: '确定删除「' + env.name + '」吗？',
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async function () {
      try {
        await envs.remove(env.id);
        activeId.value = envs.environments.length ? envs.environments[0].id : '';
        message.success('已删除');
      } catch (err) {
        message.error(err.message);
      }
    }
  });
}
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    title="管理环境"
    style="width: 820px; max-width: 94vw"
    @update:show="emit('update:show', $event)"
  >
    <div class="env-manager">
      <aside class="list">
        <div class="list-head">
          <span>环境</span>
          <n-button size="tiny" quaternary type="primary" @click="createEnv">新增</n-button>
        </div>

        <div class="list-body">
          <div
            v-for="env in envs.environments"
            :key="env.id"
            class="list-item"
            :class="{ active: env.id === activeId }"
            @click="activeId = env.id"
          >
            {{ env.name }}
          </div>
          <n-empty v-if="!envs.environments.length" description="还没有环境" size="small" />
        </div>
      </aside>

      <section class="detail">
        <template v-if="active">
          <n-space align="center" :wrap="false" class="detail-head">
            <n-input
              size="small"
              :value="draftName"
              @update:value="(v) => { draftName = v; }"
              @blur="renameEnv"
              @keyup.enter="renameEnv"
            />
            <n-button size="small" quaternary @click="exportEnv">导出</n-button>
            <n-button size="small" quaternary type="error" @click="removeEnv">删除</n-button>
          </n-space>

          <div class="vars">
            <var-table :model-value="draftVariables" @update:model-value="onVariablesChange" />
          </div>
        </template>

        <n-empty v-else description="左边选一个环境，或者新增一个" />
      </section>
    </div>
  </n-modal>
</template>

<style scoped>
.env-manager {
  display: flex;
  gap: 12px;
  min-height: 320px;
}

.list {
  flex: none;
  width: 200px;
  border: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.24));
  border-radius: 6px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  font-size: 12px;
  opacity: 0.7;
  border-bottom: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.16));
}

.list-body {
  flex: 1;
  overflow: auto;
  padding: 4px;
}

.list-item {
  padding: 6px 8px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.list-item:hover {
  background: rgba(128, 128, 128, 0.12);
}

.list-item.active {
  background: rgba(32, 128, 240, 0.16);
}

.detail {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.detail-head {
  width: 100%;
}

.vars {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
</style>
