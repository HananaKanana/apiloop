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
  /** 全局查找替换（第五轮第 2 节）：入口在项目名下拉和 ⌘⇧F，弹窗挂在工作台 */
  const findReplaceVisible = ref(false);

  /** 帮助抽屉（用户 2026-10-02 要的帮助页）；helpSection 是打开时要跳到的那一节 */
  const helpVisible = ref(false);
  const helpSection = ref('');

  function openHelp(section) {
    helpSection.value = section || '';
    helpVisible.value = true;
  }
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

  /**
   * 「打开某个接口的评论面板，并滚到哪一条」：`{ apiId, commentId }` 或 null。
   *
   * 铃铛点一条提醒时用 —— 评论面板挂在请求标签页里，跨组件只能这么告诉它。
   * 请求标签页匹配到自己的 apiId 就打开面板，然后把它清掉（免得切回来又弹一次）。
   */
  const commentsTarget = ref(null);

  function openComments(apiId, commentId) {
    if (!apiId) return;
    commentsTarget.value = { apiId: apiId, commentId: commentId || '' };
  }

  function clearCommentsTarget() {
    commentsTarget.value = null;
  }

  function openMockLog() {
    mockLogVisible.value = true;
  }

  function openQuickOpen() {
    quickOpenVisible.value = true;
  }

  function openFindReplace() {
    findReplaceVisible.value = true;
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

  /**
   * 响应体的查找（T43）。
   *
   * 按 ⌘F 要打开「当前标签页响应」的查找框，但那个 CodeMirror 藏在
   * 工作台 › RequestTab › ResponsePanel › BodyViewer 四层里面，一层层往下传事件太啰嗦。
   * 所以反过来：**BodyViewer 挂载时把自己「打开查找」的方法登记到这里**，
   * 工作台按键时调一下。同一时间只有一个 BodyViewer 挂着（标签页按 key 重建），
   * 所以不需要按 key 存。
   *
   * **故意不放进 reactive**：它是个函数，包成 ref 只会多一层 `.value`，没有任何响应式的用处。
   */
  let responseSearchHandler = null;

  /** 登记 / 注销（传 null 就是注销）。只有文本响应才登记 —— 图片、二进制没有可查的东西 */
  function registerResponseSearch(fn) {
    responseSearchHandler = typeof fn === 'function' ? fn : null;
  }

  /** 当前标签页有没有可查的响应（工作台据此决定要不要拦 ⌘F） */
  function hasResponseSearch() {
    return typeof responseSearchHandler === 'function';
  }

  /** 打开响应的查找框，`text` 是要预填的（一般是选中的文字） */
  function openResponseSearch(text) {
    if (responseSearchHandler) responseSearchHandler(text);
  }

  return {
    helpVisible: helpVisible,
    helpSection: helpSection,
    openHelp: openHelp,
    importVisible: importVisible,
    mockLogVisible: mockLogVisible,
    quickOpenVisible: quickOpenVisible,
    findReplaceVisible: findReplaceVisible,
    sidebarTab: sidebarTab,
    conflictTarget: conflictTarget,
    openConflict: openConflict,
    closeConflict: closeConflict,
    commentsTarget: commentsTarget,
    openComments: openComments,
    clearCommentsTarget: clearCommentsTarget,
    openImport: openImport,
    openMockLog: openMockLog,
    openQuickOpen: openQuickOpen,
    openFindReplace: openFindReplace,
    setSidebarTab: setSidebarTab,

    /* ---------------- 响应体的查找（T43） ---------------- */

    registerResponseSearch: registerResponseSearch,
    hasResponseSearch: hasResponseSearch,
    openResponseSearch: openResponseSearch
  };
});
