<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  NAlert,
  NButton,
  NCard,
  NForm,
  NFormItem,
  NInput,
  NSpace,
  NTabPane,
  NTabs,
  useDialog,
  useMessage
} from 'naive-ui';
import { useProjectStore } from '@/stores/project';
import { useGatewayStore } from '@/stores/gateway';
import VarTable from '@/components/common/VarTable.vue';
import AuthEditor from '@/components/request/AuthEditor.vue';
import ScriptEditor from '@/components/scripts/ScriptEditor.vue';
import MembersPanel from '@/components/members/MembersPanel.vue';

/**
 * 项目设置。按角色收口：
 * - 改名称 / 标识、管成员、删项目 —— 只有 owner（admin 等同 owner）；
 * - 改说明 / 变量 / 鉴权 —— editor 及以上；
 * - viewer 只能看，页面上不留任何可点的写入口。
 *
 * 这些都只是体验优化，真正的拦截在服务端 guard 上，所以 403 一律原样提示。
 */
const route = useRoute();
const router = useRouter();
const projects = useProjectStore();
const gateway = useGatewayStore();
const message = useMessage();
const dialog = useDialog();

/**
 * 成员管理的数据在云端（成员不同步到本机），没登录就没有这个页签。
 * 整块不渲染，不是禁用。
 */
const showMembers = computed(function () {
  return gateway.cloudFeaturesAvailable;
});

const loading = ref(true);
const saving = ref(false);
const errorText = ref('');
const activeTab = ref('basic');

const form = ref({
  name: '',
  description: '',
  variables: [],
  auth: { type: 'inherit' },
  scripts: []
});

const projectId = ref('');

const canEdit = computed(function () {
  return projects.canEdit;
});

const isOwner = computed(function () {
  return projects.isOwner;
});

function fillFrom(project) {
  form.value = {
    name: project.name || '',
    description: project.description || '',
    variables: JSON.parse(JSON.stringify(project.variables || [])),
    auth: project.auth ? JSON.parse(JSON.stringify(project.auth)) : { type: 'inherit' },
    scripts: JSON.parse(JSON.stringify(project.scripts || []))
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
    // 名称只有 owner 能改，只提交自己能改的字段，别替服务端做判断
    const patch = {
      description: form.value.description,
      variables: form.value.variables,
      auth: form.value.auth,
      scripts: form.value.scripts
    };
    if (isOwner.value) {
      patch.name = form.value.name.trim();
    }

    await projects.update(projectId.value, patch);
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

/** 退出项目之后要把项目列表重新拉一遍，否则切换器里还留着已经看不到的项目 */
async function onLeft() {
  await projects.load();
  router.replace('/workbench');
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
          v-if="isOwner"
          size="small"
          quaternary
          type="error"
          :disabled="loading || Boolean(errorText)"
          @click="removeProject"
        >
          删除项目
        </n-button>
        <n-button
          v-if="canEdit"
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

      <n-tabs v-else v-model:value="activeTab" type="line" size="small" animated>
        <n-tab-pane name="basic" tab="基本信息">
          <n-card :bordered="false" size="small" title="基本信息">
            <n-form label-placement="top">
              <n-form-item label="名称">
                <n-input v-model:value="form.name" :disabled="!isOwner" placeholder="项目名称" />
              </n-form-item>
              <n-form-item label="说明">
                <n-input
                  v-model:value="form.description"
                  type="textarea"
                  :disabled="!canEdit"
                  :autosize="{ minRows: 2, maxRows: 5 }"
                />
              </n-form-item>
            </n-form>
            <p v-if="!isOwner" class="tip">只有 owner 能修改项目名称和标识。</p>
          </n-card>

          <n-card :bordered="false" size="small" title="项目变量" class="card">
            <p class="tip">
              项目变量在发送时先展开，同名的话会被当前环境里的变量覆盖。
            </p>
            <var-table v-model="form.variables" :disabled="!canEdit" />
          </n-card>

          <n-card :bordered="false" size="small" title="项目级鉴权" class="card">
            <p class="tip">
              接口自己的鉴权留空或选了「继承父级」时，就沿用到这里。
            </p>
            <auth-editor v-model="form.auth" :disabled="!canEdit" />
          </n-card>

          <n-card :bordered="false" size="small" title="项目脚本" class="card">
            <p class="tip">
              这个项目里所有接口发送时都会执行：前置脚本在请求发出之前，测试脚本在响应回来之后。
              顺序是「项目 → 目录（从外到内）→ 接口」。
            </p>
            <script-editor v-model="form.scripts" :disabled="!canEdit" min-height="180px" />
          </n-card>
        </n-tab-pane>

        <n-tab-pane v-if="showMembers" name="members" tab="成员">
          <members-panel v-if="projectId" :pid="projectId" @left="onLeft" />
        </n-tab-pane>
      </n-tabs>
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
  padding: 0 16px;
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
  padding: 12px 16px;
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
