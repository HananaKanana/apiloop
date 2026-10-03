/**
 * 「一个人自己的行」这类表的公共读写。
 *
 * 现在有两张表用它：
 *
 *   - `secret_values`（第三轮第 7 节，保密值在自己的设备之间同步）：键是 `(scope, scope_id, key)`
 *   - `user_prefs`（第七轮第 2 节，项目分组 / 收藏 / 最近打开）：键是 `(key)`
 *
 * 两张表的形状一样：`(user_id, <若干键列>, value, updated_at, deleted, dirty, seq)`，
 * 主键是 `user_id + 键列`。和 `lib/sync/rows.js` 那套多实体同步**走的是两条路**：
 * 这里只交换「当前用户自己的」行，接口里写死 `user_id = req.user.id`。
 *
 * 三个「同步用」的列分工一致：
 *
 *   - `deleted`：墓碑。删掉不真删，否则别的设备上的旧值会被推回来。读的地方一律跳过 `deleted = 1`。
 *   - `dirty`：**只在客户端**有意义：1 = 本机改过、还没推上云端。
 *   - `seq`：**只在云端**有意义：每次写入取一个新号，客户端按它增量拉（时间戳会被同毫秒的
 *     两次写入和各设备时钟偏差坑到，不能当游标）。
 *
 * 同一份代码两边都要跑，靠 `handle.localStore` 区分（客户端那一份由
 * `lib/gateway/space.js` 打开空间时打上这个标记）：
 *
 *   - 客户端写：`dirty = 1`，不动 `seq`；
 *   - 云端写：`dirty = 0`，从 `meta.<seqMetaKey>` 取新 `seq`。
 * 反过来做也不会坏（客户端的 seq 没人看、云端的 dirty 没人看），但分开更省事、也更好读。
 *
 * **键一律用 camelCase 的对象传**（`{ scope, scopeId, key }` / `{ key }`），行也按 camelCase
 * 返回（`scope_id` → `scopeId`），这样两张表的调用方写法一致。给不满一整组键就是「按前缀匹配」
 * —— `removeScope` / `keepOnly` 用它。
 */

/**
 * @param {{table: string, keyColumns: string[], seqMetaKey: string,
 *          itemToKey: Function, validateKey?: Function}} options
 *        `keyColumns` 用数据库里的列名（下划线），顺序就是主键顺序；
 *        `itemToKey` 把云端 / 客户端发来的一个 item 变成键对象（camelCase）；
 *        `validateKey` 拿**还没转成字符串**的键对象做业务校验（比如 scope 必须是那三种）。
 */
