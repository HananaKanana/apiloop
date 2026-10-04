/**
 * 数据库操作（第九轮第 3 节）。
 *
 * 测接口时常要「先往库里造一条测试数据」「调完接口去库里看有没有写进去」「拿库里刚生成的
 * 验证码填进下一个请求」。以前只能在另一个数据库工具里来回切，这里把它做成表格：
 *
 *   - **连接**存在 `projects.extra.databases`：`{ id, name, type, host, port, user, password, database }`，
 *     每个字段都能写 `{{变量}}`（开发 / 测试连的是不同的库，用环境变量区分）；
 *   - **操作**存在 `apis.extra.dbOps`：`{ id, enabled, phase, connectionId, statement, extracts }`，
 *     `phase` 是 prerequest / test 之外的第三种时机 —— 见 `lib/send-core.js` 里的执行顺序。
 *
 * 这个文件分两半：
 *  1. **纯函数**（清洗、语句解析、控制台文案）—— 不 require 任何驱动，能单独跑断言；
 *  2. **执行**（`run`）—— 三个驱动都**用到时才 require**，它们的连接只在一次操作里存活。
 *
 * 为什么不建连接池：池要管生命周期、要处理连接失效、进程退出还得收尾，而这里一次
 * 测试集也就几十次连接。**每次开一个、用完关掉**，行为好推演，出错也好定位。
 *
 * 三个容易想歪的地方：
 * - **超时自己兜一层**。mysql2 的 `connectTimeout` 只管连接不管查询，pg 的
 *   `statement_timeout` 是服务端侧的（服务端不理它就没用），ioredis 的 `commandTimeout`
 *   在重连时又是另一套。所以三个驱动都用 `raceTimeout` 兜 10 秒 —— 上面那些是**优化**，
 *   真正保证「不会挂住」的是这一层。
 * - **ioredis 必须挂一个 `error` 监听**。它是 EventEmitter，连接出错时发 `error` 事件，
 *   没人监听就会**把整个进程带崩**（Node 对未处理的 `error` 事件就是这个行为）。
 *   `retryStrategy` 也返回 null：默认会无限重连，一次「连不上」能转几十秒。
 * - **取回来的值要能 JSON 出去**（要进 NDJSON、要过网关）。所以 MySQL 开了 `dateStrings`，
 *   `Date` 对象到时候会变成一个没法预测的字符串；DECIMAL / 大整数按驱动默认给字符串，
 *   正好保住精度。
 */

var variables = require('./variables');
var assertions = require('./assertions');

/** 支持的数据库类型（界面上的下拉就是它） */
var TYPES = ['mysql', 'postgres', 'redis'];

var TYPE_LABELS = { mysql: 'MySQL', postgres: 'PostgreSQL', redis: 'Redis' };
var DEFAULT_PORTS = { mysql: 3306, postgres: 5432, redis: 6379 };

/** 操作分两个时机：发请求前 / 拿到响应后 */
var PHASES = ['pre', 'post'];

var SCOPES = ['environment', 'project'];

var TIMEOUT_MS = 10000;

/** 一次最多取多少行（几百行的结果对界面没意义，还会把每行都 JSON 一遍） */
var MAX_ROWS = 100;

/** 控制台里带出前几行数据 */
var CONSOLE_ROWS = 5;

/** 控制台里语句那一截最多显示多少字 */
var STATEMENT_LIMIT = 60;

/** 控制台里前几行数据最多显示多少字（不然一个宽表就能刷一屏） */
var SAMPLE_LIMIT = 400;

