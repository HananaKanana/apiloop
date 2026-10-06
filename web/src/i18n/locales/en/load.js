/**
 * load region: user-visible text under `web/src/components/load/`
 * (load-test settings, live numbers, result summary, real-time chart).
 *
 * Terminology follows the glossary in README.md: Environment, Variable.
 * Proper nouns stay untranslated: QPS, Mock.
 *
 * Note: when a message contains the literal `{{variables}}`, vue-i18n treats `{}` as
 * interpolation syntax, so it must be escaped as a literal (`{{` becomes `{'{'}{'{'}`),
 * otherwise compilation fails with "Not allowed nest placeholder".
 */
export default {
  /* ---------------- Shared ---------------- */
  noEnvironment: 'No environment',
  mockBuiltIn: 'Mock (built-in)',
  listSeparator: ', ',

  /* ---------------- LoadTab ---------------- */
  environment: 'Environment',
  concurrency: 'Concurrency',
  stopCondition: 'Stop condition',
  byCount: 'By count',
  byDuration: 'By duration',
  seconds: 's',
  rampUp: 'Ramp-up',
  timeout: 'Timeout',
  milliseconds: 'ms',
  countAsSuccess: 'Count as success',
  okStatusPlaceholder: 'Leave empty for 2xx and 3xx, or write e.g. 200,201',
  hint: 'Load testing only looks at status codes and response times: no scripts, no assertions, no history. Variables are resolved once per environment at the start.',
  stop: 'Stop',
  start: 'Start load test',
  blockedNotice: 'The web version cannot run load tests; use the desktop client.',
  blockedHint: 'The web version cannot run load tests; use the desktop client',
  pressureWarning: 'A load test puts real pressure on the target server; confirm with the API owner first',
  varExample: "{'{'}{'{'}name{'}'}{'}'}",
  missingVariables: 'These variables have no value and will be sent as-is in the URL: {example}. Missing: {vars}',
  prodTitle: 'Load test a production environment',
  prodConfirm: 'You are about to load test a production environment: {env}. Continue?',
  prodContinue: 'Continue',
  statusFinished: 'Finished',
  statusStopped: 'Stopped',
  statusError: 'Failed',
  resultCopied: 'Result copied',
  copyResult: 'Copy result',
  sent: 'Sent',
  success: 'Success',
  failed: 'Failed',
  currentQps: 'Current QPS',
  avgResponse: 'Avg response',
  active: 'Active',
  elapsedTime: 'Elapsed',
  totalRequests: 'Total requests',
  errorRate: 'Error rate',
  totalDuration: 'Total duration',
  avgQps: 'Avg QPS',
  min: 'Min',
  avg: 'Avg',
  max: 'Max',
  statusCodesTitle: 'Status code distribution',
  noResponses: 'No responses received',
  errorsTitle: 'Error groups',
  noNetworkErrors: 'No network errors (responses with the wrong status count as failures; see the status code distribution on the left)',
  aborted: '{n} request was cancelled when you stopped; it counts as neither success nor failure. | {n} requests were cancelled when you stopped; they count as neither success nor failure.',
  previousTitle: 'Previous result',
  previousSummary:
    'Total {sent} · success {ok} · failed {failed} ({rate}) · avg {avg} · P95 {p95} · QPS {qps} · duration {duration}',

  /* ---------------- LoadChart ---------------- */
  legendQps: 'Requests per second',
  legendMs: 'Avg response time per second',
  legendFailed: 'Seconds with failures',
  chartEmpty: 'No data yet',
  chartAria: 'Load test chart'
};
