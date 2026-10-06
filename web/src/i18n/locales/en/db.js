/**
 * db region: user-visible text under `web/src/components/db/`
 * (database connections in project settings, the API's Database tab).
 *
 * Terminology follows the glossary in README.md: Environment, Variable, Folder.
 * Proper nouns stay untranslated: Redis, MySQL, PostgreSQL, SQL, Mock.
 *
 * Note: when a message contains the literal `{{variables}}`, vue-i18n treats `{}` as
 * interpolation syntax, so it must be escaped as a literal (`{{` becomes `{'{'}{'{'}`),
 * otherwise compilation fails with "Not allowed nest placeholder".
 *
 * The connection hint sentence wraps `<code>{{variables}}</code>` elements, so it is split
 * into hintLead / hintMid / hintTail (same for noEnv) to keep each value within one text run.
 */
export default {
  /* ---------------- DatabasePanel ---------------- */
  name: 'Name',
  type: 'Type',
  address: 'Address',
  edit: 'Edit',
  emptyConnections: 'No connections yet. Once you add one, you can pick it in the API\u2019s Database tab to seed and query data.',
  addConnection: '+ New connection',
  webUnavailable: 'The web version cannot connect to databases: connections must be added, edited and tested in the desktop client (database operations also only run there).',
  readonlyHint: 'Read-only roles can only view the connection list; they cannot change it.',
  editConnectionTitle: 'Edit connection: {name}',
  newConnectionTitle: 'New connection',
  namePlaceholder: 'e.g. dev database',
  host: 'Host',
  port: 'Port',
  portPlaceholder: 'Default {port}',
  user: 'Username',
  userPlaceholderRedis: 'Redis before 6 has no username; leave empty',
  password: 'Password',
  labelRedisDb: 'DB index',
  labelDatabase: 'Database',
  dbIndexPlaceholder: '0 (default)',
  testConnection: 'Test connection',
  testOk: 'Connected ({ms} ms)',
  testFail: 'Connection failed: {error}',
  nameRequired: 'Please give this connection a name',
  hostRequired: 'Please enter a host',
  hintLead: 'Every field of a connection can contain',
  hintMid: '\u2014 when the dev and test environments connect to different databases, set a variable per environment to tell them apart; for the password, use',
  hintTail: 'and store it as a secret variable in the environment.',
  noEnvLead: 'No environment is selected right now, so',
  noEnvTail: 'inside the connection cannot be resolved and the connection test will fail.',
  varSample: "{'{'}{'{'}variables{'}'}{'}'}",
  varPassword: "{'{'}{'{'}dbPassword{'}'}{'}'}",
  hostPlaceholder: "127.0.0.1 (you can use {'{'}{'{'}dbHost{'}'}{'}'})",
  passwordPlaceholder: "You can use {'{'}{'{'}dbPassword{'}'}{'}'}",

  /* ---------------- DbOpsPane ---------------- */
  paneTitle: 'Database operations',
  paneNote: 'Pre-request ones run first (they can seed data and fill values into this request); response ones run before assertions (assertions can use the variables just queried)',
  noConnections: 'This project has no database connection yet. Add one under Project settings \u2192 Database first, then you can pick it here.',
  webOpsUnavailable: 'The web version cannot connect to databases: database operations can only be added, edited and run in the desktop client. Here you can only view them; they are skipped when sending.',
  noEnvironmentNotice: 'No environment is selected right now (or the built-in Mock environment is selected); variables extracted to the Environment will not be saved.',
  phasePre: 'Pre-request',
  phasePost: 'Response',
  selectConnection: 'Select connection',
  addExtract: '+ Extract',
  variableName: 'Variable name',
  emptyPre: 'No pre-request operations yet.',
  emptyPost: 'No response operations yet.',
  addOp: '+ Add {phase} operation',
  resultTitle: 'Where to see results',
  resultNote: 'Each operation takes one line in the Console of the response panel (which database, statement, duration, rows returned)'
};
