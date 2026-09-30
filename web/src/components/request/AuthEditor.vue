<script setup>
import { computed } from 'vue';
import { NAlert, NFormItem, NInput, NSelect, NSpace } from 'naive-ui';

/**
 * 鉴权编辑器。既给接口用，也给目录和项目用。
 *
 * 数据形状见契约：null 与 { type: 'inherit' } 都表示「沿用父级」。
 * 导入进来的 oauth2 / digest 这类不支持的鉴权，只读显示一句提示，不让人误以为它会生效。
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
  inheritHint: { type: String, default: '' }
});

const emit = defineEmits(['update:modelValue']);

const TYPE_OPTIONS = [
  { label: '继承父级', value: 'inherit' },
  { label: '无鉴权', value: 'noauth' },
  { label: 'Bearer Token', value: 'bearer' },
  { label: 'Basic Auth', value: 'basic' },
  { label: 'API Key', value: 'apikey' }
];

const API_KEY_IN_OPTIONS = [
  { label: '加到请求头', value: 'header' },
  { label: '加到查询参数', value: 'query' }
];

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
      导入的 {{ auth.type }} 鉴权暂不支持，发送时不生效。
    </n-alert>

    <template v-else>
      <n-form-item label="鉴权方式" :show-feedback="false">
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
          <n-input
            size="small"
            :value="auth.token || ''"
            :disabled="disabled"
            placeholder="支持 {{变量}}"
            @update:value="(v) => { patch({ token: v }); }"
          />
        </n-form-item>
      </template>

      <template v-else-if="currentType === 'basic'">
        <n-space vertical size="small" class="full">
          <n-form-item label="用户名" :show-feedback="false">
            <n-input
              size="small"
              :value="auth.username || ''"
              :disabled="disabled"
              @update:value="(v) => { patch({ username: v }); }"
            />
          </n-form-item>
          <n-form-item label="密码" :show-feedback="false">
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
            <n-input
              size="small"
              :value="auth.key || ''"
              :disabled="disabled"
              @update:value="(v) => { patch({ key: v }); }"
            />
          </n-form-item>
          <n-form-item label="Value" :show-feedback="false">
            <n-input
              size="small"
              :value="auth.value || ''"
              :disabled="disabled"
              @update:value="(v) => { patch({ value: v }); }"
            />
          </n-form-item>
          <n-form-item label="位置" :show-feedback="false">
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
        {{ inheritHint || '沿用上一级的鉴权设置。' }}
      </p>
      <p v-else class="hint">这个请求不携带鉴权信息。</p>
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
