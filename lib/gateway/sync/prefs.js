/**
 * 个人偏好的同步（第七轮第 2 节，设计见 docs/plans/2026-10-03-round7.md）。
 *
 * 「分组、收藏、最近打开只属于你自己」这条规则下，同一个人可能有好几台设备。这一轮做的事：
 * 把自己的偏好推上云端、把别的设备写的拉下来 —— **只动当前用户自己的行**，别人拿不到。
 *
 * 先拉后推、游标存 `meta.prefs_pull_seq`、404 / 网络错自己吞掉、切空间抛 `stale`
 * —— 这套机制和保密值共用（`lib/gateway/sync/records.js`），这里只把
 * 「user_prefs 这张表 + `/prefs` 这两个接口」对上。
 *
 * 和保密值的一处不同要记住：**拉下来之后页面上的分组 / 收藏 / 最近打开要重读一遍**，
 * 所以引擎看到 `pulled` 会去动 `dataVersion`（见 `engine.js`）。
 */

var records = require('./records');
var repo = require('../../db/repos/user-prefs');

/** 一批多少行。和云端 `lib/api/prefs.js` 的 MAX_ITEMS 对齐 */
var MAX_ITEMS = records.MAX_ITEMS;

var CURSOR_KEY = 'prefs_pull_seq';

/** 一行 → 推上去的形状。墓碑的值一律空（别把删掉的值又带出去） */
function toItem(row) {
    return {
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
function runPrefs(options) {
    var options_ = options || {};
    return records.runRecordSync({
        handle: options_.handle,
        cloud: options_.cloud,
        userId: options_.userId,
        isCurrent: options_.isCurrent,
        path: '/prefs',
        cursorKey: CURSOR_KEY,
        repo: repo,
        toItem: toItem
    });
}

module.exports = {
    runPrefs: runPrefs,
    MAX_ITEMS: MAX_ITEMS,
    CURSOR_KEY: CURSOR_KEY
};
