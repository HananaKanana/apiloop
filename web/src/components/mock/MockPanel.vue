<script setup>
import { computed, ref, watch } from 'vue';
import {
  NButton,
  NEmpty,
  NInput,
  NInputNumber,
  NSwitch,
  NTag,
  useDialog,
  useMessage
} from 'naive-ui';
import * as apisApi from '@/api/apis';
import * as expectationsApi from '@/api/expectations';
import { useProjectStore } from '@/stores/project';
import { useSessionStore } from '@/stores/session';
import { useGatewayStore } from '@/stores/gateway';
import { mockPrefix } from '@/utils/mock';
import { usePrompt } from '@/utils/prompt';
import { conditionSummary } from '@/utils/expectation';
import ExampleEditor from './ExampleEditor.vue';
import ExpectationEditor from './ExpectationEditor.vue';
import { copyText } from '@/utils/clipboard';

/**
 * Mock 页签：mock 配置 + 示例列表 + 期望列表 + 各自的编辑器。
 *
 * 所有写操作都走服务端返回的 api 覆盖本地的，不在前端自己拼状态。
 * 期望的「修改」接口只回 `{ expectation }`，所以那一条要单独并回列表里
 * （见 mergeExpectation）—— 别指望它带上整个 api。
 */
const props = defineProps({
  tab: { type: Object, required: true }
});

/** 「用最近一次响应生成」：交给父组件走它现成的「保存为示例」弹窗（不在这里再写一套） */
const emit = defineEmits(['save-response']);

const projects = useProjectStore();
const gateway = useGatewayStore();
const session = useSessionStore();
const message = useMessage();
const dialog = useDialog();
const prompt = usePrompt();

const selectedId = ref('');
const selectedExpectationId = ref('');
/** mock.path 单独存一份草稿：mock 是 computed，直接绑它改的是临时对象 */
const draftPath = ref('');
/** 期望 id → 服务端返回的错误原因。错误要显示在出错的那一条旁边，不能只弹一下 */
const expectationErrors = ref({});

/** 期望列表拖拽排序时的两个下标 */
const dragIndex = ref(-1);
const overIndex = ref(-1);

/** 「更多设置」（路径 / 延迟 / 跨域）默认收起 */
const showMore = ref(false);
/** 「按条件返回（高级）」默认收起；这个接口已经有期望时默认展开 */
const showRules = ref(false);

/** 示例编辑器实例，用来问它「有没有没保存的修改」 */
const exampleEditorRef = ref(null);

const api = computed(function () {
  return props.tab.api;
});

/** 只读角色（viewer）看不到任何写入口；真正的拦截在服务端 */
const canEdit = computed(function () {
  return projects.canEdit;
});

const mock = computed(function () {
  const value = api.value && api.value.mock;
  return {
    enabled: Boolean(value && value.enabled),
    path: (value && value.path) || '',
    delay: (value && value.delay) || 0,
    cors: Boolean(value && value.cors),
    exampleId: (value && value.exampleId) || null
  };
});

const examples = computed(function () {
  return (api.value && api.value.examples) || [];
});

const expectations = computed(function () {
  return (api.value && api.value.expectations) || [];
});

/** mock 现在默认返回的那条示例（没指定就是第一条，和服务端 routes-store 的规则一样） */
const defaultExample = computed(function () {
  const list = examples.value;
  if (!list.length) return null;
  return list.find(function (item) { return item.id === mock.value.exampleId; }) || list[0];
});

/**
 * 「用最近一次响应生成」能不能点：和响应区「保存为示例」的条件一致 ——
 * 有响应、是文本（二进制存不了）、不是 SSE（SSE 走事件视图里那个按钮）、不是 WS。
 */
const canGenerate = computed(function () {
  const response = props.tab.result && props.tab.result.response;
  return canEdit.value && !isWs.value && !props.tab.sseEvents &&
    Boolean(response && response.bodyEncoding === 'utf8');
});

