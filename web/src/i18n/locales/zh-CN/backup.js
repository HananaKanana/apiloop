/**
 * backup 区域：项目备份与恢复（第十四轮 T20）。
 *
 * 界面在：项目设置的「备份」页签（`components/backup/`）、项目下拉的「从备份恢复成新项目」、
 * 系统设置的「自动备份」一节。术语按 README 的术语表。
 */
export default {
  /* ---------------- 页签与通用 ---------------- */
  title: '备份',
  restoreAction: '恢复',
  closeAction: '关闭',

  /* ---------------- 下载备份 ---------------- */
  downloadTitle: '下载备份',
  downloadHint:
    '把整个项目导出成一个 JSON 文件：目录、接口、示例、Mock 期望、环境、项目变量、测试集都在里面。不含保密变量的值、成员、分享链接和历史。',
  downloadAction: '下载备份',
  downloaded: '备份已下载',

  /* ---------------- 从备份文件恢复（覆盖当前项目） ---------------- */
  restoreFileTitle: '从备份文件恢复（覆盖当前项目）',
  restoreFileHint:
    '选一个之前下载的备份文件，用它替换当前项目的内容。现在的目录、接口、环境会移进回收站（还能找回来），测试集会直接删除。',
  restoreFileAction: '从备份文件恢复…',
  ownerOnly: '只有项目的 owner（或系统管理员）能覆盖恢复。',

  /* ---------------- 云端自动备份列表 ---------------- */
  autoTitle: '云端自动备份',
  autoHint: '云端每天自动备份一次，文件放在服务器上，可以下载，也可以直接拿来恢复。',
  autoDisabled: '自动备份没有开启。管理员可以在「系统设置 → 自动备份」里开启。',
  autoEmpty: '还没有自动备份。',
  autoUnavailable: '自动备份保存在云端，登录后才能看。',
  autoDownloadAction: '下载',
  autoRestoreNew: '恢复成新项目',
  autoRestoreOverwrite: '覆盖当前项目',

  /* ---------------- 恢复对话框 ---------------- */
  pickFile: '选择备份文件',
  pickFileHint: '选一个之前从 apiloop 下载的备份文件（.json）。',
  noFile: '请先选择备份文件',
  notBackup: '这不是 apiloop 的备份文件',
  previewTitle: '备份内容',
  previewName: '项目名',
  previewExportedAt: '导出时间',
  previewFolders: '目录',
  previewApis: '接口',
  previewExamples: '示例',
  previewExpectations: 'Mock 期望',
  previewEnvironments: '环境',
  previewSuites: '测试集',
  previewLoading: '正在读取备份…',

  restoreNewTitle: '从备份恢复成新项目',
  restoreOverwriteTitle: '恢复备份（覆盖当前项目）',
  newNameLabel: '新项目名称',
  newNamePlaceholder: '留空则用备份里的项目名加「（恢复）」',
  nameSuffix: '（恢复）',

  overwriteWarning:
    '覆盖会用备份里的内容替换当前项目的目录、接口、环境、变量和设置。现在的目录、接口、环境会移进回收站（还能找回来），测试集会直接删除。',
  overwriteConfirmLabel: '输入当前项目名「{name}」以确认覆盖',
  overwriteConfirmPlaceholder: '{name}',
  beforeRestoreDownload: '覆盖之前会先自动下载一份当前项目的备份（含测试集），这是找回它们的唯一途径。',
  backupFirstFailed: '下载当前项目的备份失败，已中止覆盖：{message}',

  /* ---------------- 恢复结果 ---------------- */
  doneTitle: '恢复完成',
  doneNew: '已恢复成新项目「{name}」。',
  doneOverwrite:
    '已经用备份覆盖了当前项目。原来的目录、接口、环境在回收站里；测试集已删除（{n} 个），覆盖前的备份已下载到本地。',
  warningsTitle: '下面这些内容没能完整恢复：',

  /* ---------------- 系统设置 · 自动备份 ---------------- */
  settingsTitle: '自动备份',
  settingsHint:
    '云端每天在这个时间给每个项目做一份备份，存在服务器的数据目录里。内容和上一份完全一样时不重复写。',
  settingsEnabled: '开启自动备份',
  settingsHour: '每天几点',
  settingsKeepDays: '保留天数',
  settingsKeepHint: '超过这个天数的备份会被删掉（1–90 天）。',
  settingsSaved: '已保存',

  /* ---------------- 项目下拉 ---------------- */
  restoreFromFileMenu: '从备份恢复成新项目…'
};
