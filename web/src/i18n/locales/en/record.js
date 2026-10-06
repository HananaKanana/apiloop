/**
 * record region: user-visible text under `web/src/components/record/`
 * (Mock recording drawer, record detail, save-selected dialog).
 *
 * Terminology follows the glossary in README.md: Mock is not translated,
 * folders use "Folder".
 *
 * Note: when a message contains the literal `{{variables}}`, vue-i18n treats `{}`
 * as interpolation syntax, so it must be escaped as a literal (`{{` becomes
 * `{'{'}{'{'}`), otherwise compilation fails with "Not allowed nest placeholder".
 */
export default {
  /* ---------------- RecordDrawer ---------------- */
  drawerTitle: 'Mock recording',
  busyOther: 'A recording is in progress for project "{project}"; only one project can be recorded at a time. Switch to that project to stop it, or wait for it to stop.',
  targetLabel: 'Target URL',
  useEnvVar: 'Use an environment variable',
  targetRequired: 'Fill in the target URL first',
  targetTip: 'Requests are forwarded to this URL (a path prefix is allowed) and recorded at the same time.',
  startedHint: 'Recording started; change the API URL to the proxy URL below',
  stoppedHint: 'Recording stopped; the records are kept and you can still pick some to save',
  portLabel: 'Port',
  portPlaceholder: 'Auto',
  portTip: 'Empty / 0 means auto (find a free port starting from 47400)',
  prefixLabel: 'Only record this prefix',
  prefixPlaceholder: 'Empty means record everything, e.g. /api',
  optionsLabel: 'Options',
  lanLabel: 'Allow LAN access (phones, other computers)',
  lanWarn: 'Anyone on the same network can reach your target service through this URL; be careful not to expose an intranet service.',
  skipStaticLabel: 'Skip static assets (js / css / images / pages)',
  start: 'Start recording',
  proxyLabel: 'Proxy URL',
  copy: 'Copy',
  lanAddr: 'LAN',
  forwardTo: 'Forward to',
  recordingTip: 'Change the front-end / app API URL to the proxy URL above; requests are forwarded to {target} and responses are recorded below.',
  stop: 'Stop',
  selectAll: 'Select all',
  countRatio: '{shown} / {total}',
  searchPlaceholder: 'Search by path',
  onlyUnmatched: 'Only those not matched to an API',
  dedupe: 'Deduplicate',
  unreachable: 'Unreachable',
  newApi: 'New API',
  collapse: 'Collapse',
  detail: 'Details',
  empty: 'No records yet',
  emptyRecording: 'Change the API URL to the proxy URL above; visit it once and it will show up here.',
  emptyIdle: 'After you start recording, requests to the proxy URL will show up here.',
  loading: 'Loading…',
  saveSelected: 'Save selected ({n})',
  readonlyHint: 'Read-only members can only view records',
  selectFirst: 'Select a few records to save first',
  saveCreated: 'Created {apis} APIs and added {examples} examples',
  saveFailedTitle: '{n} records failed to save',
  gotIt: 'Got it',
  clearTitle: 'Clear records',
  clearBody: 'Clear all records recorded for this project (saved APIs and examples are not affected).',
  clearAction: 'Clear',
  cleared: 'Cleared',

  /* ---------------- RecordDetail ---------------- */
  none: '(none)',
  emptyValue: '(empty)',
  truncated: '(too long; only the first 1 MB was recorded)',
  binary: '(binary content, not recorded)',
  matchedApi: 'Matched API',
  noMatchHint: 'Not matched; a new API will be created when saving',
  requestHeaders: 'Request headers',
  requestBody: 'Request body',
  responseHeaders: 'Response headers',
  responseBody: 'Response body',

  /* ---------------- RecordSaveDialog ---------------- */
  saveDialogTitle: 'Save selected records',
  saveMatchedGroup: 'Save as examples ({n})',
  saveMatchedHint: "Added to their respective APIs; if \"Set as Mock response\" is checked, each API's Mock is pointed at the new example.",
  moreItems: '…and {n} more',
  createGroup: 'Create APIs ({n})',
  createHint: 'These requests did not match an existing API; new APIs are created from the recorded method and URL, then examples are added.',
  moreCreated: '…and {n} more',
  folderLabel: 'Folder',
  rootFolder: 'Project root',
  paramize: 'Turn numbers / IDs in the path into params (/orders/1001 → /orders/:id)',
  setMock: 'Set as Mock response (fall back to Mock when the backend is down)',
  saveCount: 'Save ({n})'
};
