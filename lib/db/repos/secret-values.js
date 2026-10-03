/**
 * secret_values 表读写（第三轮第 3 节；第 7 节起改成「自己的设备之间同步」）。
 *
 * 变量行标了 `secret: true` 的，值按「人 + 变量所在位置 + 变量名」存在这里；共享数据
 * （项目 / 目录 / 环境的 variables JSON）里 value 永远空串，所以同事看不到。
 *
 * **这一张表走单独的同步**（不并入 `lib/sync/rows.js` 那套多实体同步）：只交换「当前用户
 * 自己的」行 —— 接口里写死 `user_id = req.user.id`，A 的行拿不到、也推不进 B 的。三列各有分工：
 *
 *   - `deleted`：墓碑。关掉保密 / 删掉变量时**不真删**，记成 `deleted = 1`、值置空，
 *     否则别的设备上的旧值会被推回来。读的地方一律跳过 `deleted = 1`。
 *   - `dirty`：**只在客户端**有意义：1 = 本机改过、还没推上云端。
 *   - `seq`：**只在云端**有意义：每次写入取一个新号，客户端按它增量拉。
 *
 * 同一份代码两边都要跑，靠 `handle.localStore` 区分（客户端那一份由
 * `lib/gateway/space.js` 打开空间时打上这个标记）：
 *   - 客户端写：`dirty = 1`，不动 `seq`；
 *   - 云端写：`dirty = 0`，从 `meta.secret_seq` 取新 `seq`。
 * 反过来做也不会坏（客户端的 seq 没人看、云端的 dirty 没人看），但分开更省事、也更好读。
 *
 * `removeScope`（目录 / 环境被删）照旧**真删、不同步**：那个位置已经不存在了，
 * 别的设备上残留几行没有害处。
 */

var SELECT = 'SELECT * FROM secret_values';

var SCOPES = ['project', 'folder', 'environment'];

/** 这个库是不是客户端那一份（要往云端推自己的保密值） */
function isLocal(handle) {
    return !!(handle && handle.localStore === true);
}

/* ------------------------------------------------------------------ seq（云端） */

function latestSeq(handle) {
    var row = handle.db.prepare("SELECT value FROM meta WHERE key = 'secret_seq'").get();
    var value = row ? Number(row.value) : 0;
    return Number.isFinite(value) && value > 0 ? value : 0;
}

/** 取一个递增号。seq 单调递增，客户端拿它当游标（时间戳会被同毫秒写入和时钟偏差坑到） */
function nextSeq(handle) {
    var next = latestSeq(handle) + 1;
    handle.db.prepare(
        "INSERT INTO meta (key, value) VALUES ('secret_seq', ?) " +
        'ON CONFLICT (key) DO UPDATE SET value = excluded.value'
    ).run(String(next));
    return next;
}

/* ------------------------------------------------------------------ 读 */

function fromRow(row) {
    if (!row) return null;
    return {
        userId: row.user_id,
        scope: row.scope,
        scopeId: row.scope_id,
        key: row.key,
        value: row.value,
        deleted: !!row.deleted,
        dirty: !!row.dirty,
        seq: row.seq,
        updatedAt: row.updated_at
    };
}

/** 这个用户在那个位置存着的值 → `{ key: value }`。墓碑不算值 */
function mapFor(handle, userId, scope, scopeId) {
    var out = {};
    if (!userId) return out;

    handle.db.prepare(SELECT + ' WHERE user_id = ? AND scope = ? AND scope_id = ? AND deleted = 0')
        .all(userId, scope, scopeId).forEach(function (row) {
            out[row.key] = row.value;
        });
    return out;
}

/** 一行（**含墓碑**）—— 同步时要比 updated_at，墓碑也算一行 */
function getOne(handle, userId, scope, scopeId, key) {
    return fromRow(handle.db.prepare(
        SELECT + ' WHERE user_id = ? AND scope = ? AND scope_id = ? AND key = ?'
    ).get(userId, scope, scopeId, String(key)));
}

