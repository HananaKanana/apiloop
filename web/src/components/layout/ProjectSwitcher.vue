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
  useMessage
} from 'naive-ui';
import { useProjectStore } from '@/stores/project';

const emit = defineEmits(['change']);

const projects = useProjectStore();
const message = useMessage();

const showCreate = ref(false);
const creating = ref(false);
const form = ref({ name: '', slug: '', description: '' });

function renderLabel(option) {
  return h('div', { class: 'proj-option' }, [
    h('span', { class: 'name' }, option.name),
    option.slug ? h('span', { class: 'slug' }, option.slug) : null,
    option.isRoot
      ? h(NTag, { size: 'tiny', bordered: false, type: 'info' }, { default: () => '根' })
      : null
  ]);
}

const options = computed(function () {
  const items = projects.projects.map(function (project) {
    return {
      key: project.id,
      name: project.name,
      slug: project.slug,
      isRoot: Boolean(project.isRoot),
      render: renderLabel
    };
  });

  items.push({ type: 'divider', key: '__divider' });
  items.push({ key: '__settings', name: '项目设置', slug: '', render: renderLabel });
  items.push({ key: '__create', name: '新建项目', slug: '', render: renderLabel });
  return items;
});

function openCreate() {
  form.value = { name: '', slug: '', description: '' };
  showCreate.value = true;
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
  if (key === projects.currentId) return;

  projects.setCurrent(key);
  emit('change', key);
}
</script>

<template>
  <n-dropdown :options="options" trigger="click" @select="onSelect">
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

<style scoped>
:deep(.proj-option) {
  display: flex;
  align-items: center;
  gap: 8px;
}

:deep(.proj-option .slug) {
  font-size: 12px;
  opacity: 0.5;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
</style>
