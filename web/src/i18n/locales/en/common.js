/**
 * common region: user-visible text of the shared components under
 * `web/src/components/common/` (inline rename, key-value table, variable input,
 * variable table, templatize dialog, …).
 *
 * Terminology follows the glossary in README.md: Variable, Secret variable, Example.
 * CodeEditor / ContextMenu have no user-visible text (comments only), so they have no section here.
 */
export default {
  /* ---------------- InlineRename ---------------- */
  renameHint: 'Double-click to rename',

  /* ---------------- KeyValueTable ---------------- */
  paramName: 'Parameter name',
  value: 'Value',
  description: 'Description',
  batchEdit: 'Bulk edit',
  exitBatchEdit: 'Exit bulk edit',
  showDescColumn: 'Show description column',
  hideDescColumn: 'Hide description column',
  batchPlaceholder: 'One per line: key: value; prefix with // to disable',
  apply: 'Apply',
  tableOptions: 'Table options',
  deleteRow: 'Delete this row',

  /* ---------------- TemplatizeDialog ---------------- */
  templatizeTitle: 'Smart templatization',
  templatizeNone: 'No values to randomize were found; the content is unchanged.',
  templatizeTip: 'These values will be replaced with placeholders that are random each time; the structure and field types stay the same. It takes effect only after you confirm.',
  templatizePath: 'Path',
  templatizeFrom: 'Original value',
  templatizePlaceholder: 'Placeholder',
  templatizeCount: '{n} replacement in total | {n} replacements in total',
  templatizeConfirm: 'Confirm replacement',

  /* ---------------- VarInput ---------------- */
  dynamicVariable: 'Built-in dynamic variable',
  tooltipMock: '{token}: Mock placeholder, expanded only when Mock renders',
  tooltipDynamic: '{token}: built-in dynamic variable, generates a new value each time it appears',
  tooltipLiteral: 'Not a variable; kept as-is when sent',
  tooltipUndefined: 'Undefined — add it in an environment, folder, or project variable',

  /* ---------------- VarTable ---------------- */
  varName: 'Variable name',
  secretHint: 'Only you can see it; it syncs across the devices you are signed in on and is never shared with other members',
  secretValuePlaceholder: 'Only you can see it',
  secretToggleOnTitle: 'Click to make it secret (only you can see it; it syncs across your devices)',
  secretToggleOffTitle: '{hint}, click to switch back to plain text',
  resizeColumn: 'Drag to resize the column',
  secretDialogTitle: 'Make secret variable',
  secretDialogBody: 'Once made secret, only you can see this value; it syncs across the devices you are signed in on and is never shared with other members.',
  secretDialogConfirm: 'Make secret'
};
