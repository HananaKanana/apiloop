/**
 * sio region: user-visible text under `web/src/components/sio/`
 * (Socket.IO tab).
 *
 * Terminology follows the glossary in README.md: Socket.IO, WebSocket, Cookie,
 * JSON and ack are proper nouns / protocol terms and are not translated.
 */
export default {
  /* ---------------- SioTab: status ---------------- */
  statusIdle: 'Not connected',
  statusOpen: 'Connected',
  statusConnecting: 'Connecting…',
  statusError: 'Error',
  statusClosed: 'Disconnected',

  /* ---------------- SioTab: buttons ---------------- */
  connect: 'Connect',
  reconnect: 'Reconnect',
  disconnect: 'Disconnect',
  save: 'Save',
  send: 'Send',
  saveAsCommon: 'Save as common',

  /* ---------------- SioTab: notices ---------------- */
  readonlyNotice: 'Read-only role: connection settings cannot be changed and Connect is unavailable.',
  connectBlockedTooltip: 'The web version cannot connect; use the desktop client (or ask the administrator to enable sending in the cloud)',
  connectBlocked: 'The web version cannot connect; use the desktop client',
  authInvalid: 'auth is not valid JSON and was not saved',
  connectFailed: 'Connection failed',
  notConnected: 'Not connected yet',
  eventNameRequired: 'Please enter an event name first',
  argsInvalid: 'Arguments are not valid JSON',
  sendFailed: 'Send failed',
  commonSaved: 'Saved this common send',
  saved: 'Saved',

  /* ---------------- SioTab: options ---------------- */
  transportPolling: 'Polling first, then upgrade',
  transportWebsocket: 'WebSocket only',

  /* ---------------- SioTab: connection form ---------------- */
  titlePlaceholder: 'API name',
  transportLabel: 'Transport',
  headerLabel: 'Headers',
  headerPlaceholder: 'Header name',
  valuePlaceholder: 'Value',
  queryLabel: 'Query params',
  paramName: 'Parameter name',
  authLabel: 'Auth (headers / query params, same rules as HTTP APIs)',
  handshakeAuthLabel: 'Handshake auth (JSON)',
  handshakeAuthNote: 'Socket.IO auth is an object passed during the handshake; it is different from the auth above',
  listenEventsLabel: 'Events to listen to',
  listenEventsNote: 'One per line; leave empty to listen to all events',

  /* ---------------- SioTab: send ---------------- */
  eventNamePlaceholder: 'Event name',
  waitAck: 'Wait for ack',
  argsPlaceholder: '["hello", 1]',
  commonSends: 'Common sends',
  noSends: 'No common sends yet. Write an event and click "Save as common"; next time one click sends it.',

  /* ---------------- SioTab: tabs ---------------- */
  tabConnect: 'Connect',
  tabSend: 'Send',
  tabLog: 'Messages'
};
