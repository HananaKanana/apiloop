/**
 * 保密值的同步（第三轮第 7 节，设计见 docs/plans/2026-10-03-round3.md）。
 *
 * 「保密值只属于填它的人」这条规则下，同一个人可能有好几台设备。这一轮做的事：把自己
 * 的保密值推上云端、把别的设备写的拉下来 —— **只动当前用户自己的行**，别人拿不到。
 *
 * 先拉后推、游标存 `meta.secret_pull_seq`、404 / 网络错自己吞掉、切空间抛 `stale`
 * —— 这套机制两张表共用，实现在 `lib/gateway/sync/records.js`。这里只把
 * 「保密值这张表 + `/secrets` 这两个接口」对上。
 */

var records = require('./records');
var repo = require('../../db/repos/secret-values');

/** 一批多少行。和云端 `lib/api/secrets.js` 的 MAX_ITEMS 对齐 */
var MAX_ITEMS = records.MAX_ITEMS;

var CURSOR_KEY = 'secret_pull_seq';

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
    var options_ = options || {};
    return records.runRecordSync({
        handle: options_.handle,
        cloud: options_.cloud,
        userId: options_.userId,
        isCurrent: options_.isCurrent,
        path: '/secrets',
        cursorKey: CURSOR_KEY,
        repo: repo,
        toItem: toItem
    });
}

module.exports = {
    runSecrets: runSecrets,
    MAX_ITEMS: MAX_ITEMS,
    CURSOR_KEY: CURSOR_KEY
};
