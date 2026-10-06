/**
 * openapi region: user-visible text under `web/src/components/openapi/`
 * (the "Sync updates from OpenAPI" dialog).
 *
 * Terminology follows the glossary in README.md: OpenAPI / Swagger / JSON / YAML /
 * Mock are not translated, folders use "Folder", Trash is used for the recycle bin.
 */
export default {
  /* ---------------- SyncDialog ---------------- */
  dialogTitle: 'Sync updates from OpenAPI',
  scope: 'Scope: {scope}',
  scopeFolder: 'folder "{name}" (including subfolders)',
  scopeProject: 'the entire project',
  modeUrl: 'URL',
  modeText: 'Paste content',
  urlBlockedHint:
    'The web version cannot fetch from a URL (the cloud cannot reach your intranet). Paste the document content instead; to use a URL, sync from the apiloop desktop client.',
  urlPlaceholder: 'API document URL, e.g. http://intranet-host/v3/api-docs or /swagger.json',
  textPlaceholder: 'Paste the OpenAPI / Swagger definition (JSON or YAML)',
  check: 'Check for updates',
  urlRemembered: 'The URL is remembered and filled in next time',
  urlBlockedCheck: 'The web version cannot fetch from a URL; switch to "Paste content" or check from the desktop client',
  urlRequired: 'Enter a URL, or switch to "Paste content"',
  textRequired: 'Paste the OpenAPI definition',
  upToDate: 'Already up to date',
  groupAdded: 'Added ({n})',
  groupChanged: 'Changed ({n})',
  groupRemoved: 'Removed from the document ({n})',
  groupRemovedNote: 'Only processed if checked; moved to Trash (not permanently deleted)',
  unnamed: '(unnamed)',
  rootFolder: 'Project root',
  empty: '(empty)',
  applyTip: 'Only the URL, params, request body fields, name and description are updated; your scripts, examples, Mock and auth settings are preserved.',
  nothingSelected: 'Nothing selected',
  applyResult: 'Added {added}, updated {updated}, moved to Trash {removed}',
  selectedCount: '{n} selected',
  apply: 'Sync selected'
};
