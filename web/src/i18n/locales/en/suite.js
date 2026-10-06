/**
 * suite region: user-visible text under `web/src/components/suite/`
 * (test suite tab, sidebar list, steps / data / settings / run history panes, run report).
 *
 * Terminology follows the glossary in README.md: Test suite, API, Folder, Assertion,
 * Extract, Environment, Variable, Mock, Example, Expectation.
 *
 * Note: when a message contains the literal `{{variables}}`, vue-i18n treats `{}` as
 * interpolation syntax, so it must be escaped as a literal (`{{` becomes `{'{'}{'{'}`),
 * otherwise compilation fails with "Not allowed nest placeholder".
 */
export default {
  /* ---------------- SuiteList ---------------- */
  title: 'Test suites',
  newSuite: 'New test suite',
  emptyList: 'No test suites yet. Click + above to create one, or use "Save as test suite" from "Batch run".',
  rename: 'Rename',
  copy: 'Copy',
  deleteConfirm: 'Delete "{name}"? Its run history will be deleted too (cannot be undone).',
  deleted: 'Deleted',

  /* ---------------- SuiteTab ---------------- */
  stepCount: '{n} step | {n} steps',
  stop: 'Stop',
  run: 'Run',
  backToEdit: 'Back to edit',
  failedCountLabel: 'Failed {n}',
  viewAll: 'View all',
  onlyFailed: 'Failed only',
  roundN: 'Round {n}',
  paneSteps: 'Steps',
  paneData: 'Data',
  paneSettings: 'Settings',
  paneRuns: 'Run history',
  mockEnv: 'Mock (built-in)',
  saveFailed: 'Save failed: {message}',
  webCannotRun: 'The web version cannot run test suites; run it from the desktop client',
  progressRoundStep: 'Round {iteration}/{iterations} · Step {index}/{steps}',
  preparing: 'Preparing…',

  /* ---------------- SuiteStepsPane ---------------- */
  stepsHintLead: 'Runs in order; expand a row to',
  stepsHintBold: 'append',
  stepsHintAfter: 'assertions and extracts to this step.',
  addApi: 'Add API',
  emptySteps: 'No steps yet. Click "Add API" to pick a few from the folder tree — the same API can be added more than once.',
  apiDeleted: 'API deleted',
  onFailContinue: 'Continue on failure',
  onFailSkipIteration: 'Skip this iteration on failure',
  removeStep: 'Delete this step',
  detailHint: "The API's own assertions still run; these are appended after them.",
  openApi: 'Open API',
  pickApisFirst: 'Pick a few APIs first',
  addedApis: 'Added {n} API | Added {n} APIs',
  pickHint: 'Checking a folder adds all APIs under it in tree order; WebSocket APIs cannot be added.',
  noApis: 'This project has no APIs yet.',
  add: 'Add',

  /* ---------------- SuiteDataPane ---------------- */
  dataNone: 'No data',
  chooseFile: 'Choose file',
  csvPlaceholderHeader: 'First row is the column names, comma-separated:',
  csvPlaceholderRow1: 'account,password',
  csvPlaceholderRow2: 'user1,pass1',
  csvPlaceholderRow3: 'user2,pass2',
  jsonPlaceholder: '[{"account":"user1","password":"pass1"}]',
  fileTooLarge: 'The file is over 2 MB; split it up',
  readFileFailed: 'Failed to read the file',
  dataHintLead: 'Each row runs one iteration. Column names are variable names; in an API, write',
  dataHintVar: "{'{'}{'{'}columns{'}'}{'}'}",
  dataHintAfterVar: 'to use them; in scripts, use',
  dataHintColumn: 'column',
  dataHintStrong: 'Data variables take precedence over environment variables.',
  dataHintTail: 'Limit 1000 rows / 2 MB.',
  previewCount: '{rows} rows, will run {iterations} iterations (previewing the first 20 below)',
  noDataHint: 'Without data, it runs the number of iterations set in Settings (default 1).',

  /* ---------------- SuiteSettingsPane ---------------- */
  iterationsLabel: 'Iterations without data',
  delayLabel: 'Delay between requests',
  delayUnit: 'Per-step delays are added on top of this',
  timeoutLabel: 'Request timeout',
  followGlobal: 'Follow global settings',
  timeoutUnit: 'Leave empty to follow global settings',
  noteLead: 'Variables extracted or set by scripts at runtime are',
  noteStrong: 'only valid for this run',
  noteTail: ', and do not change the values saved in the environment; cookies start empty for each run and are shared between steps; no history is kept.',

  /* ---------------- SuiteRunsPane ---------------- */
  statusPassed: 'Passed',
  statusFailed: 'Failed',
  statusStopped: 'Stopped',
  statusError: 'Error',
  runsKeepHint: 'Only the most recent 100 runs are kept per test suite.',
  refresh: 'Refresh',
  runsCloudHint: 'After signing in, run history is saved to the cloud and your teammates can see it. You can still run now; it just will not be recorded.',
  noRuns: 'No run history yet.',
  sourceCli: 'CLI',
  sourceApp: 'Client',
  removeRun: 'Delete this record',

  /* ---------------- SuiteReport ---------------- */
  noEnvironment: '(no environment)',
  buildLabel: 'Build {label}',
  exportReport: 'Export report',
  unitRounds: 'round | rounds',
  unitRequests: 'request | requests',
  assertions: 'Assertions',
  statDuration: 'Total time',
  statAverage: 'Average',
  truncatedNote: "This run's result was too large; request / response details were not saved (only each step's result is kept).",
  hasFailure: 'Has failures',
  statusSkipped: 'Skipped',
  collapse: 'Collapse',
  viewRequestResponse: 'View request / response',
  testMessagePrefix: ': ',
  actualRequest: 'Actual request sent',
  responseWithStatus: 'Response (HTTP {status})',
  noStepsInRun: 'This run has no steps (or the details were truncated).'
};
