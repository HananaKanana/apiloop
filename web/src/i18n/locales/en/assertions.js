/**
 * assertions region: user-visible text of `web/src/components/assertions/`
 * (the Assertions / Extract variables tab).
 *
 * Terminology follows the glossary in README.md: Assertion, Extract, Environment, Mock.
 * The dropdown options (what to check, comparison, extract from, store to) and the
 * per-source input hints come from `utils/assertions.js` (the utils region); only the
 * text rendered by the component itself lives here.
 */
export default {
  /* ---------------- AssertionsPane ---------------- */
  title: 'Assertions',
  note: 'Runs after the response is received (before the response script; the script can use variables just extracted)',
  checkWhat: 'Check',
  fieldOrName: 'Field / name',
  compareBy: 'Comparison',
  expectedValue: 'Expected value',
  emptyAssertions: 'No assertions yet. Click the button below to add one.',
  addAssertion: '+ Add assertion',
  commonPresets: 'Common:',
  extracts: 'Extract variables',
  extractNote: "Save values from the response as variables; the next request can reference them with {'{'}{'{'}name{'}'}{'}'}",
  envHint: 'No environment is selected (or the built-in Mock environment is selected), so variables extracted to an environment are not saved.',
  extractFrom: 'Extract from',
  pathHeader: 'Path / header name / regex',
  storeTo: 'Store to',
  varName: 'Variable name',
  emptyExtracts: 'Nothing extracted yet. Tokens and IDs from the previous step can be saved for the next API.',
  addExtract: '+ Add extract',
  noValueNeeded: 'Not required',
  valuePlaceholder: "Expected value (you can use {'{'}{'{'}variable{'}'}{'}'})"
};