/** 云端：某个游标之后的行（含墓碑），按 seq 升序 */
function listSince(handle, userId, since, limit) {
    return handle.db.prepare(
        SELECT + ' WHERE user_id = ? AND seq > ? ORDER BY seq LIMIT ?'
    ).all(userId, Number(since) || 0, Number(limit) || 500).map(fromRow);
}

/** 客户端：还没推上去的行 */
function listDirty(handle, userId) {
    return handle.db.prepare(
        SELECT + ' WHERE user_id = ? AND dirty = 1 ORDER BY updated_at, rowid'
    ).all(userId).map(fromRow);
}

/** 那个位置下所有**没删**的 key（keepOnly 用） */
function liveKeys(handle, userId, scope, scopeId) {
    return handle.db.prepare(
        "SELECT key FROM secret_values WHERE user_id = ? AND scope = ? AND scope_id = ? AND deleted = 0"
    ).all(userId, scope, scopeId).map(function (row) { return row.key; });
}

/* ------------------------------------------------------------------ 写（本地） */

function stampNow() {
    return Date.now();
}

/**
 * 写一行。同一个 `(user, scope, scopeId, key)` 覆盖，`deleted` 一起清掉（又填了值 = 复活）。
 */
function upsert(handle, userId, scope, scopeId, key, value) {
    var text = value === undefined || value === null ? '' : String(value);
    var now = stampNow();

    if (isLocal(handle)) {
        handle.db.prepare(
            'INSERT INTO secret_values (user_id, scope, scope_id, key, value, deleted, dirty, seq, updated_at) ' +
            'VALUES (?, ?, ?, ?, ?, 0, 1, 0, ?) ' +
            'ON CONFLICT (user_id, scope, scope_id, key) DO UPDATE SET ' +
            'value = excluded.value, deleted = 0, dirty = 1, updated_at = excluded.updated_at'
        ).run(userId, scope, scopeId, String(key), text, now);
        return;
    }

    handle.db.prepare(
        'INSERT INTO secret_values (user_id, scope, scope_id, key, value, deleted, dirty, seq, updated_at) ' +
        'VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?) ' +
        'ON CONFLICT (user_id, scope, scope_id, key) DO UPDATE SET ' +
        'value = excluded.value, deleted = 0, dirty = 0, seq = excluded.seq, updated_at = excluded.updated_at'
    ).run(userId, scope, scopeId, String(key), text, nextSeq(handle), now);
}

/**
 * 墓碑：`deleted = 1`、值置空、`updated_at` 打当前时间，**不真删**。
 * 行不存在时什么都不做（本地没有、云端也没有的东西，没有别的设备需要知道它被删了）。
 */
function tombstone(handle, userId, scope, scopeId, key) {
    var now = stampNow();

    if (isLocal(handle)) {
        handle.db.prepare(
            "UPDATE secret_values SET deleted = 1, value = '', dirty = 1, updated_at = ? " +
            'WHERE user_id = ? AND scope = ? AND scope_id = ? AND key = ?'
        ).run(now, userId, scope, scopeId, String(key));
        return;
    }

    handle.db.prepare(
        "UPDATE secret_values SET deleted = 1, value = '', dirty = 0, seq = ?, updated_at = ? " +
        'WHERE user_id = ? AND scope = ? AND scope_id = ? AND key = ?'
    ).run(nextSeq(handle), now, userId, scope, scopeId, String(key));
}

function removeKeys(handle, userId, scope, scopeId, keys) {
    (keys || []).forEach(function (key) {
        tombstone(handle, userId, scope, scopeId, key);
    });
}

/** 只留下 `keepKeys` 里的那些行，其余记成墓碑（保密开关关掉、行被删掉时用） */
function keepOnly(handle, userId, scope, scopeId, keepKeys) {
    var keep = {};
    (keepKeys || []).forEach(function (key) { keep[String(key)] = true; });

    liveKeys(handle, userId, scope, scopeId).forEach(function (key) {
        if (keep[key]) return;
        tombstone(handle, userId, scope, scopeId, key);
    });
}

