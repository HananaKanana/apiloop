/**
 * 迁移列表：按 version 升序排列。
 *
 * db.open 会读出库里记录的 meta.schema_version，只执行比它大的那些迁移，
 * 每条迁移在自己的事务里跑，跑完写回版本号。
 *
 * 往后加迁移时**只追加，不改动已发布过的条目** —— 别人机器上的库已经按老版本
 * 跑过了，改历史条目不会重放，只会造成两边结构不一致。
 *
 * 时间统一用毫秒时间戳（Date.now()），由写入方负责，这里只声明 INTEGER。
 */

var V1_STATEMENTS = [
    /* ---------------------------------------------------------- 用户与登录 */
    'CREATE TABLE IF NOT EXISTS users (' +
    '    id TEXT PRIMARY KEY,' +
    '    username TEXT NOT NULL UNIQUE COLLATE NOCASE,' +
    '    password_hash TEXT NOT NULL,' +
    "    display_name TEXT NOT NULL DEFAULT ''," +
    "    role TEXT NOT NULL CHECK(role IN ('admin','member'))," +
    '    disabled INTEGER NOT NULL DEFAULT 0,' +
    '    created_at INTEGER NOT NULL,' +
    '    updated_at INTEGER NOT NULL' +
    ')',

    'CREATE TABLE IF NOT EXISTS sessions (' +
    '    token_hash TEXT PRIMARY KEY,' +
    '    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,' +
    '    created_at INTEGER NOT NULL,' +
    '    expires_at INTEGER NOT NULL' +
    ')',

    /* ---------------------------------------------------------- 项目 */
    'CREATE TABLE IF NOT EXISTS projects (' +
    '    id TEXT PRIMARY KEY,' +
    '    slug TEXT NOT NULL UNIQUE,' +
    '    name TEXT NOT NULL,' +
    "    description TEXT NOT NULL DEFAULT ''," +
    '    source_dir TEXT UNIQUE,' +
    '    is_default INTEGER NOT NULL DEFAULT 0,' +
    "    variables TEXT NOT NULL DEFAULT '[]'," +
    '    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,' +
    '    created_at INTEGER NOT NULL,' +
    '    updated_at INTEGER NOT NULL' +
    ')',

    'CREATE TABLE IF NOT EXISTS project_members (' +
    '    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,' +
    '    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,' +
    "    role TEXT NOT NULL CHECK(role IN ('owner','editor','viewer'))," +
    '    PRIMARY KEY (project_id, user_id)' +
    ')',

    'CREATE TABLE IF NOT EXISTS environments (' +
    '    id TEXT PRIMARY KEY,' +
    '    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,' +
    '    name TEXT NOT NULL,' +
    "    variables TEXT NOT NULL DEFAULT '[]'," +
    '    position INTEGER NOT NULL DEFAULT 0' +
    ')',

    /* ---------------------------------------------------------- 目录树与接口 */
    'CREATE TABLE IF NOT EXISTS folders (' +
    '    id TEXT PRIMARY KEY,' +
    '    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,' +
    '    parent_id TEXT REFERENCES folders(id) ON DELETE CASCADE,' +
    '    name TEXT NOT NULL,' +
    "    description TEXT NOT NULL DEFAULT ''," +
    '    position INTEGER NOT NULL DEFAULT 0,' +
    '    auth TEXT,' +
    "    variables TEXT NOT NULL DEFAULT '[]'," +
    "    extra TEXT NOT NULL DEFAULT '{}'" +
    ')',

    'CREATE TABLE IF NOT EXISTS apis (' +
    '    id TEXT PRIMARY KEY,' +
    '    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,' +
    '    folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,' +
    "    name TEXT NOT NULL DEFAULT ''," +
    "    description TEXT NOT NULL DEFAULT ''," +
    '    position INTEGER NOT NULL DEFAULT 0,' +
    "    method TEXT NOT NULL DEFAULT 'GET'," +
    "    url TEXT NOT NULL DEFAULT ''," +
    '    params TEXT NOT NULL DEFAULT \'{"path":[],"query":[],"headers":[]}\',' +
    '    body TEXT NOT NULL DEFAULT \'{"mode":"none"}\',' +
    '    auth TEXT,' +
    "    scripts TEXT NOT NULL DEFAULT '[]'," +
    '    mock_enabled INTEGER NOT NULL DEFAULT 1,' +
    '    mock_path TEXT,' +
    '    mock_delay INTEGER NOT NULL DEFAULT 0,' +
    '    mock_cors INTEGER NOT NULL DEFAULT 0,' +
    '    mock_example_id TEXT,' +
    "    extra TEXT NOT NULL DEFAULT '{}'," +
    '    created_at INTEGER NOT NULL,' +
    '    updated_at INTEGER NOT NULL' +
    ')',

    'CREATE TABLE IF NOT EXISTS examples (' +
    '    id TEXT PRIMARY KEY,' +
    '    api_id TEXT NOT NULL REFERENCES apis(id) ON DELETE CASCADE,' +
    "    name TEXT NOT NULL DEFAULT ''," +
    '    position INTEGER NOT NULL DEFAULT 0,' +
    '    status INTEGER NOT NULL DEFAULT 200,' +
    "    headers TEXT NOT NULL DEFAULT '[]'," +
    "    body TEXT NOT NULL DEFAULT ''," +
    "    response_type TEXT NOT NULL DEFAULT 'json'," +
    '    is_template INTEGER NOT NULL DEFAULT 1,' +
    "    source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual','recorded','imported'))," +
    '    created_at INTEGER NOT NULL' +
    ')',

    // mock_example_id 故意不加外键：它和 examples 互相引用，删除示例时由 repo 负责置空
    'CREATE TABLE IF NOT EXISTS mock_expectations (' +
    '    id TEXT PRIMARY KEY,' +
    '    api_id TEXT NOT NULL REFERENCES apis(id) ON DELETE CASCADE,' +
    '    position INTEGER NOT NULL DEFAULT 0,' +
    "    name TEXT NOT NULL DEFAULT ''," +
    '    enabled INTEGER NOT NULL DEFAULT 1,' +
    "    conditions TEXT NOT NULL DEFAULT '[]'," +
    '    example_id TEXT REFERENCES examples(id) ON DELETE CASCADE' +
    ')',

    /* ---------------------------------------------------------- 历史与迁移留痕 */
    'CREATE TABLE IF NOT EXISTS history (' +
    '    id INTEGER PRIMARY KEY AUTOINCREMENT,' +
    '    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,' +
    '    api_id TEXT REFERENCES apis(id) ON DELETE SET NULL,' +
    '    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,' +
    "    request TEXT NOT NULL DEFAULT '{}'," +
    "    response TEXT NOT NULL DEFAULT '{}'," +
    '    created_at INTEGER NOT NULL' +
    ')',

    'CREATE TABLE IF NOT EXISTS legacy_imports (' +
    '    source_path TEXT PRIMARY KEY,' +
    '    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,' +
    '    imported_at INTEGER NOT NULL' +
    ')',

    'CREATE TABLE IF NOT EXISTS meta (' +
    '    key TEXT PRIMARY KEY,' +
    '    value TEXT NOT NULL' +
    ')',

    /* ---------------------------------------------------------- 索引 */
    'CREATE INDEX IF NOT EXISTS idx_apis_project_position ON apis(project_id, position)',
    'CREATE INDEX IF NOT EXISTS idx_folders_project_parent_position ON folders(project_id, parent_id, position)',
    'CREATE INDEX IF NOT EXISTS idx_examples_api_position ON examples(api_id, position)',
    'CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)'
];

