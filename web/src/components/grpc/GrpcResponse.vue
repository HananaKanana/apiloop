<script setup>
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { NCollapse, NCollapseItem, NEmpty, NTabPane, NTabs, NTag } from 'naive-ui';
import BodyViewer from '@/components/response/BodyViewer.vue';
import { byteLength, formatClock, messageResponse, statusTagType } from './grpc-util';

/**
 * gRPC 调用的响应区（第十一轮第 3 节）。
 *
 * 和 HTTP 的响应面板平行的一块：上面是状态（码名 + details + 中文提示）和耗时，
 * 下面是三个页签 —— 消息 / Metadata / Trailers。
 *
 * 消息用 `BodyViewer` 显示：它已经带了 JSON 树、格式化、复制、下载，
 * 这里只要把一条消息包成它认的响应对象（见 `messageResponse`）。
 */
const props = defineProps({
  /** `stores/grpc.js` 里那个状态对象；没有就是「还没调过」 */
  state: { type: Object, default: null },
  /** 这次选中的方法是不是服务端流（决定消息页签是一条还是多条） */
  streaming: { type: Boolean, default: false }
});

const { t } = useI18n();

const phase = computed(function () { return (props.state && props.state.phase) || 'idle'; });
const status = computed(function () { return props.state && props.state.status; });
const messages = computed(function () { return (props.state && props.state.messages) || []; });
const missing = computed(function () { return (props.state && props.state.missing) || []; });

const statusLabel = computed(function () {
  const current = status.value;
  if (!current) return '';
  return current.name ? current.name : String(current.code);
});

const metadataText = computed(function () {
  const value = props.state && props.state.metadata;
  return value ? JSON.stringify(value, null, 2) : '';
});

const trailersText = computed(function () {
  const value = props.state && props.state.trailers;
  return value && Object.keys(value).length ? JSON.stringify(value, null, 2) : '';
});

/** 断言和提取变量（第十二轮第 1 节）：结果跟在 end 那一行里 */
const tests = computed(function () { return (props.state && props.state.tests) || []; });
const extracted = computed(function () { return (props.state && props.state.extracted) || []; });

const passedCount = computed(function () {
  return tests.value.filter(function (item) { return item.passed; }).length;
});

const testsTab = computed(function () {
  if (!tests.value.length && !extracted.value.length) return t('grpc.testsLabel');
  return t('grpc.testsLabel') + t('grpc.testsCount', { passed: passedCount.value, total: tests.value.length }) +
    (extracted.value.length ? t('grpc.testsExtracted', { n: extracted.value.length }) : '');
});

/** 响应区自己的页签：只在组件内部用，不进 store（切标签页本来就会重建组件） */
const activePane = ref('messages');

/** 单条消息的 BodyViewer 输入 */
function responseOf(item) {
  return messageResponse(item && item.data);
}

function sizeOf(item) {
  return byteLength(String(item && item.data === undefined ? '' : JSON.stringify(item.data, null, 2)));
}
</script>

