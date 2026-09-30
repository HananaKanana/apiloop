<script setup>
import { computed, ref } from 'vue';
import { NButton, NDropdown, NRadioButton, NRadioGroup } from 'naive-ui';
import CodeEditor from '@/components/common/CodeEditor.vue';
import { SCRIPT_SNIPPETS } from './snippets';

/**
 * 可编辑的脚本编辑器（契约第 16 节）。接口、目录、项目三处共用。
 *
 * 数据形状是 `[{ listen: 'prerequest'|'test', exec }]` —— 和接口/目录/项目上的
 * `scripts` 字段一模一样，所以三个地方都直接 v-model 到各自的可编辑对象上，
 * 保存沿用它们原有的保存机制（未保存标记也是白拿的）。
 *
 * 空的一段不留在数据里：契约里 `listen` 只有两个取值，留着 `exec: ''` 没有意义，
 * 清空编辑器就等于删掉这一段。
 */
const props = defineProps({
  modelValue: { type: Array, default: function () { return []; } },
  /** 只读角色：编辑器只读，不出现「常用片段」 */
  disabled: { type: Boolean, default: false },
  minHeight: { type: String, default: '200px' }
});

const emit = defineEmits(['update:modelValue']);

const PHASES = [
  { key: 'prerequest', label: '前置脚本' },
  { key: 'test', label: '测试' }
];

const PHASE_HINT = {
  prerequest: '请求发出之前执行。这里改过的变量会参与变量替换；抛出异常时请求不会发出去。',
  test: '响应回来之后执行。用 pm.test 写断言，结果显示在响应面板的「测试结果」里。'
};

const activePhase = ref('prerequest');
const editorRef = ref(null);

function execOf(list, phase) {
  const found = (list || []).find(function (item) { return item && item.listen === phase; });
  return found ? String(found.exec || '') : '';
}

const exec = computed(function () {
  return execOf(props.modelValue, activePhase.value);
});

const hint = computed(function () {
  return PHASE_HINT[activePhase.value];
});

function commit(phase, text) {
  const list = (props.modelValue || []).map(function (item) {
    return { listen: item.listen, exec: String(item.exec || '') };
  });

  const index = list.findIndex(function (item) { return item.listen === phase; });
  if (!text) {
    if (index !== -1) list.splice(index, 1);
  } else if (index === -1) {
    list.push({ listen: phase, exec: text });
  } else {
    list[index].exec = text;
  }

  emit('update:modelValue', list);
}

/** 只放当前阶段能用的片段：`pm.response` 在前置脚本里是不存在的 */
const snippetOptions = computed(function () {
  return SCRIPT_SNIPPETS.filter(function (item) {
    return item.phase === 'both' || item.phase === activePhase.value;
  }).map(function (item) {
    return { label: item.label, key: item.label };
  });
});

function insertSnippet(label) {
  if (props.disabled) return;

  const snippet = SCRIPT_SNIPPETS.find(function (item) { return item.label === label; });
  if (!snippet || !editorRef.value) return;

  editorRef.value.insertAtCursor(snippet.code);
}
</script>

<template>
  <div class="script-editor">
    <div class="toolbar">
      <n-radio-group v-model:value="activePhase" size="small">
        <n-radio-button v-for="phase in PHASES" :key="phase.key" :value="phase.key">
          {{ phase.label }}
        </n-radio-button>
      </n-radio-group>

      <span class="spacer" />

      <n-dropdown
        v-if="!disabled"
        trigger="click"
        :options="snippetOptions"
        @select="insertSnippet"
      >
        <n-button size="small" quaternary>常用片段</n-button>
      </n-dropdown>
    </div>

    <code-editor
      ref="editorRef"
      class="editor"
      :model-value="exec"
      language="javascript"
      :readonly="disabled"
      :min-height="minHeight"
      @update:model-value="(v) => commit(activePhase, v)"
    />

    <p class="hint">
      {{ hint }}
      <span v-if="disabled" class="readonly">当前角色是只读，不能修改脚本。</span>
    </p>
  </div>
</template>

<style scoped>
.script-editor {
  display: flex;
  flex-direction: column;
  gap: 8px;
  height: 100%;
  min-height: 0;
}

.toolbar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
}

.spacer {
  flex: 1;
}

/* 编辑器吃掉剩下的高度，工具栏和提示行不参与拉伸 */
.editor {
  flex: 1;
  min-height: 0;
}

.hint {
  margin: 0;
  flex: none;
  font-size: 12px;
  opacity: 0.6;
  line-height: 1.6;
}

.readonly {
  margin-left: 6px;
}
</style>
