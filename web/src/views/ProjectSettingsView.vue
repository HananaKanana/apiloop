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
  useMessage
} from 'naive-ui';
import { useDialog } from '@/utils/dialog';
import { useProjectStore } from '@/stores/project';
import { useGatewayStore } from '@/stores/gateway';
import { useTreeStore } from '@/stores/tree';
import VarTable from '@/components/common/VarTable.vue';
import KeyValueTable from '@/components/common/KeyValueTable.vue';
import AuthEditor from '@/components/request/AuthEditor.vue';
import ScriptEditor from '@/components/scripts/ScriptEditor.vue';
import MembersPanel from '@/components/members/MembersPanel.vue';
import ShareLinksPanel from '@/components/share/ShareLinksPanel.vue';
import MockFaultPanel from '@/components/mock/MockFaultPanel.vue';
import DatabasePanel from '@/components/db/DatabasePanel.vue';
import PreflightPanel from '@/components/preflight/PreflightPanel.vue';

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
const tree = useTreeStore();
const message = useMessage();
const dialog = useDialog();

/**
 * 成员管理和分享链接的数据都在云端（不同步到本机），没登录就没有这两个页签。
 * 整块不渲染，不是禁用。
 */
const showCloudTabs = computed(function () {
  return gateway.cloudFeaturesAvailable;
});

const loading = ref(true);
const saving = ref(false);
const errorText = ref('');
/**
 * `?tab=xxx` 直接打开那个页签（分享弹窗跳到 shares、项目名旁「故障模拟中」跳到 mock……）。
 * 成员 / 分享链接只在能用云端时才有，不然退回基本信息。
 *
 * 页签按用途分（2026-10-04 用户：基本信息里东西太多，不好看）：基本信息只放名称和说明，
 * 发送相关的放「请求设置」，脚本、Mock、数据库各一页。右上角「保存」一次存所有页签的改动。
 */
const LOCAL_TABS = ['basic', 'request', 'scripts', 'mock', 'database'];
const CLOUD_TABS = ['members', 'shares'];
const activeTab = ref((function () {
  const wanted = String(route.query.tab || '');
  if (LOCAL_TABS.indexOf(wanted) > -1) return wanted;
  if (showCloudTabs.value && CLOUD_TABS.indexOf(wanted) > -1) return wanted;
  return 'basic';
})());

const form = ref({
  name: '',
  description: '',
  variables: [],
  auth: { type: 'inherit' },
  headers: [],
  scripts: [],
  // Mock 故障模拟（第七轮第 1 节）：`projects.extra.mockFaults`，没设过是 null
  mockFaults: null,
  // 数据库连接（第九轮第 3 节）：`projects.extra.databases`，接口的「数据库」页签挑的就是它们
  databases: [],
  // 前置接口（第十轮第 3 节）：`projects.extra.preflight`，没配过是 null
  preflight: null
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
    headers: JSON.parse(JSON.stringify(project.headers || [])),
    scripts: JSON.parse(JSON.stringify(project.scripts || [])),
    mockFaults: project.mockFaults ? JSON.parse(JSON.stringify(project.mockFaults)) : null,
    databases: JSON.parse(JSON.stringify(project.databases || [])),
    // 前置接口（第十轮第 3 节）：整份深拷贝，没配过就是 null
    preflight: project.preflight ? JSON.parse(JSON.stringify(project.preflight)) : null
  };
}