/** 第 ② 步旁边那句「现在是什么效果」 */
const mockStatus = computed(function () {
  if (!mock.value.enabled) {
    return examples.value.length
      ? '未开启：请求 mock 地址会返回 404'
      : '先完成第 ① 步，才能打开';
  }
  if (!defaultExample.value) return '已开启，但还没有示例';
  let text = '已开启：会返回示例「' + defaultExample.value.name + '」';
  if (!isWs.value && expectations.value.some(function (item) { return item.enabled; })) {
    text += '；满足条件时按「按条件返回」里的规则';
  }
  return text;
});

const selectedExample = computed(function () {
  return examples.value.find(function (item) { return item.id === selectedId.value; }) || null;
});

const selectedExpectation = computed(function () {
  return expectations.value.find(function (item) { return item.id === selectedExpectationId.value; }) || null;
});

/**
 * WebSocket 接口（契约第 17 节）：走 ws 的回放，没有期望、也不看 CORS 和延迟
 * —— 那几项是 HTTP 的事，摆在这里会让人以为它们对这个接口有用。
 */
const isWs = computed(function () {
  return Boolean(api.value && api.value.method === 'WS');
});

const mockUrl = computed(function () {
  // mock 是 computed，脚本里必须写 .value；只有模板里才会自动解包。
  // 写成 mock.path 会拿到 undefined，拼出来就是 http://host/mock-<ID>undefined
  //
  // WS 接口给的是 WebSocket 地址。http → ws / https → wss 正好是一次前缀替换，
  // 端口也能跟着一起带过来（window.location.origin 里含端口）。
  const origin = isWs.value
    ? window.location.origin.replace(/^http/, 'ws')
    : window.location.origin;
  return origin + mockPrefix(projects.current) + mock.value.path;
});

watch(
  function () { return mock.value.path; },
  function (value) { draftPath.value = value; },
  { immediate: true }
);

watch(
  function () { return api.value && api.value.id; },
  function () {
    expectationErrors.value = {};
    selectedExpectationId.value = '';
    showRules.value = expectations.value.length > 0;

    const list = examples.value;
    if (!list.length) {
      selectedId.value = '';
      return;
    }
    if (list.some(function (item) { return item.id === selectedId.value; })) return;
    selectedId.value = mock.value.exampleId || list[0].id;
  },
  { immediate: true }
);

/**
 * 「保存为 SSE 示例」这类操作会把它新存下的示例 id 挂在标签页上，让这里选中。
 * 读完立刻清掉，否则下次打开 Mock 页签又会被它抢走选中。
 * immediate 是必要的：这个页签是按需渲染的，挂载时可能已经带着 id 了。
 */
watch(
  function () { return props.tab.focusExampleId; },
  function (id) {
    if (!id) return;
    selectedExpectationId.value = '';
    selectedId.value = id;
    props.tab.focusExampleId = null;
  },
  { immediate: true }
);

/* ---------------- 配置 ---------------- */

async function refreshApi() {
  if (!props.tab.apiId) return;
  const data = await apisApi.getApi(props.tab.apiId);
  props.tab.api = data.api;
}

async function patchMock(patch) {
  if (!props.tab.apiId) return;

  const next = Object.assign({}, mock.value, patch);
  try {
    // updateApi 自己会包一层 `{ api: ... }`，这里只传字段。多包一层的话
    // 服务端读不到 `input.mock`，会**静默忽略**（返回 200 和原样的 api），
    // 界面上还弹「已保存」—— 启用 mock / 改路径 / 设为 mock 全都失效。
    const data = await apisApi.updateApi(props.tab.apiId, { mock: next });
    props.tab.api = data.api;
    message.success('已保存');
  } catch (err) {
    // 服务端的 400（比如「请先保存一个示例」）原样提示，并把界面退回真实状态
    message.error(err.message);
    try {
      await refreshApi();
    } catch (refreshError) {
      // 拉不回来就先这样，下一次操作会再拉
    }
  }
}