function str(value) {
    return value === null || value === undefined ? '' : String(value);
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/* ------------------------------------------------------------------ 清洗 */

/** 端口：给得不合法（空、0、7 位数）就用这个类型的默认端口，不报错 */
function portOf(value, type) {
    var port = Number(str(value).trim());
    if (!Number.isFinite(port) || port <= 0 || port > 65535) return DEFAULT_PORTS[type];
    return Math.round(port);
}

/**
 * 单个连接行。**认不出的类型返回 null** —— 一条坏连接不该让整个项目 DTO 出错，
 * 也不该在界面上留一个点不开的条目。
 *
 * @param {object} item
 * @param {object} [options] `{ allowEmptyName }` —— 「测试连接」时名字还没填是常事，
 *   那时候给个占位名就收下（存库的路径不许空名字，见 `toDatabases`）
 */
function toDatabase(item, options) {
    var opts = options || {};
    if (!isPlainObject(item)) return null;

    var type = str(item.type).toLowerCase();
    // 有的人写 postgresql，收下
    if (type === 'postgresql') type = 'postgres';
    if (TYPES.indexOf(type) === -1) return null;

    var name = str(item.name).trim();
    if (!name && opts.allowEmptyName !== true) return null;
    if (!name) name = '未命名连接';

    /**
     * 端口也允许写 `{{变量}}`（开发 / 测试连的是不同的库）。**认得出是变量就原样留着**，
     * 交给 `resolveConnection` 在替换之后才转数字 —— 在这里就转的话，`{{dbPort}}`
     * 会被当成非法端口、悄悄换成默认端口，用户只看到「连不上 6379」，
     * 根本看不出是变量没生效（第九轮第 3 节自测就是这么撞出来的）。
     */
    var rawPort = str(item.port).trim();
    var port = rawPort.indexOf('{{') === -1 ? portOf(rawPort, type) : rawPort;

    return {
        id: str(item.id).trim() || ('db' + (opts.index === undefined ? '' : opts.index)),
        name: name,
        type: type,
        host: str(item.host),
        port: port,
        user: str(item.user),
        password: str(item.password),
        // Redis 时这一格是库号（0–15）
        database: str(item.database)
    };
}

/**
 * 连接表：`[{ id, name, type, host, port, user, password, database }]`。
 *
 * 读的时候宽容（库里可能存着写坏的 / 老版本的行）：认不出的类型、没有名字的行直接丢掉。
 * id 重复的也丢（后面的那个），不然界面上两行同一个 key、操作也分不清指的是谁。
 */
function toDatabases(list) {
    if (!Array.isArray(list)) return [];

    var out = [];
    var seen = {};

    list.forEach(function (item) {
        var row = toDatabase(item, { index: out.length });
        if (!row) return;

        var id = row.id || ('db' + out.length);
        if (seen[id]) return;
        seen[id] = true;
        row.id = id;

        out.push(row);
    });

    return out;
}

/**
 * 提取行：`{ id, enabled, path, scope, name }`。
 *
 * 和可视化提取（`lib/assertions.js` 的 `toExtracts`）几乎一样，只有一处不同：
 * **路径可以是空的** —— 空路径就是「整个返回值」。SQL 的返回值是行数组、Redis 是命令的
 * 返回，这两种「整体」都挺常用（比如把 `[0]` 整行存下来）。
 *
 * 没写变量名的行丢掉：那种行跑起来只会得到一句「没有名字」，留着是噪音。
 */
function toDbExtracts(list) {
    if (!Array.isArray(list)) return [];

    var out = [];

    list.forEach(function (item) {
        if (!isPlainObject(item)) return;

        var name = str(item.name).trim();
        if (!name) return;

        var scope = str(item.scope) || 'environment';
        if (SCOPES.indexOf(scope) === -1) return;

        out.push({
            id: str(item.id).trim() || ('e' + out.length),
            enabled: item.enabled !== false,
            path: str(item.path).trim(),
            scope: scope,
            name: name
        });
    });

    return out;
}

/**
 * 操作行：`{ id, enabled, phase, connectionId, statement, extracts }`。
 *
 * 语句为空的行丢掉 —— 和断言里「没有字段名的行」一个道理，跑起来只会得到一句
 * 「没有语句」。连接可以留空（运行时给「没有选连接」），因为用户可能先写语句再挑连接。
 */
function toDbOps(list) {
    if (!Array.isArray(list)) return [];

    var out = [];

    list.forEach(function (item) {
        if (!isPlainObject(item)) return;

        var statement = str(item.statement);
        if (!statement.trim()) return;

        var phase = PHASES.indexOf(str(item.phase)) > -1 ? str(item.phase) : 'pre';

        out.push({
            id: str(item.id).trim() || ('op' + out.length),
            enabled: item.enabled !== false,
            phase: phase,
            connectionId: str(item.connectionId).trim(),
            statement: statement,
            extracts: toDbExtracts(item.extracts)
        });
    });

    return out;
}

/* ------------------------------------------------------------------ Redis 命令 */

/**
 * 把一行命令拆成参数数组，双引号 / 单引号包起来的部分算一个参数（里面可以有空格）。
 *
 * 支持反斜杠转义（`\"`）。引号没配对时返回失败 —— 与其猜用户想干什么，
 * 不如直接说「引号没有配对」，他改一下就好。
 *
 * @returns {{ok: true, args: string[]} | {ok: false, reason: string}}
 */
function parseCommand(text) {
    var source = str(text);
    var args = [];
    var current = '';
    var quote = null;
    var started = false;

    for (var i = 0; i < source.length; i++) {
        var ch = source.charAt(i);

        if (quote) {
            if (ch === '\\' && i + 1 < source.length) {
                current += source.charAt(i + 1);
                i += 1;
                continue;
            }
            if (ch === quote) {
                quote = null;
                continue;
            }
            current += ch;
            continue;
        }

        if (ch === '"' || ch === "'") {
            quote = ch;
            started = true;
            continue;
        }

        if (/\s/.test(ch)) {
            if (started) {
                args.push(current);
                current = '';
                started = false;
            }
            continue;
        }

        current += ch;
        started = true;
    }

    if (quote) return { ok: false, reason: '引号没有配对' };
    if (started) args.push(current);

    return { ok: true, args: args };
}

/** Redis 里的库号，写坏了一律当 0 */
function redisDatabase(value) {
    var number = Number(str(value).trim());
    if (!Number.isFinite(number) || number < 0 || number > 255) return 0;
    return Math.trunc(number);
}

/* ------------------------------------------------------------------ 执行 */

/** 一行里的 `{{变量}}` 逐个替换；连接和语句共用这一份（和发送用的是同一张表） */
function resolveText(text, vars) {
    return variables.resolve(str(text), vars || {}).text;
}

/**
 * 把连接行解析成「真要连的那个地址」。
 *
 * 变量替换**在连接这一层就做完**：`{{dbHost}}` 这种写法很常用（开发 / 测试连不同的库），
 * 到了驱动那里必须是真地址。
 *
 * @returns {{problem: string} | {id, name, type, host, port, user, password, database}}
 */
function resolveConnection(connection, vars) {
    if (!isPlainObject(connection)) return { problem: '没有找到这个连接' };

    var type = str(connection.type).toLowerCase();
    if (type === 'postgresql') type = 'postgres';
    if (TYPES.indexOf(type) === -1) return { problem: '不认识的数据库类型：' + str(connection.type) };

    var name = str(connection.name).trim() || '未命名连接';
    var host = resolveText(connection.host, vars).trim();
    if (!host) return { problem: '连接「' + name + '」没有填主机' };

    var user = resolveText(connection.user, vars).trim();
    if (!user && type !== 'redis') {
        return { problem: '连接「' + name + '」没有填用户名' };
    }

    var portText = resolveText(connection.port, vars).trim();
    var password = resolveText(connection.password, vars);
    var database = resolveText(connection.database, vars).trim();

    /**
     * 变量没替换掉时**当场说清楚**。默认行为是「找不到的变量原样留着」，那样
     * `host: "{{dbHost}}"` 最后会变成一句 `getaddrinfo ENOTFOUND {{dbhost}}` ——
     * 用户根本看不出是变量没配对。端口漏在外面的话，未替换的 `{{dbPort}}` 会被
     * 当成非法端口、悄悄换成默认端口，更看不出来（自测撞到过）。
     */
    var unresolved = [];
    [['主机', host], ['端口', portText], ['用户名', user], ['密码', password], ['数据库名', database]]
        .forEach(function (pair) {
            if (pair[1].indexOf('{{') !== -1) unresolved.push(pair[0]);
        });
    if (unresolved.length) {
        return {
            problem: '连接「' + name + '」的' + unresolved.join('、') +
                '里还有没替换的变量，检查当前环境里有没有这些变量'
        };
    }

    var port = portOf(portText, type);

    return {
        id: str(connection.id),
        name: name,
        type: type,
        host: host,
        port: port,
        user: user,
        password: password,
        database: database
    };
}

/** 驱动抛出来的错误转成给用户看的一句话（有错误码就把码带上，好搜） */
function errorText(err) {
    var message = err && err.message ? String(err.message) : str(err);
    var code = err && err.code ? String(err.code) : '';
    if (code && message.indexOf(code) === -1) return code + '：' + message;
    return message;
}

/**
 * 兜底超时。驱动自己的超时选项都留着（能早断就早断），但**真正保证不会挂住的是这一层**：
 * 有的驱动只在连接阶段认超时，有的把超时交给服务端，服务端不理它就一直等。
 *
 * 超时的那个 promise 后面可能还会 reject —— `Promise.race` 已经挂了处理器，
 * 不会变成 unhandled rejection。
 */
function raceTimeout(promise, ms, onTimeout) {
    var timer = null;

    var timeout = new Promise(function (resolve, reject) {
        timer = setTimeout(function () {
            if (typeof onTimeout === 'function') onTimeout();
            reject(new Error('执行超时（' + Math.max(1, Math.round(ms / 1000)) + ' 秒）'));
        }, ms);
    });

    return Promise.race([promise, timeout]).finally(function () {
        if (timer) clearTimeout(timer);
    });
}

function capRows(rows) {
    if (rows.length <= MAX_ROWS) return { rows: rows, truncated: false };
    return { rows: rows.slice(0, MAX_ROWS), truncated: true };
}

async function executeMysql(target, statement, timeoutMs) {
    var mysql = require('mysql2/promise');
    var conn = null;
    var timedOut = false;

    async function work() {
        conn = await mysql.createConnection({
            host: target.host,
            port: target.port,
            user: target.user,
            password: target.password,
            database: target.database || undefined,
            connectTimeout: timeoutMs,
            // DATE / DATETIME 直接给字符串：Date 对象 JSON 出去是什么样没人说得准
            dateStrings: true,
            multipleStatements: false
        });

        var out = await conn.query(statement);

        if (Array.isArray(out[0])) {
            var packed = capRows(out[0]);
            return { kind: 'rows', rows: packed.rows, truncated: packed.truncated, affected: 0 };
        }

        return {
            kind: 'affected',
            rows: [],
            truncated: false,
            affected: Number(out[0] && out[0].affectedRows) || 0
        };
    }

    try {
        return await raceTimeout(work(), timeoutMs, function () {
            timedOut = true;
            try { if (conn) conn.destroy(); } catch (err) { /* 已经断了 */ }
        });
    } finally {
        if (conn && !timedOut) {
            try {
                await conn.end();
            } catch (err) {
                try { conn.destroy(); } catch (err2) { /* 已经断了 */ }
            }
        }
    }
}

async function executePostgres(target, statement, timeoutMs) {
    var pg = require('pg');
    var connected = false;
    var timedOut = false;

    var client = new pg.Client({
        host: target.host,
        port: target.port,
        user: target.user || undefined,
        password: target.password || undefined,
        database: target.database || undefined,
        connectionTimeoutMillis: timeoutMs,
        // 服务端侧的兜底（服务端认它才有用）
        statement_timeout: timeoutMs,
        query_timeout: timeoutMs
    });

    async function work() {
        await client.connect();
        connected = true;

        var out = await client.query(statement);

        var rowCount = Number(out.rowCount) || 0;
        var rows = Array.isArray(out.rows) ? out.rows : [];
        var command = str(out.command).toUpperCase();
        var takesRows = rows.length > 0 || command === 'SELECT' || command === 'SHOW' ||
            command === 'EXPLAIN' || command === 'VALUES';

        if (takesRows) {
            var packed = capRows(rows);
            return { kind: 'rows', rows: packed.rows, truncated: packed.truncated, affected: 0 };
        }

        return { kind: 'affected', rows: [], truncated: false, affected: rowCount };
    }

    try {
        return await raceTimeout(work(), timeoutMs, function () {
            timedOut = true;
            // 查询还挂在服务端上，end() 会等它 —— 不 await，让它自己收尾
            try { client.end().catch(function () { /* 断了就算了 */ }); } catch (err) { /* 同上 */ }
        });
    } finally {
        if (connected && !timedOut) {
            try {
                await client.end();
            } catch (err) { /* 连接已经没了，不算这次操作的错 */ }
        }
    }
}

async function executeRedis(target, statement, timeoutMs) {
    var Redis = require('ioredis');

    var parsed = parseCommand(statement);
    if (!parsed.ok) throw new Error(parsed.reason);
    if (!parsed.args.length) throw new Error('命令是空的');

    var client = new Redis({
        host: target.host,
        port: target.port,
        username: target.user || undefined,
        password: target.password || undefined,
        db: redisDatabase(target.database),
        lazyConnect: true,
        connectTimeout: timeoutMs,
        commandTimeout: timeoutMs,
        // 默认无限重连：一次「连不上」能转几十秒，这里只试一次
        retryStrategy: function () { return null; },
        maxRetriesPerRequest: 0
    });

    /**
     * 不挂这个监听，一次连接错误就会把整个进程带崩（EventEmitter 的 error 事件没人接就是抛）。
     * 顺手把最后一个错误记下来：ioredis 在 connect 失败时给的是 `Connection is closed.`，
     * 光看这句用户不知道是「没连上」还是「密码错了」。
     */
    var lastError = null;
    client.on('error', function (err) { lastError = err; });

    async function work() {
        try {
            await client.connect();
        } catch (err) {
            throw lastError || err;
        }

        try {
            return { kind: 'value', rows: [], truncated: false, affected: 0, value: await client.call.apply(client, parsed.args) };
        } catch (err) {
            throw err && err.message === 'Connection is closed.' && lastError ? lastError : err;
        }
    }

    try {
        return await raceTimeout(work(), timeoutMs, function () {
            try { client.disconnect(); } catch (err) { /* 已经断了 */ }
        });
    } finally {
        // 别用 quit()：它要等服务端回话，服务端不理它这里就要多等一个超时
        try { client.disconnect(); } catch (err) { /* 已经断了 */ }
    }
}

function execute(target, statement, timeoutMs) {
    if (target.type === 'redis') return executeRedis(target, statement, timeoutMs);
    if (target.type === 'postgres') return executePostgres(target, statement, timeoutMs);
    return executeMysql(target, statement, timeoutMs);
}

/**
 * 跑一个数据库操作。**永远 resolve**：连不上、语句错、超时都在 `error` 里，
 * 调用方不用 try/catch（和 `lib/executor.js` 一个约定）。
 *
 * @param {object} op `toDbOps` 的结果里的一行（只有 statement 会被读）
 * @param {object} connection 连接行（可能是 `{{变量}}` 的原文）
 * @param {object} vars 这次发送最终的变量表
 * @param {object} [options] `{ timeoutMs }`
 * @returns {Promise<{ok: boolean, timeMs: number, statement: string,
 *   connection: {id, name, type}, kind?: string, rows?: Array, truncated?: boolean,
 *   affected?: number, value?: *, error?: string}>}
 */
function run(op, connection, vars, options) {
    var opts = options || {};
    var timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : TIMEOUT_MS;
    var started = Date.now();

    var statement = resolveText(op && op.statement, vars);
    if (!statement.trim()) {
        return Promise.resolve({
            ok: false,
            error: '语句是空的',
            timeMs: 0,
            statement: statement,
            connection: null
        });
    }

    /**
     * 连接找不到时**先说这一条**，别再往下走：`connectionId` 指向别的项目里的连接
     * （跨项目复制接口就是这个下场，见第九轮计划）或者连接已经被删了，这两种情况
     * 报「没有填主机」之类的都牛头不对马嘴。
     */
    if (!isPlainObject(connection)) {
        var missingId = str(op && op.connectionId).trim();
        return Promise.resolve({
            ok: false,
            error: missingId ? '连接不存在：' + missingId : '这条操作没有选连接',
            timeMs: 0,
            statement: statement,
            connection: null
        });
    }

    var target = resolveConnection(connection, vars);
    if (target.problem) {
        return Promise.resolve({
            ok: false,
            error: target.problem,
            timeMs: 0,
            statement: statement,
            connection: null
        });
    }

    // 结果里只带「够显示的」，**密码一个字都不往外带**（它会进控制台、进历史、过网关）
    var identity = { id: target.id, name: target.name, type: target.type };

    return execute(target, statement, timeoutMs).then(function (out) {
        return Object.assign({
            ok: true,
            timeMs: Date.now() - started,
            statement: statement,
            connection: identity
        }, out);
    }, function (err) {
        return {
            ok: false,
            error: errorText(err),
            timeMs: Date.now() - started,
            statement: statement,
            connection: identity
        };
    });
}

/* ------------------------------------------------------------------ 结果 → 给用户看的东西 */

/** 语句压缩成一行、截断，用在控制台和测试结果的名字里 */
function shortStatement(statement) {
    var text = str(statement).replace(/\s+/g, ' ').trim();
    if (text.length <= STATEMENT_LIMIT) return text;
    return text.slice(0, STATEMENT_LIMIT) + '…';
}

/** 「「本地库」SELECT id FROM t …」——控制台和测试结果都从这里起头 */
function labelOf(outcome, connection) {
    var name = (outcome && outcome.connection && outcome.connection.name) ||
        (connection && connection.name) || '未选连接';
    return '「' + name + '」' + shortStatement(outcome && outcome.statement);
}

/** 一行数据压成一行 JSON（给控制台看的） */
function rowText(row) {
    if (!isPlainObject(row)) return assertions.textOf(row);
    try {
        return JSON.stringify(row);
    } catch (err) {
        return assertions.textOf(row);
    }
}

/** 成功时的摘要：返回几行 / 影响几行 / Redis 返回什么 */
function summaryOf(outcome) {
    if (outcome.kind === 'rows') {
        var count = outcome.rows.length;
        var text = '返回 ' + count + ' 行' + (outcome.truncated ? '（只取了前 ' + MAX_ROWS + ' 行）' : '');
        return text + '，' + outcome.timeMs + ' ms';
    }

    if (outcome.kind === 'affected') {
        return '影响 ' + outcome.affected + ' 行，' + outcome.timeMs + ' ms';
    }

    var value = outcome.value;
    var what;
    if (value === null || value === undefined) what = '返回空';
    else if (Array.isArray(value)) what = '返回数组（' + value.length + ' 项）';
    else if (typeof value === 'object') what = '返回对象';
    else what = '返回 ' + assertions.textOf(value);

    return what + '，' + outcome.timeMs + ' ms';
}

/**
 * 控制台里的一行（`state.console` 的形状）。失败的进 `level: 'error'`，界面上是红的。
 *
 * 成功取到行时把前 5 行也贴出来 —— 「调完接口去库里看数据有没有写进去」看的正是这几行，
 * 不贴的话用户还得再开一个数据库工具，那就白做了。
 */
function consoleLine(outcome, connection) {
    if (!outcome) return null;

    var label = labelOf(outcome, connection);
    if (!outcome.ok) {
        return { level: 'error', source: '数据库', text: label + ' 失败：' + outcome.error };
    }

    var text = label + ' —— ' + summaryOf(outcome);

    if (outcome.kind === 'rows' && outcome.rows.length) {
        var lines = outcome.rows.slice(0, CONSOLE_ROWS).map(rowText);
        var sample = lines.join('\n');
        if (sample.length > SAMPLE_LIMIT) sample = sample.slice(0, SAMPLE_LIMIT) + '…';
        text += '\n' + sample;
    }

    return { level: 'log', source: '数据库', text: text };
}

/** 失败的操作在「测试结果」里也留一条（不然只有控制台里那一行，很容易漏看） */
function testEntry(outcome, connection) {
    return {
        name: '数据库操作：' + labelOf(outcome, connection),
        passed: false,
        error: outcome.error,
        source: '数据库操作'
    };
}

/**
 * 把一次操作的结果按提取行取出来，存成环境 / 项目变量。
 *
 * 形状和 `lib/assertions.js` 的 `runExtracts` 一样（调用方并进脚本状态就行），
 * **路径规则也复用同一份**（`parsePath` / `valueAt`）—— 两处各写一套迟早对不上。
 *
 * 取值基准（`base`）：SQL 是返回的行数组（`[0].code` 就是第一行的 `code` 列），
 * Redis 是命令的返回（字符串 / 数组 / 数字）。**路径留空就是整个返回值。**
 *
 * 三种「没提取到」都只记警告、不算失败：取不到值、没选环境、没有结果。
 *
 * @returns {{environment: object, project: object, console: Array, warnings: Array, names: object}}
 */
function runExtracts(rows, base, options) {
    var opts = options || {};
    var result = { environment: {}, project: {}, console: [], warnings: [], names: {} };

    (rows || []).forEach(function (row) {
        if (!row || row.enabled === false) return;

        if (row.scope === 'environment' && !opts.hasEnvironment) {
            result.warnings.push('提取「' + row.name + '」：没有选环境，这个变量没有保存');
            return;
        }

        if (base === undefined) {
            result.warnings.push('提取「' + row.name + '」：这次没有结果可提取');
            return;
        }

        var value;
        if (!row.path) {
            value = base;
        } else {
            value = assertions.valueAt(base, row.path);
            if (value === undefined) {
                result.warnings.push('提取「' + row.name + '」：没有这个字段');
                return;
            }
        }

        var text = typeof value === 'string' ? value : assertions.textOf(value);
        var bucket = row.scope === 'project' ? result.project : result.environment;
        bucket[row.name] = text;
        result.names[row.name] = row.scope;
        // 文案和可视化提取共用一份（`lib/assertions.js` 的 consoleLine）
        result.console.push({
            level: 'log',
            text: assertions.consoleLine(row.name, text),
            source: '数据库'
        });
    });

    return result;
}

/** 从一串操作里挑出某一阶段的（只有启用的会被挑出来） */
function opsFor(ops, phase) {
    return (ops || []).filter(function (op) {
        return op && op.enabled !== false && op.phase === phase;
    });
}

module.exports = {
    TYPES: TYPES,
    TYPE_LABELS: TYPE_LABELS,
    DEFAULT_PORTS: DEFAULT_PORTS,
    PHASES: PHASES,
    SCOPES: SCOPES,
    TIMEOUT_MS: TIMEOUT_MS,
    MAX_ROWS: MAX_ROWS,
    CONSOLE_ROWS: CONSOLE_ROWS,
    toDatabases: toDatabases,
    toDatabase: toDatabase,
    toDbOps: toDbOps,
    toDbExtracts: toDbExtracts,
    parseCommand: parseCommand,
    redisDatabase: redisDatabase,
    resolveConnection: resolveConnection,
    run: run,
    runExtracts: runExtracts,
    opsFor: opsFor,
    consoleLine: consoleLine,
    testEntry: testEntry,
    labelOf: labelOf,
    summaryOf: summaryOf,
    shortStatement: shortStatement
};
