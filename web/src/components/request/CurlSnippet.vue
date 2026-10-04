<script setup>
import { computed, ref, watch } from 'vue';
import { NAlert, NButton, NDrawer, NDrawerContent, NSelect, NSpin, useMessage } from 'naive-ui';
import CodeEditor from '@/components/common/CodeEditor.vue';
import { copyText } from '@/utils/clipboard';

/**
 * 代码片段面板（参考 Postman 右侧的 Code snippet）：当前请求的调用代码 + 一键复制。
 *
 * 代码由后台按发送时的同一套规则生成（变量换成实际值、鉴权和继承的鉴权都带上），
 * 所以复制出去跑，和点「发送」打出去的是同一个请求。
 *
 * 后台一次把**所有语言**都返回（`code` 是「语言 → 代码」的表），所以切换语言不用再打接口。
 */
const props = defineProps({
  show: { type: Boolean, default: false },
  /** 拿代码的函数：() => Promise<{ curl, code, missing }>，由请求标签页提供 */
  load: { type: Function, required: true },
  /** 当前环境名，给一句「变量按哪个环境解析的」 */
  envName: { type: String, default: '' }
});

const emit = defineEmits(['update:show']);
const message = useMessage();

/** 语言清单：id 和后台 `code` 的键一一对应，label 是下拉里显示的文字 */
const LANGUAGES = [
  { id: 'curl', label: 'cURL', editor: 'curl' },
  { id: 'fetch', label: 'JavaScript – fetch', editor: 'javascript' },
  { id: 'axios', label: 'JavaScript – axios', editor: 'javascript' },
  { id: 'python', label: 'Python – requests', editor: 'python' },
  { id: 'java', label: 'Java – OkHttp', editor: 'java' },
  { id: 'go', label: 'Go – net/http', editor: 'go' },
  { id: 'php', label: 'PHP – cURL', editor: 'php' },
  { id: 'csharp', label: 'C# – HttpClient', editor: 'csharp' }
];

const languageOptions = LANGUAGES.map(function (item) {
  return { label: item.label, value: item.id };
});

const STORAGE_KEY = 'apiloop.codeSnippet.language';

/** 上次选的语言。localStorage 在隐私模式 / 嵌入式壳里可能直接抛异常，读写都要包住 */
function readLanguage() {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    return LANGUAGES.some(function (item) { return item.id === saved; }) ? saved : 'curl';
  } catch (err) {
    return 'curl';
  }
}

function writeLanguage(value) {
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch (err) {
    // 存不了就存不了，不影响这次使用
  }
}

const visible = computed({
  get: function () { return props.show; },
  set: function (value) { emit('update:show', value); }
});

const loading = ref(false);
const language = ref(readLanguage());
const codes = ref({});
const missing = ref([]);
const error = ref('');

const currentLabel = computed(function () {
  const found = LANGUAGES.filter(function (item) { return item.id === language.value; })[0];
  return found ? found.label : 'cURL';
});

const currentCode = computed(function () {
  return codes.value[language.value] || '';
});

/** 代码编辑器认识的语言名（fetch / axios 都是 JavaScript；C# 由编辑器映射到 Java 高亮） */
const editorLanguage = computed(function () {
  const found = LANGUAGES.filter(function (item) { return item.id === language.value; })[0];
  return found ? found.editor : 'text';
});

async function refresh() {
  loading.value = true;
  error.value = '';
  try {
    const data = await props.load();
    // 老后台只回 curl 一个字段，这里兜一下底
    codes.value = data.code || (data.curl ? { curl: data.curl } : {});
    missing.value = data.missing || [];
    if (!codes.value[language.value]) language.value = 'curl';
  } catch (err) {
    error.value = err.message;
    codes.value = {};
  } finally {
    loading.value = false;
  }
}

// 每次打开都重新生成：请求可能刚改过、环境可能刚换过
watch(
  function () { return props.show; },
  function (open) { if (open) refresh(); }
);

function onLanguageChange(value) {
  language.value = value;
  writeLanguage(value);
}

async function copy() {
  try {
    await copyText(currentCode.value);
    message.success('已复制 ' + currentLabel.value);
  } catch (err) {
    message.warning('复制失败，请手动选中复制');
  }
}
</script>

<template>
  <n-drawer v-model:show="visible" :width="520" placement="right">
    <n-drawer-content title="代码片段" closable :native-scrollbar="false">
      <div class="snippet">
        <div class="bar">
          <n-select
            class="lang"
            size="small"
            :value="language"
            :options="languageOptions"
            :consistent-menu-width="false"
            @update:value="onLanguageChange"
          />
          <n-button size="small" type="primary" :disabled="!currentCode" @click="copy">复制</n-button>
        </div>

        <div class="hint">
          变量按{{ envName ? '环境「' + envName + '」' : '「无环境」' }}解析成了实际值；「请求前」脚本不运行。
        </div>

        <n-alert v-if="error" type="error" :show-icon="false">{{ error }}</n-alert>
        <n-alert v-else-if="missing.length" type="warning" :show-icon="false">
          这些变量没有定义，代码里原样保留：{{ missing.join('、') }}
        </n-alert>

        <n-spin :show="loading">
          <code-editor class="code" :model-value="currentCode" :language="editorLanguage" readonly wrap min-height="240px" />
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

.lang {
  width: 220px;
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
