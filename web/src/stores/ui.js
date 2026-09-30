import { defineStore } from 'pinia';
import { ref } from 'vue';

/** 跨组件的界面开关：管理环境弹窗、历史抽屉。 */
export const useUiStore = defineStore('ui', function () {
  const envManagerVisible = ref(false);
  const historyVisible = ref(false);
  const importVisible = ref(false);

  function openEnvManager() {
    envManagerVisible.value = true;
  }

  function openHistory() {
    historyVisible.value = true;
  }

  function openImport() {
    importVisible.value = true;
  }

  return {
    envManagerVisible: envManagerVisible,
    historyVisible: historyVisible,
    importVisible: importVisible,
    openEnvManager: openEnvManager,
    openHistory: openHistory,
    openImport: openImport
  };
});
