<script setup>
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { typeDoc, typeIndex, rootTypes } from '@/utils/graphqlSchema';

/**
 * GraphQL 的「文档」面板（第七轮第 3 节）。
 *
 * 从 Query / Mutation / Subscription 开始一层层点进去看类型、字段、参数和说明。
 * 只做「看」这一件事 —— 不做成 GraphiQL 那样的全功能文档浏览器。
 *
 * **说明一律当纯文本**：`description` 是对方服务写的内容，用 `{{ }}` 输出，
 * 不解析 HTML（和评论那边同一条规矩）。
 */
const props = defineProps({
  /** introspection 的 `data`（含 `__schema`） */
  schema: { type: Object, default: null }
});

const { t } = useI18n();

/** 正在看的类型栈（空 = 根那一层）；点字段的类型会压进去，返回就弹出来 */
const stack = ref([]);

const index = computed(function () { return typeIndex(props.schema); });

const roots = computed(function () { return rootTypes(props.schema); });

const current = computed(function () {
  const names = stack.value;
  if (!names.length) return null;
  return typeDoc(index.value[names[names.length - 1]]);
});

const canBack = computed(function () { return stack.value.length > 0; });

function openType(name) {
  if (!name || !index.value[name]) return;
  stack.value = stack.value.concat([name]);
}

function openRoot(type) {
  if (type) stack.value = [type.name];
}

function back() {
  stack.value = stack.value.slice(0, -1);
}

// 换了一份 schema（重新拉过）：回到根那一层
watch(function () { return props.schema; }, function () { stack.value = []; });
</script>

<template>
  <div class="docs">
    <div class="head">
      <button v-if="canBack" class="back" @click="back">{{ t('request.docsBack') }}</button>
      <span class="title">{{ current ? current.name : t('request.docs') }}</span>
      <span v-if="current" class="kind">{{ current.kind }}</span>
    </div>

    <div class="body">
      <template v-if="current">
        <p v-if="current.description" class="desc">{{ current.description }}</p>

        <div v-for="field in current.fields" :key="field.name" class="field">
          <div class="line">
            <span class="name">{{ field.name }}</span>
            <span v-if="field.args.length" class="args">
              (<span v-for="(arg, index2) in field.args" :key="arg.name"><template v-if="index2">, </template>{{ arg.name }}: {{ arg.type }}</span>)
            </span>
            <span class="colon">:</span>
            <button class="type-link" @click="openType(field.typeName)">{{ field.type }}</button>
            <span v-if="field.deprecated" class="deprecated">{{ field.deprecated }}</span>
          </div>

          <p v-if="field.description" class="desc">{{ field.description }}</p>

          <div v-for="arg in field.args" :key="arg.name" class="arg">
            <span class="name">{{ arg.name }}</span>
            <span class="colon">:</span>
            <span class="type">{{ arg.type }}</span>
            <span v-if="arg.defaultValue" class="default">= {{ arg.defaultValue }}</span>
            <span v-if="arg.description" class="desc inline">{{ arg.description }}</span>
          </div>
        </div>

        <div v-if="current.enumValues.length" class="fields">
          <div v-for="value in current.enumValues" :key="value.name" class="field">
            <div class="line">
              <span class="name">{{ value.name }}</span>
            </div>
            <p v-if="value.description" class="desc">{{ value.description }}</p>
          </div>
        </div>

        <p v-if="!current.fields.length && !current.enumValues.length" class="empty">
          {{ t('request.docsEmptyType') }}
        </p>
      </template>

      <template v-else>
        <p class="hint">{{ t('request.docsHint') }}</p>
        <button v-for="root in roots" :key="root.key" class="root" @click="openRoot(root.type)">
          <span class="name">{{ root.label }}</span>
          <span class="root-type">{{ root.type.name }}</span>
        </button>
        <p v-if="!roots.length" class="empty">{{ t('request.docsNoQuery') }}</p>
      </template>
    </div>
  </div>
</template>

<style scoped>
.docs {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  border: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.24));
  border-radius: 6px;
  overflow: hidden;
}

.head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid rgba(128, 128, 128, 0.16);
  font-size: 12px;
}

.back {
  padding: 1px 6px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  font-size: 12px;
  cursor: pointer;
  opacity: 0.7;
}

.back:hover {
  opacity: 1;
  background: rgba(128, 128, 128, 0.14);
}

.title {
  font-weight: 600;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.kind {
  opacity: 0.45;
}

.body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 8px 10px;
  font-size: 12px;
}

.hint {
  margin: 0 0 8px;
  opacity: 0.55;
}

.root {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 5px 6px;
  margin-bottom: 4px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.root:hover {
  background: rgba(128, 128, 128, 0.12);
}

.root-type {
  opacity: 0.5;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.field {
  padding: 4px 0;
  border-bottom: 1px solid rgba(128, 128, 128, 0.1);
}

.field:last-child {
  border-bottom: none;
}

.line {
  display: flex;
  align-items: baseline;
  gap: 4px;
  flex-wrap: wrap;
}

.name {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-weight: 600;
}

.args {
  opacity: 0.6;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.colon {
  opacity: 0.45;
}

.type-link {
  padding: 0;
  border: none;
  background: transparent;
  color: var(--apiloop-primary);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  cursor: pointer;
}

.type-link:hover {
  text-decoration: underline;
}

.deprecated {
  padding: 0 4px;
  border-radius: 3px;
  background: rgba(208, 48, 80, 0.12);
  color: #d03050;
  font-size: 11px;
}

.desc {
  margin: 2px 0 0;
  line-height: 1.6;
  opacity: 0.7;
  white-space: pre-wrap;
}

.desc.inline {
  display: inline;
  margin-left: 6px;
}

.arg {
  display: flex;
  align-items: baseline;
  gap: 4px;
  flex-wrap: wrap;
  margin: 3px 0 0 12px;
  opacity: 0.85;
}

.type {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  opacity: 0.75;
}

.default {
  opacity: 0.55;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.empty {
  margin: 8px 0 0;
  opacity: 0.5;
}
</style>
