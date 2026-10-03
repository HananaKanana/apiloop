/**
 * secret_values 表读写（第三轮第 3 节：保密变量的值）。
 *
 * 变量行标了 `secret: true` 的，共享数据（项目 / 目录 / 环境的 variables JSON）里 value
 * 永远存空串，真正的值按「人 + 变量所在位置 + 变量名」存在这里。**这张表不同步**：
 * 客户端里只在这台电脑，网页版只在服务器上、只有自己能读到。
 *
 * 主键是 `(user_id, scope, scope_id, key)`，所以同一台机器上换个账号登录看到的是另一份值。
 */

var SELECT = 'SELECT * FROM secret_values';

/** 这个用户在那个位置存着的值 → `{ key: value }` */
function mapFor(handle, userId, scope, scopeId) {
    var out = {};
    if (!userId) return out;

    handle.db.prepare(SELECT + ' WHERE user_id = ? AND scope = ? AND scope_id = ?')
        .all(userId, scope, scopeId).forEach(function (row) {
            out[row.key] = row.value;
        });
    return out;
}

function upsert(handle, userId, scope, scopeId, key, value) {
    handle.db.prepare(
        'INSERT INTO secret_values (user_id, scope, scope_id, key, value, updated_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT (user_id, scope, scope_id, key) ' +
        'DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
    ).run(userId, scope, scopeId, String(key), value === undefined || value === null ? '' : String(value), Date.now());
}

function removeKeys(handle, userId, scope, scopeId, keys) {
    var statement = handle.db.prepare(
        'DELETE FROM secret_values WHERE user_id = ? AND scope = ? AND scope_id = ? AND key = ?'
    );
    (keys || []).forEach(function (key) {
        statement.run(userId, scope, scopeId, String(key));
    });
}

/** 只留下 `keepKeys` 里的那些行，其余删掉（保密开关关掉、行被删掉时用） */
function keepOnly(handle, userId, scope, scopeId, keepKeys) {
    var keep = {};
    (keepKeys || []).forEach(function (key) { keep[String(key)] = true; });

    handle.db.prepare('SELECT key FROM secret_values WHERE user_id = ? AND scope = ? AND scope_id = ?')
        .all(userId, scope, scopeId).forEach(function (row) {
            if (keep[row.key]) return;
            handle.db.prepare(
                'DELETE FROM secret_values WHERE user_id = ? AND scope = ? AND scope_id = ? AND key = ?'
            ).run(userId, scope, scopeId, row.key);
        });
}

/** 目录 / 环境被删掉时顺手清掉它的保密值（不清也只是留几行垃圾） */
function removeScope(handle, scope, scopeId) {
    handle.db.prepare('DELETE FROM secret_values WHERE scope = ? AND scope_id = ?').run(scope, scopeId);
}

module.exports = {
    mapFor: mapFor,
    upsert: upsert,
    removeKeys: removeKeys,
    keepOnly: keepOnly,
    removeScope: removeScope
};
