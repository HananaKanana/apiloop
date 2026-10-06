/**
 * importExport region: import / export (`components/importExport/`) — the import
 * dialog (JSON file, YApi, Apifox, cURL, OpenAPI, HAR), the external-format import
 * panel, the OpenAPI export dialog and the document export dialog.
 */
export default {
  /* ---------------- shared ---------------- */
  done: 'Import finished',
  importAction: 'Import',
  pickFile: 'Choose a file…',
  clear: 'Clear',
  preview: 'Parse and preview',
  typeLine: 'Type: {type}',
  nameLine: 'Name: {name}',
  detectedLine: 'Detected as: {format}',
  quoted: '“{name}”',
  needEditor: 'Importing into the current project needs the editor role or above.',
  readonlyHint: 'Your role is read-only, so this can only be imported as a new project (you become its owner).',
  intoCurrent: 'Import into the current project',
  newProject: 'New project (named after the project in the file)',
  pickProjectFirst: 'Pick a project first',
  stats: '{folders} folder(s), {apis} API(s), {examples} example(s)',
  statsScripts: ', {n} script(s)',
  statsEnvs: ', {n} environment(s)',
  none: 'None',
  text: 'Text',
  form: 'Form',
  file: 'File',

  /* ---------------- JSON file / YApi / Apifox ---------------- */
  jsonFileTab: 'JSON file',
  pasteOrPickJson: 'Paste JSON or choose a file',
  orPasteJson: 'Or paste the JSON right here',
  collectionPlaceholder: 'Paste the JSON of a collection, environments or globals (Collection v2.1)',
  yapiPlaceholder: 'Paste the file downloaded from a YApi project under “Data export → json”',
  apifoxPlaceholder: 'Paste the .apifox.json downloaded from Apifox under “Export → Apifox format”',
  pickOrPaste: 'Choose a file, or paste the JSON below',
  orPaste: 'Or paste the JSON right here',
  newProjectFromCollection: 'New project (named after the collection)',
  newProjectFromHar: 'New project (named after the page title in the HAR)',
  globalsHint: 'Environments and globals are imported into the current project.',
  formatPostman: 'Postman collection',

  /* ---------------- cURL ---------------- */
  curlPlaceholder: "Paste the browser's Copy as cURL here; it is parsed as you paste",
  curlStats: '{headers} header(s) · {query} query parameter(s) · body: {body} · auth: {auth}',
  intoSelected: 'It goes into the folder selected in the tree',
  intoSelectedImport: 'They are imported into the folder selected in the tree',
  intoRoot: 'No folder is selected, so it goes to the root',
  intoByGroup: 'No folder is selected, so top-level folders are created per tag',
  openInNewTab: 'Open in a new tab',
  intoCurrentFolder: 'Import into the current folder',
  importedInto: 'Imported into{where}',
  selectedFolder: ' the selected folder',
  rootFolder: ' the root',

  /* ---------------- OpenAPI ---------------- */
  urlBlockedHint:
    'The web version cannot fetch a URL (the cloud cannot reach a LAN). Pick a file or paste the content; to use a URL, import from the apiloop client.',
  urlBlockedShort: 'The web version cannot fetch a URL; please import from the client',
  urlOrFileOrPaste: 'Enter a URL, choose a file, or paste the content',
  openapiUrlPlaceholder: 'API doc URL, e.g. http://intranet/v3/api-docs or /swagger.json (leave empty to use the file or the pasted content)',
  openapiPastePlaceholder: 'Paste the OpenAPI / Swagger definition (JSON or YAML)',
  openapiFileHint: 'Supports .json / .yaml / .yml, or paste the content right here',
  loaded: 'Loaded {name}',
  fetchAndParse: 'Fetch and parse',
  parse: 'Parse',
  parsedCount: 'Parsed {n} API(s)',
  importedApis: 'Imported {n} API(s). Later, when the backend changes an API, you can right-click it in the tree and choose “Sync from OpenAPI”.',

  /* ---------------- HAR ---------------- */
  pasteOrPickHar: 'Paste the HAR content or choose a file',
  orPasteHar: 'Or paste the JSON right here (up to 50MB)',
  harPlaceholder: 'Browser devtools → Network panel → right-click → Save all as HAR with content',
  harTooBig: 'This HAR is {size}, over the 50MB limit',
  keepCredentials: 'Keep credentials',
  keepCredentialsWarn: 'Cookie and Authorization are written into the project as they are; every project member can see them',
  harStats: '{hosts} host(s), {apis} API(s), {examples} example(s)',

  /* ---------------- export ---------------- */
  exported: 'Exported',
  exportAction: 'Export',
  format: 'Format',
  formatHtml: 'HTML (single file, the sidebar is clickable)',
  scope: 'Scope',
  thisFolder: 'This folder (including subfolders): {name}',
  wholeProject: 'The whole project',
  options: 'Options',
  withExamples: 'Include example responses',
  withMockUrl: 'Include Mock URLs',
  doneOnly: 'Only export finished APIs',
  exportDocHint: 'Passwords, tokens and the like are masked; environment variable values and scripts are not exported.',
  exportDoc: 'Export document',
  exportDocFor: 'Export document: {name}',
  exportOpenapi: 'Export as OpenAPI',
  exportOpenapiFor: 'Export as OpenAPI: {name}',
  openapiHintLead: 'Variables (like ',
  openapiHintTail: ') are kept as they are; for authorization only the type is exported, not the value.'
};
