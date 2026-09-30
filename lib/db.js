/**
 * SQLite 持久化层：把 mock 配置（分组 + 接口）存进一个本地库文件。
 *
 * 只用 node:sqlite —— Node 内置，零外部依赖。版本要求见下面的 requireSqlite()。
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

/** 打开（不存在则创建）库文件并建表 */
function openDatabase(file) {
    var sqlite = requireSqlite();
    var dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

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