/* ---------------- 示例 ---------------- */

const SOURCE_LABELS = {
  manual: { text: '手工', type: 'default' },
  recorded: { text: '录制', type: 'success' },
  imported: { text: '导入', type: 'info' }
};

/**
 * 切走之前问一句：示例编辑器里有没有没保存的内容。
 * 只有智能模板化会留下这种状态（普通改动 600ms 后自动保存），
 * 但丢掉的是整段响应体，值得拦一下。
 *
 * @returns {Promise<boolean>} true 表示可以切走
 */
function confirmLeaveExampleEditor() {
  const editor = exampleEditorRef.value;
  if (!editor || !editor.isDirty()) return Promise.resolve(true);

  return new Promise(function (resolve) {
    let settled = false;
    function done(value) {
      if (settled) return;
      settled = true;
      resolve(value);
    }

    dialog.warning({
      title: '有未保存的修改',
      content: '示例编辑器里还有没保存的内容，切走就没了。',
      positiveText: '放弃修改',
      negativeText: '取消',
      onPositiveClick: function () { done(true); },
      onNegativeClick: function () { done(false); },
      onClose: function () { done(false); },
      onMaskClick: function () { done(false); }
    });
  });
}

async function selectExample(id) {
  if (id === selectedId.value) return;
  if (!(await confirmLeaveExampleEditor())) return;

  selectedId.value = id;
  selectedExpectationId.value = '';
}

async function createExample() {
  // WS 接口的新示例直接给一个能用的场景骨架，省得用户对着空 JSON 发呆
  const payload = isWs.value
    ? {
        name: '新示例',
        status: 101,
        responseType: 'ws',
        headers: [],
        body: JSON.stringify({
          onOpen: [{ delay: 0, send: '{"type":"hello"}' }],
          rules: [],
          fallback: 'none'
        }, null, 2),
        source: 'manual'
      }
    : {
        name: '新示例',
        status: 200,
        responseType: 'json',
        headers: [],
        body: '{\n  "code": 0,\n  "msg": "ok",\n  "data": {}\n}',
        source: 'manual'
      };

  try {
    const data = await apisApi.createExample(props.tab.apiId, payload);
    props.tab.api = data.api;
    await selectExample(data.example.id);
    message.success('已新建示例');
  } catch (err) {
    message.error(err.message);
  }
}

async function renameExample(example) {
  const name = await prompt({ title: '重命名示例', value: example.name, confirmText: '保存' });
  if (name === null || !String(name).trim()) return;

  try {
    const data = await apisApi.updateExample(example.id, { name: String(name).trim() });
    emitSaved(data.example);
    message.success('已重命名');
  } catch (err) {
    message.error(err.message);
  }
}

async function removeExample(example) {
  dialog.error({
    title: '删除示例',
    content: '确定删除「' + example.name + '」吗？指向它的期望会一起删掉。',
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async function () {
      try {
        const data = await apisApi.removeExample(example.id);
        props.tab.api = data.api;
        selectedId.value = '';
        message.success('已删除');
      } catch (err) {
        message.error(err.message);
      }
    }
  });
}

/** 编辑器自动保存后，把最新的示例并回列表里 */
function emitSaved(example) {
  const list = ((api.value && api.value.examples) || []).slice();
  const index = list.findIndex(function (item) { return item.id === example.id; });
  if (index !== -1) list[index] = example;
  if (api.value) api.value.examples = list;
}

async function useAsMock(example) {
  await patchMock({ exampleId: example.id });
}

async function copyMockUrl() {
  try {
    await copyText(mockUrl.value);
    message.success('已复制 mock 地址');
  } catch (err) {
    message.warning('复制失败，请手动选中复制');
  }
}

/* ---------------- 期望 ---------------- */

function exampleName(exampleId) {
  const found = examples.value.find(function (item) { return item.id === exampleId; });
  return found ? found.name : '(已删除的示例)';
}

