/**
 * user_prefs 表读写（第七轮第 2 节，设计见 docs/plans/2026-10-03-round7.md）。
 *
 * 项目分组、收藏、最近打开：**只属于你自己**，不影响同事，在你登录的设备之间同步。
 * 一个 key 一行，值是 JSON，「updated_at 大的赢」。两台设备同时改了同一个 key，
 * 后改的整份覆盖先改的 —— 可以接受（都是自己的操作）。
 *
 * dirty / seq / 墓碑那套和保密值共用同一份实现（`lib/db/repos/record-store.js`），
 * 区别只在键：这里只有一列 `key`。
 *
 * 外面来的值（别的设备发来的、手改库的）一律先过 `normalize` 再交给界面 ——
 * 缺字段、类型不对的行不该让页面炸掉，`recent` 最多 20 条也在这里夹住。
 */

var recordStoreModule = require('./record-store');

var KEYS = ['projectGroups', 'favorites', 'recent'];

/** `recent` 最多留多少条 */
var MAX_RECENT = 20;

var store = recordStoreModule.createRecordStore({
    table: 'user_prefs',
    keyColumns: ['key'],
    seqMetaKey: 'prefs_seq',
    itemToKey: function (item) { return { key: item.key }; },
    // 只认这三个 key；别的一律不收（请求体是外面来的，不能信）
    validateKey: function (keys) { return KEYS.indexOf(keys.key) > -1; }
});

function text(value) {
    if (value === undefined || value === null) return '';
    return String(value).trim();
}

function uniqueStrings(list) {
    var seen = {};
    var out = [];
    (Array.isArray(list) ? list : []).forEach(function (item) {
        var value = text(item);
        if (!value || seen[value]) return;
        seen[value] = true;
        out.push(value);
    });
    return out;
}

/** `[{ projectId, apiId }]`：两个字段都要有，按「项目 + 接口」去重 */
function uniqueApiRefs(list) {
    var seen = {};
    var out = [];
    (Array.isArray(list) ? list : []).forEach(function (item) {
        if (!item || typeof item !== 'object') return;
        var projectId = text(item.projectId);
        var apiId = text(item.apiId);
        if (!projectId || !apiId) return;
        var key = projectId + '\u0000' + apiId;
        if (seen[key]) return;
        seen[key] = true;
        out.push({ projectId: projectId, apiId: apiId });
    });
    return out;
}

/** 数组顺序就是分组顺序，不要按名字排 —— 用户拖动排过序 */
function normalizeGroups(value) {
    var seen = {};
    var out = [];
    (Array.isArray(value) ? value : []).forEach(function (group) {
        if (!group || typeof group !== 'object') return;
        var id = text(group.id);
        // 没有 id 的分组没法被项目引用、也没法改名 / 删除，直接丢掉
        if (!id || seen[id]) return;
        seen[id] = true;
        out.push({
            id: id,
            name: text(group.name) || '未命名分组',
            projectIds: uniqueStrings(group.projectIds),
            collapsed: group.collapsed === true
        });
    });
    return out;
}

function normalizeFavorites(value) {
    var source = value && typeof value === 'object' ? value : {};
    return {
        projects: uniqueStrings(source.projects),
        apis: uniqueApiRefs(source.apis)
    };
}

/** 新的在前，最多 20 条。同一个接口出现过多次就留时间最晚的那次 */
function normalizeRecent(value) {
    var seen = {};
    var rows = [];

    (Array.isArray(value) ? value : []).forEach(function (item) {
        if (!item || typeof item !== 'object') return;
        var projectId = text(item.projectId);
        var apiId = text(item.apiId);
        var openedAt = Number(item.openedAt);
        if (!projectId || !apiId || !Number.isFinite(openedAt)) return;

        var dedupe = projectId + '\u0000' + apiId;
        if (seen[dedupe]) {
            if (openedAt > seen[dedupe].openedAt) seen[dedupe].openedAt = openedAt;
            return;
        }

        var row = { projectId: projectId, apiId: apiId, openedAt: openedAt };
        seen[dedupe] = row;
        rows.push(row);
    });

    rows.sort(function (a, b) { return b.openedAt - a.openedAt; });
    return rows.slice(0, MAX_RECENT);
}

/** 一个 key 的默认值（还没有那一行，或者墓碑还没被覆盖掉） */
function defaultValue(key) {
    if (key === 'projectGroups') return [];
    if (key === 'favorites') return { projects: [], apis: [] };
    if (key === 'recent') return [];
    return null;
}

function normalize(key, value) {
    if (key === 'projectGroups') return normalizeGroups(value);
    if (key === 'favorites') return normalizeFavorites(value);
    if (key === 'recent') return normalizeRecent(value);
    return null;
}

function parseJson(text_) {
    if (typeof text_ !== 'string' || !text_) return null;
    try {
        return JSON.parse(text_);
    } catch (err) {
        return null;
    }
}

/** 一个 key 的值（理成合法形状）。没有那一行、或者墓碑，就给默认值 */
function read(handle, userId, key) {
    if (KEYS.indexOf(key) === -1) return null;
    if (!userId) return defaultValue(key);

    var row = store.getOne(handle, userId, { key: key });
    if (!row || row.deleted) return defaultValue(key);
    return normalize(key, parseJson(row.value));
}

/** 三个 key 一起读，缺的补默认值（`GET /me/prefs` 用） */
function readAll(handle, userId) {
    var out = {};
    KEYS.forEach(function (key) {
        out[key] = read(handle, userId, key);
    });
    return out;
}

/** 写一个 key。返回写进去的那份（理过的），调用方拿它回给页面 */
function write(handle, userId, key, value) {
    if (KEYS.indexOf(key) === -1) throw new Error('不认识的偏好项：' + key);

    var normalized = normalize(key, value);
    store.upsert(handle, userId, { key: key }, JSON.stringify(normalized));
    return normalized;
}

/** 这个库是不是客户端那一份（要往云端推自己的偏好） */
function isLocal(handle) {
    return store.isLocal(handle);
}

function latestSeq(handle) {
    return store.latestSeq(handle);
}

/** 一行（**含墓碑**）—— 同步时要比 updated_at */
function getOne(handle, userId, key) {
    return store.getOne(handle, userId, { key: key });
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
 * 收下别处来的一行（云端发来的，或者客户端推上来的）。**按 `updated_at` 大的赢**。
 *
 * @param {{local: boolean}} mode `local: true` 表示「这是云端发来、落到客户端」
 * @returns {boolean} 真的写进去了没有
 */
function writeRemote(handle, userId, item, mode) {
    return store.writeRemote(handle, userId, item, mode);
}

/** 客户端把推成功的行标成干净（`updated_at` 一起比，见 record-store 的说明） */
function markPushed(handle, userId, rows) {
    store.markPushed(handle, userId, rows);
}

/** 把这些行全标成「本机改过、还没推」（并库、改名成账号空间时用） */
function markAllDirty(handle, userId) {
    return store.markAllDirty(handle, userId);
}

module.exports = {
    KEYS: KEYS,
    MAX_RECENT: MAX_RECENT,
    defaultValue: defaultValue,
    normalize: normalize,
    read: read,
    readAll: readAll,
    write: write,
    isLocal: isLocal,
    latestSeq: latestSeq,
    getOne: getOne,
    listSince: listSince,
    listDirty: listDirty,
    writeRemote: writeRemote,
    markPushed: markPushed,
    markAllDirty: markAllDirty
};
