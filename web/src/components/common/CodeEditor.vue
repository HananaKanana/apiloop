<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { EditorView, basicSetup } from 'codemirror';
import { EditorState, StateEffect } from '@codemirror/state';
import { json } from '@codemirror/lang-json';
import { html } from '@codemirror/lang-html';
import { xml } from '@codemirror/lang-xml';
import { javascript } from '@codemirror/lang-javascript';
import { autocompletion } from '@codemirror/autocomplete';
import { Decoration } from '@codemirror/view';
import { openSearchPanel } from '@codemirror/search';
import { syntaxHighlighting } from '@codemirror/language';
import { classHighlighter } from '@lezer/highlight';
import { formatJson } from '@/utils/jsonFormat';

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
  minHeight: { type: String, default: '180px' },
  /** 自动换行（响应体、代码片段里长行要能看全） */
  wrap: { type: Boolean, default: false },
  /**
   * mock 占位符（`/meta` 的 placeholders）。传了它，输入 `{{@` 就补全占位符 ——
   * 只在 mock 示例编辑器里传；请求区不补，因为发送请求时不会渲染它们。
   */
  placeholders: { type: Array, default: function () { return []; } },
  /**
   * GraphQL 的 introspection 结果（`{ __schema: {...} }`）。传了它 + `language="graphql"`
   * 才有补全 / 校验 / 悬停提示（第七轮第 3 节）。
   *
   * 它是**异步**加载的：`graphql` 和 `cm6-graphql` 两个包加起来不小，
   * 只有真的在写 GraphQL 查询时才动态 import（见下面的 ensureGraphql）。
   */
  schema: { type: Object, default: null }
});

const emit = defineEmits(['update:modelValue', 'format-error']);

const host = ref(null);
let view = null;
let applying = false;

/** GraphQL 的补全扩展（动态加载好之后放这儿）；没加载好或没 schema 时是 null */
let graphqlExtension = null;
/** 正在加载 / 加载的是哪一份 schema（schema 换了要重建扩展） */
let graphqlLoading = null;
let graphqlFor = null;

function languageExtension(name) {
  if (name === 'json') return json();
  if (name === 'html') return html();
  if (name === 'xml') return xml();
  if (name === 'javascript') return javascript();
  // graphql 的扩展要等动态 import（见 ensureGraphql），这里不给
  return [];
}

/* ---------------- GraphQL：动态加载 cm6-graphql ---------------- */

let graphqlModules = null;

/**
 * `cm6-graphql` 和 `graphql` 两个包加起来几百 KB，只有真的在写 GraphQL 查询时才需要。
 * 静态 import 会把它们塞进主包（每个打开管理台的人都要下），所以这里动态 import ——
 * vite 会单独切一个 chunk，第一次用的时候才拉。
 */
async function loadGraphqlModules() {
  if (!graphqlModules) {
    graphqlModules = Promise.all([import('cm6-graphql'), import('graphql')])
      .then(function (loaded) {
        return { cm6: loaded[0], gql: loaded[1] };
      });
  }
  return graphqlModules;
}

/**
 * 保证 `graphqlExtension` 和当前 schema 对得上。
 *
 * @returns {Promise<boolean>} 扩展有没有变化（变了要 reconfigure）
 */
async function ensureGraphql() {
  if (props.language !== 'graphql' || !props.schema) {
    const had = Boolean(graphqlExtension);
    graphqlExtension = null;
    graphqlFor = null;
    return had;
  }

  if (graphqlExtension && graphqlFor === props.schema) return false;

  graphqlLoading = loadGraphqlModules().then(function (modules) {
    // 加载期间 schema 可能又换了，认最后一次
    graphqlExtension = modules.cm6.graphql(modules.gql.buildClientSchema(props.schema));
    graphqlFor = props.schema;
    return true;
  }, function (err) {
    console.warn('[apiloop] GraphQL 补全加载失败：' + ((err && err.message) || err));
    graphqlExtension = null;
    graphqlFor = null;
    return false;
  });

  return graphqlLoading;
}

/** schema 变了：重新建扩展并就地换掉（不重建编辑器，光标和滚动位置都留着） */
async function reloadGraphql() {
  const changed = await ensureGraphql();
  if (!changed || !view) return;
  view.dispatch({ effects: StateEffect.reconfigure.of(buildExtensions()) });
}

/* ---------------- `{{@占位符}}` 的补全与高亮 ---------------- */

/** 占位符在正文里是紫色的，和变量区分开 */
const placeholderMark = Decoration.mark({ class: 'cm-placeholder-token' });

