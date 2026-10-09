/**
 * tree 区域：目录树（`components/tree/`）—— 工具条、收藏区、右键菜单、
 * 新建 / 重命名 / 删除的提示，以及「复制 / 移动到其他项目」弹窗。
 *
 * 术语按 README 的术语表：Folder（目录）、API（接口）。**不要**把目录写成 Directory。
 */
export default {
  /* ---------------- 工具条 ---------------- */
  filterPlaceholder: '过滤',
  filterLabel: '筛选：',
  filterAll: '全部',
  newTitle: '新建',
  importTitle: '导入',
  collapseAll: '全部收起',
  expandAll: '全部展开',
  newMenuApi: '接口',
  newMenuFolder: '目录',

  /* ---------------- 列表 ---------------- */
  starredTitle: '收藏',
  groupTitle: '目录',
  untitledApi: '(未命名接口)',
  emptyNoMatch: '没有匹配的接口',
  emptyEditable: '还没有接口，右键目录或点右上角 ＋ 新建',
  emptyReadonly: '这个项目还没有接口',
  conflictMark: '和云端有冲突，点这里处理',
  pendingMark: '还没同步到云端',
  mockMark: 'mock 已启用',
  projectFallback: '项目',

  /* ---------------- 右键菜单 ---------------- */
  runAll: '运行全部',
  syncFromOpenapi: '从 OpenAPI 同步更新',
  shareProjectDoc: '分享整个项目的文档',
  shareDoc: '分享文档',
  menuNewApi: '新建接口',
  menuNewFolder: '新建目录',
  newSubfolder: '新建子目录',
  folderSettings: '目录设置',
  run: '运行',
  exportOpenapi: '导出为 OpenAPI',
  exportDoc: '导出文档…',
  copyToProject: '复制到其他项目…',
  moveToProject: '移动到其他项目…',
  duplicate: '复制',
  rename: '重命名',
  delete: '删除',

  /* ---------------- 新建 / 重命名 / 删除 ---------------- */
  newFolderTitle: '新建目录',
  newFolderUnder: '会建在选中的目录下面',
  newFolderRoot: '会建在根目录下',
  folderNamePlaceholder: '目录名称',
  createAction: '创建',
  created: '已创建',
  renameFolderTitle: '重命名目录',
  renameApiTitle: '重命名接口',
  save: '保存',
  renamed: '已重命名',
  folderDeletedAll: '已删除目录及其子项',
  folderDeletedKeep: '已删除目录，子项已移到上一级',
  deleted: '已删除',
  deleteApiTitle: '删除接口',
  deleteApiBody: '删除「{name}」后可以在回收站里恢复（保留 30 天）。确定删除吗？',
  deleteFolder: '删除目录',
  deleteFolderTitle: '删除目录「{name}」',
  deleteFolderCounts: '该目录下有 {folders} 个子目录、{apis} 个接口。请选择如何处理这些子项：',
  deleteFolderRecycle: '删除后可以在回收站里恢复（保留 30 天）。',
  deleteFolderKeepChildren: '仅删除目录（子项移到上一级）',
  deleteFolderWithChildren: '连同子项一起删除',

  /* ---------------- 复制 / 移动完成 ---------------- */
  quotedName: '「{name}」',
  copiedDone: '已复制 {n} 个接口到{where}',
  movedDone: '已移动 {n} 个接口到{where}',
  goLook: '去看看',

  /* ---------------- 复制 / 移动到其他项目 ---------------- */
  copyTitleApi: '复制接口到其他项目',
  copyTitleFolder: '复制目录到其他项目',
  moveTitleApi: '移动接口到其他项目',
  moveTitleFolder: '移动目录到其他项目',
  targetNodeCopy: '要复制的',
  targetNodeMove: '要移动的',
  thisApi: '这个接口',
  thisFolder: '这个目录',
  targetProject: '目标项目',
  pickProjectPlaceholder: '选一个项目',
  pickTargetProject: '先选一个目标项目',
  targetFolder: '目标目录',
  projectRoot: '项目根目录',
  noFoldersInTarget: '这个项目还没有目录',
  moveWarnApi: '移动后，原项目里的这些接口会放进回收站 （30 天内可以恢复）。评论不会跟着移动。',
  moveWarnFolder: '移动后，原项目里的这些目录和接口会放进回收站 （30 天内可以恢复）。评论不会跟着移动。',
  copyTip: '复制出来的是新的一份（新 id），原项目里的东西不动。',
  noTargetProject: '没有别的项目可以放（只列你在里面是 editor 及以上的项目）',
  moveAction: '移动',
  copyAction: '复制',

  /* ---------------- 多选（2026-10-08） ---------------- */
  multiSelected: '已选 {n} 项',
  multiHint: '拖动一起移动，右键批量操作',
  multiClear: '取消选择',
  multiMoveTo: '移动到目录…',
  multiMoveTitle: '把 {n} 项移动到',
  multiMoveAction: '移动',
  moveToRoot: '项目根目录',
  multiMoved: '已移动 {n} 项',
  multiDelete: '删除 {n} 项',
  multiDeleteTitle: '删除 {n} 项？',
  multiDeleteBody: '选中的 {n} 项会被删除，可以在回收站里恢复。',
  multiDeleteBodyFolders: '选中的 {n} 项会被删除，其中 {folders} 个目录连同里面的接口一起删除。可以在回收站里恢复。',
  multiDeleted: '已删除 {n} 项'
};
