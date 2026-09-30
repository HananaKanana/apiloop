<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { NInput } from 'naive-ui';
import {
  Decoration,
  EditorView,
  hoverTooltip,
  keymap,
  placeholder as placeholderExt
} from '@codemirror/view';
import { EditorState, StateEffect, StateField } from '@codemirror/state';
import { autocompletion, completionStatus } from '@codemirror/autocomplete';
import { history, historyKeymap, defaultKeymap, standardKeymap } from '@codemirror/commands';
import { findVariables } from '@/utils/variables';
import { BARE_INPUT_THEME } from '@/utils/bareInput';

/**
 * 带 `{{变量}}` 高亮 / 补全 / 悬停提示的**单行**输入框。
 *
 * 外观照着 naive-ui 的小号输入框做，所以能直接换掉原来的 `n-input` 而不动布局。
 *
 * 几条要守住的行为（审阅重点第 1 条）：
 * - 只允许一行：粘贴带换行的内容时，换行直接去掉；
 * - 补全列表开着时，回车是「选中补全项」，**不发送**；列表没开才把回车交给父组件；
 * - 中文输入法组字过程中，回车既不发送也不选中；
 * - 没传 `scope` 时退化成普通输入框 —— 调用方没给作用域（比如响应头表格），
 *   就不该去猜哪个变量「未定义」，也不该挂一个 CodeMirror 上去。
 */
const props = defineProps({
  modelValue: { type: String, default: '' },
  placeholder: { type: String, default: '' },
  readonly: { type: Boolean, default: false },
  /** `resolveScope()` 的结果；不传就用普通输入框 */
  scope: { type: Map, default: null },
  /** 不要自己的边框（地址栏把它和方法的框合成一个整体时用） */
  borderless: { type: Boolean, default: false },
  /**
   * 表格格子里的样式：边框、底色、内边距全去掉，直接坐在格子上。
   * 聚焦时的底色由格子的 `:focus-within` 负责，所以这里也不再画聚焦边框。
   */
  bare: { type: Boolean, default: false },
  /**
   * 普通单词的补全（请求头名字、Content-Type 的值这类），和 `{{变量}}` 的补全是两套：
   * 这个不看 `{{`，输入任意前缀就提示。
   */
  suggest: { type: Array, default: null },
  /** 补全列表里值预览最多显示多少个字符 */
  previewLimit: { type: Number, default: 30 }
});

const emit = defineEmits(['update:modelValue', 'enter']);

const host = ref(null);
const focused = ref(false);

const hasScope = computed(function () {
  return props.scope instanceof Map;
});

/**
 * 表格里几十行的时候，每一格都挂一个 CodeMirror 是浪费（实测 41 行要 179ms 才渲染完）。
 * 只给「正在编辑」或者「值里已经有 `{{`」的格子挂，其余仍然是普通输入框。
 * 一旦挂上就一直用编辑器，避免清空内容时又换回输入框、把焦点弄丢。
 */
const editing = ref(false);

const hasToken = computed(function () {
  return String(props.modelValue || '').indexOf('{{') !== -1;
});

/** 有单词补全候选（请求头名字那种）时必须上编辑器，不然补全根本出不来 */
const hasSuggest = computed(function () {
  return Array.isArray(props.suggest) && props.suggest.length > 0;
});

const useEditor = computed(function () {
  if (hasSuggest.value) return true;
  return hasScope.value && (editing.value || hasToken.value);
});

/** 从普通输入框切到编辑器时，创建完要把焦点接过去 */
let pendingFocus = false;

/** 编辑器扩展是建一次就一直用的，作用域随时会变，所以放在这个盒子里给它读 */
const scopeRef = { current: new Map() };

let view = null;
let applying = false;

/* ---------------- 高亮 ---------------- */

const refreshEffect = StateEffect.define();

function currentScope() {
  return scopeRef.current instanceof Map ? scopeRef.current : new Map();
}

function decorate(state) {
  const known = currentScope();
  const ranges = [];

  findVariables(state.doc.toString()).forEach(function (item) {
    let cls = 'cm-var-mock';
    if (item.kind === 'var') cls = known.has(item.name) ? 'cm-var-ok' : 'cm-var-missing';
    ranges.push(Decoration.mark({ class: cls }).range(item.from, item.to));
  });

  return Decoration.set(ranges, true);
}

