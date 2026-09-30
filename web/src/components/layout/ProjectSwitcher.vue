<script setup>
import { computed, h, ref } from 'vue';
import {
  NDropdown,
  NForm,
  NFormItem,
  NInput,
  NModal,
  NSpace,
  NTag,
  NButton,
  useDialog,
  useMessage
} from 'naive-ui';
import * as importExportApi from '@/api/importExport';
import { useProjectStore } from '@/stores/project';
import { useTabsStore } from '@/stores/tabs';
import { downloadJson } from '@/utils/download';

const emit = defineEmits(['change']);

const projects = useProjectStore();
const tabs = useTabsStore();
const message = useMessage();
const dialog = useDialog();

const showCreate = ref(false);
const creating = ref(false);
const form = ref({ name: '', slug: '', description: '' });

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
   * 标识显示成它的 mock 前缀（/mock/qb），一眼能看出是什么，不会像名字重复了一遍；
   * 根项目挂在根路径，只显示「根」标签。
   */
  const hint = option.slug && !option.isRoot ? '/mock/' + option.slug : '';

  return h('div', { style: 'display: flex; align-items: center; gap: 8px;' }, [
    h('span', null, option.name),
    hint
      ? h('span', {
        style: 'font-size: 12px; opacity: 0.5; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;'
      }, hint)
      : null,
    option.isRoot
      ? h(NTag, { size: 'tiny', bordered: false, type: 'info' }, { default: () => '根' })
      : null
  ]);
}

const options = computed(function () {
  const items = projects.projects.map(function (project) {
    return {
      key: project.id,
      label: project.name,
      name: project.name,
      slug: project.slug,
      isRoot: Boolean(project.isRoot)
    };
  });

  items.push({ type: 'divider', key: '__divider' });
  items.push({ key: '__settings', label: '项目设置', name: '项目设置', slug: '' });
  items.push({ key: '__export', label: '导出为 Postman 集合', name: '导出为 Postman 集合', slug: '' });
  items.push({ key: '__create', label: '新建项目', name: '新建项目', slug: '' });
  return items;
});

function openCreate() {
  form.value = { name: '', slug: '', description: '' };
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
    if (form.value.slug.trim()) payload.slug = form.value.slug.trim();
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
    <n-button size="small" quaternary>
      {{ projects.current ? projects.current.name : '选择项目' }}
      <template v-if="projects.current && projects.current.isRoot">
        <n-tag size="tiny" :bordered="false" type="info" style="margin-left: 6px">根</n-tag>
      </template>
    </n-button>
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
      <n-form-item label="标识">
        <n-input v-model:value="form.slug" placeholder="留空自动生成；用于 /mock/<标识>/ 前缀" />
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
</template>