/**
 * v2：接入阶段的补齐。
 *
 * - examples.extra：Postman 导入时那一层没被映射到的字段（originalRequest、cookie……）
 *   原样兜在这里，导出时再摊回去 —— 往返无损靠的就是它。
 * - projects.auth / scripts / extra：集合级的鉴权、脚本和未映射字段。
 *   folders 从 v1 起就有这三列，项目这一层少了一份，导入时没地方放。
 * - 两个索引：历史按「项目 + id 倒序」翻页、环境按「项目 + 顺序」列出。
 */
var V2_STATEMENTS = [
    "ALTER TABLE examples ADD COLUMN extra TEXT NOT NULL DEFAULT '{}'",
    'ALTER TABLE projects ADD COLUMN auth TEXT',
    "ALTER TABLE projects ADD COLUMN scripts TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE projects ADD COLUMN extra TEXT NOT NULL DEFAULT '{}'",
    'CREATE INDEX IF NOT EXISTS idx_history_project ON history(project_id, id)',
    'CREATE INDEX IF NOT EXISTS idx_environments_project ON environments(project_id, position)'
];

/**
 * v3：目录也能存脚本。
 *
 * Postman 的 folder 可以挂 event（prerequest / test），而目录这一层原先没有放脚本的
 * 地方 —— 项目和接口都有，只有目录缺一个，导入时这部分只能丢。补上这一列，
 * 往返才能真的无损。
 */
