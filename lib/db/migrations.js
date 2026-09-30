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

var MIGRATIONS = [
    { version: 1, name: '初始表结构', statements: V1_STATEMENTS },
    { version: 2, name: '接入阶段补齐列与索引', statements: V2_STATEMENTS },
    { version: 3, name: '目录支持脚本', statements: V3_STATEMENTS },
    { version: 4, name: '项目成员', statements: V4_STATEMENTS }
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
