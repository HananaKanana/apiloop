/**
 * runner region: user-visible text under `web/src/components/runner/`
 * (batch run tab: requests to run, settings, summary and results).
 *
 * Terminology follows the glossary in README.md: Folder, Project, Environment,
 * Assertion, Test suite, History, Variable.
 * Proper nouns stay untranslated: Mock, WebSocket.
 */
export default {
  /* ---------------- Shared ---------------- */
  noEnvironment: 'No environment',
  mockBuiltIn: 'Mock (built-in)',

  /* ---------------- RunnerTab ---------------- */
  suiteName: 'Test suite {stamp}',
  suiteSaved: 'Saved as test suite "{name}"',
  stopped: 'Stopped',
  failed: 'Failed',
  webBlocked: 'The web version cannot run; use the desktop client',
  saveAsSuite: 'Save as test suite',
  stop: 'Stop',
  start: 'Start run',
  webBlockedHint: 'The web version cannot run; use the desktop client (or ask the administrator to enable sending in the cloud)',
  requestsTitle: 'Requests to run ({checked}/{total})',
  unselectAll: 'Unselect all',
  selectAll: 'Select all',
  unnamedApi: '(unnamed API)',
  emptyList: 'This {scope} has no APIs yet',
  folder: 'folder',
  project: 'project',
  environment: 'Environment',
  repeat: 'Repeats',
  interval: 'Interval',
  milliseconds: 'ms',
  stopOnFail: 'Stop when an assertion fails',
  recordHistory: 'Record to history',
  progress: '{total} requests in total, {done} done',
  assertions: 'Assertions',
  passedWord: 'passed',
  failedLabel: '{n} failed',
  elapsed: 'Elapsed {time}',
  filterAll: 'All {n}',
  filterFailed: 'Failed only {n}',
  roundNth: 'Run {n}',
  noAssertions: 'This API has no assertions',
  running: 'Running…',
  idleHint: 'Click "Start run" at the top right to run these APIs in order',
  noFailedRequests: 'No failed requests'
};
