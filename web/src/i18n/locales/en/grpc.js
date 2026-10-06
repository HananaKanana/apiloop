/**
 * grpc region: user-visible text under `web/src/components/grpc/`
 * (gRPC tab, response area, streaming message list, and the labels / notes meant
 * for humans inside grpc-util).
 *
 * Terminology follows the glossary in README.md: Project, Folder, API, Environment,
 * Variable, Mock, Test suite, Assertion, Extract, Example, Expectation, Workbench.
 *
 * Note: when a message contains the literal `{{variables}}`, vue-i18n treats `{}` as
 * interpolation syntax, so it must be escaped as a literal (`{{` becomes `{'{'}{'{'}`),
 * otherwise compilation fails with "Not allowed nest placeholder". The variable name in
 * examples follows the language (zh `变量` / en `variables`).
 */
export default {
  /* ---------------- GrpcTab ---------------- */
  varHint: "{'{'}{'{'}variables{'}'}{'}'}",
  namePlaceholder: 'API name',
  copyAsGrpcurl: 'Copy as grpcurl',
  save: 'Save',
  saved: 'Saved',
  serviceMethodPlaceholder: 'Service / method',
  disconnect: 'Disconnect',
  connect: 'Connect',
  call: 'Call',
  readonlyNotice:
    'Read-only role: you can view what is configured, but cannot change or save parameters, and calling is unavailable too.',
  webNoCallPrefix: 'The web version cannot call gRPC; use the desktop client. ',
  webNoCallBold: 'Proto can only be parsed in the desktop client',
  webNoCallSuffix: ', so the Service / method dropdown here only shows the one you saved.',
  parsingProto: 'Parsing proto…',
  reflectEmpty: 'No services were parsed from the saved descriptor; use Fetch from server again.',
  parseEmpty: 'No services parsed yet. Check that the proto file content below is correct.',
  messages: 'Messages',
  generateExample: 'Generate example',
  savedMessages: 'Saved messages',
  saveAsSaved: 'Save as saved',
  send: 'Send',
  endSend: 'End sending',
  streamHalfClosed: 'Sending has ended; waiting for the server to finish',
  streamSendHint: 'Click Connect first, then send one at a time; click End sending when done',
  streamConnectFirst: 'Click Connect above first',
  metadataHintPrefix: 'Metadata sent with the call (both keys and values support ',
  metadataHintSuffix: ')',
  keyPlaceholder: 'Key',
  valuePlaceholder: 'Value',
  tabDefinition: 'Service definition',
  fetchFromServer: 'Fetch from server',
  fetchedAt: 'Fetched at {time}',
  notFetchedYet: 'Not fetched yet',
  autoReparse: 'Changes are reparsed automatically',
  reflectedGot: 'Got ',
  reflectedServicesSuffix: ' services, ',
  reflectedMethodsAt: ' methods, fetched at {time}.',
  reflectedSaved: 'The descriptor is saved with the API, so you do not need to reconnect next time.',
  noReflectionYet: 'No descriptor fetched from the server yet',
  webNoReflectHint:
    'The web version does not have this endpoint: the Service / method dropdown only shows the one you saved. To fetch again, open it in the desktop client.',
  importProto: 'Import .proto',
  newFile: 'New',
  noProtoFiles: 'No proto files yet',
  fileNameLabel: 'File name (imports look up other files by this name)',
  tabAssertions: 'Assertions',
  assertionsHint:
    'After the call ends, assertions and extracts run against the Response below (same usage as HTTP APIs): the status code is the gRPC status code, the response headers are metadata and trailers combined, and the response body is the single unary message, or an array of all messages for server streaming.',
  tabSettings: 'Settings',
  timeoutLabel: 'Timeout (ms)',
  timeoutNote:
    'Cancels this call when it is reached; the status will say DEADLINE_EXCEEDED. Default {n} ms.',
  methodUnparsed: '{service} / {method} (not parsed)',
  sourceProto: 'Import proto files',
  sourceReflection: 'Server reflection',
  fillTargetFirst: 'Enter the service address first (host:port)',
  reflectTooLarge: 'The descriptor was too large to save; it will be fetched again each time you open this',
  reflectedCount: 'Fetched {n} service | Fetched {n} services',
  reflectFailed: 'Fetch failed',
  parseFailed: 'Parse failed',
  noMethodForExample: 'Select a method first (examples are available after the proto is parsed)',
  parseProtoInClient: 'To parse proto, open this API in the desktop client',
  messageEmpty: 'The message is empty; write one first',
  saveAsSavedTitle: 'Save as a saved message',
  saveAsSavedLabel: 'Give this message a name so you can insert it from Saved messages next time',
  savedMessageDefaultName: 'Saved message {n}',
  savedMessagePlaceholder: 'Query user #1',
  savedMessageSaved: 'Saved as a saved message',
  savedMessageSavedLocal: 'Saved as a saved message (kept only after saving to a folder)',
  webNoStream: 'The web version cannot connect to gRPC; use the desktop client',
  webNoCall: 'The web version cannot call gRPC; use the desktop client',
  readonlyNoCall: 'A read-only role cannot make calls',
  selectServiceMethod: 'Select a service and method first',
  writeMessageFirst: 'Write a message first',
  copiedGrpcurl: 'grpcurl command copied',

  /* ---------------- GrpcResponse ---------------- */
  responseLabel: 'Response',
  notCalledYet: 'Not called yet',
  calling: 'Calling…',
  cancelled: 'Cancelled',
  failed: 'Failed',
  passed: 'Passed',
  dropped: '(Too many messages; the first {n} were omitted)',
  missingVars: 'These variables have no value: {vars} (sent as-is; check the current environment)',
  listSeparator: ', ',
  messagesCount: ' ({n})',
  noMessages: 'No messages',
  waitingResponse: 'Waiting for the response…',
  noMetadata: 'No Metadata',
  noTrailers: 'No Trailers',
  noTestsOrExtracts: 'No assertions or extracts (add them on the Assertions tab)',
  extractedVars: 'Extracted variables',
  testsLabel: 'Test results',
  testsCount: ' ({passed}/{total})',
  testsExtracted: ' · Extracted {n}',

  /* ---------------- GrpcStreamList ---------------- */
  entrySent: 'Sent',
  entryReceived: 'Received',
  entrySystem: 'Info',
  clear: 'Clear',
  noMessagesYet: 'No messages yet',

  /* ---------------- grpc-util ---------------- */
  methodClientStream: ' · client streaming (unsupported)',
  methodServerStream: ' · server streaming',
  grpcurlPlaceholder: '<service>/<method>',
  grpcurlStreamingNote:
    'This command is for client / bidirectional streaming: after starting it, paste JSON messages one per line; an empty line ends sending',
  grpcurlReflectionNote:
    'It uses server reflection, so there is no -proto; if the server has reflection disabled, export the proto file first and switch to the -proto form',
  grpcurlMultiProtoNote:
    'This API has {n} proto files but the command only includes the first; put the other imported files in the -import-path directory too',
  grpcurlLocalProtoNote:
    'Save {name} to the current directory first (the proto is stored in the API, and grpcurl reads local files)'
};