const highlightField = StateField.define({
  create: decorate,
  update: function (deco, tr) {
    if (tr.docChanged || tr.effects.some(function (effect) { return effect.is(refreshEffect); })) {
      return decorate(tr.state);
    }
    return deco;
  },
  provide: function (field) { return EditorView.decorations.from(field); }
});

/* ---------------- 补全 ---------------- */

function valuePreview(entry) {
  if (!entry) return '';
  if (entry.secret) return '••••';
  const value = String(entry.value === undefined || entry.value === null ? '' : entry.value);
  return value.length > props.previewLimit ? value.slice(0, props.previewLimit) + '…' : value;
}

/** 环境 > 目录 > 项目：生效的那一级排前面 */
function sourceRank(source) {
  const text = String(source || '');
  if (text.indexOf('环境') === 0) return 2;
  if (text.indexOf('目录') === 0) return 1;
  return 0;
}

function completionOptions() {
  const list = [];
  currentScope().forEach(function (entry, name) {
    list.push({
      label: name,
      detail: valuePreview(entry),
      info: entry.source,
      boost: sourceRank(entry.source),
      // 不挂 apply 的话，组件库只把名字插进去，补出来是 `{{name`（少一对花括号）
      apply: applyCompletion
    });
  });
  return list;
}

/**
 * 只在「正在输入 `{{...`」时给补全。
 * 过滤和排序自己做（`filter: false`），这样「前缀匹配优先、其次包含匹配」
 * 这条要求是写死的，不依赖组件库默认的评分。
 */
