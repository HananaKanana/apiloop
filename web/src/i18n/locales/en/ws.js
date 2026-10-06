/**
 * ws region: user-visible text under `web/src/components/ws/`
 * (WebSocket tab, message log, save-as-mock preview dialog).
 *
 * Terminology follows the glossary in README.md: WebSocket, Mock and Cookie are
 * proper nouns and are not translated.
 *
 * Note: when a message contains the literal `{{variables}}`, vue-i18n treats `{}`
 * as interpolation syntax, so it must be escaped as a literal (`{{` becomes
 * `{'{'}{'{'}`).
 */
export default {
  /* ---------------- Shared ---------------- */
  connect: 'Connect',
  disconnect: 'Disconnect',
  save: 'Save',
  saveToFolder: 'Save to folder',
  conflictText: 'This API conflicts with the cloud',
  resolve: 'Resolve',
  recent: 'Recent',
  urlPlaceholder: "wss://echo.example.com/socket, supports {'{'}{'{'}variables{'}'}{'}'}",
  connectBlockedTooltip: 'The web version cannot connect; use the desktop client (or ask the administrator to enable sending in the cloud)',
  connectBlocked: 'The web version cannot connect; use the desktop client',
  noProject: 'No project selected yet',
  rootFolder: '(root folder)',
  apiNameRequired: 'Please enter an API name',
  readonlyCannotSave: 'Your role is read-only; you cannot save changes',

  /* ---------------- WsTab: status ---------------- */
  statusIdle: 'Not connected',
  statusConnecting: 'Connecting…',
  statusOpen: 'Connected',
  statusClosed: 'Disconnected',
  statusEnded: 'Session ended',
  statusError: 'Error',
  channelRetrying: 'The event stream dropped; reconnecting…',
  channelEnded: 'The session was reclaimed by the server',

  /* ---------------- WsTab: connection ---------------- */
  urlRequired: 'Please enter the WebSocket URL first',
  schemeRequired: 'The URL must start with ws:// or wss://',

  /* ---------------- WsTab: tabs ---------------- */
  tabSettings: 'Settings',
  headerPlaceholder: 'Header',
  valuePlaceholder: 'Value',
  paramName: 'Parameter name',
  protocolHint: 'Sec-WebSocket-Protocol is negotiated as a subprotocol and is not sent as an ordinary header.',
  cookieOptionTitle: 'Send cookies automatically',
  cookieOptionDesc: 'On connect, matching cookies are taken from the cookie store by target address. Set-Cookie in the handshake response is not available and is not written back.',

  /* ---------------- WsTab: log and composer ---------------- */
  messageLog: 'Message log',
  saveScenarioTitle: 'Generate a replay scenario from the message log and save it as a ws example',
  saveAsMock: 'Save as mock',
  clearLog: 'Clear log',
  composerPlaceholder: 'Content to send, Ctrl+Enter to send',
  send: 'Send',

  /* ---------------- WsTab: save ---------------- */
  saved: 'Saved',
  renamed: 'Renamed',
  savedToFolder: 'Saved to folder',
  wsRecordedName: 'WS recorded at {time}',
  savedWsExample: 'Saved as a WebSocket example',
  nameLabel: 'Name',
  apiNamePlaceholder: 'API name',
  folderLabel: 'Folder',

  /* ---------------- WsMessageLog ---------------- */
  directionOut: '↑ Sent',
  directionAck: '↩ Ack',
  directionIn: '↓ Received',
  logOverflow: 'Only the most recent 2000 are shown; the earlier {n} has been dropped. | Only the most recent 2000 are shown; the earlier {n} have been dropped.',
  truncatedNote: 'This message exceeded 64 KB; the server kept only the beginning, and the length shown is the original size.',
  empty: 'No messages yet.',
  logBinarySummary: '(binary content, {size})',
  logConnected: 'Connected',
  logConnectedProtocol: 'Connected, subprotocol {protocol}',
  logClosed: 'Connection closed: code {code}',
  logClosedReason: ', {reason}',
  logError: 'Error: {message}',

  /* ---------------- WsScenarioDialog ---------------- */
  scenarioTitle: 'Save as mock',
  scenarioPushLead: 'Will push ',
  scenarioPushMid: ' messages and generate ',
  scenarioRuleTail: ' rules',
  scenarioSkipLead: ', skipping ',
  scenarioSkipTail: ' binary messages',
  scenarioPeriod: '.',
  scenarioBinaryNote: 'Binary messages cannot be matched by text and will not appear during replay.',
  scenarioCappedDelays: '{n} interval exceeded 60 seconds and was saved as 60 seconds (the limit defined by the contract). | {n} intervals exceeded 60 seconds and were saved as 60 seconds (the limit defined by the contract).',
  scenarioTruncated: 'The total number of steps exceeded 1000; only the first 1000 steps were kept, and {n} step was not saved. | The total number of steps exceeded 1000; only the first 1000 steps were kept, and {n} steps were not saved.',
  scenarioDuplicates: '{n} duplicate sent message. Rules are "the first match wins", so the duplicate and the reply it received cannot be replayed; only the first rule was kept. | {n} duplicate sent messages. Rules are "the first match wins", so the duplicates and the replies they received cannot be replayed; only the first rule was kept.',
  scenarioGenerated: 'Generated scenario'
};
