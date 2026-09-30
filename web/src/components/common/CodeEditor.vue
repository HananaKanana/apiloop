<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { EditorView, basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { json } from '@codemirror/lang-json';
import { html } from '@codemirror/lang-html';
import { xml } from '@codemirror/lang-xml';
import { javascript } from '@codemirror/lang-javascript';

/**
 * CodeMirror 6 的薄封装。
 *
 * 主题不引第三方主题包（计划里没有），只用一段小主题把背景设成透明、文字继承外层颜色，
 * 这样亮色和暗色都能用；语法高亮的配色用 CodeMirror 自带的默认值。
 */
const props = defineProps({
  modelValue: { type: String, default: '' },
  language: { type: String, default: 'text' },
  readonly: { type: Boolean, default: false },
  minHeight: { type: String, default: '180px' }
});

const emit = defineEmits(['update:modelValue']);

const host = ref(null);
let view = null;
let applying = false;

function languageExtension(name) {
  if (name === 'json') return json();
  if (name === 'html') return html();
  if (name === 'xml') return xml();
  if (name === 'javascript') return javascript();
  return [];
}

const theme = EditorView.theme({
  '&': {
    fontSize: '13px',
    backgroundColor: 'transparent',
    color: 'inherit',
    height: '100%'
  },
  '.cm-content': {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    padding: '6px 0'
  },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'inherit',
    opacity: '0.5',
    border: 'none'
  },
  '.cm-activeLine': { backgroundColor: 'rgba(128, 128, 128, 0.08)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent' },
  '.cm-scroller': { overflow: 'auto' },
  '&.cm-focused': { outline: 'none' }
});

function createView() {
  if (!host.value) return;

  view = new EditorView({
    parent: host.value,
    state: EditorState.create({
      doc: props.modelValue || '',
      extensions: [
        basicSetup,
        theme,
        languageExtension(props.language),
        EditorState.readOnly.of(props.readonly),
        EditorView.editable.of(!props.readonly),
        EditorView.updateListener.of(function (update) {
          if (!update.docChanged || applying) return;
          emit('update:modelValue', update.state.doc.toString());
        })
      ]
    })
  });
}

onMounted(createView);

onBeforeUnmount(function () {
  if (view) {
    view.destroy();
    view = null;
  }
});

// 外部值变了才写回编辑器，避免和用户输入互相打架
watch(
  function () { return props.modelValue; },
  function (value) {
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === (value || '')) return;
    applying = true;
    view.dispatch({ changes: { from: 0, to: current.length, insert: value || '' } });
    applying = false;
  }
);

watch(
  function () { return props.language; },
  function () {
    if (!view) return;
    const doc = view.state.doc.toString();
    view.destroy();
    view = null;
    createView();
    if (view.state.doc.toString() !== doc) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: doc } });
    }
  }
);

watch(
  function () { return props.readonly; },
  function () {
    if (view) view.destroy();
    view = null;
    createView();
  }
);

/** 在光标处插入一段文本（「插入 Mock 字段」用），插完把焦点还给编辑器 */
function insertAtCursor(text) {
  if (!view || props.readonly) return;

  const range = view.state.selection.main;
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: text },
    selection: { anchor: range.from + text.length }
  });
  view.focus();
}

defineExpose({ insertAtCursor: insertAtCursor });
</script>

<template>
  <div ref="host" class="code-editor" :style="{ minHeight: minHeight }" />
</template>

<style scoped>
.code-editor {
  border: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.24));
  border-radius: 6px;
  overflow: hidden;
  height: 100%;
  box-sizing: border-box;
}
</style>
