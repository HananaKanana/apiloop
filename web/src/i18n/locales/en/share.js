/**
 * share region: sharing (`components/share/`) — the dialog that creates a share
 * link, the “Share links” panel in project settings, and “My shares” in the
 * account menu.
 */
export default {
  /* ---------------- create ---------------- */
  dialogTitleProject: 'Share the whole project as a document',
  dialogTitleFolder: 'Share the document of folder “{name}”',
  expires: 'Expires',
  expires30: '30 days',
  expires7: '7 days',
  expiresNever: 'Never',
  generate: 'Create link',
  copy: 'Copy',
  linkCopied: 'Link copied',
  linkActiveLead: 'This link is live. All links you have shared are listed under',
  manageLinkText: 'Project settings → Share links',
  linkActiveTail: ', where you can copy or revoke them again.',
  tip: 'Anyone opening the link sees the URLs, parameters and examples of these APIs without signing in. Secret variables and credentials never appear. What is shared is the cloud copy, so changes not synced from this computer yet are missing.',

  /* ---------------- panel ---------------- */
  panelTip: 'What is shared is the cloud copy of the API document; anyone opening the link can read it without signing in. Revoking takes the link down immediately.',
  noShares: 'No share link yet. Right-click an API in the tree and choose “Share document” to create one.',
  revokeTitle: 'Revoke share link',
  revokeAction: 'Revoke',
  revokeBody: 'The link stops working right away and the document of {scope} can no longer be opened. Continue?',
  revoked: 'Revoked',
  folderScope: 'folder “{name}”',
  projectScope: 'the whole project',
  colScope: 'Scope',
  colCreatedBy: 'Created by',
  colCreator: 'Created by',
  colCreatedAt: 'Created at',
  colExpiresAt: 'Expires at',
  colActions: 'Actions',

  /* ---------------- my shares ---------------- */
  mySharesTitle: 'Share links',
  mySharesTip: 'These links open without signing in. Revoke the ones you no longer need.',
  mySharesEmpty: 'No API document has been shared yet. Right-click a folder in the tree and choose “Share document”.',
  colProject: 'Project',
  quotedName: '“{name}”',
  thisProject: 'this project',
  wholeProjectScope: 'the whole project',
  revokeBodyMine: 'The link stops working right away and {project} / {scope} can no longer be opened. Continue?',

  /* ---------------- “Try it” in the document (public document page) ---------------- */
  tryButton: 'Try it',
  tryHint: 'The request goes to Mock, so you get sample data, not the real backend.',
  tryCopyCurl: 'Copy as cURL',
  tryCopiedCurl: 'cURL copied',
  tryPathTitle: 'Path parameters',
  tryQueryTitle: 'Query parameters',
  tryHeadersTitle: 'Headers',
  tryBodyTitle: 'Body',
  tryNoBody: 'This API has no request body',
  tryBinaryBody: 'The request body of this API is a binary file, so the shared page cannot try it.',
  tryFormFile: 'File field (the shared page cannot reach your local file, so it is skipped when sending)',
  trySend: 'Send',
  trySending: 'Sending…',
  tryStatus: 'Status',
  tryDuration: 'Time',
  trySize: 'Size',
  tryTabBody: 'Body',
  tryTabHeaders: 'Response headers',
  tryEmptyBody: '(empty response)',
  tryNetworkError: 'Request failed: {message}',
  tryUnresolved: 'The URL still contains variables that were not replaced; Mock may not recognise it.'
};
