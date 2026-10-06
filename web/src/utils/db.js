import { t } from '@/i18n';
/**
 * 数据库连接与数据库操作这两张表的纯逻辑（第九轮第 3 节）。
 *
 * 和别的前端纯逻辑模块一样抽出来是为了能单独跑断言（`.vue` 里的东西不开浏览器验不了，
 * 见 skill `apiloop-selftest-harness`）。这里只放**规则**，不放界面。
 *
 * 和服务端 `lib/db-ops.js` 是同一套清单（能选什么类型、默认端口、哪些时机），
 * 服务端那份是执行时的依据 —— 它会把界面上多送的行丢掉（`toDbOps`）。
 */

export const TYPE_OPTIONS = [
  { label: 'MySQL', value: 'mysql' },
  { label: 'PostgreSQL', value: 'postgres' },
  { label: 'Redis', value: 'redis' }
];

export const TYPE_LABELS = { mysql: 'MySQL', postgres: 'PostgreSQL', redis: 'Redis' };

export const DEFAULT_PORTS = { mysql: 3306, postgres: 5432, redis: 6379 };

/** 一行操作的时机：发请求前 / 拿到响应后 */
export const PHASE_OPTIONS = [
  { value: 'pre', get label() { return t('utils.dbPre'); } },
  { value: 'post', get label() { return t('utils.dbPost'); } }
];

export const SCOPE_OPTIONS = [
  { value: 'environment', get label() { return t('utils.scopeEnv'); } },
  { value: 'project', get label() { return t('utils.scopeProject'); } }
];

/** Redis 的返回是个值、SQL 是行数组，路径提示不一样 */
export function pathPlaceholder(connection) {
  return connection && connection.type === 'redis'
    ? t('utils.dbPathRedis')
    : t('utils.dbPathSql');
}

/** 语句输入框的提示（SQL 和 Redis 命令长得完全不一样） */
export function statementPlaceholder(type) {
  if (type === 'redis') return t('utils.dbStmtRedis');
  return t('utils.dbStmtSql');
}

export function typeLabel(type) {
  return TYPE_LABELS[type] || type || '';
}

/** 连接的地址一行：`127.0.0.1:3306/demo`、Redis 是 `127.0.0.1:6379/2` */
export function addressOf(connection) {
  if (!connection) return '';
  const port = connection.port || DEFAULT_PORTS[connection.type] || '';
  const host = connection.host || '';
  const tail = connection.database ? '/' + connection.database : '';
  return host + (port ? ':' + port : '') + tail;
}

function newId(prefix) {
  return (prefix || 'r') + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export function newConnection(partial) {
  const type = (partial && partial.type) || 'mysql';
  return Object.assign({
    id: newId('db'),
    name: '',
    type: type,
    host: '',
    port: DEFAULT_PORTS[type],
    user: '',
    password: '',
    database: ''
  }, partial || {});
}

export function newDbOp(partial) {
  return Object.assign({
    id: newId('op'),
    enabled: true,
    phase: 'pre',
    connectionId: '',
    statement: '',
    extracts: []
  }, partial || {});
}

export function newDbExtract(partial) {
  return Object.assign({
    id: newId('e'),
    enabled: true,
    path: '',
    scope: 'environment',
    name: ''
  }, partial || {});
}

/**
 * 换类型时把端口跟着换掉 —— 只在端口还是「上一个类型的默认值」或者空着时才动，
 * 用户自己填过的端口不能被改掉。
 */
export function withType(connection, type) {
  const oldDefault = DEFAULT_PORTS[connection.type];
  const keepPort = connection.port !== '' && Number(connection.port) !== oldDefault;
  return Object.assign({}, connection, {
    type: type,
    port: keepPort ? connection.port : DEFAULT_PORTS[type]
  });
}

/** 填了明文密码就提醒一句 —— 连接会同步给项目里所有人 */
export function passwordWarning(connection) {
  const password = String((connection && connection.password) || '');
  if (!password) return '';
  if (password.indexOf('{{') !== -1) return '';
  // 这句里有 {{变量名}}，不能整句写进语言文件（vue-i18n 会把 {{ 当成嵌套插值）
  return t('utils.dbPasswordWarnLead') + '{{变量名}}' + t('utils.dbPasswordWarnTail');
}

/** 下拉里那一行：`本地 MySQL（127.0.0.1:3306/demo）` */
export function connectionOptions(databases) {
  return (databases || []).map(function (connection) {
    return {
      label: connection.name + '（' + typeLabel(connection.type) + ' · ' + addressOf(connection) + '）',
      value: connection.id
    };
  });
}

/** 这一行操作有什么问题（缺行的话在下发前提示一下，服务端会直接丢掉它） */
export function opProblem(op) {
  if (!String((op && op.statement) || '').trim()) return t('utils.dbNoStatement');
  if (!String((op && op.connectionId) || '').trim()) return t('utils.dbNoConnection');
  return '';
}

/** 页签上的小圆点：有没有启用着的操作 */
export function hasEnabled(rows) {
  return (rows || []).some(function (row) { return row && row.enabled !== false; });
}

/** 操作列表分成两组（界面上下两张表） */
export function splitByPhase(list) {
  const rows = list || [];
  return {
    pre: rows.filter(function (row) { return row.phase !== 'post'; }),
    post: rows.filter(function (row) { return row.phase === 'post'; })
  };
}
