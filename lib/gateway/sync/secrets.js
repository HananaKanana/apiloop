/**
 * 保密值的同步（第三轮第 7 节，设计见 docs/plans/2026-10-03-round3.md）。
 *
 * 「保密值只属于填它的人」这条规则下，同一个人可能有好几台设备。这一轮做的事：把自己
 * 的保密值推上云端、把别的设备写的拉下来 —— **只动当前用户自己的行**，别人拿不到。
 *
 * 顺序是**先拉后推**（和普通同步一致）：先把云端的合进来，再把本机的推上去。
 *   - 拉：`GET /secrets?since=<本机游标>`，逐行和本机比 `updated_at`，新的覆盖；
 *     游标存在本机 `meta.secret_pull_seq`，第一次（0）就是全量拉。
 *   - 推：本机 `dirty = 1` 的行分批 500 推上去，成功后清 `dirty`。
 *
 * **它自己吞掉错误**：
 *   - 云端是旧版本（没有这两个接口）会回 404 —— 记一次日志、跳过，绝不能影响普通同步；
 *   - 网络不通的时候上面那两段已经报过「连不上云端」，这里不重复报（`offline` 一起带出去）；
 *   - 只有「切了空间」这一种要往外抛（`stale`），让引擎按「这一轮作废」处理。
 */

var repo = require('../../db/repos/secret-values');

/** 一批多少行。和云端 `lib/api/secrets.js` 的 MAX_ITEMS 对齐 */
var MAX_ITEMS = 500;

/** 防呆：万一下游一直回 hasMore，别把一轮跑成死循环 */
var MAX_ROUNDS = 200;

var CURSOR_KEY = 'secret_pull_seq';

function readCursor(handle) {
    var found = handle.db.prepare('SELECT value FROM meta WHERE key = ?').get(CURSOR_KEY);
    var value = found ? Number(found.value) : 0;
    return Number.isFinite(value) && value > 0 ? value : 0;
}

function writeCursor(handle, seq) {
    handle.db.prepare(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value"
    ).run(CURSOR_KEY, String(Number(seq) || 0));
}

/** 一行 → 推上去的形状。墓碑的值一律空（别把删掉的值又带出去） */
function toItem(row) {
    return {
        scope: row.scope,
        scopeId: row.scopeId,
        key: row.key,
        value: row.deleted ? '' : row.value,
        deleted: row.deleted,
        updatedAt: row.updatedAt
    };
}

/**
 * @param {{handle: object, cloud: {get: Function, post: Function}, userId?: string,
 *          isCurrent?: Function}} options
 * @returns {Promise<{pulled: number, pushed: number, unsupported: boolean,
 *                    offline: boolean, error: string|null}>} 不 reject（stale 除外）
 */
function runSecrets(options) {
    var handle = options.handle;
    var cloud = options.cloud;
    var userId = options.userId || null;
    var isCurrent = typeof options.isCurrent === 'function' ? options.isCurrent : function () { return true; };

    var summary = { pulled: 0, pushed: 0, unsupported: false, offline: false, error: null };
    if (!userId) return Promise.resolve(summary);

    function ensureCurrent() {
        if (isCurrent()) return;
        var err = new Error('空间已经切换，这一轮作废');
        err.stale = true;
        throw err;
    }

    return pull(handle, cloud, userId, summary, ensureCurrent)
        .then(function () { return push(handle, cloud, userId, summary, ensureCurrent); })
        .then(function () { return summary; })
        .catch(function (err) {
            // 切空间：往外抛，让引擎按「这一轮作废」处理（和普通同步一样）
            if (err && err.stale === true) throw err;

            if (err && Number(err.status) === 404) {
                summary.unsupported = true;
                return summary;
            }

            summary.error = (err && err.message) || String(err);
            summary.offline = !!(err && err.offline);
            return summary;
        });
}

function pull(handle, cloud, userId, summary, ensureCurrent) {
    var since = readCursor(handle);
    var round = 0;

    function one() {
        round++;
        if (round > MAX_ROUNDS) return Promise.resolve();

        return cloud.get('/secrets?since=' + since + '&limit=' + MAX_ITEMS).then(function (page) {
            ensureCurrent();

            var items = (page && page.items) || [];
            var applied = 0;

            handle.transaction(function () {
                items.forEach(function (item) {
                    // 和本机比 updated_at：新的才覆盖（本机改得更晚的不动）
                    if (repo.writeRemote(handle, userId, item, { local: true })) applied++;
                });
            }, { projectId: null });

            summary.pulled += applied;

            var next = page && page.nextSeq !== undefined ? Number(page.nextSeq) : since;
            since = Number.isFinite(next) && next > since ? next : since;
            writeCursor(handle, since);

            if (page && page.hasMore) return one();
        });
    }

    return one();
}

function push(handle, cloud, userId, summary, ensureCurrent) {
    var rows = repo.listDirty(handle, userId);
    if (!rows.length) return Promise.resolve();

    var batches = [];
    for (var i = 0; i < rows.length; i += MAX_ITEMS) batches.push(rows.slice(i, i + MAX_ITEMS));

    var chain = Promise.resolve();

    batches.forEach(function (batch) {
        chain = chain.then(function () {
            ensureCurrent();
            return cloud.post('/secrets', { items: batch.map(toItem) }).then(function () {
                // 只把**这一批推上去的那一行**标干净：推送在路上时用户又改了同一行的话，
                // updated_at 已经变了，markPushed 里的那条 UPDATE 匹配不上，dirty 留着
                handle.transaction(function () {
                    repo.markPushed(handle, userId, batch);
                }, { projectId: null });
                summary.pushed += batch.length;
            });
        });
    });

    return chain;
}

module.exports = {
    runSecrets: runSecrets,
    MAX_ITEMS: MAX_ITEMS,
    CURSOR_KEY: CURSOR_KEY
};
