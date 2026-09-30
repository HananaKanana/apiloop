/**
 * P0 格式的库读写：每个目录一个 routes.db，里面是「分组 + 接口」两张业务表。
 *
 * 这个模块是过渡产物。P1 起全局只有一个库（lib/db/），每个目录的旧库由
 * lib/legacy-import.js 导入成项目。所以这里最终只保留「读」的能力，
 * 供迁移使用；writeAll 在 Task 4 会删掉。
 *
 * 设计取舍：配置数据很小（几十到几百条接口），不值得做细粒度增量更新。
 * 这里读是全量读、写是全量写（事务里先清空再灌入），换来的是 routes-store
 * 那一层可以保持「内存里的数组就是唯一真相」的模型不变，不必改成每次访问
 * 都去查库。写频率极低（人工点保存），全量写的代价可以忽略。
 */

var fs = require('fs');
var path = require('path');

var SCHEMA_VERSION = 1;

/**
 * 表结构说明：
 * - 列名躲开了 SQL 关键字：group → grp、desc → descr。用引号也能解决，
 *   但裸列名以后手写 SQL 排查时更省事。
 * - headers / query / body 是结构化的字段描述数组，存 JSON 文本。
 * - enabled / cors 用 0/1，读出来再还原成布尔。
 * - position 记录展示顺序，读写都带上，保证管理台里的排序稳定。
 */
var SCHEMA = [
    'CREATE TABLE IF NOT EXISTS groups (',
    '    name TEXT PRIMARY KEY,',
    '    position INTEGER NOT NULL',
    ');',
    'CREATE TABLE IF NOT EXISTS routes (',
    '    id TEXT PRIMARY KEY,',
    "    name TEXT NOT NULL DEFAULT '',",
    "    grp TEXT NOT NULL DEFAULT '',",
    "    descr TEXT NOT NULL DEFAULT '',",
    '    enabled INTEGER NOT NULL DEFAULT 1,',
    "    method TEXT NOT NULL DEFAULT 'GET',",
    "    path TEXT NOT NULL DEFAULT '/',",
    '    status INTEGER NOT NULL DEFAULT 200,',
    '    delay INTEGER NOT NULL DEFAULT 0,',
    '    cors INTEGER NOT NULL DEFAULT 0,',
    "    headers TEXT NOT NULL DEFAULT '[]',",
    "    query TEXT NOT NULL DEFAULT '[]',",
    "    body TEXT NOT NULL DEFAULT '[]',",
    "    response_type TEXT NOT NULL DEFAULT 'json',",
    "    response TEXT NOT NULL DEFAULT '',",
    '    position INTEGER NOT NULL DEFAULT 0',
    ');',
    'CREATE TABLE IF NOT EXISTS meta (',
    '    key TEXT PRIMARY KEY,',
    '    value TEXT NOT NULL',
    ');'
].join('\n');

var INSERT_ROUTE = [
    'INSERT INTO routes (id, name, grp, descr, enabled, method, path, status, delay, cors,',
    '    headers, query, body, response_type, response, position)',
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
].join(' ');

/**
 * node:sqlite 从 v22.5.0 起提供，但 v22.13.0 之前还躲在 --experimental-sqlite
 * 标志后面；Node 20 及更早版本里根本没有这个模块。require 失败时给一句人话，
 * 而不是把 "Cannot find module 'node:sqlite'" 直接甩出去。
 */
function requireSqlite() {
    try {
        return require('node:sqlite');
    } catch (err) {
        throw new Error('存储改用 SQLite，需要 Node 22.13 及以上版本（node:sqlite ' +
            '自 22.5.0 提供，22.13.0 起才不需要 --experimental-sqlite 标志）。' +
            '当前版本 ' + process.version);
    }
}

/** SQLite 库文件固定以这 16 字节开头，用来和别的文件区分 */
var SQLITE_HEADER = 'SQLite format 3\u0000';

/**
 * 目标文件已存在时先确认它真是 SQLite 库。
 * 配置从 routes.json 改成 routes.db 之后，最容易出的岔子就是有人把 --config
 * 指到一个旧的 JSON 文件上，那时 SQLite 只会甩一句 "file is not a database"，
 * 完全看不出该怎么办。
 */
