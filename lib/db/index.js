/**
 * 全局库的连接层：打开库、设 pragma、跑迁移、开事务、广播变更、轮询外部变更。
 *
 * 各张表的具体增删改查不在这里，放在 lib/db/repos/*。
 *
 * 两条并发约定（见 P1 计划的 Review Focus）：
 * - 两个进程共用一个库时，写操作靠 WAL + busy_timeout 不互相 SQLITE_BUSY 崩掉；
 * - 一方写完，另一方靠 PRAGMA data_version 的变化感知到（它只在别的连接提交后
 *   才变，所以不会被自己触发），从而让 mock 接口在大约一个轮询周期内生效。
 */

var fs = require('fs');
var path = require('path');
var EventEmitter = require('events').EventEmitter;

var migrations = require('./migrations');

/** SQLite 库文件固定以这 16 字节开头，用来和别的文件区分 */
var SQLITE_HEADER = 'SQLite format 3\u0000';

var DEFAULT_POLL_INTERVAL = 1000;

/**
 * node:sqlite 从 v22.5.0 起提供，但 v22.13.0 之前还躲在 --experimental-sqlite
 * 标志后面；Node 20 及更早版本里根本没有这个模块。require 失败时给一句人话，
 * 而不是把 "Cannot find module 'node:sqlite'" 直接甩出去。
 */
function requireSqlite() {
    try {
        return require('node:sqlite');
    } catch (err) {
        throw new Error('需要 Node 22.13 及以上版本（node:sqlite 自 22.5.0 提供，' +
            '22.13.0 起才不需要 --experimental-sqlite 标志）。当前版本 ' + process.version);
    }
}

/**
 * 目标文件已存在时先确认它真是 SQLite 库。
 * 最容易出的岔子是把 --db 指到一个旧的 JSON 配置文件上，那时 SQLite 只会甩一句
 * "file is not a database"，完全看不出该怎么办。
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

    throw new Error(file + ' 已存在，但不是 SQLite 数据库。如果这是一份旧的 ' +
        'routes.json 配置，请把它留在原目录、不要指给 --db，启动时会自动导入成一个项目。');
}

/** 读库里的 schema 版本；meta 表还不存在时按 0 算 */
function readSchemaVersion(db) {
    db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    var row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version');
    var version = row ? parseInt(row.value, 10) : 0;
    return Number.isFinite(version) && version > 0 ? version : 0;
}

/** 依次执行比库里记录更新的迁移，每条单独一个事务 */
function migrate(db) {
    var known = migrations.latestVersion();
    var from = readSchemaVersion(db);

    if (from > known) {
        throw new Error('数据库由更新版本创建（schema v' + from + '），' +
            '当前代码只支持到 v' + known + '，请升级后再打开。');
    }

    migrations.list().forEach(function (migration) {
        if (migration.version <= from) return;

        db.exec('BEGIN IMMEDIATE');
        try {
            db.exec(migration.statements.join(';\n'));
            db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
                .run('schema_version', String(migration.version));
            db.exec('COMMIT');
        } catch (err) {
            try {
                db.exec('ROLLBACK');
            } catch (rollbackError) {
                // 事务已经不在了，忽略
            }
            throw new Error('迁移 v' + migration.version + '（' + migration.name + '）失败：' + err.message);
        }
    });
}

/**
 * 打开（不存在则创建）全局库。
 * @param {string} file 库文件路径
 * @returns {object} handle
 */
function open(file) {
    var sqlite = requireSqlite();
    var target = path.resolve(file);

    var dir = path.dirname(target);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    assertDatabaseFile(target);
    var db = new sqlite.DatabaseSync(target);

    // WAL 让读写不互相阻塞，busy_timeout 让并发写等一会儿而不是直接报错
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA busy_timeout=5000');
    db.exec('PRAGMA foreign_keys=ON');

    migrate(db);

    var pollTimer = null;
    var lastDataVersion = null;
    var inTransaction = false;

    var handle = {
        db: db,
        file: target,
        events: new EventEmitter()
    };

    /**
     * 在一个事务里跑 fn，成功提交、失败回滚并重新抛出。
     * 提交后广播变更事件，让各项目的 store 重新读一遍。
     *
     * @param {Function} fn
     * @param {{projectId?: string|null}} [change] 传了才广播；projectId 为 null 表示影响所有项目
     */
    handle.transaction = function (fn, change) {
        if (inTransaction) {
            throw new Error('不支持嵌套事务：事务里的写操作请直接调用 repo');
        }
        inTransaction = true;
        db.exec('BEGIN IMMEDIATE');

        var result;
        try {
            result = fn();
            db.exec('COMMIT');
        } catch (err) {
            try {
                db.exec('ROLLBACK');
            } catch (rollbackError) {
                // 事务已经不在了，忽略
            }
            throw err;
        } finally {
            inTransaction = false;
        }

        if (change) {
            handle.events.emit('change', {
                projectId: change.projectId === undefined ? null : change.projectId,
                external: false
            });
        }
        return result;
    };

    function readDataVersion() {
        var row = db.prepare('PRAGMA data_version').get();
        return row ? Number(row.data_version) : 0;
    }

    handle.startPolling = function (intervalMs) {
        if (pollTimer) return;
        lastDataVersion = readDataVersion();

        pollTimer = setInterval(function () {
            var current;
            try {
                current = readDataVersion();
            } catch (err) {
                return; // 库暂时读不到（比如被替换），下一轮再看
            }
            if (current === lastDataVersion) return;
            lastDataVersion = current;

            // 监听器里的异常不允许把轮询（进而把整个进程）带走：这里跑在定时器
            // 回调里，没有 Express 那种兜底，抛出去就是 uncaughtException。
            // 外部改动来自别的进程，监听器出错是它们的 bug，不该由轮询者承担。
            try {
                handle.events.emit('change', { projectId: null, external: true });
            } catch (err) {
                console.error('[apiloop] 处理外部变更时出错（已忽略，服务继续运行）：' +
                    ((err && err.stack) || err));
            }
        }, intervalMs || DEFAULT_POLL_INTERVAL);

        // 定时器不能拦着进程退出
        if (pollTimer.unref) pollTimer.unref();
    };

    handle.stopPolling = function () {
        if (!pollTimer) return;
        clearInterval(pollTimer);
        pollTimer = null;
    };

    handle.close = function () {
        handle.stopPolling();
        try {
            db.close();
        } catch (err) {
            // 关不掉就算了，进程退出时系统会回收
        }
    };

    return handle;
}

module.exports = {
    open: open,
    assertDatabaseFile: assertDatabaseFile
};
