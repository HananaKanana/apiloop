/**
 * app 区域：跨组件的通用词（主要是对话框的按钮）。
 * 界面里出现频率高，放一处统一口径，别各写各的。
 */
export default {
  cancel: '取消',
  confirm: '确定',
  close: '关闭',
  delete: '删除',
  retry: '重试',
  copied: '已复制',
  copyFailed: '复制失败，请手动选中复制',
  // 全局兜底（main.js）：某个组件渲染 / 事件处理里报了错
  uiError: '界面出错了，刚才这块可能没显示全或操作没完成：{message}'
};