async function load() {
  loading.value = true;
  errorText.value = '';
  try {
    if (!projects.projects.length) await projects.load();
    projectId.value = String(route.params.pid || '');
    // 前置接口要选一个接口，所以这一个页签也要一份接口清单（目录树的数据）
    if (!tree.apis.length) await tree.load();
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
      headers: form.value.headers,
      scripts: form.value.scripts,
      // Mock 故障模拟（第七轮第 1 节）：没开过、也没加过规则时给 null，服务端会把这块清掉
      mockFaults: form.value.mockFaults,
      // 数据库连接（第九轮第 3 节）：整份提交，空数组就是清掉
      databases: form.value.databases,
      // 前置接口（第十轮第 3 节）：整份提交，null 就是清掉
      preflight: form.value.preflight
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

    <!-- 滚动区占满整个宽度（滚动条在窗口最右边），内容在中间 -->
    <div class="content">
      <div class="inner">
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
            <p class="tip">变量、鉴权、公共请求头、前置接口在「请求设置」里；脚本、Mock、数据库各有一个页签。右上角「保存」会一起保存所有页签的改动。</p>
          </n-card>
        </n-tab-pane>

        <!-- 请求设置：发送时会用到的那几样（变量、鉴权、公共请求头、前置接口） -->
        <n-tab-pane name="request" tab="请求设置">
          <n-card :bordered="false" size="small" title="项目变量">
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

          <!--
            公共请求头（第五轮第 1 节）：这个项目里所有接口发送时都会带上。
            目录 / 接口自己写了同名的，以更靠近接口的那一层为准。
          -->
          <n-card :bordered="false" size="small" title="公共请求头" class="card">
            <p class="tip">
              这个项目下的所有接口发送时都会带上这些请求头；接口里有同名的请求头时，用接口自己的。
            </p>
            <key-value-table
              v-model="form.headers"
              :disabled="!canEdit"
              kind="common-headers"
              key-placeholder="请求头"
              value-placeholder="值"
            />
          </n-card>

          <!--
            前置接口（第十轮第 3 节）：token 过期时不用再手动点一次登录。
            目录上也能设，离接口最近的那一层说了算；项目这一层是最外层。
          -->
          <n-card :bordered="false" size="small" title="前置接口" class="card">
            <p class="tip">
              发送之前先自动调一遍这个接口（通常是登录接口），把 token 拿回来。
              目录上单独设过的话，以目录上的为准。
            </p>
            <preflight-panel
              v-model="form.preflight"
              :apis="tree.apis"
              :disabled="!canEdit"
            />
          </n-card>
        </n-tab-pane>

        <n-tab-pane name="scripts" tab="脚本">
          <n-card :bordered="false" size="small" title="项目脚本">
            <p class="tip">
              这个项目里所有接口发送时都会执行：「请求前」脚本在请求发出之前，「响应后」脚本在响应回来之后。
              顺序是「项目 → 目录（从外到内）→ 接口」。
            </p>
            <script-editor v-model="form.scripts" :disabled="!canEdit" min-height="180px" />
          </n-card>

          <!--
            Mock 故障模拟（第七轮第 1 节）：让 Mock 按比例故意出错，
            给前端测「报错提示对不对」「慢的时候有没有加载状态」。
          -->
        </n-tab-pane>

        <n-tab-pane name="mock" tab="Mock">
          <n-card :bordered="false" size="small" title="Mock 故障模拟">
            <mock-fault-panel
              v-model="form.mockFaults"
              :pid="projectId"
              :disabled="!canEdit"
            />
          </n-card>

          <!--
            数据库连接（第九轮第 3 节）：接口的「数据库」页签挑的就是这里的连接 ——
            测接口时要造数据、查数据，都靠它。
          -->
        </n-tab-pane>

        <n-tab-pane name="database" tab="数据库">
          <n-card :bordered="false" size="small" title="数据库连接">
            <database-panel
              v-model:databases="form.databases"
              :pid="projectId"
              :disabled="!canEdit"
              :local-allowed="!(gateway.loaded && !gateway.isGateway)"
            />
          </n-card>


        </n-tab-pane>

        <n-tab-pane v-if="showCloudTabs" name="members" tab="成员">
          <members-panel v-if="projectId" :pid="projectId" @left="onLeft" />
        </n-tab-pane>

        <!--
          分享链接：数据在云端（分享是云端对外发布的东西），和成员管理一样，
          未登录时整块不渲染。
        -->
        <n-tab-pane v-if="showCloudTabs" name="shares" tab="分享链接">
          <share-links-panel v-if="projectId" :pid="projectId" />
        </n-tab-pane>
      </n-tabs>
      </div>
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
  box-sizing: border-box;
}

/* 内容居中、限宽（2026-10-04 用户：只占左半边不好看） */
.inner {
  max-width: 860px;
  margin: 0 auto;
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
