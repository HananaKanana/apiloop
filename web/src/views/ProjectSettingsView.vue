<script setup>
import { onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  NAlert,
  NButton,
  NCard,
  NForm,
  NFormItem,
  NInput,
  NSpace,
  useDialog,
  useMessage
} from 'naive-ui';
import { useProjectStore } from '@/stores/project';
import { useSessionStore } from '@/stores/session';
import VarTable from '@/components/common/VarTable.vue';
import AuthEditor from '@/components/request/AuthEditor.vue';

const route = useRoute();
const router = useRouter();
const projects = useProjectStore();
const session = useSessionStore();
const message = useMessage();
const dialog = useDialog();

const loading = ref(true);
const saving = ref(false);
const errorText = ref('');

const form = ref({
  name: '',
  slug: '',
  description: '',
  variables: [],
  auth: { type: 'inherit' }
});

const projectId = ref('');

function fillFrom(project) {
  form.value = {
    name: project.name || '',
    slug: project.slug || '',
    description: project.description || '',
    variables: JSON.parse(JSON.stringify(project.variables || [])),
    auth: project.auth ? JSON.parse(JSON.stringify(project.auth)) : { type: 'inherit' }
  };
}

async function load() {
  loading.value = true;
  errorText.value = '';
  try {
    if (!projects.projects.length) await projects.load();
    projectId.value = String(route.params.pid || '');
    const project = projects.projects.find(function (item) { return item.id === projectId.value; });
    if (!project) {
      errorText.value = '找不到这个项目，它可能已经被删除了。';
      return;
    }
    fillFrom(project);
  } catch (err) {
    errorText.value = err.message;
  } finally {
    loading.value = false;
  }
}

async function save() {
  if (!form.value.name.trim()) {
    message.warning('请填写项目名称');
    return;
  }

  saving.value = true;
  try {
    await projects.update(projectId.value, {
      name: form.value.name.trim(),
      slug: form.value.slug.trim(),
      description: form.value.description,
      variables: form.value.variables,
      auth: form.value.auth
    });
    message.success('已保存');
  } catch (err) {
    // 标识被占用这类 400 原样提示，服务端文案已经说清楚了
    message.error(err.message);
  } finally {
    saving.value = false;
  }
}

function removeProject() {
  dialog.error({
    title: '删除项目',
    content: '确定删除「' + form.value.name + '」吗？项目下的接口、示例和历史都会一起删掉，不可撤销。',
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async function () {
      try {
        await projects.remove(projectId.value);
        message.success('已删除');
        router.replace('/workbench');
      } catch (err) {
        message.error(err.message);
      }
    }
  });
}

onMounted(load);
watch(function () { return route.params.pid; }, load);
</script>

<template>
  <div class="page">
    <div class="header">
      <n-space align="center">
        <n-button quaternary size="small" @click="router.push('/workbench')">← 返回</n-button>
        <span class="title">项目设置</span>
      </n-space>
      <n-space align="center">
        <n-button
          v-if="session.isAdmin"
          size="small"
          quaternary
          type="error"
          :disabled="loading || Boolean(errorText)"
          @click="removeProject"
        >
          删除项目
        </n-button>
        <n-button
          type="primary"
          size="small"
          :loading="saving"
          :disabled="loading || Boolean(errorText)"
          @click="save"
        >
          保存
        </n-button>
      </n-space>
    </div>

    <div class="content">
      <n-alert v-if="errorText" type="error" :show-icon="false" class="alert">
        {{ errorText }}
      </n-alert>

      <n-card v-else :bordered="false" size="small" title="基本信息">
        <n-form label-placement="top">
          <n-form-item label="名称">
            <n-input v-model:value="form.name" placeholder="项目名称" />
          </n-form-item>
          <n-form-item label="标识">
            <n-input v-model:value="form.slug" placeholder="用于 /mock/<标识>/ 前缀" />
          </n-form-item>
          <n-form-item label="说明">
            <n-input v-model:value="form.description" type="textarea" :autosize="{ minRows: 2, maxRows: 5 }" />
          </n-form-item>
        </n-form>
      </n-card>

      <n-card v-if="!errorText" :bordered="false" size="small" title="项目变量" class="card">
        <p class="tip">
          项目变量在发送时先展开，同名的话会被当前环境里的变量覆盖。
        </p>
        <var-table v-model="form.variables" />
      </n-card>

      <n-card v-if="!errorText" :bordered="false" size="small" title="项目级鉴权" class="card">
        <p class="tip">
          接口自己的鉴权留空或选了「继承父级」时，就沿用到这里。
        </p>
        <auth-editor v-model="form.auth" />
      </n-card>
    </div>
  </div>
</template>

<style scoped>
.page {
  height: 100%;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
}

.header {
  height: 48px;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px;
  border-bottom: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.24));
}

.title {
  font-size: 15px;
  font-weight: 600;
}

.content {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 12px;
  max-width: 760px;
  width: 100%;
  box-sizing: border-box;
}

.card {
  margin-top: 12px;
}

.alert {
  margin-bottom: 12px;
}

.tip {
  margin: 0 0 10px;
  font-size: 12px;
  opacity: 0.6;
  line-height: 1.6;
}
</style>