function assertDatabaseFile(file) {
    if (!fs.existsSync(file)) return;
    if (fs.statSync(file).size === 0) return;

    var fd = fs.openSync(file, 'r');
    var head = Buffer.alloc(16);
    var read = 0;
    try {
        read = fs.readSync(fd, head, 0, 16, 0);
    } finally {
        fs.closeSync(fd);
    }
    if (read === 16 && head.toString('utf8') === SQLITE_HEADER) return;

    throw new Error(file + ' 已存在，但不是 SQLite 数据库。配置已经从 routes.json 换成 ' +
        '数据库文件（默认 routes.db）：如果这是一份旧的 JSON 配置，请把它改名为 routes.json ' +
        '放在库文件旁边，下次启动会自动导入。');
}

/** 打开（不存在则创建）库文件并建表 */
function openDatabase(file) {
    var sqlite = requireSqlite();
    var dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    assertDatabaseFile(file);
    var db = new sqlite.DatabaseSync(file);
    db.exec(SCHEMA);
    db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)')
        .run('version', String(SCHEMA_VERSION));
    return db;
}

function parseJson(text, fallback) {
    try {
        var value = JSON.parse(text);
        return Array.isArray(value) ? value : fallback;
    } catch (err) {
        return fallback;
    }
}

/** 一行 → 接口对象，形状与 routes-store 里的内存模型一致 */
function rowToRoute(row) {
    return {
        id: row.id,
        name: row.name,
        group: row.grp,
        desc: row.descr,
        enabled: !!row.enabled,
        method: row.method,
        path: row.path,
        status: row.status,
        delay: row.delay,
        cors: !!row.cors,
        headers: parseJson(row.headers, []),
        query: parseJson(row.query, []),
        body: parseJson(row.body, []),
        responseType: row.response_type,
        response: row.response
    };
}

/** 全量读：按 position 还原分组顺序与接口顺序 */
function readAll(db) {
    var groups = db.prepare('SELECT name FROM groups ORDER BY position, rowid').all()
        .map(function (row) { return row.name; });

    var routes = db.prepare('SELECT * FROM routes ORDER BY position, rowid').all()
        .map(rowToRoute);

    return { groups: groups, routes: routes };
}

/**
 * 全量写：一个事务里清空再灌入，中途出错整体回滚，不会留下写了一半的配置。
 * @param {object} db
 * @param {{groups: string[], routes: object[]}} doc
 */
function writeAll(db, doc) {
    var routes = (doc && doc.routes) || [];
    var groups = (doc && doc.groups) || [];

    db.exec('BEGIN IMMEDIATE');
    try {
        db.exec('DELETE FROM routes');
        db.exec('DELETE FROM groups');

        var insertRoute = db.prepare(INSERT_ROUTE);
        routes.forEach(function (route, index) {
            insertRoute.run(
                String(route.id),
                String(route.name || ''),
                String(route.group || ''),
                String(route.desc || ''),
                route.enabled ? 1 : 0,
                String(route.method || 'GET'),
                String(route.path || '/'),
                Number(route.status) || 200,
                Number(route.delay) || 0,
                route.cors ? 1 : 0,
                JSON.stringify(route.headers || []),
                JSON.stringify(route.query || []),
                JSON.stringify(route.body || []),
                String(route.responseType || 'json'),
                String(route.response === undefined || route.response === null ? '' : route.response),
                index
            );
        });

        var insertGroup = db.prepare('INSERT INTO groups (name, position) VALUES (?, ?)');
        groups.forEach(function (name, index) { insertGroup.run(String(name), index); });

        db.exec('COMMIT');
    } catch (err) {
        db.exec('ROLLBACK');
        throw err;
    }
}

function close(db) {
    if (!db) return;
    try {
        db.close();
    } catch (err) {
        // 关不掉就算了，进程退出时系统会回收
    }
}

module.exports = {
    openDatabase: openDatabase,
    readAll: readAll,
    writeAll: writeAll,
    close: close,
    SCHEMA_VERSION: SCHEMA_VERSION
};
