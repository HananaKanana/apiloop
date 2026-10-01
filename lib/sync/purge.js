/**
 * 变更流水的清理（L2）。
 *
 * `changes` 只增不减，一个天天用的库几年就能攒下几百万行。这里删掉 30 天以前
 * 的记录，并把 `meta.sync_min_seq` 推到「还在的最小 seq」—— 同步方拿它判断
 * 自己是不是落后得太久（落后太久就得重新下载一份快照，而不是拉变更）。
 *
 * **30 天是「本机离线多久还算正常」的上限**：超过这个时间的本机数据要靠快照重新
 * 对齐，而不是靠变更流水追。
 *
 * 全删光了用「当前最大 seq + 1」而不是 1：还能接上的同步方（它记的 seq 不小于
 * 这个值）不会被误判成「落后太多」。seq 由 AUTOINCREMENT 保证不复用，所以这个
 * 值不会撞上以后新写入的记录。
 *
 * `sync_min_seq` 的读写顺手也放在这里 —— 写它的只有本模块，读它的地方（同步接口）
 * 直接 require 本模块，免得同一句 SQL 写两遍。
 */

var THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

/**
 * 删掉过期的变更记录，并把 `sync_min_seq` 推到还剩的最小 seq。
 *
 * @param {object} handle db.open 返回的 handle
 * @param {number} [now] 当前毫秒时间戳，默认取 Date.now()（测试要能指定）
 * @returns {{removed: number, minSeq: number}}
 */
function purgeChanges(handle, now) {
    var moment = Number(now);
    if (!Number.isFinite(moment)) moment = Date.now();

    var result = handle.db.prepare('DELETE FROM changes WHERE at < ?').run(moment - THIRTY_DAYS);
    var removed = Number(result && result.changes) || 0;

    var oldest = handle.db.prepare('SELECT MIN(seq) AS seq FROM changes').get();
    var minSeq = oldest && oldest.seq !== null && oldest.seq !== undefined
        ? Number(oldest.seq)
        : latestSeq(handle) + 1;

    writeMinSeq(handle, minSeq);
    return { removed: removed, minSeq: minSeq };
}

/**
 * 这张表**有过**的最大 seq（不是现在还剩的最大 seq）。
 *
 * 取的是 `sqlite_sequence` 里的高水位，因为 `changes.seq` 是 AUTOINCREMENT（永不复用）。
 * 全删光之后 `MAX(seq)` 会变成 0，那时再把 min_seq 写成 1 就等于告诉所有同步方
 * 「谁都跟得上」—— 落后几千条的本机也会被放过去，正好是这个字段要防的事。
 */
function latestSeq(handle) {
    var row = handle.db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'changes'").get();
    if (!row || row.seq === null || row.seq === undefined) return 0;
    return Number(row.seq);
}

/** 读 `meta.sync_min_seq`；没写过（理论上不会有）时按 1 算 */
function readMinSeq(handle) {
    var row = handle.db.prepare("SELECT value FROM meta WHERE key = 'sync_min_seq'").get();
    var value = row ? Number(row.value) : 1;
    return Number.isFinite(value) && value > 0 ? value : 1;
}

/** 写 `meta.sync_min_seq`。迁移只负责写初值，之后的维护都走这里 */
function writeMinSeq(handle, minSeq) {
    handle.db.prepare(
        "INSERT INTO meta (key, value) VALUES ('sync_min_seq', ?) " +
        'ON CONFLICT (key) DO UPDATE SET value = excluded.value'
    ).run(String(minSeq));
}

module.exports = {
    purgeChanges: purgeChanges,
    readMinSeq: readMinSeq,
    latestSeq: latestSeq
};
