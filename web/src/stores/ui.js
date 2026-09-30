import { defineStore } from 'pinia';
import { ref } from 'vue';

/** 侧栏当前是哪一页。存 localStorage，读写都要包 try/catch（隐私模式下会抛） */
const SIDEBAR_KEY = 'apiloop.sidebar.tab';
const SIDEBAR_TABS = ['tree', 'env', 'history'];

function readSidebarTab() {
  try {
    const value = localStorage.getItem(SIDEBAR_KEY);
    return SIDEBAR_TABS.indexOf(value) > -1 ? value : 'tree';
  } catch (err) {
    return 'tree';
  }
}

/** 跨组件的界面开关：侧栏那一页、管理环境弹窗、导入弹窗、Mock 日志抽屉、快速打开。 */
export const useUiStore = defineStore('ui', function () {
  const envManagerVisible = ref(false);
  /** 打开环境管理时要定位到哪个环境（侧栏「环境」页点进来用） */
  const envManagerTarget = ref('');
  const importVisible = ref(false);
  const mockLogVisible = ref(false);
  const quickOpenVisible = ref(false);
  const sidebarTab = ref(readSidebarTab());

  function openEnvManager(envId) {
    envManagerTarget.value = envId || '';
    envManagerVisible.value = true;
  }

  function openImport() {
    importVisible.value = true;
  }

  function openMockLog() {
    mockLogVisible.value = true;
  }

  function openQuickOpen() {
    quickOpenVisible.value = true;
  }

  function setSidebarTab(tab) {
    if (SIDEBAR_TABS.indexOf(tab) === -1) return;
    sidebarTab.value = tab;
    try {
      localStorage.setItem(SIDEBAR_KEY, tab);
    } catch (err) {
      // 存不下就算了，不影响用
    }
  }

  return {
    envManagerVisible: envManagerVisible,
    envManagerTarget: envManagerTarget,
    importVisible: importVisible,
    mockLogVisible: mockLogVisible,
    quickOpenVisible: quickOpenVisible,
    sidebarTab: sidebarTab,
    openEnvManager: openEnvManager,
    openImport: openImport,
    openMockLog: openMockLog,
    openQuickOpen: openQuickOpen,
    setSidebarTab: setSidebarTab
  };
});
