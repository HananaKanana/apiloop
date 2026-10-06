/**
 * env region: environments (`components/env/`) — the sidebar list, one
 * environment's editor, the built-in Mock environment, and the comparison view.
 *
 * Glossary: Environment, Variable.
 */
export default {
  /* ---------------- sidebar list ---------------- */
  title: 'Environments',
  newEnv: 'New environment',
  newEnvName: 'New environment',
  created: 'Created',
  builtin: 'Built-in',
  current: 'Current',
  setCurrent: 'Use this one',
  setCurrentDone: 'Now using this environment',
  switchedTo: 'Switched to “{name}”',
  switchedToMock: 'Switched to “Mock”',
  duplicate: 'Duplicate',
  duplicateEnv: 'Duplicate environment',
  copySuffix: ' copy',
  deleteTitle: 'Delete environment',
  deleteBody: 'Delete “{name}”? Requests that use its variables will end up with undefined values. Deleted environments can be restored from the trash for 30 days.',
  dirtyTitle: 'Unsaved changes — ⌘S to save',
  more: 'More',

  /* ---------------- one environment ---------------- */
  namePlaceholder: 'Environment name',
  nameRequired: 'The environment name cannot be empty',
  readonly: 'Your role is read-only, so changes cannot be saved',
  readonlyShort: 'Read-only role',
  filterPlaceholder: 'Filter variables',
  countLabel: '{n} variable(s) in total',
  gone: 'This environment has been deleted.',
  exported: 'Exported',
  exportJson: 'Export as JSON',

  /* ---------------- built-in Mock environment ---------------- */
  restoreDefaultTitle: 'Restore defaults',
  restoreDefaultBody: 'The variables go back to just host = {host}; everything you changed or added is removed.',
  restoreAction: 'Restore',
  defaultRestored: 'Defaults restored',
  mockIntroLead: 'With this environment selected, a request URL of ',
  mockIntroMid: ' hits this project’s Mock. The default host is ',
  mockIntroMid2: '; change it if all your APIs share a prefix, for example by appending ',
  mockIntroTail: '.',

  /* ---------------- comparison ---------------- */
  diffTitle: 'Compare environments',
  diffCount: '{envs} environment(s) · {vars} variable(s)',
  onlyDiff: 'Only differences',
  fillMissing: 'Add the missing variables',
  noMissing: 'No variables are missing',
  filled: 'Added {n} missing variable(s); fill in the values and save',
  discard: 'Discard changes',
  discarded: 'Changes discarded',
  saveWithCount: 'Save ({n} change(s))',
  savedEnvs: '{n} environment(s) saved',
  failedName: '“{name}”: ',
  saveFailed: 'These environments could not be saved: {list}',
  noEnvsHint: 'This project has no environments yet. Create a few under “Environments” on the left, then come back to compare.',
  variableName: 'Variable',
  hide: 'Hide',
  reveal: 'Show my value',
  missing: '(missing)',
  addHere: 'Click to add it to this environment',
  allSame: 'Every environment is the same, there are no differences',
  noVarsYet: 'These environments have no variables yet'
};
