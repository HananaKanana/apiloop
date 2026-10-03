/**
 * secret_values 表读写（第三轮第 3 节；第 7 节起改成「自己的设备之间同步」）。
 *
 * 变量行标了 `secret: true` 的，值按「人 + 变量所在位置 + 变量名」存在这里；共享数据
 * （项目 / 目录 / 环境的 variables JSON）里 value 永远空串，所以同事看不到。
 *
 * **这一张表走单独的同步**（不并入 `lib/sync/rows.js` 那套多实体同步）：只交换「当前用户
 * 自己的」行 —— 接口里写死 `user_id = req.user.id`，A 的行拿不到、也推不进 B 的。
 *
 * dirty / seq / 墓碑那套机制和 `user_prefs` 一模一样，公共实现抽在
 * `lib/db/repos/record-store.js`；这里只负责把「位置 + 变量名」这组键翻译过去，
 * 对外保持原来的位置参数签名（`lib/secrets.js`、`lib/api/secrets.js` 都按它调）。
 */

var recordStoreModule = require('./record-store');

var SCOPES = ['project', 'folder', 'environment'];

var store = recordStoreModule.createRecordStore({
    table: 'secret_values',
    keyColumns: ['scope', 'scope_id', 'key'],
    seqMetaKey: 'secret_seq',
    itemToKey: function (item) {
        return { scope: item.scope, scopeId: item.scopeId, key: item.key };
    },
    // 位置只认这三种；别的一律不收（请求体是外面来的，不能信）
    validateKey: function (keys) { return SCOPES.indexOf(keys.scope) > -1; }
});

/** 这个库是不是客户端那一份（要往云端推自己的保密值） */
function isLocal(handle) {
    return store.isLocal(handle);
}

/** 云端分配 seq 用的计数器（客户端那份没人看） */
function latestSeq(handle) {
    return store.latestSeq(handle);
}

function nextSeq(handle) {
    return store.nextSeq(handle);
}

/** 这个用户在那个位置存着的值 → `{ key: value }`。墓碑不算值 */
function mapFor(handle, userId, scope, scopeId) {
    var out = {};
    if (!userId) return out;

    store.listLive(handle, userId, { scope: scope, scopeId: scopeId }).forEach(function (row) {
        out[row.key] = row.value;
    });
    return out;
}

/** 一行（**含墓碑**）—— 同步时要比 updated_at，墓碑也算一行 */
function getOne(handle, userId, scope, scopeId, key) {
    return store.getOne(handle, userId, { scope: scope, scopeId: scopeId, key: key });
}

/** 云端：某个游标之后的行（含墓碑），按 seq 升序 */
function listSince(handle, userId, since, limit) {
    return store.listSince(handle, userId, since, limit);
}

/** 客户端：还没推上去的行 */
function listDirty(handle, userId) {
    return store.listDirty(handle, userId);
}

/**
 * 写一行。同一个 `(user, scope, scopeId, key)` 覆盖，`deleted` 一起清掉（又填了值 = 复活）。
 */
function upsert(handle, userId, scope, scopeId, key, value) {
    store.upsert(handle, userId, { scope: scope, scopeId: scopeId, key: key }, value);
}

/**
 * 墓碑：`deleted = 1`、值置空、`updated_at` 打当前时间，**不真删**。
 * 行不存在时什么都不做。
 */
function removeKeys(handle, userId, scope, scopeId, keys) {
    store.removeKeys(handle, userId, { scope: scope, scopeId: scopeId }, keys);
}

/** 只留下 `keepKeys` 里的那些行，其余记成墓碑（保密开关关掉、行被删掉时用） */
function keepOnly(handle, userId, scope, scopeId, keepKeys) {
    store.keepOnly(handle, userId, { scope: scope, scopeId: scopeId }, keepKeys);
}

/** 目录 / 环境被删掉时清掉它的保密值。**真删**，不走同步 */
function removeScope(handle, scope, scopeId) {
    store.removePrefix(handle, { scope: scope, scopeId: scopeId });
}

/**
 * 收下别处来的一行（云端发来的，或者客户端推上来的）。**按 `updated_at` 大的赢**。
 *
 * @param {{local: boolean}} mode `local: true` 表示「这是云端发来、落到客户端」
 * @returns {boolean} 真的写进去了没有
 */
function writeRemote(handle, userId, item, mode) {
    return store.writeRemote(handle, userId, item, mode);
}

/**
 * 客户端把推成功的行标成干净。**`updated_at` 一起比**：推送在路上时用户又改了那一行，
 * 这条就不清 `dirty`，下一轮再推。
 *
 * @param {Array<object>} rows `listDirty` 给的那种（camelCase）行
 */
function markPushed(handle, userId, rows) {
    store.markPushed(handle, userId, rows);
}

/** 把这些行全标成「本机改过、还没推」（并库、改名成账号空间时用） */
function markAllDirty(handle, userId) {
    return store.markAllDirty(handle, userId);
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
