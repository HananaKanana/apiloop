/**
 * folder region: the folder settings tab (`components/folder/`) — name,
 * description, folder variables, folder-level authorization, shared headers,
 * scripts and preflight request.
 */
export default {
  settingsTitle: 'Folder settings',
  location: 'Location: {path}',
  runHint: 'Run the APIs in this folder one after another',
  nameRequired: 'Please enter a folder name',
  gone: 'This folder is gone; it may have just been deleted.',
  readonlyHint: 'Your role is read-only, so you can only look at the folder settings.',
  basicTitle: 'Basics',
  nameLabel: 'Name',
  namePlaceholder: 'Folder name',
  descLabel: 'Description',
  varsTitle: 'Folder variables',
  varsTip: 'Folder variables are expanded when sending; the priority is project < outer folder < inner folder < environment, later ones win. APIs and subfolders in this folder can use them.',
  authTitle: 'Folder authorization',
  authTip: 'APIs and subfolders here that choose “Inherit from parent” fall back to this level.',
  authLevelFolder: 'folder “{name}”',
  authLevelProject: 'project',
  headersTitle: 'Shared headers',
  headersTip: 'Every API in this folder sends with these headers; an API that sets the same header wins.',
  headerNamePlaceholder: 'Header',
  headerValuePlaceholder: 'Value',
  scriptsTitle: 'Scripts',
  scriptsTip: 'APIs in this folder run their pre-request scripts in the order project → folder (outside in) → API, and their post-response scripts in the same order.',
  preflightTitle: 'Preflight request',
  preflightTip: 'Before sending, APIs in this folder call the selected API once (usually a login API) to fetch a token. Without one they follow the outer level (parent folder → project).'
};
