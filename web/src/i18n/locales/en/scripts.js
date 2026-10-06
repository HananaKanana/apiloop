/**
 * scripts region: user-visible text under `web/src/components/scripts/`
 * (script editor, common snippets).
 *
 * Terminology follows the glossary in README.md: Variable, Environment, Assertion,
 * Pre-request, Response.
 * Note: the `code` field of a snippet is script source inserted into the editor
 * and is never translated.
 */
export default {
  /* ---------------- ScriptEditor ---------------- */
  phasePrerequest: 'Pre-request',
  phaseTest: 'Response',
  hintPrerequest:
    'Runs before the request is sent. Variables changed here take part in variable substitution; if it throws, the request is not sent.',
  hintTest:
    'Runs after the response comes back. Write assertions with pm.test; results show under "Test results" in the response panel.',
  snippets: 'Snippets',
  helpLink: 'How do I write these? See help and examples',
  readonlyHint: 'Your role is read-only, so scripts cannot be modified.',

  /* ---------------- Common snippets ---------------- */
  snippetSetEnv: 'Set an environment variable',
  snippetJsonToEnv: 'Read a value from the JSON response into an environment variable',
  snippetStatus200: 'Check that the status code is 200',
  snippetResponseTime: 'Check that the response time is under 500ms',
  snippetBodyContains: 'Check that the response body contains a field',
  snippetSendRequest: 'Get a token with pm.sendRequest'
};