function mergeExpectation(expectation) {
  const list = ((api.value && api.value.expectations) || []).slice();
  const index = list.findIndex(function (item) { return item.id === expectation.id; });
  if (index !== -1) list[index] = expectation;
  if (api.value) api.value.expectations = list;
}

function setExpectationError(id, text) {
  const next = Object.assign({}, expectationErrors.value);
  next[id] = text;
  expectationErrors.value = next;
}

function clearExpectationError(id) {
  if (!expectationErrors.value[id]) return;
  const next = Object.assign({}, expectationErrors.value);
  delete next[id];
  expectationErrors.value = next;
}

async function selectExpectation(id) {
  if (id === selectedExpectationId.value) return;
  if (!(await confirmLeaveExampleEditor())) return;

  selectedExpectationId.value = id;
  selectedId.value = '';
}

async function createExpectation() {
  if (!examples.value.length) {
    message.warning('先新建一个示例 —— 期望要指明返回哪一条示例');
    return;
  }

  try {
    const data = await expectationsApi.createExpectation(props.tab.apiId, {
      name: '新期望',
      enabled: true,
      conditions: [],
      exampleId: mock.value.exampleId || examples.value[0].id
    });
    props.tab.api = data.api;
    selectExpectation(data.expectation.id);
    message.success('已新建期望');
  } catch (err) {
    message.error(err.message);
  }
}

async function toggleExpectation(item, value) {
  try {
    const data = await expectationsApi.updateExpectation(item.id, { enabled: value });
    mergeExpectation(data.expectation);
    clearExpectationError(item.id);
  } catch (err) {
    // 开关拨不动的时候，原因也要落在这一条上
    setExpectationError(item.id, err.message);
    message.error(err.message);
  }
}

function removeExpectation(item) {
  dialog.error({
    title: '删除期望',
    content: '确定删除「' + (item.name || '未命名期望') + '」吗？',
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async function () {
      try {
        const data = await expectationsApi.removeExpectation(item.id);
        props.tab.api = data.api;
        if (selectedExpectationId.value === item.id) selectedExpectationId.value = '';
        clearExpectationError(item.id);
        message.success('已删除');
      } catch (err) {
        message.error(err.message);
      }
    }
  });
}

/** 编辑器保存成功：把这一条并回列表，并清掉它上次的错误 */
function onExpectationSaved(expectation) {
  mergeExpectation(expectation);
  clearExpectationError(expectation.id);
}

function onExpectationFailed(payload) {
  setExpectationError(payload.id, payload.message);
}

/* ---------------- 拖动排序 ---------------- */

function onDragStart(index) {
  dragIndex.value = index;
}

function onDragOver(index) {
  overIndex.value = index;
}

function onDragEnd() {
  dragIndex.value = -1;
  overIndex.value = -1;
}

async function onDrop() {
  const from = dragIndex.value;
  const to = overIndex.value;
  onDragEnd();

  if (from === -1 || to === -1 || from === to) return;

  const list = expectations.value.slice();
  const moved = list.splice(from, 1)[0];
  list.splice(to, 0, moved);

  // 先本地排好，界面立刻跟手；服务端返回的 api 才是最终真相
  if (api.value) api.value.expectations = list;

  try {
    const data = await expectationsApi.reorderExpectations(
      props.tab.apiId,
      list.map(function (item) { return item.id; })
    );
    props.tab.api = data.api;
  } catch (err) {
    message.error(err.message);
    try {
      await refreshApi();
    } catch (refreshError) {
      // 拉不回来就先这样
    }
  }
}
</script>

