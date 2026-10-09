/**
 * tree region: the API tree (`components/tree/`) — toolbar, starred section,
 * context menus, create / rename / delete prompts, and the
 * "copy / move to another project" dialog.
 *
 * Glossary: Folder, API.
 */
export default {
  /* ---------------- toolbar ---------------- */
  filterPlaceholder: 'Filter',
  filterLabel: 'Filter: ',
  filterAll: 'All',
  newTitle: 'New',
  importTitle: 'Import',
  collapseAll: 'Collapse all',
  expandAll: 'Expand all',
  newMenuApi: 'API',
  newMenuFolder: 'Folder',

  /* ---------------- list ---------------- */
  starredTitle: 'Favorites',
  groupTitle: 'Folders',
  untitledApi: '(untitled API)',
  emptyNoMatch: 'No matching API',
  emptyEditable: 'No APIs yet. Right-click a folder or use the + button at the top right.',
  emptyReadonly: 'This project has no APIs yet',
  conflictMark: 'Conflicts with the cloud; click to resolve',
  pendingMark: 'Not synced to the cloud yet',
  mockMark: 'Mock is on',
  projectFallback: 'Project',

  /* ---------------- context menus ---------------- */
  runAll: 'Run all',
  syncFromOpenapi: 'Sync from OpenAPI',
  shareProjectDoc: 'Share the whole project as a document',
  shareDoc: 'Share document',
  menuNewApi: 'New API',
  menuNewFolder: 'New folder',
  newSubfolder: 'New subfolder',
  folderSettings: 'Folder settings',
  run: 'Run',
  exportOpenapi: 'Export as OpenAPI',
  exportDoc: 'Export document…',
  copyToProject: 'Copy to another project…',
  moveToProject: 'Move to another project…',
  duplicate: 'Duplicate',
  rename: 'Rename',
  delete: 'Delete',

  /* ---------------- create / rename / delete ---------------- */
  newFolderTitle: 'New folder',
  newFolderUnder: 'It will be created inside the selected folder',
  newFolderRoot: 'It will be created at the project root',
  folderNamePlaceholder: 'Folder name',
  createAction: 'Create',
  created: 'Created',
  renameFolderTitle: 'Rename folder',
  renameApiTitle: 'Rename API',
  save: 'Save',
  renamed: 'Renamed',
  folderDeletedAll: 'Folder and its contents deleted',
  folderDeletedKeep: 'Folder deleted; its contents moved up one level',
  deleted: 'Deleted',
  deleteApiTitle: 'Delete API',
  deleteApiBody: 'Deleting "{name}" moves it to the trash, where it can be restored for 30 days. Delete it?',
  deleteFolder: 'Delete folder',
  deleteFolderTitle: 'Delete folder "{name}"',
  deleteFolderCounts: 'This folder contains {folders} subfolder(s) and {apis} API(s). Choose what to do with them:',
  deleteFolderRecycle: 'Deleted items go to the trash and can be restored for 30 days.',
  deleteFolderKeepChildren: 'Delete only the folder (contents move up one level)',
  deleteFolderWithChildren: 'Delete the folder and everything in it',

  /* ---------------- copy / move result ---------------- */
  quotedName: '"{name}"',
  copiedDone: 'Copied {n} API(s) to{where}',
  movedDone: 'Moved {n} API(s) to{where}',
  goLook: 'Go look',

  /* ---------------- copy / move to another project ---------------- */
  copyTitleApi: 'Copy API to another project',
  copyTitleFolder: 'Copy folder to another project',
  moveTitleApi: 'Move API to another project',
  moveTitleFolder: 'Move folder to another project',
  targetNodeCopy: 'Copying',
  targetNodeMove: 'Moving',
  thisApi: 'this API',
  thisFolder: 'this folder',
  targetProject: 'Target project',
  pickProjectPlaceholder: 'Pick a project',
  pickTargetProject: 'Pick a target project first',
  targetFolder: 'Target folder',
  projectRoot: 'Project root',
  noFoldersInTarget: 'This project has no folders yet',
  moveWarnApi:
    'After moving, these APIs in the original project go to the trash (restorable for 30 days). Comments do not move with them.',
  moveWarnFolder:
    'After moving, these folders and APIs in the original project go to the trash (restorable for 30 days). Comments do not move with them.',
  copyTip: 'The copies are new rows with new ids; the originals stay where they are.',
  noTargetProject: 'No other project can take them (only projects where you are editor or above are listed)',
  moveAction: 'Move',
  copyAction: 'Copy',

  /* ---------------- Multi-select (2026-10-08) ---------------- */
  multiMoveTo: 'Move to folder…',
  multiMoveTitle: 'Move {n} items to',
  multiMoveAction: 'Move',
  moveToRoot: 'Project root',
  multiMoved: 'Moved {n} items',
  multiDelete: 'Delete {n} items',
  multiDeleteTitle: 'Delete {n} items?',
  multiDeleteBody: 'The {n} selected items will be deleted. You can restore them from the trash.',
  multiDeleteBodyFolders: 'The {n} selected items will be deleted, including {folders} folders with everything inside them. You can restore them from the trash.',
  multiDeleted: 'Deleted {n} items'
};
