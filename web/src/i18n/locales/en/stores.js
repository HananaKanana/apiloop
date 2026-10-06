/**
 * stores region: user-visible text inside the Pinia stores (`stores/`) — tab
 * titles, status / error messages of the debug pages, default names.
 *
 * These places cannot use `useI18n()`, so they use the `t` exported from
 * `@/i18n`. Values that used to sit in module-level constants are now looked up
 * when they are needed, so a language switch takes effect.
 */
export default {
  /* ---------------- tab titles ---------------- */
  untitledApi: '(untitled API)',
  newRequest: 'New request',
  folderSettings: 'Folder settings',
  project: 'Project',
  runnerTitle: 'Run: {name}',
  testSuite: 'Test suite',
  loadTitle: 'Load test · {name}',
  apiFallback: 'an API',
  envDiff: 'Compare environments',
  historyRecord: 'History',

  /* ---------------- messages ---------------- */
  preflightRetried: 'The token expired; signed in again and resent',
  newGroup: 'New group',
  loadNoProject: 'No project selected',
  loadFailed: 'The load test failed',
  runnerStopped: 'Stopped',
  runnerFailed: 'The request failed',
  runnerWebBlocked: 'The web version cannot run collections; use the client',
  runnerNoSelection: 'No API selected',
  suiteRunFailed: 'The run failed',
  disconnected: 'Disconnected',

  /* ---------------- gRPC ---------------- */
  grpcCallFailed: 'The call failed',
  grpcNoResult: 'The connection dropped before the call returned',
  grpcConnected: 'Connected to {target}',
  grpcTls: ' (TLS)',
  grpcMissing: '; these variables have no value: {list}',
  grpcMetadata: 'Handshake metadata received',
  grpcCallEnd: 'Call finished: {status}',
  grpcUnknownStatus: 'unknown status',
  grpcDetails: ' ({details})',
  grpcDuration: ', took {ms}ms',
  grpcTests: '; {passed}/{total} assertion(s) passed',
  grpcExtracted: '; extracted {n} variable(s)',
  grpcStreamFailed: 'The streaming call failed',
  grpcNoEndStatus: 'The connection dropped before the final status arrived',
  grpcDisconnected: 'The connection dropped',
  grpcNoSessionId: 'The server returned no session id',
  grpcCreateFailed: 'Could not open the session',
  grpcHalfClosed: 'Sending finished; waiting for the server to send the rest'
};
