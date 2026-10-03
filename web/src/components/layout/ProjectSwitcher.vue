<script setup>
import { computed, h, ref } from 'vue';
import {
  NDropdown,
  NForm,
  NFormItem,
  NIcon,
  NInput,
  NModal,
  NSpace,
  NButton,
  useMessage
} from 'naive-ui';
import { useDialog } from '@/utils/dialog';
import { ChevronDown, Package } from '@vicons/tabler';
import * as importExportApi from '@/api/importExport';
import { useProjectStore } from '@/stores/project';
import { useTabsStore } from '@/stores/tabs';
import { useUiStore } from '@/stores/ui';
import { downloadJson } from '@/utils/download';
import OpenapiExportDialog from '@/components/importExport/OpenapiExportDialog.vue';

const emit = defineEmits(['change']);

const projects = useProjectStore();
const tabs = useTabsStore();
const ui = useUiStore();
const message = useMessage();
const dialog = useDialog();

const showCreate = ref(false);
const creating = ref(false);
/* 导出 OpenAPI 的小弹窗（第四轮第 2 节）：范围是整个项目 */
const showOpenapi = ref(false);
// 没有「标识」这一项了：mock 地址改成 /mock-<项目ID>/，标识不再用于 mock（L1）。
// 服务端仍然会自动生成一个唯一标识，只是界面上不用管它。
const form = ref({ name: '', description: '' });

/**
 * 选项的自定义渲染，通过 n-dropdown 的 render-label 传入。
 *
 * 注意不能把它挂在选项的 `render` 字段上：naive-ui 只认 `type: 'render'` 的整行渲染，
 * 普通选项上的 `render` 会被忽略，再加上没有 `label`，下拉里就只剩一排空白。
 */
function renderLabel(option) {
  /*
   * 样式必须写成内联：下拉菜单被 teleport 到 body 下渲染，不在本组件的 DOM 里，
   * 组件的 scoped 样式（包括 :deep）够不着它。之前写在组件样式里，结果名字和标识
   * 挤成一串，「qb」显示成「qbqb」。
   *
   * 名字后面跟项目描述（灰字，太长就省略号）；没填描述就只显示名字。
   * 原来这里显示的是 mock 前缀 /mock/<标识>，根项目还带个「根」标签，
   * 用户看不懂也用不上，2026-09-30 改成描述。
   */
  const desc = String(option.description || '').trim();

  return h('div', { style: 'display: flex; align-items: center; gap: 8px; max-width: 320px;' }, [
    h('span', { style: 'flex: none;' }, option.name),
    desc
      ? h('span', {
        style: 'min-width: 0; font-size: 12px; opacity: 0.5; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;',
        title: desc
      }, desc)
      : null
  ]);
}

const options = computed(function () {
  const items = projects.projects.map(function (project) {
    return {
      key: project.id,
      label: project.name,
      name: project.name,
      description: project.description || ''
    };
  });

  items.push({ type: 'divider', key: '__divider' });
  items.push({ key: '__settings', label: '项目设置', name: '项目设置' });
  items.push({ key: '__export', label: '导出为 JSON', name: '导出为 JSON' });
  items.push({ key: '__export-openapi', label: '导出为 OpenAPI', name: '导出为 OpenAPI' });
  // 环境对比（第五轮第 3 节）：环境下拉最底下也有一个入口
  items.push({ key: '__envdiff', label: '环境对比', name: '环境对比' });
  // 查找替换（第五轮第 2 节）：快捷键 ⌘⇧F / Ctrl+Shift+F
  items.push({ key: '__find', label: '查找替换', name: '查找替换' });
  items.push({ key: '__create', label: '新建项目', name: '新建项目' });
  return items;
});

function openCreate() {
  form.value = { name: '', description: '' };
  showCreate.value = true;
}

async function exportCollection() {
  if (!projects.currentId) return;

  try {
    const data = await importExportApi.exportCollection(projects.currentId);
    downloadJson(data.filename, data.json);
    message.success('已导出');
  } catch (err) {
    message.error(err.message);
  }
}

async function submitCreate() {
  if (!form.value.name.trim()) {
    message.warning('请填写项目名称');
    return;
  }

  creating.value = true;
  try {
    const payload = { name: form.value.name.trim() };
    if (form.value.description.trim()) payload.description = form.value.description.trim();

    const project = await projects.create(payload);
    showCreate.value = false;
    message.success('项目已创建');
    emit('change', project.id);
  } catch (err) {
    message.error(err.message);
  } finally {
    creating.value = false;
  }
}

function onSelect(key) {
  if (key === '__create') return openCreate();
  if (key === '__settings') return emit('change', '__settings');
  if (key === '__export') return exportCollection();
  if (key === '__export-openapi') {
    showOpenapi.value = true;
    return;
  }
  // 环境对比（第五轮第 3 节）：开一个「环境对比」标签页
  if (key === '__envdiff') {
    tabs.openEnvDiff();
    return;
  }
  // 查找替换（第五轮第 2 节）：弹窗挂在工作台（和 ⌘⇧F 走同一个开关）
  if (key === '__find') {
    ui.openFindReplace();
    return;
  }
  if (key === projects.currentId) return;

  // 切项目会把标签页全清掉，有没保存的修改就先问一句
  if (tabs.hasDirty) {
    dialog.warning({
      title: '切换项目',
      content: '当前有没保存的标签页，切换项目会全部关掉，未保存的修改会丢失。确定切换吗？',
      positiveText: '切换',
      negativeText: '取消',
      onPositiveClick: function () {
        tabs.closeAll();
        projects.setCurrent(key);
        emit('change', key);
      }
    });
    return;
  }

  tabs.closeAll();
  projects.setCurrent(key);
  emit('change', key);
}
</script>

<template>
  <n-dropdown :options="options" :render-label="renderLabel" trigger="click" @select="onSelect">
    <button class="switcher">
      <n-icon size="15" :component="Package" />
      <span class="name">{{ projects.current ? projects.current.name : '选择项目' }}</span>
      <n-icon size="14" :component="ChevronDown" />
    </button>
  </n-dropdown>

  <n-modal
    v-model:show="showCreate"
    preset="card"
    title="新建项目"
    style="width: 440px; max-width: 92vw"
  >
    <n-form>
      <n-form-item label="名称">
        <n-input v-model:value="form.name" placeholder="项目名称" />
      </n-form-item>
      <n-form-item label="说明">
        <n-input v-model:value="form.description" placeholder="可留空" />
      </n-form-item>
    </n-form>

    <template #footer>
      <n-space justify="end">
        <n-button @click="showCreate = false">取消</n-button>
        <n-button type="primary" :loading="creating" @click="submitCreate">创建</n-button>
      </n-space>
    </template>
  </n-modal>

  <!-- 导出 OpenAPI（第四轮第 2 节）：默认 YAML，下载 <项目名>.openapi.yaml -->
  <openapi-export-dialog
    v-model:show="showOpenapi"
    :pid="projects.currentId"
    :folder-id="null"
    :scope-name="projects.current ? projects.current.name : ''"
  />
</template>

<style scoped>
/* 项目切换：图标 + 名字 + ▾（只读标签由顶栏紧跟在后面） */
.switcher {
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: 220px;
  height: 28px;
  padding: 0 8px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: inherit;
  font-size: 13px;
  cursor: pointer;
}

.switcher:hover {
  background: rgba(128, 128, 128, 0.14);
}

.switcher .name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
