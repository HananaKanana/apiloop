<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { NButton, NDropdown, NIcon, NInput, NTag, useDialog, useMessage } from 'naive-ui';
import { ChevronDown } from '@vicons/tabler';
import { useEnvStore } from '@/stores/env';
import { useProjectStore } from '@/stores/project';
import { useTabsStore } from '@/stores/tabs';
import * as importExportApi from '@/api/importExport';
import { downloadJson } from '@/utils/download';
import VarTable from '@/components/common/VarTable.vue';

/**
 * 环境标签页（Task 7）。环境就是「名字 + 一串变量」，原来那个管理弹窗又窄又空，
 * 现在改成和接口、目录并列的标签页：名字可以直接点着改，变量表占满整屏。
 *
 * 编辑的是**一份草稿**：保存前不动 store 里的对象，所以「未保存」的圆点、
 * ⌘S、切项目时的提醒都跟接口标签页是同一套规则。
 */
const props = defineProps({
  tab: { type: Object, required: true }
});

const envs = useEnvStore();
const projects = useProjectStore();
const tabs = useTabsStore();
const message = useMessage();
const dialog = useDialog();

const draftName = ref('');
const draftVariables = ref([]);
const saving = ref(false);
const keyword = ref('');

const canEdit = computed(function () {
  return projects.canEdit;
});

const env = computed(function () {
  return envs.environments.find(function (item) { return item.id === props.tab.envId; }) || null;
});

const isCurrent = computed(function () {
  return envs.selectedId === props.tab.envId;
});

/** 草稿和 store 里的那份不一样就算「未保存」 */
const dirty = computed(function () {
  const saved = env.value;
  if (!saved) return false;
  return draftName.value !== saved.name ||
    JSON.stringify(draftVariables.value) !== JSON.stringify(saved.variables || []);
});

/** 灌草稿：打开时、以及环境被别处改过（比如刚保存完）时 */
function resetDraft() {
  const saved = env.value;
  draftName.value = saved ? saved.name : '';
  draftVariables.value = saved ? JSON.parse(JSON.stringify(saved.variables || [])) : [];
}

watch(env, resetDraft, { immediate: true });

// 标签页标题跟着名字走（改名时标签上立刻能看出来）
watch(draftName, function (value) {
  props.tab.title = value || '环境';
});

// 让「切项目 / 关页面」的未保存提醒也认这个标签页
watch(dirty, function (value) {
  props.tab.dirty = value;
}, { immediate: true });

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
    await envs.update(saved.id, { name: name, variables: draftVariables.value });
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
  envs.select(props.tab.envId);
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
    await tabs.openEnv(created.id);
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
        tabs.close(props.tab.key);
        message.success('已删除');
      } catch (err) {
        message.error(err.message);
      }
    }
  });
}

const menuOptions = computed(function () {
  if (!canEdit.value) return [];
  return [
    { label: '复制环境', key: 'duplicate' },
    { label: '导出为 Postman 环境', key: 'export' },
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

      <n-tag v-if="isCurrent" size="small" :bordered="false" type="success">当前</n-tag>
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

      <n-dropdown v-if="canEdit" trigger="click" :options="menuOptions" @select="onMenuSelect">
        <n-button size="small" quaternary title="更多">
          <template #icon>
            <n-icon :component="ChevronDown" />
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
