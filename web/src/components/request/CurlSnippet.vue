<script setup>
import { computed, ref, watch } from 'vue';
import { NAlert, NButton, NDrawer, NDrawerContent, NSpin, useMessage } from 'naive-ui';
import CodeEditor from '@/components/common/CodeEditor.vue';
import { copyText } from '@/utils/clipboard';

/**
 * 代码片段面板（参考 Postman 右侧的 Code snippet）：当前请求的 cURL 命令 + 一键复制。
 *
 * 命令由后台按发送时的同一套规则生成（变量换成实际值、鉴权和继承的鉴权都带上），
 * 所以复制出去在终端里跑，和点「发送」打出去的是同一个请求。
 */
const props = defineProps({
  show: { type: Boolean, default: false },
  /** 拿命令的函数：() => Promise<{ curl, missing }>，由请求标签页提供 */
  load: { type: Function, required: true },
  /** 当前环境名，给一句「变量按哪个环境解析的」 */
  envName: { type: String, default: '' }
});

const emit = defineEmits(['update:show']);
const message = useMessage();

const visible = computed({
  get: function () { return props.show; },
  set: function (value) { emit('update:show', value); }
});

const loading = ref(false);
const curl = ref('');
const missing = ref([]);
const error = ref('');

async function refresh() {
  loading.value = true;
  error.value = '';
  try {
    const data = await props.load();
    curl.value = data.curl || '';
    missing.value = data.missing || [];
  } catch (err) {
    error.value = err.message;
    curl.value = '';
  } finally {
    loading.value = false;
  }
}

// 每次打开都重新生成：请求可能刚改过、环境可能刚换过
watch(
  function () { return props.show; },
  function (open) { if (open) refresh(); }
);

async function copy() {
  try {
    await copyText(curl.value);
    message.success('已复制 cURL');
  } catch (err) {
    message.warning('复制失败，请手动选中复制');
  }
}
</script>

<template>
  <n-drawer v-model:show="visible" :width="520" placement="right">
    <n-drawer-content title="代码片段 · cURL" closable :native-scrollbar="false">
      <div class="snippet">
        <div class="bar">
          <span class="hint">
            变量按{{ envName ? '环境「' + envName + '」' : '「无环境」' }}解析成了实际值；「请求前」脚本不运行。
          </span>
          <n-button size="small" type="primary" :disabled="!curl" @click="copy">复制</n-button>
        </div>

        <n-alert v-if="error" type="error" :show-icon="false">{{ error }}</n-alert>
        <n-alert v-else-if="missing.length" type="warning" :show-icon="false">
          这些变量没有定义，命令里原样保留：{{ missing.join('、') }}
        </n-alert>

        <n-spin :show="loading">
          <code-editor class="code" :model-value="curl" language="text" readonly wrap min-height="240px" />
        </n-spin>
      </div>
    </n-drawer-content>
  </n-drawer>
</template>

<style scoped>
.snippet {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.hint {
  font-size: 12px;
  opacity: 0.6;
  line-height: 1.6;
}

.code {
  height: auto;
}
</style>
