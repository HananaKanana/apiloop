/**
 * backup region: project backup and restore (round 14, T20).
 *
 * Used by the "Backup" tab in project settings (`components/backup/`),
 * "Restore from backup" in the project dropdown, and the "Automatic backup"
 * section in system settings.
 */
export default {
  /* ---------------- tab and shared ---------------- */
  title: 'Backup',
  restoreAction: 'Restore',
  closeAction: 'Close',

  /* ---------------- download ---------------- */
  downloadTitle: 'Download backup',
  downloadHint:
    'Exports the whole project as a JSON file: folders, APIs, examples, Mock expectations, environments, project variables and test suites. Secret variable values, members, share links and history are not included.',
  downloadAction: 'Download backup',
  downloaded: 'Backup downloaded',

  /* ---------------- restore from file (overwrite) ---------------- */
  restoreFileTitle: 'Restore from a backup file (overwrites this project)',
  restoreFileHint:
    'Pick a backup file you downloaded earlier to replace the contents of this project. The current folders, APIs and environments move to the trash (they can still be recovered); test suites are deleted.',
  restoreFileAction: 'Restore from backup file…',
  ownerOnly: 'Only a project owner (or a system administrator) can restore over a project.',
  editorOnly: 'Merging needs editor permission (or higher) on this project.',

  /* ---------------- cloud auto backups ---------------- */
  autoTitle: 'Cloud auto backups',
  autoHint:
    'The cloud backs up each project once a day. The files live on the server; you can download them or restore straight from them.',
  autoDisabled: 'Auto backup is off. An administrator can turn it on under System settings → Automatic backup.',
  autoEmpty: 'No auto backup yet.',
  autoUnavailable: 'Auto backups live in the cloud; sign in to see them.',
  autoDownloadAction: 'Download',
  autoRestoreNew: 'Restore as new project',
  autoRestoreOverwrite: 'Overwrite this project',

  /* ---------------- restore dialog ---------------- */
  pickFile: 'Choose a backup file',
  pickFileHint: 'Pick a .json backup file downloaded from apiloop earlier.',
  noFile: 'Choose a backup file first',
  notBackup: 'This is not an apiloop backup file',
  previewTitle: 'Backup contents',
  previewName: 'Project',
  previewExportedAt: 'Exported at',
  previewFolders: 'Folders',
  previewApis: 'APIs',
  previewExamples: 'Examples',
  previewExpectations: 'Mock expectations',
  previewEnvironments: 'Environments',
  previewSuites: 'Test suites',
  previewLoading: 'Reading the backup…',

  restoreNewTitle: 'Restore backup as a new project',
  restoreMergeTitle: 'Merge update',
  mergeTitle: 'Merge update (one side → this side)',
  mergeCardHint: 'Merge a backup exported elsewhere (e.g. an offline intranet) into this project: existing APIs, examples and Mock expectations are updated from the file, missing ones are added, things created here are left alone. Importing the same file again never duplicates. Environments and variables are only filled in where missing; values here are not changed.',
  mergeOpenAction: 'Pick a backup to merge',
  mergeHint: 'Pick a backup exported on the other side. You will see a preview before anything is written.',
  mergePreviewTitle: 'Merge preview',
  mergeCounts: 'Add {added}, update {updated}, unchanged {unchanged}, {vars} variable(s) filled in',
  mergeRemovedTitle: 'Deleted on the other side ({n})',
  mergeRemovedHint: 'These came from this source last time but are no longer in the file. They are kept by default; checked ones are deleted (APIs go to the trash).',
  mergeKind_api: 'API',
  mergeKind_folder: 'Folder',
  mergeKind_example: 'Example',
  mergeKind_expectation: 'Mock expectation',
  mergeKind_suite: 'Test suite',
  mergeAction: 'Merge',
  doneMerge: 'Merged: added {added}, updated {updated}, unchanged {unchanged}, {vars} variable(s) filled in, deleted {removed}.',
  restoreOverwriteTitle: 'Restore backup (overwrites this project)',
  newNameLabel: 'New project name',
  newNamePlaceholder: 'Leave empty to use the backed-up name plus "(restored)"',
  nameSuffix: ' (restored)',

  overwriteWarning:
    'Overwriting replaces the folders, APIs, environments, variables and settings of this project with the ones in the backup. The current folders, APIs and environments move to the trash (they can still be recovered); test suites are deleted.',
  overwriteConfirmLabel: 'Type the current project name "{name}" to confirm',
  overwriteConfirmPlaceholder: '{name}',
  beforeRestoreDownload:
    'A backup of the current project (including its test suites) is downloaded automatically first — that is the only way to get them back.',
  backupFirstFailed: 'Downloading the current project backup failed, so the overwrite was stopped: {message}',

  /* ---------------- result ---------------- */
  doneTitle: 'Restore finished',
  doneNew: 'Restored as the new project "{name}".',
  doneOverwrite:
    'The backup has overwritten this project. The previous folders, APIs and environments are in the trash; {n} test suite(s) were deleted, and the backup taken before overwriting has been downloaded.',
  warningsTitle: 'These items could not be restored completely:',

  /* ---------------- system settings ---------------- */
  settingsTitle: 'Automatic backup',
  settingsHint:
    'The cloud backs up every project once a day at this time, storing the files in the data directory on the server. A backup identical to the previous one is not written again.',
  settingsEnabled: 'Enable automatic backup',
  settingsHour: 'Time of day',
  settingsKeepDays: 'Keep for (days)',
  settingsKeepHint: 'Backups older than this are deleted (1–90 days).',
  settingsSaved: 'Saved',

  /* ---------------- project dropdown ---------------- */
  restoreFromFileMenu: 'Restore from backup as new project…'
};
