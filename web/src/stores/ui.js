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

/** 跨组件的界面开关：侧栏那一页、管理环境弹窗、导入弹窗、Mock 日志抽屉、快速打开、冲突对话框。 */
export const useUiStore = defineStore('ui', function () {
  const importVisible = ref(false);
  const mockLogVisible = ref(false);
  const quickOpenVisible = ref(false);
  const sidebarTab = ref(readSidebarTab());

  /**
   * 正在处理哪一条冲突：`{ entity, id }` 或 null。
   *
   * 冲突对话框挂在顶栏（`ConnectionStatus`），但打开它的入口有三个
   * （顶栏的冲突列表、目录树、请求标签页顶部），所以这个「打开哪一条」放在这里。
   */
  const conflictTarget = ref(null);

  function openConflict(entity, id) {
    if (!entity || !id) return;
    conflictTarget.value = { entity: entity, id: id };
  }

  function closeConflict() {
    conflictTarget.value = null;
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
    importVisible: importVisible,
    mockLogVisible: mockLogVisible,
    quickOpenVisible: quickOpenVisible,
    sidebarTab: sidebarTab,
    conflictTarget: conflictTarget,
    openConflict: openConflict,
    closeConflict: closeConflict,
    openImport: openImport,
    openMockLog: openMockLog,
    openQuickOpen: openQuickOpen,
    setSidebarTab: setSidebarTab
  };
});
