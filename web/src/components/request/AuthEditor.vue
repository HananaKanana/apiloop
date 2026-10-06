<script setup>
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { NAlert, NFormItem, NInput, NSelect, NSpace } from 'naive-ui';
import VarInput from '@/components/common/VarInput.vue';

/**
 * 鉴权编辑器。既给接口用，也给目录和项目用。
 *
 * 数据形状见契约：null 与 { type: 'inherit' } 都表示「沿用父级」。
 * 导入进来的 oauth2 / digest 这类不支持的鉴权，只读显示一句提示，不让人误以为它会生效。
 *
 * token / 用户名 / key / value 用 VarInput（`Bearer {{token}}` 这种写法很常见，
 * 要能高亮和补全）；**密码那一格仍然是普通的打码输入框** ——
 * CodeMirror 里没法做密码遮罩，为了一个基本不会写变量的字段牺牲遮罩不划算。
 */
const props = defineProps({
  modelValue: { type: Object, default: null },
  disabled: { type: Boolean, default: false },
  /**
   * 选了「继承父级」时下方显示的提示。调用方用 `utils/auth.js` 的 `inheritHint()`
   * 算出来（「继承自 目录「人员信息」：Bearer Token」这类），比只说一句
   * 「沿用上一级」有用得多 —— 用户不知道那个「上一级」到底配没配。
   * 传空串就用原来的通用文案。
   */
  inheritHint: { type: String, default: '' },
  /** resolveScope() 的结果，给变量高亮和补全用 */
  scope: { type: Map, default: null }
});

const emit = defineEmits(['update:modelValue']);

const { t } = useI18n();

const TYPE_OPTIONS = computed(function () {
  return [
    { label: t('request.authTypeInherit'), value: 'inherit' },
    { label: t('request.authTypeNoAuth'), value: 'noauth' },
    { label: 'Bearer Token', value: 'bearer' },
    { label: 'Basic Auth', value: 'basic' },
    { label: 'API Key', value: 'apikey' }
  ];
});

const API_KEY_IN_OPTIONS = computed(function () {
  return [
    { label: t('request.authKeyInHeader'), value: 'header' },
    { label: t('request.authKeyInQuery'), value: 'query' }
  ];
});

const unsupported = computed(function () {
  return Boolean(props.modelValue && props.modelValue.unsupported);
});

const currentType = computed(function () {
  const auth = props.modelValue;
  if (!auth || !auth.type) return 'inherit';
  return auth.type;
});

const auth = computed(function () {
  return props.modelValue || { type: 'inherit' };
});

function changeType(type) {
  if (type === 'inherit') return emit('update:modelValue', { type: 'inherit' });
  if (type === 'noauth') return emit('update:modelValue', { type: 'noauth' });
  if (type === 'bearer') return emit('update:modelValue', { type: 'bearer', token: '' });
  if (type === 'basic') {
    return emit('update:modelValue', { type: 'basic', username: '', password: '' });
  }
  if (type === 'apikey') {
    return emit('update:modelValue', { type: 'apikey', key: '', value: '', in: 'header' });
  }
}

function patch(fields) {
  emit('update:modelValue', Object.assign({}, props.modelValue, fields));
}
</script>

<template>
  <div class="auth-editor">
    <n-alert v-if="unsupported" type="warning" :show-icon="false">
      {{ t('request.authUnsupported', { type: auth.type }) }}
    </n-alert>

    <template v-else>
      <n-form-item :label="t('request.authType')" :show-feedback="false">
        <n-select
          :value="currentType"
          :options="TYPE_OPTIONS"
          size="small"
          :disabled="disabled"
          @update:value="changeType"
        />
      </n-form-item>

      <template v-if="currentType === 'bearer'">
        <n-form-item label="Token" :show-feedback="false">
          <var-input
            :model-value="auth.token || ''"
            :readonly="disabled"
            :scope="scope"
            :placeholder="t('request.authVarHint')"
            @update:model-value="(v) => { patch({ token: v }); }"
          />
        </n-form-item>
      </template>

      <template v-else-if="currentType === 'basic'">
        <n-space vertical size="small" class="full">
          <n-form-item :label="t('request.authUsername')" :show-feedback="false">
            <var-input
              :model-value="auth.username || ''"
              :readonly="disabled"
              :scope="scope"
              @update:model-value="(v) => { patch({ username: v }); }"
            />
          </n-form-item>
          <n-form-item :label="t('request.authPassword')" :show-feedback="false">
            <n-input
              size="small"
              type="password"
              show-password-on="click"
              :value="auth.password || ''"
              :disabled="disabled"
              @update:value="(v) => { patch({ password: v }); }"
            />
          </n-form-item>
        </n-space>
      </template>

      <template v-else-if="currentType === 'apikey'">
        <n-space vertical size="small" class="full">
          <n-form-item label="Key" :show-feedback="false">
            <var-input
              :model-value="auth.key || ''"
              :readonly="disabled"
              :scope="scope"
              @update:model-value="(v) => { patch({ key: v }); }"
            />
          </n-form-item>
          <n-form-item label="Value" :show-feedback="false">
            <var-input
              :model-value="auth.value || ''"
              :readonly="disabled"
              :scope="scope"
              @update:model-value="(v) => { patch({ value: v }); }"
            />
          </n-form-item>
          <n-form-item :label="t('request.authInPosition')" :show-feedback="false">
            <n-select
              size="small"
              :value="auth.in === 'query' ? 'query' : 'header'"
              :options="API_KEY_IN_OPTIONS"
              :disabled="disabled"
              @update:value="(v) => { patch({ in: v }); }"
            />
          </n-form-item>
        </n-space>
      </template>

      <p v-else-if="currentType === 'inherit'" class="hint">
        {{ inheritHint || t('request.authInheritHint') }}
      </p>
      <p v-else class="hint">{{ t('request.authNoAuthHint') }}</p>
    </template>
  </div>
</template>

<style scoped>
.auth-editor {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.full {
  width: 100%;
}

.hint {
  margin: 0;
  font-size: 12px;
  opacity: 0.6;
}
</style>
