import { defineStore } from 'pinia';
import { ref } from 'vue';

/** 跨组件的界面开关。目前只有「管理环境」弹窗需要从响应面板那边打开。 */
export const useUiStore = defineStore('ui', function () {
  const envManagerVisible = ref(false);

  function openEnvManager() {
    envManagerVisible.value = true;
  }

  return {
    envManagerVisible: envManagerVisible,
    openEnvManager: openEnvManager
  };
});
