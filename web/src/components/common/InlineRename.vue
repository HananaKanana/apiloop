<script setup>
import { nextTick, ref } from 'vue';
import { useI18n } from 'vue-i18n';

/**
 * 双击改名（参考 Postman）：平时是一段文字，双击变成同样大小的输入框、文字全选。
 * 回车或失焦提交，Esc 取消；去掉首尾空格后为空、或者和原来一样，直接退出、不提交。
 *
 * 这个组件只管「编辑」这件事，不知道要改的是接口还是目录：提交时 emit `commit(新名字)`，
 * 由父组件去保存。保存失败时父组件不改 `value`，这里显示的自然就还是原名。
 */
const props = defineProps({
  value: { type: String, default: '' },
  /** 只读成员不能改：不给悬停底色，双击也没反应 */
  editable: { type: Boolean, default: true },
  placeholder: { type: String, default: '' }
});

const emit = defineEmits(['commit']);

const { t } = useI18n();

const editing = ref(false);
const draft = ref('');
const inputRef = ref(null);

async function start() {
  if (!props.editable || editing.value) return;
  draft.value = props.value;
  editing.value = true;
  await nextTick();
  if (inputRef.value) {
    inputRef.value.focus();
    inputRef.value.select();
  }
}

function finish(commit) {
  if (!editing.value) return;
  editing.value = false;
  if (!commit) return;

  const name = String(draft.value || '').trim();
  if (!name || name === props.value) return;
  emit('commit', name);
}

function onKeydown(event) {
  // 输入法组字中的回车是在选字，不是提交
  if (event.isComposing) return;
  if (event.key === 'Enter') {
    event.preventDefault();
    finish(true);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    finish(false);
  }
}
</script>

<template>
  <input
    v-if="editing"
    ref="inputRef"
    v-model="draft"
    class="inline-rename-input"
    :placeholder="placeholder"
    @keydown="onKeydown"
    @blur="finish(true)"
  />
  <span
    v-else
    class="inline-rename"
    :class="{ editable: editable }"
    :title="editable ? t('common.renameHint') : ''"
    @dblclick="start"
  >{{ value || placeholder }}</span>
</template>

<style scoped>
.inline-rename {
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: bottom;
  padding: 1px 4px;
  border: 1px solid transparent;
  border-radius: 4px;
}

.inline-rename.editable {
  cursor: text;
}

.inline-rename.editable:hover {
  background: rgba(128, 128, 128, 0.14);
}

/* 和文字一样大，看起来是「原地变成可编辑」，而不是弹出一个表单 */
.inline-rename-input {
  font: inherit;
  color: inherit;
  min-width: 120px;
  max-width: 320px;
  padding: 1px 4px;
  border: 1px solid var(--apiloop-primary, #ff6c37);
  border-radius: 4px;
  outline: none;
  background: transparent;
}
</style>
