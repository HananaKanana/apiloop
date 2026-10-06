/**
 * fields region: user-visible text of `web/src/components/fields/`
 * (the Response field descriptions tab).
 *
 * Terminology follows the glossary in README.md: Field, Example, OpenAPI.
 * The type dropdown values are JSON type names (string / number / …), i.e. code, not translated.
 */
export default {
  /* ---------------- ResponseFieldsTab ---------------- */
  title: 'Response field descriptions',
  generateFromExample: 'Generate from example',
  clearMissing: 'Remove fields missing from the example ({n})',
  saveFirstHint: 'Save it as an API first to generate from an example',
  noExamplesHint: 'This API has no examples yet',
  tip: 'For frontend developers and integrators: what each field means. Descriptions appear in the shared API document and in the exported OpenAPI.',
  colField: 'Field',
  colType: 'Type',
  colDesc: 'Description',
  colRequired: 'Required',
  missingTag: 'No longer in the example',
  descPlaceholder: 'What does this field mean?',
  deleteRow: 'Delete this row',
  empty: 'No fields yet. Generate from an example, or add a row manually.',
  addPathPlaceholder: 'Add a row manually: field path, e.g. data.list[].id',
  add: 'Add',
  unnamedExample: 'Example {n}',
  exampleOption: '{name} ({status})',
  selectExampleFirst: 'Select an example first',
  noFieldsInExample: 'This example has no listable fields',
  generatedCount: 'Listed {n} field | Listed {n} fields',
  pathRequired: 'Enter a field path, e.g. data.list[].id',
  pathExists: 'This path already exists'
};