const placeholderDecorations = EditorView.decorations.compute(['doc'], function (state) {
  const text = state.doc.toString();
  const ranges = [];
  const pattern = /\{\{\s*@[^{}]*?\s*\}\}/g;

  let matched = pattern.exec(text);
  while (matched) {
    ranges.push(placeholderMark.range(matched.index, matched.index + matched[0].length));
    matched = pattern.exec(text);
  }

  return Decoration.set(ranges, true);
});

function placeholderSource(context) {
  const list = props.placeholders || [];
  if (!list.length) return null;

  const before = context.matchBefore(/\{\{\s*@[^{}]*$/);
  if (!before) return null;

  const typed = before.text.replace(/^\{\{\s*@/, '').toLowerCase();
  const from = before.to - typed.length;

  const matched = list.filter(function (item) {
    return String(item.name).toLowerCase().indexOf(typed) !== -1;
  }).sort(function (a, b) {
    const prefixA = String(a.name).toLowerCase().indexOf(typed) === 0 ? 0 : 1;
    const prefixB = String(b.name).toLowerCase().indexOf(typed) === 0 ? 0 : 1;
    if (prefixA !== prefixB) return prefixA - prefixB;
    return String(a.name).localeCompare(String(b.name));
  }).map(function (item) {
    return {
      label: item.name,
      detail: item.desc || '',
      info: item.group || '',
      apply: function (target, completion, start, end) {
        const after = target.state.sliceDoc(end, Math.min(end + 2, target.state.doc.length));
        const insert = completion.label + (after === '}}' ? '' : '}}');
        target.dispatch({
          changes: { from: start, to: end, insert: insert },
          selection: { anchor: start + insert.length }
        });
      }
    };
  });

  return { from: from, options: matched, filter: false, validFor: /^[^{}]*$/ };
}

/* ---------------- JSON 美化 ---------------- */

/**
 * 美化当前内容。按钮和快捷键都走这一个函数，行为保证一致。
 * 失败时抛 `format-error` 事件让外面去提示，组件自己不弹窗 ——
 * 同一个编辑器可能被放在不同上下文里，提示方式该由调用方决定。
 */
function applyFormat() {
  if (!view || props.readonly) return;

  const current = view.state.doc.toString();
  const result = formatJson(current, 2);

  if (!result.ok) {
    emit('format-error', result.error);
    return;
  }
  if (result.text === current) return;

  applying = true;
  view.dispatch({ changes: { from: 0, to: current.length, insert: result.text } });
  applying = false;
  emit('update:modelValue', result.text);
}

/**
 * ⇧⌥F / Shift+Alt+F 触发美化（和 VS Code 一样）。
 *
 * 这里**不用 CodeMirror 的 keymap**，而是在 DOM 层听 keydown：
 * CM 的键名是从 `event.key` 拼出来的，而 macOS 上 ⌥F 会组合成一个特殊字符
 * （`event.key` 不再是 'f'），键名就对不上了。`event.code` 不受组合影响，
 * 认 `KeyF` 才能在各种键盘布局和输入法下都稳。
 *
 * 这个扩展**一直挂着**，语言在事件里判（审阅 N3）：如果只在创建时按语言决定挂不挂，
 * 用户在请求体里把语言从「文本」切到 JSON 之后就得重建编辑器才生效 ——
 * 虽然现在确实会重建，但把「生效与否」押在重建路径上太脆。
 */
const formatKeyHandler = EditorView.domEventHandlers({
  keydown: function (event) {
    if (props.language !== 'json') return false;
    if (!event.shiftKey || !event.altKey) return false;
    if (event.ctrlKey || event.metaKey) return false;
    if (event.code !== 'KeyF' && String(event.key).toLowerCase() !== 'f') return false;

    event.preventDefault();
    applyFormat();
    return true;
  }
});

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
  '&.cm-focused': { outline: 'none' },
  '.cm-placeholder-token': {
    color: '#623ce4',
    backgroundColor: 'rgba(98, 60, 228, 0.12)',
    borderRadius: '2px'
  },
  '@media (prefers-color-scheme: dark)': {
    '.cm-placeholder-token': {
      color: '#b39dff',
      backgroundColor: 'rgba(179, 157, 255, 0.16)'
    }
  }
});

/** 当前的扩展列表。reconfigure 要**整份**，所以抽成一个函数，别在两处各写一份 */
function buildExtensions() {
  const extensions = [
    basicSetup,
    theme,
    languageExtension(props.language),
    // 语法高亮用 class（tok-*），颜色在下面的样式里按亮 / 暗两套给（接近 Postman 的配色）
    syntaxHighlighting(classHighlighter),
    EditorState.readOnly.of(props.readonly),
    EditorView.editable.of(!props.readonly),
    EditorView.updateListener.of(function (update) {
      if (!update.docChanged || applying) return;
      emit('update:modelValue', update.state.doc.toString());
    })
  ];

  if (props.wrap) extensions.push(EditorView.lineWrapping);

  // GraphQL 的补全 / 校验 / 悬停（动态加载好的那份扩展）
  if (graphqlExtension) extensions.push(graphqlExtension);

  // 只有传了占位符才挂：请求区、脚本编辑器都不需要
  if (props.placeholders && props.placeholders.length) {
    extensions.push(placeholderDecorations);
    extensions.push(autocompletion({ override: [placeholderSource], activateOnTyping: true, icons: false }));
  }

  // 只有 JSON 才谈得上美化（XML / JS 的美化规则不一样，先不做）。
  // 一直挂着，语言在事件里判 —— 见 formatKeyHandler 的注释（审阅 N3）
  extensions.push(formatKeyHandler);

  return extensions;
}

function createView() {
  if (!host.value) return;

  view = new EditorView({
    parent: host.value,
    state: EditorState.create({
      doc: props.modelValue || '',
      extensions: buildExtensions()
    })
  });
}

onMounted(function () {
  createView();
  // GraphQL 的扩展是异步来的：加载好了就 reconfigure 上去
  reloadGraphql();
});

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
    // 切到 / 切出 GraphQL：补全扩展要跟着来或去掉
    reloadGraphql();
  }
);