var V3_STATEMENTS = [
    "ALTER TABLE folders ADD COLUMN scripts TEXT NOT NULL DEFAULT '[]'"
];

/**
 * v4：项目成员。
 *
 * `project_members` 这张表从 v1 就建好了，但一直没人往里写过东西。这一版把
 * 「一个项目只有它的成员能看到」这条规则真正跑起来，所以老库必须一次性把
 * 「谁属于哪个项目」补齐 —— 否则升级完所有人都进不去自己的项目。
 *
 * 按契约第 10 节「存量数据迁移」的三条规则，顺序不能换：
 *   1. 所有现有项目 × 所有现有用户，全部设为 editor（`OR IGNORE` 保住已存在的行）；
 *   2. 项目的创建者设为 owner —— legacy 导入时写进去的 owner 因此原样保留；
 *   3. 仍然一个 owner 都没有的项目，由最早创建的那个 admin 顶上。
 *
 * 第 3 条里 `user_id = (子查询)` 最多命中一行，所以即使 SQLite 逐行重算子查询，
 * 也不会把同一个项目的多个成员一起提成 owner。
 */
var V4_STATEMENTS = [
    "INSERT OR IGNORE INTO project_members (project_id, user_id, role) " +
    "SELECT p.id, u.id, 'editor' FROM projects p CROSS JOIN users u",

    "UPDATE project_members SET role = 'owner' WHERE EXISTS (" +
    '    SELECT 1 FROM projects p WHERE p.id = project_members.project_id' +
    '      AND p.created_by = project_members.user_id)',

    "UPDATE project_members SET role = 'owner' " +
    "WHERE user_id = (SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1) " +
    "  AND project_id NOT IN (SELECT project_id FROM project_members WHERE role = 'owner')"
];

/**
 * v5：Cookie 自动管理（契约第 12 节）。
 *
 * 作用范围是「每个用户在每个项目里各一份」—— 所以唯一键是
 * `(project_id, user_id, domain, path, name)`，正好是 RFC 6265 里判定
 * 「同一个 cookie」的那三个字段再加上归属。
 *
 * `expires` 允许为 NULL（会话 cookie）；过期的那行由 repo 负责删掉，
 * 不靠数据库的默认值。
 */
var V5_STATEMENTS = [
    'CREATE TABLE IF NOT EXISTS cookies (' +
    '    id TEXT PRIMARY KEY,' +
    '    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,' +
    '    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,' +
    '    domain TEXT NOT NULL,' +
    "    path TEXT NOT NULL DEFAULT '/'," +
    '    name TEXT NOT NULL,' +
    "    value TEXT NOT NULL DEFAULT ''," +
    '    expires INTEGER,' +
    '    host_only INTEGER NOT NULL DEFAULT 0,' +
    '    secure INTEGER NOT NULL DEFAULT 0,' +
    '    http_only INTEGER NOT NULL DEFAULT 0,' +
    '    same_site TEXT,' +
    '    created_at INTEGER NOT NULL,' +
    '    updated_at INTEGER NOT NULL' +
    ')',

    'CREATE UNIQUE INDEX IF NOT EXISTS idx_cookies_owner ' +
    'ON cookies(project_id, user_id, domain, path, name)'
];

/**
 * v6：重置或由管理员设置的密码，登录后必须先改掉（2026-10-01 用户要求）。
 *
 * 已有用户一律 0：迁移时不知道谁的密码是别人设的，不能一上线就把所有人拦住。
 */
var V6_STATEMENTS = [
    'ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0'
];

