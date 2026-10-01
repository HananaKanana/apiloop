<script setup>
import { computed, ref } from 'vue';
import {
  NButton,
  NDropdown,
  NForm,
  NFormItem,
  NInput,
  NModal,
  NSpace,
  NTooltip,
  useMessage
} from 'naive-ui';
import * as gatewayApi from '@/api/gateway';
import { useGatewayStore } from '@/stores/gateway';

/**
 * 顶栏右侧的连接状态：一个小圆点 + 一句话，点开可以改云端地址。
 *
 * 三种形态（契约「依赖的服务端接口」）：
 * - 网关上、云端连得上 → 绿点「本机发送」；
 * - 网关上、云端连不上 → 红点「云端连不上」；
 * - 直接打开云端 → 灰点「云端发送」。
 *
 * 直接打开云端、而且云端不发送请求（`serverSend` 为 false）时整块不显示 ——
 * 那种情况下发送按钮已经变灰并给了说明，这里再说一遍是噪音。
 */
const gateway = useGatewayStore();
const message = useMessage();

const showDialog = ref(false);
const cloudUrlInput = ref('');
const saving = ref(false);

const indicator = computed(function () {
  if (gateway.isGateway) {
    const reachable = Boolean(gateway.status && gateway.status.cloudReachable);
    if (reachable) {
      return {
        color: '#0cbb52',
        text: '本机发送',
        hint: '请求从这台电脑发出；数据保存在 ' + (gateway.cloudUrl || '云端')
      };
    }
    return {
      color: '#eb2013',
      text: '云端连不上',
      hint: gateway.cloudUrl
        ? '连不上 ' + gateway.cloudUrl + '。点这里改云端地址'
        : '还没设置云端地址。点这里设置'
    };
  }

  return {
    color: '#6b7280',
    text: '云端发送',
    hint: '请求从云端服务器发出，访问不了你电脑上和内网的地址。安装本机的 apiloop 后可以从本机发送'
  };
});

/** 只有一个菜单项。以后要加「重新连接」之类的再往这里放 */
const menuOptions = [{ label: '云端地址…', key: 'cloud-url' }];

function onMenuSelect(key) {
  if (key === 'cloud-url') openDialog();
}

function openDialog() {
  cloudUrlInput.value = gateway.cloudUrl;
  showDialog.value = true;
}

async function save() {
  saving.value = true;
  try {
    await gatewayApi.setup(cloudUrlInput.value.trim());
    // 云端地址一改，网关后面的转发目标就全变了，整页刷新最干净
    window.location.reload();
  } catch (err) {
    message.error(err.message);
    saving.value = false;
  }
}
</script>

<template>
  <n-dropdown
    v-if="gateway.showIndicator"
    :options="menuOptions"
    trigger="click"
    :disabled="!gateway.isGateway"
    @select="onMenuSelect"
  >
    <n-tooltip trigger="hover">
      <template #trigger>
        <button class="conn" :class="{ clickable: gateway.isGateway }" type="button">
          <span class="dot" :style="{ background: indicator.color }" />
          <span class="text">{{ indicator.text }}</span>
        </button>
      </template>
      {{ indicator.hint }}
    </n-tooltip>
  </n-dropdown>

  <n-modal
    v-model:show="showDialog"
    preset="card"
    title="云端地址"
    style="width: 460px; max-width: 92vw"
  >
    <n-form>
      <n-form-item label="云端地址" :show-feedback="false">
        <n-input
          v-model:value="cloudUrlInput"
          placeholder="https://apiloop.example.com"
          @keyup.enter="save"
        />
      </n-form-item>
    </n-form>
    <p class="hint">
      改完之后页面会刷新。请求仍然从这台电脑发出，只是数据存到新的云端。
    </p>

    <template #footer>
      <n-space justify="end">
        <n-button @click="showDialog = false">取消</n-button>
        <n-button type="primary" :loading="saving" @click="save">保存</n-button>
      </n-space>
    </template>
  </n-modal>
</template>

<style scoped>
.conn {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 8px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: inherit;
  font-size: 12px;
  cursor: default;
  white-space: nowrap;
}

.conn.clickable {
  cursor: pointer;
}

.conn.clickable:hover {
  background: rgba(128, 128, 128, 0.14);
}

.dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
}

.text {
  opacity: 0.85;
}

.hint {
  margin: 10px 0 0;
  font-size: 12px;
  opacity: 0.6;
  line-height: 1.6;
}
</style>