<template>
  <div class="grpc-response">
    <div class="head">
      <span class="label">{{ t('grpc.responseLabel') }}</span>

      <template v-if="phase === 'idle'">
        <span class="dim">{{ t('grpc.notCalledYet') }}</span>
      </template>
      <template v-else-if="phase === 'running'">
        <n-tag size="small" type="warning">{{ t('grpc.calling') }}</n-tag>
      </template>
      <template v-else-if="phase === 'cancelled'">
        <n-tag size="small">{{ t('grpc.cancelled') }}</n-tag>
      </template>
      <template v-else-if="status">
        <n-tag size="small" :type="statusTagType(status.name)">{{ statusLabel }}</n-tag>
        <span v-if="typeof state.durationMs === 'number'" class="dim">{{ state.durationMs }} ms</span>
        <span v-if="status.details" class="details">{{ status.details }}</span>
      </template>
      <template v-else>
        <n-tag size="small" type="error">{{ t('grpc.failed') }}</n-tag>
      </template>

      <span v-if="state && state.dropped" class="dim">{{ t('grpc.dropped', { n: state.dropped }) }}</span>
    </div>

    <p v-if="phase === 'error' && state && state.error" class="error">{{ state.error }}</p>
    <p v-if="missing.length" class="warn">
      {{ t('grpc.missingVars', { vars: missing.join(t('grpc.listSeparator')) }) }}
    </p>

    <n-tabs v-model:value="activePane" type="line" size="small" class="panes">
      <n-tab-pane name="messages" :tab="messages.length ? t('grpc.messages') + t('grpc.messagesCount', { n: messages.length }) : t('grpc.messages')">
        <template v-if="!messages.length">
          <n-empty v-if="phase !== 'running'" size="small" :description="t('grpc.noMessages')" />
          <p v-else class="dim">{{ t('grpc.waitingResponse') }}</p>
        </template>

        <!-- 一元调用：一条消息，直接铺开 -->
        <body-viewer
          v-else-if="!streaming"
          :response="responseOf(messages[messages.length - 1])"
          :readonly="true"
        />

        <!-- 服务端流：每条一行，点开看内容 -->
        <n-collapse v-else>
          <n-collapse-item
            v-for="(item, index) in messages"
            :key="index"
            :name="String(index)"
          >
            <template #header>
              <span class="msg-head">
                <span class="dim">#{{ index + 1 }}</span>
                <span class="dim">{{ formatClock(item.at) }}</span>
                <span class="dim">{{ sizeOf(item) }} B</span>
              </span>
            </template>
            <body-viewer :response="responseOf(item)" :readonly="true" />
          </n-collapse-item>
        </n-collapse>
      </n-tab-pane>

      <n-tab-pane name="metadata" tab="Metadata">
        <pre v-if="metadataText" class="json">{{ metadataText }}</pre>
        <n-empty v-else size="small" :description="t('grpc.noMetadata')" />
      </n-tab-pane>

      <n-tab-pane name="trailers" tab="Trailers">
        <pre v-if="trailersText" class="json">{{ trailersText }}</pre>
        <n-empty v-else size="small" :description="t('grpc.noTrailers')" />
      </n-tab-pane>

      <n-tab-pane name="tests" :tab="testsTab">
        <template v-if="!tests.length && !extracted.length">
          <n-empty size="small" :description="t('grpc.noTestsOrExtracts')" />
        </template>

        <div v-if="tests.length" class="tests">
          <div v-for="(item, index) in tests" :key="index" class="test" :class="{ bad: !item.passed }">
            {{ item.passed ? t('grpc.passed') : t('grpc.failed') }}：{{ item.name }}
            <span v-if="item.message" class="msg">{{ item.message }}</span>
          </div>
        </div>

        <div v-if="extracted.length" class="extracted">
          <p class="label">{{ t('grpc.extractedVars') }}</p>
          <div v-for="(item, index) in extracted" :key="index" class="test">
            {{ item.key }} = {{ item.value }}（{{ item.scope === 'environment' ? t('layout.entityEnvironment') : t('layout.entityProject') }}）
          </div>
        </div>
      </n-tab-pane>
    </n-tabs>
  </div>
</template>

<style scoped>
.grpc-response {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-top: 1px solid rgba(128, 128, 128, 0.18);
  padding-top: 8px;
}

.head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.label {
  font-weight: 600;
  opacity: 0.8;
}

.dim {
  opacity: 0.6;
}

.details {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.error {
  flex: none;
  margin: 6px 0 0;
  padding: 5px 10px;
  border-radius: 4px;
  font-size: 12px;
  color: #eb2013;
  background: rgba(235, 32, 19, 0.1);
}

.warn {
  flex: none;
  margin: 6px 0 0;
  font-size: 12px;
  opacity: 0.75;
}

.panes {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.panes :deep(.n-tab-pane) {
  height: 100%;
  min-height: 0;
  overflow: auto;
  padding-top: 8px;
}

.msg-head {
  display: flex;
  gap: 10px;
  font-size: 12px;
}

.json {
  margin: 0;
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: pre-wrap;
  word-break: break-all;
}

.tests,
.extracted {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.extracted {
  margin-top: 10px;
}

.extracted .label {
  margin: 0 0 2px;
  font-size: 12px;
  opacity: 0.7;
}

.test {
  font-size: 12px;
  line-height: 1.7;
}

.test.bad {
  color: #d03050;
}

.test .msg {
  opacity: 0.7;
}
</style>