<template>
  <div class="mock-panel">
    <n-empty
      v-if="!api"
      class="placeholder"
      description="临时标签页要先保存成接口，才能配置 mock"
    />

    <template v-else>
      <!-- 一句话说明：用户反馈「完全不知道 mock 页是干嘛的」（2026-10-01） -->
      <p class="intro">
        Mock 就是「假接口」：后端还没写好时，先请求下面的 mock 地址，拿到你在这里设定的假数据。
        <template v-if="isWs">WebSocket 接口用默认示例回放：连接后按示例里的 onOpen 推送，收到消息后按规则回复。</template>
      </p>

      <!-- 三步：每步做完换成绿色的勾 -->
      <div class="steps">
        <div class="step">
          <span class="step-no" :class="{ done: examples.length > 0 }">{{ examples.length ? '✓' : '1' }}</span>
          <span class="step-title">准备返回的数据</span>
          <div class="step-body">
            <span v-if="examples.length" class="step-text">
              已有 {{ examples.length }} 个示例，默认返回「{{ defaultExample && defaultExample.name }}」
            </span>
            <template v-else>
              <span v-if="!canEdit" class="step-text">还没有示例</span>
              <n-button v-if="canEdit" size="tiny" type="primary" secondary @click="createExample">新建示例</n-button>
              <n-button v-if="canGenerate" size="tiny" secondary @click="emit('save-response')">
                用最近一次响应生成
              </n-button>
              <span v-else-if="canEdit && !isWs" class="step-text">也可以先发一次请求，再从响应生成</span>
            </template>
          </div>
        </div>

        <div class="step">
          <span class="step-no" :class="{ done: mock.enabled }">{{ mock.enabled ? '✓' : '2' }}</span>
          <span class="step-title">打开 mock</span>
          <div class="step-body">
            <n-switch
              size="small"
              :value="mock.enabled"
              :disabled="!canEdit || (!mock.enabled && !examples.length)"
              @update:value="(v) => patchMock({ enabled: v })"
            />
            <span class="step-text">{{ mockStatus }}</span>
          </div>
        </div>

        <div class="step">
          <span class="step-no">3</span>
          <span class="step-title">调用 mock 地址</span>
          <div class="step-body column">
            <!-- 本机模式下 mock 服务在云端，地址还不可用 -->
            <span v-if="!gateway.mockAvailable" class="step-text">登录后可用</span>
            <template v-else>
              <div class="url-row">
                <code class="url" :title="mockUrl">{{ mockUrl }}</code>
                <n-button size="tiny" secondary @click="copyMockUrl">复制</n-button>
              </div>
              <span class="step-text">
                或者在右上角环境里选「Mock」，直接点「{{ isWs ? '连接' : '发送' }}」
              </span>
            </template>
          </div>
        </div>
      </div>

      <!-- 更多设置：默认收起，大多数人用不到 -->
      <div class="more">
        <a class="more-toggle" @click="showMore = !showMore">{{ showMore ? '▾' : '▸' }} 更多设置</a>
        <div v-if="showMore" class="more-body">
          <div class="more-row">
            <span class="more-label">路径</span>
            <n-input
              size="small"
              class="more-input"
              :value="draftPath"
              :disabled="!canEdit"
              placeholder="/api/users"
              @update:value="(v) => { draftPath = v; }"
              @blur="canEdit && draftPath !== mock.path && patchMock({ path: draftPath })"
            />
            <span class="more-hint">mock 地址最后那段，默认和接口路径一样</span>
          </div>
          <div v-if="!isWs" class="more-row">
            <span class="more-label">延迟</span>
            <n-input-number
              size="small"
              class="more-number"
              :value="mock.delay"
              :min="0"
              :max="60000"
              :disabled="!canEdit"
              @update:value="(v) => patchMock({ delay: v || 0 })"
            />
            <span class="more-hint">模拟慢接口，单位毫秒</span>
          </div>
          <div v-if="!isWs" class="more-row">
            <span class="more-label">跨域</span>
            <n-switch
              size="small"
              :value="mock.cors"
              :disabled="!canEdit"
              @update:value="(v) => patchMock({ cors: v })"
            />
            <span class="more-hint">浏览器里的网页直接调用 mock 地址时要打开</span>
          </div>
        </div>
      </div>

      <div class="body">
        <aside class="list">
          <div class="section">
            <div class="list-head">
              <span>返回数据（示例）</span>
              <n-button
                v-if="canEdit"
                size="tiny"
                quaternary
                type="primary"
                @click="createExample"
              >
                新建
              </n-button>
            </div>

            <div class="list-body">
              <div
                v-for="example in examples"
                :key="example.id"
                class="list-item"
                :class="{ active: example.id === selectedId }"
                @click="selectExample(example.id)"
              >
                <div class="item-main">
                  <span class="item-name">{{ example.name }}</span>
                  <n-tag
                    v-if="mock.exampleId === example.id"
                    size="tiny"
                    :bordered="false"
                    type="success"
                  >
                    mock 使用中
                  </n-tag>
                  <n-tag
                    size="tiny"
                    :bordered="false"
                    :type="(SOURCE_LABELS[example.source] || SOURCE_LABELS.manual).type"
                  >
                    {{ (SOURCE_LABELS[example.source] || SOURCE_LABELS.manual).text }}
                  </n-tag>
                </div>
                <div v-if="canEdit" class="item-actions">
                  <n-button size="tiny" quaternary @click.stop="useAsMock(example)">设为 mock</n-button>
                  <n-button size="tiny" quaternary @click.stop="renameExample(example)">改名</n-button>
                  <n-button size="tiny" quaternary type="error" @click.stop="removeExample(example)">
                    删除
                  </n-button>
                </div>
              </div>

              <n-empty v-if="!examples.length" size="small" description="还没有示例" />
            </div>
          </div>

          <div v-if="!isWs" class="section" :class="{ collapsed: !showRules }">
            <div class="list-head">
              <a class="rules-toggle" @click="showRules = !showRules">
                {{ showRules ? '▾' : '▸' }} 按条件返回（高级）
              </a>
              <n-button
                v-if="canEdit && showRules"
                size="tiny"
                quaternary
                type="primary"
                @click="createExpectation"
              >
                新建
              </n-button>
            </div>

            <div v-if="showRules" class="list-body">
              <p class="rules-intro">
                按请求里的参数返回不同的示例，比如「参数 id=1 时返回示例 A，其他情况返回默认示例」。
                从上到下检查，第一条满足的生效。
              </p>
              <div
                v-for="(item, index) in expectations"
                :key="item.id"
                class="exp-item"
                :class="{
                  active: item.id === selectedExpectationId,
                  dragging: index === dragIndex,
                  'drop-target': index === overIndex && dragIndex !== -1 && index !== dragIndex
                }"
                :draggable="canEdit"
                @click="selectExpectation(item.id)"
                @dragstart="onDragStart(index)"
                @dragover.prevent="onDragOver(index)"
                @drop.prevent="onDrop"
                @dragend="onDragEnd"
              >
                <div class="exp-top">
                  <span class="exp-name">{{ item.name || '(未命名期望)' }}</span>
                  <n-switch
                    size="tiny"
                    :value="item.enabled"
                    :disabled="!canEdit"
                    @click.stop
                    @update:value="(v) => toggleExpectation(item, v)"
                  />
                </div>
                <div class="exp-summary" :title="conditionSummary(item.conditions)">
                  {{ conditionSummary(item.conditions) }}
                </div>
                <div class="exp-foot">
                  <span class="exp-example" :title="exampleName(item.exampleId)">
                    → {{ exampleName(item.exampleId) }}
                  </span>
                  <n-button
                    v-if="canEdit"
                    size="tiny"
                    quaternary
                    type="error"
                    @click.stop="removeExpectation(item)"
                  >
                    删除
                  </n-button>
                </div>
                <div v-if="expectationErrors[item.id]" class="exp-error">
                  {{ expectationErrors[item.id] }}
                </div>
              </div>

              <n-empty
                v-if="!expectations.length"
                size="small"
                description="还没有规则，所有请求都返回默认示例"
              />
            </div>
          </div>
        </aside>

        <section class="editor">
          <expectation-editor
            v-if="selectedExpectation"
            :key="selectedExpectation.id"
            :api="api"
            :expectation="selectedExpectation"
            :examples="examples"
            :readonly="!canEdit"
            @saved="onExpectationSaved"
            @failed="onExpectationFailed"
          />
          <example-editor
            v-else-if="selectedExample"
            ref="exampleEditorRef"
            :key="selectedExample.id"
            :example="selectedExample"
            :placeholders="(session.meta && session.meta.placeholders) || []"
            :templates="(session.meta && session.meta.templates) || []"
            :readonly="!canEdit"
            @saved="emitSaved"
          />
          <n-empty v-else description="选一个示例来编辑，或者按上面的三步先把 mock 用起来" />
        </section>
      </div>
    </template>
  </div>