/** 目录 / 环境被删掉时清掉它的保密值。**真删**，不走同步 */
function removeScope(handle, scope, scopeId) {
    handle.db.prepare('DELETE FROM secret_values WHERE scope = ? AND scope_id = ?').run(scope, scopeId);
}

/* ------------------------------------------------------------------ 写（同步） */

/**
 * 收下别处来的一行（云端发来的，或者客户端推上来的）。**按 `updated_at` 大的赢**。
 *
 * 两边都写同一行时留新的那份；本地/云端自己后来的改动如果更新，也不会被这份旧数据盖掉。
 *
 * @param {{local: boolean}} mode `local: true` 表示「这是云端发来、落到客户端」，
 *   写完之后 `dirty = 0`（不用再推回去）
 * @returns {boolean} 真的写进去了没有
 */
function writeRemote(handle, userId, item, mode) {
    if (!item) return false;

    var scope = item.scope;
    if (SCOPES.indexOf(scope) === -1) return false;

    var scopeId = item.scopeId === undefined || item.scopeId === null ? '' : String(item.scopeId);
    var key = item.key === undefined || item.key === null ? '' : String(item.key);
    if (!scopeId || !key) return false;

    var updatedAt = Number(item.updatedAt);
    if (!Number.isFinite(updatedAt) || updatedAt <= 0) return false;

    var current = getOne(handle, userId, scope, scopeId, key);
    if (current && Number(current.updatedAt) >= updatedAt) return false;

    var deleted = item.deleted === true ? 1 : 0;
    var value = deleted ? '' : (item.value === undefined || item.value === null ? '' : String(item.value));
    var seq = mode && mode.local === true
        ? (Number.isFinite(Number(item.seq)) ? Number(item.seq) : 0)
        : nextSeq(handle);

    handle.db.prepare(
        'INSERT INTO secret_values (user_id, scope, scope_id, key, value, deleted, dirty, seq, updated_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?) ' +
        'ON CONFLICT (user_id, scope, scope_id, key) DO UPDATE SET ' +
        'value = excluded.value, deleted = excluded.deleted, dirty = 0, ' +
        'seq = excluded.seq, updated_at = excluded.updated_at'
    ).run(userId, scope, scopeId, key, value, deleted, seq, updatedAt);

    return true;
}

/**
 * 客户端把推成功的行标成干净。
 *
 * **`updated_at` 一起比**：推送在路上时用户又改了同一行（`updated_at` 变新），
 * 这一条就不能清 —— 否则那次改动要等下一轮才知道要推，甚至永远推不上去。
 *
 * @param {Array<object>} rows `listDirty` 给的那种（camelCase）行
 */
function markPushed(handle, userId, rows) {
    var statement = handle.db.prepare(
        'UPDATE secret_values SET dirty = 0 ' +
        'WHERE user_id = ? AND scope = ? AND scope_id = ? AND key = ? AND updated_at = ?'
    );
    (rows || []).forEach(function (row) {
        statement.run(userId, row.scope, row.scopeId, row.key, row.updatedAt);
    });
}

/**
 * 把这些行全标成「本机改过、还没推」。
 *
 * 两个地方用：登录时把未绑定空间的保密值并进账号（`user_id` 换成账号之后要推上去），
 * 以及改名成账号空间时。
 */
function markAllDirty(handle, userId) {
    if (!userId) return 0;
    var result = handle.db.prepare('UPDATE secret_values SET dirty = 1 WHERE user_id = ?').run(userId);
    return Number(result && result.changes) || 0;
}

module.exports = {
    SCOPES: SCOPES,
    isLocal: isLocal,
    latestSeq: latestSeq,
    nextSeq: nextSeq,
    mapFor: mapFor,
    getOne: getOne,
    listSince: listSince,
    listDirty: listDirty,
    upsert: upsert,
    removeKeys: removeKeys,
    keepOnly: keepOnly,
    removeScope: removeScope,
    writeRemote: writeRemote,
    markPushed: markPushed,
    markAllDirty: markAllDirty
};
