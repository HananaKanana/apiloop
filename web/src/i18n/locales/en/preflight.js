/**
 * preflight region: user-visible text under `web/src/components/preflight/`
 * (pre-request API settings).
 *
 * Terminology follows the glossary in README.md: API, Variable, Assertion, Pre-request.
 *
 * Note: the dropdown option labels and the summary line come from
 * `optionsFor` / `describe` in `utils/preflight.js` (the utils region, owned by
 * T24); this region does not carry their keys.
 */
export default {
  /* ---------------- PreflightPanel ---------------- */
  label: 'Pre-request API',
  selectPlaceholder: 'Pick an API (usually the login API)',
  variableLabel: 'Variable',
  whenMissingSuffix: 'call it first when it has no value',
  retryOn401Label: 'on a 401 response, call it and resend once',
  tip: 'The pre-request API must store the token itself (extract a variable on its "Assertion" tab, or use a response script) — this only decides when to call it. It does not trigger a pre-request API of its own.'
};
