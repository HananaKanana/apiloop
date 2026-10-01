<script setup>
import { computed, ref } from 'vue';
import { NButton, useMessage } from 'naive-ui';
import { useGatewayStore } from '@/stores/gateway';

/**
 * 「立即更新」按钮 + 进度（页面顶部横幅和「安装新版本」对话框共用）。
 *
 * 点了之后网关去云端下载这个系统、这个芯片的安装包，下完交给系统安装：
 * Mac 弹出安装程序（要输一次电脑密码），Windows 静默安装。进度来自网关状态里的
 * `update`，顶栏每 3 秒刷一次。
 */
const gateway = useGatewayStore();
const message = useMessage();

const starting = ref(false);

const isWindows = /Windows/i.test(navigator.userAgent || '');

const update = computed(function () {
  return gateway.update || { supported: false, state: 'idle' };
});

const percent = computed(function () {
  const total = update.value.total || 0;
  if (!total) return 0;
  return Math.min(100, Math.floor((update.value.received || 0) * 100 / total));
});

const busy = computed(function () {
  return starting.value || update.value.state === 'downloading';
});

async function start() {
  starting.value = true;
  try {
    await gateway.startUpdate();
  } catch (err) {
    message.error(err.message);
  } finally {
    starting.value = false;
  }
}
</script>

<template>
  <span v-if="update.supported" class="update-action">
    <template v-if="update.state === 'downloading'">
      <span class="text">正在下载新版本 {{ percent }}%</span>
      <span class="bar"><span class="fill" :style="{ width: percent + '%' }" /></span>
    </template>

    <template v-else-if="update.state === 'installing'">
      <span class="text">
        <template v-if="isWindows">正在安装，装完 apiloop 会自动重新打开。</template>
        <template v-else>已打开安装程序：按提示输入电脑密码完成安装，装完 apiloop 会自动重新打开。</template>
      </span>
      <!-- 安装窗口被关掉、或者没弹出来：重新下一次、再打开一次 -->
      <a class="retry" @click="start">没看到安装窗口？重试</a>
    </template>

    <template v-else>
      <span v-if="update.state === 'error'" class="text error">{{ update.error }}</span>
      <n-button size="small" type="primary" :loading="busy" @click="start">
        {{ update.state === 'error' ? '重试' : '立即更新' }}
      </n-button>
    </template>
  </span>
</template>

<style scoped>
.update-action {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.text {
  font-size: 13px;
}

.text.error {
  color: #d03050;
}

.retry {
  font-size: 12px;
  cursor: pointer;
  color: var(--apiloop-primary, #ff6c37);
}

.bar {
  width: 160px;
  height: 6px;
  border-radius: 3px;
  background: rgba(128, 128, 128, 0.2);
  overflow: hidden;
}

.fill {
  display: block;
  height: 100%;
  background: var(--apiloop-primary, #ff6c37);
  transition: width 0.3s;
}
</style>