function completionSource(context) {
  const before = context.matchBefore(/\{\{[^{}]*$/);
  if (!before) return null;

  const typed = before.text.slice(2).toLowerCase();
  const matched = completionOptions().filter(function (option) {
    return option.label.toLowerCase().indexOf(typed) !== -1;
  });

  matched.sort(function (a, b) {
    const prefixA = a.label.toLowerCase().indexOf(typed) === 0 ? 0 : 1;
    const prefixB = b.label.toLowerCase().indexOf(typed) === 0 ? 0 : 1;
    if (prefixA !== prefixB) return prefixA - prefixB;
    return (b.boost || 0) - (a.boost || 0);
  });

  return {
    from: before.from + 2,
    options: matched,
    filter: false,
    validFor: /^[^{}]*$/
  };
}

/**
 * 普通单词的补全（`suggest` 传进来的那批）。和变量补全是两套，互不干扰：
 * 这个只要输入了词就提示，不看 `{{`。
 */
function suggestSource(context) {
  const list = props.suggest || [];
  if (!list.length) return null;

  const word = context.matchBefore(/[\w-]*/);
  if (!word) return null;
  // 光标没动、也不是手动触发的，就别弹（免得一点进格子就冒出来）
  if (word.from === word.to && !context.explicit) return null;

  const typed = word.text.toLowerCase();
  const matched = list.filter(function (item) {
    return item.label.toLowerCase().indexOf(typed) !== -1;
  });

  matched.sort(function (a, b) {
    const prefixA = a.label.toLowerCase().indexOf(typed) === 0 ? 0 : 1;
    const prefixB = b.label.toLowerCase().indexOf(typed) === 0 ? 0 : 1;
    return prefixA - prefixB;
  });

  return {
    from: word.from,
    options: matched,
    filter: false,
    validFor: /^[\w-]*$/
  };
}

/** 选中之后补成 `{{name}}`；光标后面已经有 `}}` 就不再补一对 */
function applyCompletion(target, completion, from, to) {
  const after = target.state.sliceDoc(to, Math.min(to + 2, target.state.doc.length));
  const insert = completion.label + (after === '}}' ? '' : '}}');

  target.dispatch({
    changes: { from: from, to: to, insert: insert },
    selection: { anchor: from + insert.length }
  });
  target.focus();
}

/* ---------------- 悬停提示 ---------------- */

function tooltipDom(text) {
  const dom = document.createElement('div');
  dom.className = 'var-tip';
  dom.textContent = text;
  return dom;
}

const variableTooltip = hoverTooltip(function (editorView, pos) {
  const item = findVariables(editorView.state.doc.toString()).find(function (found) {
    return pos >= found.from && pos <= found.to;
  });
  if (!item) return null;

  let content;
  if (item.kind === 'mock') {
    content = '{{@' + item.name + '}}：mock 占位符，只在 mock 渲染时展开';
  } else {
    const entry = currentScope().get(item.name);
    content = entry
      ? (entry.secret ? '••••' : String(entry.value || '')) + ' · ' + entry.source
      : '未定义 —— 在环境、目录或项目变量里添加';
  }

  return {
    pos: item.from,
    end: item.to,
    above: true,
    create: function () { return { dom: tooltipDom(content) }; }
  };
});

/* ---------------- 单行 / 回车 ---------------- */

const singleLine = EditorState.transactionFilter.of(function (tr) {
  if (!tr.docChanged) return tr;
  const lines = tr.newDoc.text;
  if (lines.length <= 1) return tr;
  // 粘贴进来带换行的内容：直接拼成一行
  return [tr, { changes: { from: 0, to: tr.newDoc.length, insert: lines.join('') } }];
});

const enterKey = keymap.of([
  {
    key: 'Enter',
    run: function (editorView) {
      // 补全列表开着：这一下回车是「选中补全项」，交回给补全插件
      if (completionStatus(editorView.state) === 'active') return false;
      // 中文输入法组字中：回车是在确认候选词，既不发送也不吃掉
      if (editorView.composing) return true;
      emit('enter');
      return true;
    }
  },
  // 光标移动、选中（Cmd+A）、撤销（Cmd+Z）这些照旧交给 CodeMirror 自己。
  // 没挂 history 的话 Cmd+Z 是没反应的，所以这两个 keymap 必须带上。
  ...historyKeymap,
  ...defaultKeymap,
  ...standardKeymap
]);

/* ---------------- 主题（照着 n-input small 做） ---------------- */

/*
 * 变量颜色（2026-09-30 随主色改成 Postman 橙一起调整）：已定义的用蓝色 ——
 * 原来的绿色和 GET 标签、以及当时的绿色主色撞在一起，页面上一片绿分不清层次；
 * 现在主色是橙，POST 标签也是橙，所以变量不能用橙，蓝色和两者都拉得开。
 */
const VAR_COLORS = {
  '.cm-var-ok': { color: '#1d4ed8', backgroundColor: 'rgba(29, 78, 216, 0.10)', borderRadius: '2px' },
  '.cm-var-missing': { color: '#dc2626', backgroundColor: 'rgba(220, 38, 38, 0.10)', borderRadius: '2px' },
  '.cm-var-mock': { color: '#7c3aed', backgroundColor: 'rgba(124, 58, 237, 0.10)', borderRadius: '2px' }
};

const DARK_VAR_COLORS = {
  '.cm-var-ok': { color: '#93c5fd', backgroundColor: 'rgba(147, 197, 253, 0.16)' },
  '.cm-var-missing': { color: '#fca5a5', backgroundColor: 'rgba(252, 165, 165, 0.16)' },
  '.cm-var-mock': { color: '#c4b5fd', backgroundColor: 'rgba(196, 181, 253, 0.16)' }
};

const theme = EditorView.theme(Object.assign({
  '&': {
    fontSize: '13px',
    color: 'inherit',
    backgroundColor: 'transparent'
  },
  '.cm-content': {
    padding: '0',
    fontFamily: 'inherit',
    caretColor: 'var(--n-text-color, currentColor)'
  },
  '.cm-line': { padding: '0' },
  '.cm-scroller': { fontFamily: 'inherit', lineHeight: '20px', overflow: 'hidden' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'currentColor' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
    backgroundColor: 'rgba(32, 128, 240, 0.25)'
  },
  '.cm-tooltip': {
    border: '1px solid var(--n-border-color, rgba(128, 128, 128, 0.24))',
    borderRadius: '4px',
    fontSize: '12px',
    padding: '2px 4px'
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': { maxHeight: '220px', fontFamily: 'inherit' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': { padding: '2px 6px' },
  '.cm-completionDetail': { fontStyle: 'normal', opacity: '0.6', marginLeft: '8px' },
  '.cm-completionInfo': { padding: '4px 8px' },
  '.var-tip': { padding: '4px 8px', maxWidth: '320px', wordBreak: 'break-all' }
}, VAR_COLORS, {
  // 暗色主题：亮一档，别用只在白底上好看的颜色
  '@media (prefers-color-scheme: dark)': DARK_VAR_COLORS
}), { dark: false });

/* ---------------- 生命周期 ---------------- */

function createView() {
  if (!host.value || view) return;

  view = new EditorView({
    parent: host.value,
    state: EditorState.create({
      doc: props.modelValue || '',
      extensions: [
        singleLine,
        // 撤销要能用（审阅重点第 1 条）：CodeMirror 的撤销来自 history()
        history(),
        highlightField,
        EditorView.lineWrapping,
        placeholderExt(props.placeholder || ''),
        EditorState.readOnly.of(props.readonly),
        EditorView.editable.of(!props.readonly),
        autocompletion({
          override: [completionSource, suggestSource],
          activateOnTyping: true,
          closeOnBlur: true,
          icons: false,
          // 自己过滤，见上面两个 source
          defaultKeymap: true
        }),
        variableTooltip,
        enterKey,
        theme,
        EditorView.updateListener.of(function (update) {
          if (update.docChanged && !applying) {
            emit('update:modelValue', update.state.doc.toString());
          }
          if (update.focusChanged) focused.value = update.view.hasFocus;
        })
      ]
    })
  });

  // 挂上编辑器就一直用它，别再换回普通输入框
  editing.value = true;

  if (pendingFocus) {
    pendingFocus = false;
    view.focus();
    view.dispatch({ selection: { anchor: view.state.doc.length } });
  }
}

/** 普通输入框拿到焦点：换成编辑器（用户点进来的第一下，不会丢字） */
function onPlainFocus() {
  pendingFocus = true;
  editing.value = true;
}

onMounted(function () {
  scopeRef.current = props.scope instanceof Map ? props.scope : new Map();
  if (useEditor.value) createView();
});

onBeforeUnmount(function () {
  if (view) {
    view.destroy();
    view = null;
  }
});

watch(useEditor, async function (value) {
  if (!value) {
    if (view) {
      view.destroy();
      view = null;
    }
    return;
  }
  await nextTick();
  createView();
});

watch(
  function () { return props.scope; },
  function (value) {
    scopeRef.current = value instanceof Map ? value : new Map();
    // 作用域变了，已经画好的高亮要按新的「已定义 / 未定义」重算
    if (view) view.dispatch({ effects: refreshEffect.of(null) });
  }
);

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
  function () { return props.readonly; },
  function () {
    if (view) view.destroy();
    view = null;
    createView();
  }
);

/** 给外面（比如「去环境管理」之后想聚焦回来）用 */
function focus() {
  if (view) view.focus();
}

defineExpose({ focus: focus });
</script>

<template>
  <div
    v-if="useEditor"
    ref="host"
    class="var-input"
    :class="{ focused: focused, readonly: readonly, borderless: borderless, bare: bare }"
  />

  <!-- 没给作用域、或者这一格还用不着编辑器：普通输入框 -->
  <n-input
    v-else
    size="small"
    :value="modelValue"
    :placeholder="placeholder"
    :readonly="readonly"
    :bordered="!borderless && !bare"
    :theme-overrides="bare ? BARE_INPUT_THEME : undefined"
    @focus="onPlainFocus"
    @update:value="(v) => emit('update:modelValue', v)"
    @keyup.enter="emit('enter')"
  />
</template>

<style scoped>
/* 外观照着 naive-ui 的小号输入框，这样换掉 n-input 不会动到布局 */
.var-input {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  width: 100%;
  min-height: 28px;
  padding: 0 10px;
  border: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.4));
  border-radius: 3px;
  background-color: var(--n-color, transparent);
  transition: border-color 0.3s var(--n-bezier, ease-in-out);
}

.var-input.focused {
  border-color: var(--apiloop-primary);
}

.var-input.readonly {
  opacity: 0.6;
  cursor: not-allowed;
}

/* 外面已经有框了（地址栏那种合成整体），自己就不要再画一个 */
.var-input.borderless {
  border: none;
  padding: 0;
  min-height: 26px;
}

/* 表格格子：边框、底色、内边距全不要，直接坐在格子上 */
.var-input.bare {
  border: none;
  padding: 0;
  min-height: 28px;
  background-color: transparent;
}

.var-input.bare.focused {
  border-color: transparent;
}


.var-input :deep(.cm-editor) {
  width: 100%;
}
</style>
