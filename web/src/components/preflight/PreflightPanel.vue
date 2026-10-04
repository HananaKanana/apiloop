<script setup>
import { computed } from 'vue';
import { NCheckbox, NForm, NFormItem, NInput, NSelect, NTag } from 'naive-ui';
import {
  DEFAULT_MISSING_NAME,
  applySelect,
  describe,
  optionsFor,
  selectValueOf
} from '@/utils/preflight';

/**
 * 前置接口的设置块（第十轮第 3 节）。项目设置页和目录设置页共用这一个组件。
 *
 * 「前置接口」= 发送之前先自动调一遍的那个接口，通常就是登录接口：
 * token 过期时不用再手动点一次「登录」再回来发请求，测试集也不用每步都加一个登录步骤。
 *
 * 设置本身很轻：选哪个接口 + 两个触发条件。真正存 token 的动作在**前置接口自己**身上
 * （它的「断言」页签里提取变量，或者响应后脚本），所以下面那句说明不能省。
 */
const props = defineProps({
  modelValue: { type: Object, default: null },
  /** 可选的前置接口（目录树里的接口列表，`{ id, name, method }`） */
  apis: { type: Array, default: function () { return []; } },
  /** 目录上才有「跟随上层」：项目自己没有上层，那一项不出现 */
  allowInherit: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false }
});

const emit = defineEmits(['update:modelValue']);

const value = computed(function () { return props.modelValue || null; });
const options = computed(function () {
  return optionsFor(props.apis, { allowInherit: props.allowInherit });
});
const selected = computed(function () {
  return selectValueOf(props.modelValue, { allowInherit: props.allowInherit });
});
const summary = computed(function () {
  return describe(props.modelValue, props.apis, { allowInherit: props.allowInherit });
});
const target = computed(function () {
  return value.value && value.value.apiId ? value.value : null;
});

/** 选了「某个接口」之后才显示的两个条件 */
const missing = computed(function () { return (target.value && target.value.whenMissing) || ''; });

function replace(next) {
  emit('update:modelValue', next);
}

function patch(changes) {
  replace(Object.assign({}, value.value || {}, changes));
}

function onSelect(next) {
  replace(applySelect(next, props.modelValue, { allowInherit: props.allowInherit }));
}

function onMissingToggle(checked) {
  patch({ whenMissing: checked ? (missing.value || DEFAULT_MISSING_NAME) : '' });
}

function onMissingName(text) {
  patch({ whenMissing: String(text || '').trim() });
}
</script>

<template>
  <div class="preflight">
    <n-form label-placement="top">
      <n-form-item label="前置接口">
        <n-select
          :value="selected"
          :options="options"
          :disabled="disabled"
          placeholder="选一个接口（通常是登录接口）"
          @update:value="onSelect"
        />
      </n-form-item>
    </n-form>

    <template v-if="target">
      <div class="cond">
        <n-checkbox
          :checked="Boolean(missing)"
          :disabled="disabled"
          @update:checked="onMissingToggle"
        >
          变量
        </n-checkbox>
        <n-input
          size="small"
          class="name"
          :value="missing"
          :disabled="disabled"
          placeholder="token"
          @update:value="onMissingName"
        />
        <span class="cond-text">没有值时，先调用它</span>
      </div>

      <div class="cond">
        <n-checkbox
          :checked="target.retryOn401 === true"
          :disabled="disabled"
          @update:checked="(v) => patch({ retryOn401: v })"
        >
          响应是 401 时，自动调用后重发一次
        </n-checkbox>
      </div>

      <div class="summary">
        <n-tag size="small" :bordered="false">{{ summary }}</n-tag>
      </div>
    </template>

    <p v-if="!target" class="summary">
      <n-tag size="small" :bordered="false">{{ summary }}</n-tag>
    </p>

    <p class="tip">
      前置接口要自己把 token 存起来（在它的「断言」页签里提取变量，或者写响应后脚本）——
      这里只是「什么时候调它」。它自己不会再触发前置接口。
    </p>
  </div>
</template>

<style scoped>
.preflight {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.cond {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  flex-wrap: wrap;
}

.name {
  width: 160px;
  flex: none;
}

.cond-text {
  opacity: 0.75;
}

.summary {
  margin: 0;
}

.tip {
  margin: 2px 0 0;
  font-size: 12px;
  line-height: 1.6;
  opacity: 0.6;
}
</style>