/**
 * v7：同步（L2）—— 行版本号 + 变更流水 + 触发器。
 *
 * 六张「会被同步的行」各加一列 `rev`，再配一张只追加的 `changes` 表；每张表上挂
 * 三个触发器，插入、修改、删除各写一条。**行照常真删**（不是打标记），删除只是
 * 多出一条 `deleted = 1` 的记录 —— 这样现成的查询一条都不用改，也没有「某个写入
 * 路径绕过仓储层就不会被记录」的风险（外键级联删掉的子行同样会走到触发器里）。
 *
 * 三处刻意的写法，改动前先看清楚：
 *
 * 1. **触发器是 `AFTER UPDATE OF <数据列>`，列清单里没有 `rev` 和 `updated_at`。**
 *    加 `rev` 的那条 UPDATE 只写 `rev`，因此不可能再触发自己 —— 不必依赖
 *    `PRAGMA recursive_triggers` 的默认值（实测默认是 0，但那是环境，不是我们的约束）。
 *    排掉 `updated_at` 是因为仓储层改完数据会再补一条「只更新 updated_at」的语句，
 *    让它也发一条变更记录的话，改一次名字会白白多出一条。
 * 2. **加 `rev` 的那条带 `AND NEW.rev = OLD.rev`**：推送时显式写了 `rev` 的行
 *    （本机重建出来的行带着原版本号）不再被加一次。
 * 3. **列清单在这里写死，不许从 `lib/sync/rows.js` 引。** 迁移一旦发布就不再重放，
 *    引一个还会继续演化的模块，会让老库和新库的触发器悄悄不一致。
 *
 * `changes.project_id` 故意**没有外键**：项目自己被删掉之后，那条删除记录还得能被
 * 同步方读到。级联删除子行时这里可能取到 NULL，可以接受 —— 接口自己那条记录会让
 * 同步方把它的子行一起删掉。
 */
var CHANGE_AT = "CAST(strftime('%s','now') AS INTEGER) * 1000";

/** 会被同步的六张表：表名、实体名、以及从行里取项目 id 的表达式 */
var SYNC_TABLES = [
    {
        table: 'projects',
        entity: 'project',
        // 改这些列才算「这行变了」；rev 与 updated_at 不在其中，理由见上面的注释 1
        columns: ['slug', 'name', 'description', 'source_dir', 'is_default', 'variables',
            'auth', 'scripts', 'extra', 'created_by', 'created_at'],
        projectId: function (alias) { return alias + '.id'; }
    },
    {
        table: 'environments',
        entity: 'environment',
        columns: ['project_id', 'name', 'variables', 'position'],
        projectId: function (alias) { return alias + '.project_id'; }
    },
    {
        table: 'folders',
        entity: 'folder',
        columns: ['project_id', 'parent_id', 'name', 'description', 'position', 'auth',
            'variables', 'scripts', 'extra'],
        projectId: function (alias) { return alias + '.project_id'; }
    },
    {
        table: 'apis',
        entity: 'api',
        columns: ['project_id', 'folder_id', 'name', 'description', 'position', 'method', 'url',
            'params', 'body', 'auth', 'scripts', 'mock_enabled', 'mock_path', 'mock_delay',
            'mock_cors', 'mock_example_id', 'extra', 'created_at'],
        projectId: function (alias) { return alias + '.project_id'; }
    },
    {
        table: 'examples',
        entity: 'example',
        columns: ['api_id', 'name', 'position', 'status', 'headers', 'body', 'response_type',
            'is_template', 'source', 'extra', 'created_at'],
        // 示例和期望自己不存项目 id，从所属接口绕一次
        projectId: function (alias) {
            return '(SELECT project_id FROM apis WHERE id = ' + alias + '.api_id)';
        }
    },
    {
        table: 'mock_expectations',
        entity: 'expectation',
        columns: ['api_id', 'position', 'name', 'enabled', 'conditions', 'example_id'],
        projectId: function (alias) {
            return '(SELECT project_id FROM apis WHERE id = ' + alias + '.api_id)';
        }
    }
];

