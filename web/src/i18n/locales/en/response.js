/**
 * response region: user-visible text under `web/src/components/response/`
 * (response body, response headers, field view, response panel, SSE events,
 * timings, visualizer).
 *
 * Terminology follows the glossary in README.md: Project, Folder, API, Environment,
 * Variable, Mock, Test suite, Assertion, Extract, Example, Expectation, Workbench.
 */
export default {
  /* ---------------- BodyViewer ---------------- */
  formatText: 'Text',
  formatAuto: 'Auto-detect ({format})',
  formatTextLabel: 'Text (no formatting, no highlighting)',
  preview: 'Preview',
  fields: 'Fields',
  fieldsTitle: 'List the response by field; add an assertion or extract a variable from any field',
  image: 'Image',
  wrapTitle: 'Word wrap',
  searchTitle: 'Find in response (⌘F / Ctrl+F)',
  copyBodyTitle: 'Copy response body',
  downloadBodyTitle: 'Download response body',
  copiedBody: 'Response body copied',
  truncatedNotice:
    'The response body exceeded the limit, so only the first part is kept here; the size shown is the full length.',
  tooBigNotice:
    'The response is over 1 MB; to keep the UI responsive it is not formatted and is shown as raw text.',
  needsScriptNotice: 'This page needs scripts to render, and scripts are not executed in the preview.',
  openInBrowser: 'Open in browser',
  imageAlt: 'Response image',
  binaryNotice: 'This is a binary response; its content is not shown here.',
  binarySize: 'Size: {size}',
  download: 'Download',
  fieldReasonNotText: 'This response is not text',
  fieldReasonNotJson: 'This response is not JSON, so there is no field list',
  fieldReasonTooBig: 'The response is over 1 MB; to keep the UI responsive no fields are listed',

  /* ---------------- HeadersTable ---------------- */
  noHeaders: 'No response headers',
  headerName: 'Name',
  headerValue: 'Value',

  /* ---------------- JsonTreeView ---------------- */
  fieldsNotObject: 'This is JSON whose top level is not an object, so there are no fields to click.',
  addAssertion: 'Add assertion',
  addAssertionTitle: 'Add a row in Assertions: JSON field · this path',
  addExtract: 'Extract as variable',
  addExtractTitle: 'Add a row in the extraction table on the Assertions tab',
  fieldsTruncated: 'Too many fields; only the first 500 are listed.',

  /* ---------------- ResponsePanel ---------------- */
  errorTimeout: 'Request timed out; the server did not respond in time.',
  errorAborted: 'Request cancelled.',
  errorDns: 'DNS lookup failed; check the host name.',
  errorConnect: 'Cannot connect to the target server; check the address and port, or the server is not listening.',
  errorTls:
    'TLS handshake failed; the certificate may be the problem (self-signed certificates are allowed by default, so that is not the cause).',
  errorInvalidUrl: 'Invalid URL.',
  errorInvalidHeader: 'Invalid request header.',
  errorFile: 'Failed to read the local file.',
  errorProxy:
    'Proxy unavailable: cannot reach the proxy, or the CONNECT tunnel was rejected. Check the proxy address in system settings, or turn off "Use system proxy" for this request.',
  errorScript:
    'The Pre-request script failed, so the request was not sent. Fix the script and resend, or turn off "Run script" for this request on the Settings tab.',
  errorOther: 'Request failed.',
  errorWithCode: '{message} ({code}: {detail})',
  serverSendDisabled: 'The cloud does not send requests; open apiloop locally',
  idleHint: 'Click Send or press Enter to see the response',
  localNetworkTitle: 'Local network access required',
  localNetworkBody:
    'macOS just asked to allow node to access the local network — click Allow, then resend. If you did not see the prompt: open System Settings → Privacy & Security → Local Network and turn on node.',
  resend: 'Resend',
  cancelledNotice:
    'This request was cancelled. The server still records a history entry (status "Cancelled") containing the part received before the connection was dropped.',
  historyTruncatedNotice:
    'The response body in this history entry exceeded 256 KB and was truncated when stored; the content below is the truncated version.',
  recordErrorTag: 'History not saved',
  receiving: 'Receiving… {size}',
  duration: 'Time {time}',
  size: 'Size {size}',
  viaProxy: 'Via proxy {url}',
  redirectCount: '{n} redirect | {n} redirects',
  connecting: 'Connecting…',
  notSentYet: 'Not sent yet',
  saveExample: 'Save as example',
  saveHintTemp: 'Save this temporary tab as an API before saving an example',
  saveHintSendFirst: 'Send a request first',
  saveHintBinary: 'Binary responses cannot be saved as an example',
  bodyTab: 'Body',
  visualizeTab: 'Visualize',
  eventsTab: 'Events',
  testResults: 'Test results {passed}/{total}',
  testPassed: 'Passed',
  testFailed: 'Failed',
  consoleTab: 'Console',
  cookiesTab: 'Cookies',
  cookieName: 'Name',
  cookieValue: 'Value',
  cookieDomain: 'Domain',
  cookiePath: 'Path',
  cookieExpires: 'Expires',
  cookieAttributes: 'Flags',
  cookieSession: 'Session',
  noCookies: 'This response did not set any Cookie',
  headersTab: 'Headers',
  timingsTab: 'Timings',
  requestTab: 'Request',
  requestBody: 'Request body',
  scriptErrorPrerequest: 'Pre-request script error',
  scriptErrorResponse: 'Response script error',
  maxAge: 'Max-Age {value} seconds',

  /* ---------------- SseEventsTable ---------------- */
  sseOverflow:
    'Only the latest 2000 are shown; {n} earlier event was dropped. | Only the latest 2000 are shown; {n} earlier events were dropped.',
  sseCount: '{n} event | {n} events',
  sseTip: 'Click a row to expand the full data',
  sseSave: 'Save as SSE example',
  sseSaveTitle: 'Compute the delay from each event\u2019s arrival time and save it as an sse example',
  sseTime: 'Time',
  sseLength: 'Length',
  sseEmpty: 'No events received yet.',

  /* ---------------- TimingsBar ---------------- */
  totalTiming: 'Total time',
  timingDns: 'DNS lookup',
  timingConnect: 'Connection',
  timingTls: 'TLS handshake',
  timingTtfb: 'Waiting for first byte',
  timingDownload: 'Download',

  /* ---------------- VisualizerView ---------------- */
  templateRenderError: 'Template rendering failed: {message}',

  /* ---------------- response filtering (BodyViewer, T37) ---------------- */
  filterTitle: 'Filter response (⌘⇧K)',
  filterLabel: 'Filter',
  filterKeyword: 'Keyword',
  filterPathPlaceholder: '$.data.list[*].id',
  filterKeywordPlaceholder: 'Type a keyword',
  filterCaseSensitive: 'Match case',
  filterShowPath: 'Show paths',
  filterCount: '{n} result | {n} results',
  filterNoMatch: 'No match',
  filterCopy: 'Copy result',
  filterCopied: 'Filtered result copied',
  filterClose: 'Close filter',
  filterPathError: 'Bad expression: {message}',
  filterNotJson: 'The response is not JSON, so JSONPath is unavailable',
  filterComputing: 'Computing…',
  filterTruncated: 'Too many matches, showing the first {n} lines',

  /* ---------------- ⌘F search in the response (T43) ---------------- */
  searchPanelPlaceholder: 'Find',
  searchPrev: 'Previous (⇧Enter)',
  searchNext: 'Next (Enter)',
  searchClose: 'Close (Esc)',
  searchCount: '{index} of {total}',
  searchNoMatch: 'No match'
};