</template>

<style scoped>
.mock-panel {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.placeholder {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

.intro {
  flex: none;
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  opacity: 0.65;
}

/* 三步：左边圆圈序号，做完换成绿色的勾 */
.steps {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.24));
  border-radius: 6px;
}

.step {
  display: grid;
  grid-template-columns: 22px 110px 1fr;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}

.step-no {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 700;
  background: rgba(128, 128, 128, 0.18);
}

.step-no.done {
  background: #18a058;
  color: #fff;
}

.step-title {
  font-weight: 600;
}

.step-body {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.step-body.column {
  flex-direction: column;
  align-items: stretch;
  gap: 2px;
}

.step-text {
  font-size: 12px;
  opacity: 0.65;
}

.url-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-size: 12px;
}

/* 更多设置 */
.more {
  flex: none;
  font-size: 12px;
}

.more-toggle,
.rules-toggle {
  cursor: pointer;
  user-select: none;
  opacity: 0.8;
}

.more-toggle:hover,
.rules-toggle:hover {
  opacity: 1;
}

.more-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 6px;
  padding-left: 14px;
}

.more-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.more-label {
  flex: none;
  width: 32px;
  opacity: 0.7;
}

.more-input {
  width: 260px;
}

.more-number {
  width: 140px;
}

.more-hint {
  opacity: 0.55;
}