function createRecordStore(options) {
    var table = options.table;
    var keyColumns = options.keyColumns.slice();
    var seqMetaKey = options.seqMetaKey;
    var itemToKey = options.itemToKey;
    var validateKey = typeof options.validateKey === 'function' ? options.validateKey : function () { return true; };

    var SELECT = 'SELECT * FROM ' + table;
    var INSERT_COLUMNS = keyColumns.concat(['value', 'deleted', 'dirty', 'seq', 'updated_at']).join(', ');
    var CONFLICT_TARGET = '(user_id, ' + keyColumns.join(', ') + ')';
    /** 最后一列就是「同一组里的那一个名字」，keepOnly / removeKeys 按它展开 */
    var NAME_COLUMN = keyColumns[keyColumns.length - 1];

    /** `scope_id` → `scopeId` */
    function camel(name) {
        return name.replace(/_([a-z])/g, function (match, letter) { return letter.toUpperCase(); });
    }

    /** camelCase 的键名 → 数据库列名 */
    var columnOf = {};
    var fieldOf = {};
    keyColumns.forEach(function (column) {
        columnOf[camel(column)] = column;
        fieldOf[column] = camel(column);
    });

    function isLocal(handle) {
        return !!(handle && handle.localStore === true);
    }

    /**
     * 调语句上的 get / all / run。
     *
     * **必须绑在语句对象上**：`node:sqlite` 的 StatementSync 方法里会读自己的私有槽，
     * 写成 `statement.run.apply(null, params)` 会直接抛 `Illegal invocation`。
     */
    function runStatement(statement, method, params) {
        return statement[method].apply(statement, params);
    }

    function textOf(value) {
        return value === undefined || value === null ? '' : String(value);
    }

    /** 数据库行 → camelCase。键列一起搬过来 */
    function fromRow(row) {
        if (!row) return null;
        var out = {
            userId: row.user_id,
            value: row.value,
            deleted: !!row.deleted,
            dirty: !!row.dirty,
            seq: row.seq,
            updatedAt: row.updated_at
        };
        keyColumns.forEach(function (column) {
            out[fieldOf[column]] = row[column];
        });
        return out;
    }

    /**
     * 键对象 → `{ sql, params }`。**只带上真给了的列**，给不全就是前缀匹配。
     * 全部键列都给全时，`sql` 就是完整主键的 WHERE 片段。
     */
    function whereOf(keys) {
        var source = keys || {};
        var parts = [];
        var params = [];

        keyColumns.forEach(function (column) {
            var value = source[fieldOf[column]];
            if (value === undefined || value === null) return;
            parts.push(column + ' = ?');
            params.push(String(value));
        });

        return { sql: parts.length ? ' AND ' + parts.join(' AND ') : '', params: params };
    }

    /* ------------------------------------------------------------------ seq（云端） */

    function latestSeq(handle) {
        var row = handle.db.prepare('SELECT value FROM meta WHERE key = ?').get(seqMetaKey);
        var value = row ? Number(row.value) : 0;
        return Number.isFinite(value) && value > 0 ? value : 0;
    }

    /** 取一个递增号。seq 单调递增，客户端拿它当游标 */
    function nextSeq(handle) {
        var next = latestSeq(handle) + 1;
        handle.db.prepare(
            'INSERT INTO meta (key, value) VALUES (?, ?) ' +
            'ON CONFLICT (key) DO UPDATE SET value = excluded.value'
        ).run(seqMetaKey, String(next));
        return next;
    }

    /* ------------------------------------------------------------------ 读 */

    /** 一行（**含墓碑**）—— 同步时要比 updated_at，墓碑也算一行 */
    function getOne(handle, userId, keys) {
        var where = whereOf(keys);
        var statement = handle.db.prepare(SELECT + ' WHERE user_id = ?' + where.sql);
        return fromRow(runStatement(statement, 'get', [userId].concat(where.params)));
    }

    /** 某个前缀下**没删**的行（`mapFor` / `keepOnly` 用） */
    function listLive(handle, userId, keys) {
        var where = whereOf(keys);
        var statement = handle.db.prepare(SELECT + ' WHERE user_id = ? AND deleted = 0' + where.sql);
        return runStatement(statement, 'all', [userId].concat(where.params)).map(fromRow);
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

    /* ------------------------------------------------------------------ 写（本地） */

    function stampNow() {
        return Date.now();
    }

    /**
     * 写一行。同一组键覆盖，`deleted` 一起清掉（又填了值 = 复活）。
     */
    function upsert(handle, userId, keys, value) {
        var where = whereOf(keys);
        if (where.params.length !== keyColumns.length) {
            throw new Error(table + '：upsert 要给全主键（' + keyColumns.join(', ') + '）');
        }

        var text = textOf(value);
        var now = stampNow();
        var placeholders = keyColumns.map(function () { return '?'; }).join(', ');

        if (isLocal(handle)) {
            runStatement(handle.db.prepare(
                'INSERT INTO ' + table + ' (user_id, ' + INSERT_COLUMNS + ') ' +
                'VALUES (?, ' + placeholders + ', ?, 0, 1, 0, ?) ' +
                'ON CONFLICT ' + CONFLICT_TARGET + ' DO UPDATE SET ' +
                'value = excluded.value, deleted = 0, dirty = 1, updated_at = excluded.updated_at'
            ), 'run', [userId].concat(where.params, [text, now]));
            return;
        }

        runStatement(handle.db.prepare(
            'INSERT INTO ' + table + ' (user_id, ' + INSERT_COLUMNS + ') ' +
            'VALUES (?, ' + placeholders + ', ?, 0, 0, ?, ?) ' +
            'ON CONFLICT ' + CONFLICT_TARGET + ' DO UPDATE SET ' +
            'value = excluded.value, deleted = 0, dirty = 0, seq = excluded.seq, updated_at = excluded.updated_at'
        ), 'run', [userId].concat(where.params, [text, nextSeq(handle), now]));
    }

    /**
     * 墓碑：`deleted = 1`、值置空、`updated_at` 打当前时间，**不真删**。
     * 行不存在时什么都不做（本地没有、云端也没有的东西，没有别的设备需要知道它被删了）。
     */
    function tombstone(handle, userId, keys) {
        var where = whereOf(keys);
        var now = stampNow();

        if (isLocal(handle)) {
            runStatement(handle.db.prepare(
                'UPDATE ' + table + " SET deleted = 1, value = '', dirty = 1, updated_at = ? " +
                'WHERE user_id = ?' + where.sql
            ), 'run', [now, userId].concat(where.params));
            return;
        }

        runStatement(handle.db.prepare(
            'UPDATE ' + table + " SET deleted = 1, value = '', dirty = 0, seq = ?, updated_at = ? " +
            'WHERE user_id = ?' + where.sql
        ), 'run', [nextSeq(handle), now, userId].concat(where.params));
    }

    /** 把前缀下的一个名字补全成完整键 */
    function withName(keys, name) {
        var full = {};
        Object.keys(keys || {}).forEach(function (field) { full[field] = keys[field]; });
        full[fieldOf[NAME_COLUMN]] = name;
        return full;
    }

    function removeKeys(handle, userId, keys, names) {
        (names || []).forEach(function (name) {
            tombstone(handle, userId, withName(keys, name));
        });
    }

    /** 只留下 `keepNames` 里的那些行，其余记成墓碑（保密开关关掉、行被删掉时用） */
    function keepOnly(handle, userId, keys, keepNames) {
        var keep = {};
        (keepNames || []).forEach(function (name) { keep[String(name)] = true; });

        listLive(handle, userId, keys).forEach(function (row) {
            var name = row[fieldOf[NAME_COLUMN]];
            if (keep[name]) return;
            tombstone(handle, userId, withName(keys, name));
        });
    }

    /**
     * 前缀下的行**真删**、不走同步。用在「那个位置本身已经没了」的地方
     * （保密值是目录 / 环境被删时）：别的设备上残留几行没有害处。
     */
    function removePrefix(handle, keys) {
        var where = whereOf(keys);
        if (!where.params.length) throw new Error(table + '：removePrefix 至少要给一个键列');
        runStatement(handle.db.prepare('DELETE FROM ' + table + ' WHERE 1 = 1' + where.sql),
            'run', where.params);
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

        var raw = itemToKey(item) || {};
        if (!validateKey(raw)) return false;

        var keys = {};
        var missing = false;
        keyColumns.forEach(function (column) {
            var value = textOf(raw[fieldOf[column]]);
            if (!value) missing = true;
            keys[fieldOf[column]] = value;
        });
        if (missing) return false;

        var updatedAt = Number(item.updatedAt);
        if (!Number.isFinite(updatedAt) || updatedAt <= 0) return false;

        var where = whereOf(keys);
        var current = getOne(handle, userId, keys);
        if (current && Number(current.updatedAt) >= updatedAt) return false;

        var deleted = item.deleted === true ? 1 : 0;
        var value = deleted ? '' : textOf(item.value);
        var seq = mode && mode.local === true
            ? (Number.isFinite(Number(item.seq)) ? Number(item.seq) : 0)
            : nextSeq(handle);

        var placeholders = keyColumns.map(function () { return '?'; }).join(', ');

        runStatement(handle.db.prepare(
            'INSERT INTO ' + table + ' (user_id, ' + INSERT_COLUMNS + ') ' +
            'VALUES (?, ' + placeholders + ', ?, ?, 0, ?, ?) ' +
            'ON CONFLICT ' + CONFLICT_TARGET + ' DO UPDATE SET ' +
            'value = excluded.value, deleted = excluded.deleted, dirty = 0, ' +
            'seq = excluded.seq, updated_at = excluded.updated_at'
        ), 'run', [userId].concat(where.params, [value, deleted, seq, updatedAt]));

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
            'UPDATE ' + table + ' SET dirty = 0 WHERE user_id = ?' +
            keyColumns.map(function (column) { return ' AND ' + column + ' = ?'; }).join('') +
            ' AND updated_at = ?'
        );

        (rows || []).forEach(function (row) {
            runStatement(statement, 'run', [userId].concat(keyColumns.map(function (column) {
                return row[fieldOf[column]];
            }), [row.updatedAt]));
        });
    }

    /**
     * 把这些行全标成「本机改过、还没推」。
     *
     * 两个地方用：登录时把未绑定空间的行并进账号（`user_id` 换成账号之后要推上去），
     * 以及改名成账号空间时。
     */
    function markAllDirty(handle, userId) {
        if (!userId) return 0;
        var result = handle.db.prepare('UPDATE ' + table + ' SET dirty = 1 WHERE user_id = ?').run(userId);
        return Number(result && result.changes) || 0;
    }

    return {
        table: table,
        keyColumns: keyColumns,
        isLocal: isLocal,
        latestSeq: latestSeq,
        nextSeq: nextSeq,
        getOne: getOne,
        listLive: listLive,
        listSince: listSince,
        listDirty: listDirty,
        upsert: upsert,
        tombstone: tombstone,
        removeKeys: removeKeys,
        keepOnly: keepOnly,
        removePrefix: removePrefix,
        writeRemote: writeRemote,
        markPushed: markPushed,
        markAllDirty: markAllDirty
    };
}

module.exports = {
    createRecordStore: createRecordStore
};
