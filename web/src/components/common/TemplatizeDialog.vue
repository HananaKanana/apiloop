<script setup>
import { computed, ref, watch } from 'vue';
import { NAlert, NButton, NModal, NSpace, NSpin } from 'naive-ui';
import * as templatizeApi from '@/api/templatize';

/**
 * 智能模板化的「先看清单、再确认」弹窗。
 *
 * 打开时调一次 /templatize（纯计算，不写库），把替换清单摆出来；用户点了确认才
 * emit 出模板化后的 body。**绝不自己改写调用方的数据** —— 覆盖响应体这件事必须由
 * 用户点一下确认，这是这个流程存在的全部意义。
 *
 * 服务端说 skipped（不是合法 JSON、或者换完解析不过）时照样把原文 emit 出去，
 * 由调用方决定「按原文保存」还是「什么都不做」，并在界面上说清原因。
 */
const props = defineProps({
  show: { type: Boolean, default: false },
  /** 要模板化的 JSON 文本 */
  body: { type: String, default: '' }
});

const emit = defineEmits(['update:show', 'confirm']);

const loading = ref(false);
const errorText = ref('');
const result = ref(null);

const replacements = computed(function () {
  return (result.value && result.value.replacements) || [];
});

const skipped = computed(function () {
  return (result.value && result.value.skipped) || '';
});

const canConfirm = computed(function () {
  return Boolean(result.value) && !loading.value && !errorText.value;
});

async function run() {
  loading.value = true;
  errorText.value = '';
  result.value = null;

  try {
    result.value = await templatizeApi.templatize(props.body);
  } catch (err) {
    errorText.value = err.message;
  } finally {
    loading.value = false;
  }
}

watch(
  function () { return props.show; },
  function (visible) {
    if (visible) run();
    else {
      result.value = null;
      errorText.value = '';
    }
  },
  { immediate: true }
);

function close() {
  emit('update:show', false);
}

function confirm() {
  if (!canConfirm.value) return;
  emit('confirm', {
    body: result.value.body,
    replacements: replacements.value,
    skipped: skipped.value
  });
  close();
}
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    title="智能模板化"
    style="width: 640px; max-width: 94vw"
    @update:show="emit('update:show', $event)"
  >
    <div class="templatize">
      <n-spin :show="loading">
        <n-alert v-if="errorText" type="error" :show-icon="false" class="notice">
          {{ errorText }}
        </n-alert>

        <template v-else-if="result">
          <n-alert v-if="skipped" type="warning" :show-icon="false" class="notice">
            {{ skipped }}
          </n-alert>

          <template v-else-if="!replacements.length">
            <n-alert type="info" :show-icon="false" class="notice">
              没有找到可以随机化的值，内容保持不变。
            </n-alert>
          </template>

          <template v-else>
            <p class="tip">
              下面这些值会被换成每次随机的占位符，结构和字段类型不变。确认后才会生效。
            </p>
            <div class="table">
              <div class="row head">
                <span class="cell path">路径</span>
                <span class="cell from">原值</span>
                <span class="cell ph">占位符</span>
              </div>
              <div v-for="(item, index) in replacements" :key="index" class="row">
                <span class="cell path" :title="item.path">{{ item.path }}</span>
                <span class="cell from" :title="item.from">{{ item.from }}</span>
                <span class="cell ph">{{ item.placeholder }}</span>
              </div>
            </div>
            <p class="tip">共 {{ replacements.length }} 处替换。</p>
          </template>
        </template>
      </n-spin>
    </div>

    <template #footer>
      <n-space justify="end">
        <n-button @click="close">取消</n-button>
        <n-button type="primary" :disabled="!canConfirm" :loading="loading" @click="confirm">
          确认替换
        </n-button>
      </n-space>
    </template>
  </n-modal>
</template>

<style scoped>
.templatize {
  min-height: 80px;
}

.notice {
  font-size: 12px;
}

.tip {
  margin: 0 0 8px;
  font-size: 12px;
  opacity: 0.65;
  line-height: 1.6;
}

.table {
  max-height: 44vh;
  overflow: auto;
  border: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.24));
  border-radius: 6px;
  font-size: 12px;
  margin-bottom: 8px;
}

.row {
  display: flex;
  gap: 8px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.16));
}

.row:last-child {
  border-bottom: none;
}

.row.head {
  font-weight: 600;
  opacity: 0.7;
  background: rgba(128, 128, 128, 0.08);
}

.cell {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.cell.path {
  flex: 1.4;
  min-width: 0;
}

.cell.from {
  flex: 1;
  min-width: 0;
  opacity: 0.75;
}

.cell.ph {
  flex: none;
  width: 150px;
  color: #2080f0;
}
</style>