/* 「按条件返回」收起时只剩标题那一行，把高度让给上面的示例列表 */
.section.collapsed {
  flex: none;
}

.rules-intro {
  margin: 4px 6px 6px;
  font-size: 12px;
  line-height: 1.6;
  opacity: 0.6;
}

.url {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  opacity: 0.85;
}

.body {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 10px;
}

.list {
  flex: none;
  width: 240px;
  border: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.24));
  border-radius: 6px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.section {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.section + .section {
  border-top: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.24));
}

.list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  font-size: 12px;
  opacity: 0.75;
  border-bottom: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.16));
}

.list-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 4px;
}

.list-item {
  padding: 6px 8px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
}

.list-item:hover {
  background: rgba(128, 128, 128, 0.12);
}

.list-item.active {
  background: rgba(32, 128, 240, 0.14);
}

.item-main {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.item-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 120px;
}

.item-actions {
  display: none;
  gap: 2px;
  margin-top: 4px;
}

.list-item:hover .item-actions,
.list-item.active .item-actions {
  display: flex;
}

.exp-item {
  padding: 6px 8px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  border: 1px solid transparent;
}

.exp-item:hover {
  background: rgba(128, 128, 128, 0.12);
}

.exp-item.active {
  background: rgba(32, 128, 240, 0.14);
}

.exp-item.dragging {
  opacity: 0.5;
}

.exp-item.drop-target {
  border-top-color: var(--apiloop-primary);
  border-top-style: dashed;
}

.exp-top {
  display: flex;
  align-items: center;
  gap: 6px;
}

.exp-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}

.exp-summary {
  margin-top: 2px;
  opacity: 0.65;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.exp-foot {
  margin-top: 2px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  opacity: 0.6;
}

.exp-example {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.exp-error {
  margin-top: 4px;
  color: #d03050;
  line-height: 1.5;
  word-break: break-all;
}

.editor {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
</style>