// schema 换了（重新拉过、或者切到别的接口）：重建扩展，不动文档
watch(
  function () { return props.schema; },
  function () { reloadGraphql(); }
);

watch(
  function () { return props.readonly + '|' + props.wrap; },
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

/** 打开 CodeMirror 自带的查找面板（响应体工具栏的「搜索」按钮用） */
function openSearch() {
  if (!view) return;
  view.focus();
  openSearchPanel(view);
}

defineExpose({ insertAtCursor: insertAtCursor, format: applyFormat, openSearch: openSearch });
</script>

<template>
  <div ref="host" class="code-editor" :style="{ minHeight: minHeight }" />
</template>

<style>
/* 语法高亮配色（classHighlighter 的 tok-* 类）。不能 scoped：这些类是 CodeMirror 在运行时生成的节点 */
.code-editor .tok-propertyName { color: #1f2937; }
.code-editor .tok-string { color: #1a56c5; }
.code-editor .tok-number { color: #0b8a50; }
.code-editor .tok-bool,
.code-editor .tok-null,
.code-editor .tok-atom { color: #b5530f; }
.code-editor .tok-keyword { color: #8b2fc9; }
.code-editor .tok-comment { color: #8a8f98; font-style: italic; }
.code-editor .tok-typeName,
.code-editor .tok-className { color: #0f7f8a; }
.code-editor .tok-tagName { color: #b42318; }
.code-editor .tok-attributeName { color: #b5530f; }
.code-editor .tok-attributeValue { color: #1a56c5; }
.code-editor .tok-variableName.tok-definition { color: #1f4fbf; }
.code-editor .tok-punctuation,
.code-editor .tok-bracket { opacity: 0.75; }

@media (prefers-color-scheme: dark) {
  .code-editor .tok-propertyName { color: #e5e7eb; }
  .code-editor .tok-string { color: #7fb0ff; }
  .code-editor .tok-number { color: #6fd3a1; }
  .code-editor .tok-bool,
  .code-editor .tok-null,
  .code-editor .tok-atom { color: #f0a868; }
  .code-editor .tok-keyword { color: #d4a5ff; }
  .code-editor .tok-comment { color: #8b9099; }
  .code-editor .tok-typeName,
  .code-editor .tok-className { color: #6fd0da; }
  .code-editor .tok-tagName { color: #ff8b80; }
  .code-editor .tok-attributeName { color: #f0a868; }
  .code-editor .tok-attributeValue { color: #7fb0ff; }
  .code-editor .tok-variableName.tok-definition { color: #8ab4ff; }
}
</style>

<style scoped>
.code-editor {
  border: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.24));
  border-radius: 6px;
  overflow: hidden;
  height: 100%;
  box-sizing: border-box;
}
</style>