/** 六个实体各自的「插入/修改/删除」三条触发器 */
function syncTriggers() {
    var statements = [];

    SYNC_TABLES.forEach(function (spec) {
        var table = spec.table;

        /** 往 changes 里写一条。rev 和 deleted 都是可以直接拼进 SQL 的字面量 */
        function change(alias, rev, deleted) {
            return 'INSERT INTO changes (project_id, entity, entity_id, rev, deleted, at) VALUES (' +
                spec.projectId(alias) + ", '" + spec.entity + "', " + alias + '.id, ' +
                rev + ', ' + deleted + ', ' + CHANGE_AT + ')';
        }

        statements.push(
            'CREATE TRIGGER IF NOT EXISTS trg_' + table + '_change_ins AFTER INSERT ON ' + table + ' BEGIN ' +
            change('NEW', 'NEW.rev', 0) + '; END'
        );

        statements.push(
            'CREATE TRIGGER IF NOT EXISTS trg_' + table + '_change_upd AFTER UPDATE OF ' +
            spec.columns.join(', ') + ' ON ' + table + ' BEGIN ' +
            'UPDATE ' + table + ' SET rev = OLD.rev + 1 WHERE id = NEW.id AND NEW.rev = OLD.rev; ' +
            change('NEW', '(SELECT rev FROM ' + table + ' WHERE id = NEW.id)', 0) + '; END'
        );

        statements.push(
            'CREATE TRIGGER IF NOT EXISTS trg_' + table + '_change_del AFTER DELETE ON ' + table + ' BEGIN ' +
            change('OLD', 'OLD.rev', 1) + '; END'
        );
    });

    return statements;
}

var V7_STATEMENTS = [
    /* ---------------------------------------------------------- 行版本号 */
    'ALTER TABLE projects ADD COLUMN rev INTEGER NOT NULL DEFAULT 1',
    'ALTER TABLE environments ADD COLUMN rev INTEGER NOT NULL DEFAULT 1',
    'ALTER TABLE folders ADD COLUMN rev INTEGER NOT NULL DEFAULT 1',
    'ALTER TABLE apis ADD COLUMN rev INTEGER NOT NULL DEFAULT 1',
    'ALTER TABLE examples ADD COLUMN rev INTEGER NOT NULL DEFAULT 1',
    'ALTER TABLE mock_expectations ADD COLUMN rev INTEGER NOT NULL DEFAULT 1',

    /* ---------------------------------------------------------- 变更流水 */
    'CREATE TABLE IF NOT EXISTS changes (' +
    '    seq INTEGER PRIMARY KEY AUTOINCREMENT,' +
    '    project_id TEXT,' +
    '    entity TEXT NOT NULL,' +
    '    entity_id TEXT NOT NULL,' +
    '    rev INTEGER NOT NULL,' +
    '    deleted INTEGER NOT NULL DEFAULT 0,' +
    '    at INTEGER NOT NULL' +
    ')',

    'CREATE INDEX IF NOT EXISTS idx_changes_project ON changes(project_id, seq)'
]
    .concat(syncTriggers())
    .concat([
        // 变更流水被清理到哪一条之前了。第一条记录的 seq 就是 1，所以初值是 '1'
        "INSERT OR IGNORE INTO meta (key, value) VALUES ('sync_min_seq', '1')"
    ]);

/**
 * v8：自助注册（用户 2026-10-02：加注册，管理员审核通过才能登录）。
 * pending = 1 表示注册了、还没审核。已有用户一律 0。
 */
var V8_STATEMENTS = [
    'ALTER TABLE users ADD COLUMN pending INTEGER NOT NULL DEFAULT 0'
];

var MIGRATIONS = [
    { version: 1, name: '初始表结构', statements: V1_STATEMENTS },
    { version: 2, name: '接入阶段补齐列与索引', statements: V2_STATEMENTS },
    { version: 3, name: '目录支持脚本', statements: V3_STATEMENTS },
    { version: 4, name: '项目成员', statements: V4_STATEMENTS },
    { version: 5, name: 'Cookie 自动管理', statements: V5_STATEMENTS },
    { version: 6, name: '登录后必须先改密码', statements: V6_STATEMENTS },
    { version: 7, name: '同步：行版本号与变更流水', statements: V7_STATEMENTS },
    { version: 8, name: '自助注册待审核', statements: V8_STATEMENTS }
];

function list() {
    return MIGRATIONS;
}

function latestVersion() {
    return MIGRATIONS.reduce(function (max, migration) {
        return migration.version > max ? migration.version : max;
    }, 0);
}

module.exports = {
    list: list,
    latestVersion: latestVersion
};
