<script setup>
import { computed, ref, watch } from 'vue';
import { NButton, NInput, NModal, NRadio, NRadioGroup, NSpace, useMessage } from 'naive-ui';
import * as sharesApi from '@/api/shares';
import { copyText } from '@/utils/clipboard';
import { shareUrl } from '@/utils/share';

/**
 * 「生成分享链接」弹窗（第 4 节）。
 *
 * 只负责**生成**：链接生成之后要不要撤销，去项目设置页的「分享链接」区域。
 * 生成是立刻生效的（服务端建了那一行），所以弹窗直接关掉也不会「白生成」——
 * 用户下次在项目设置里还能看到这条链接。
 *
 * 未登录时这两个入口本来就不显示（分享依赖云端，见 ApiTree），这里不再判一次。
 */
const props = defineProps({
  show: { type: Boolean, default: false },
  /** 当前项目 id */
  pid: { type: String, default: '' },
  /** 空 = 整个项目 */
  folderId: { type: String, default: null },
  /** 分享范围的名字（目录名 / 项目名），只用来显示 */
  scopeName: { type: String, default: '' }
});

const emit = defineEmits(['update:show']);

const message = useMessage();

/** 有效期三档。'never' 是「永久」，发给服务端时转成 null */
const expiresInDays = ref('30');
const creating = ref(false);
const errorText = ref('');
/** 生成出来的那一条（生成之后弹窗下半截换成链接） */
const created = ref(null);

const title = computed(function () {
  return props.folderId ? '分享目录「' + props.scopeName + '」的文档' : '分享整个项目的文档';
});

const link = computed(function () {
  return created.value ? shareUrl(created.value.id) : '';
});

// 每次打开都重置：上一次生成的链接和报错不该带到下一次
watch(
  function () { return props.show; },
  function (value) {
    if (!value) return;
    expiresInDays.value = '30';
    creating.value = false;
    errorText.value = '';
    created.value = null;
  }
);

async function generate() {
  if (!props.pid) return;

  creating.value = true;
  errorText.value = '';
  try {
    const data = await sharesApi.createShare(props.pid, {
      folderId: props.folderId || null,
      expiresInDays: expiresInDays.value === 'never' ? null : Number(expiresInDays.value)
    });
    created.value = data.share;
  } catch (err) {
    errorText.value = err.message;
  } finally {
    creating.value = false;
  }
}

async function copy() {
  try {
    await copyText(link.value);
    message.success('链接已复制');
  } catch (err) {
    message.error(err.message);
  }
}

function close() {
  emit('update:show', false);
}
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    :title="title"
    style="width: 520px; max-width: 92vw"
    @update:show="(value) => emit('update:show', value)"
  >
    <div v-if="!created" class="form">
      <div class="field">
        <span class="label">有效期</span>
        <n-radio-group v-model:value="expiresInDays" size="small">
          <n-space :size="14">
            <n-radio value="30">30 天</n-radio>
            <n-radio value="7">7 天</n-radio>
            <n-radio value="never">永久</n-radio>
          </n-space>
        </n-radio-group>
      </div>

      <div v-if="errorText" class="error">{{ errorText }}</div>

      <n-button type="primary" size="small" :loading="creating" @click="generate">
        生成链接
      </n-button>
    </div>

    <div v-else class="result">
      <div class="link-row">
        <n-input :value="link" readonly size="small" />
        <n-button size="small" type="primary" @click="copy">复制</n-button>
      </div>
      <p class="hint">
        这条链接已经生效，也可以在「项目设置 → 分享链接」里撤销。
      </p>
    </div>

    <p class="tip">
      打开链接的人不用登录就能看到这些接口的地址、参数和示例。保密变量和鉴权信息不会出现。
      分享的是云端的数据，本机还没同步上去的改动看不到。
    </p>
  </n-modal>
</template>

<style scoped>
.form {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 14px;
}

.field {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
}

.field .label {
  opacity: 0.65;
}

.error {
  font-size: 12px;
  color: #d03050;
}

.result {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.link-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.hint {
  margin: 0;
  font-size: 12px;
  opacity: 0.6;
}

.tip {
  margin: 14px 0 0;
  font-size: 12px;
  line-height: 1.7;
  opacity: 0.6;
}
</style>
