/**
 * 个人偏好的接口（第七轮第 2 节，设计见 docs/plans/2026-10-03-round7.md）。
 *
 * 两个 router，挂的地方不一样：
 *
 * - `createRouter`：`GET /me/prefs`、`PUT /me/prefs/:key`。**页面直接调的**，落在
 *   `lib/admin.js` 里（云端和网关都挂）。所以网关上读写的是**本机库**（不转发给云端），
 *   离线也能用；同步由网关的同步引擎在后台做。因为它只管当前登录用户自己的行，
 *   所以不在 `account.cloudOnlyPath` 里。
 * - `createSyncRouter`：`GET /prefs?since=`、`POST /prefs`。**只有云端要用**，
 *   挂在 `lib/sync/index.js`（那个 router 只在云端挂），形状和 `/secrets` 一样。
 *
 * 两个都只认当前登录用户自己的行：`user_id` 一律取 `req.user.id`，请求体里也没有这个字段
 * —— A 的偏好拿不到，A 也写不进 B 的。
 */

var express = require('express');

var respond = require('./respond');
var repo = require('../db/repos/user-prefs');
var i18n = require('../i18n');

/** 一次最多多少行。和网关那边的分批大小对齐（lib/gateway/sync/prefs.js） */
var MAX_ITEMS = 500;

function userIdOf(req) {
    var userId = req.user ? req.user.id : null;
    if (!userId) throw respond.apiError(401, i18n.m('请先登录'));
    return userId;
}

/* ------------------------------------------------------------------ 页面直接调 */

function createRouter(ctx) {
    var handle = ctx.handle;
    var router = express.Router();

    /** 三个 key 一起给，没有的给默认空值 —— 页面启动时只发这一个请求 */
    router.get('/me/prefs', respond.wrap(function (req, res) {
        var userId = userIdOf(req);
        respond.ok(res, { prefs: repo.readAll(handle, userId) });
    }));

    /**
     * 写一个 key。只认 `projectGroups` / `favorites` / `recent`。
     *
     * 网关上写的是本机库（`dirty = 1`），下一轮同步推上云端；云端上写的就是云端那一份。
     * 返回理过之后的值，页面拿它当准 —— 比如 `recent` 超过 20 条会被裁掉。
     */
    router.put('/me/prefs/:key', respond.wrap(function (req, res) {
        var userId = userIdOf(req);

        var key = String(req.params.key || '');
        if (repo.KEYS.indexOf(key) === -1) {
            throw respond.apiError(400, i18n.m('不认识的偏好项：{key}', { key: key || i18n.m('(空)') }));
        }

        var body = req.body || {};
        if (!Object.prototype.hasOwnProperty.call(body, 'value')) {
            throw respond.apiError(400, i18n.m('缺少 value'));
        }

        respond.ok(res, { key: key, value: repo.write(handle, userId, key, body.value) });
    }));

    return router;
}

/* ------------------------------------------------------------------ 只有云端挂 */

function createSyncRouter(ctx) {
    var handle = ctx.handle;
    var router = express.Router();

    function toItem(row) {
        return {
            key: row.key,
            // 墓碑的值一律空 —— 别把删掉的值又带出去
            value: row.deleted ? '' : row.value,
            deleted: row.deleted,
            updatedAt: row.updatedAt,
            seq: row.seq
        };
    }

    /** 按游标增量拉。含墓碑（别的设备那边这一项没了，这边也要跟着没） */
    router.get('/prefs', respond.wrap(function (req, res) {
        var userId = userIdOf(req);

        var query = req.query || {};

        var since = Number(query.since);
        if (!Number.isFinite(since) || since < 0) since = 0;

        var limit = Number(query.limit);
        if (!Number.isFinite(limit) || limit < 1) limit = MAX_ITEMS;
        limit = Math.min(Math.floor(limit), MAX_ITEMS);

        // 多取一条用来判断「还有没有下一页」：正好取满时按数量判断会给出一个永远空的下一页
        var found = repo.listSince(handle, userId, since, limit + 1);
        var page = found.slice(0, limit);
        var last = page.length ? Number(page[page.length - 1].seq) : since;

        respond.ok(res, {
            items: page.map(toItem),
            nextSeq: last,
            hasMore: found.length > limit
        });
    }));

    /**
     * 收下客户端推上来的行。逐行按「`updatedAt` 大的赢」合并，写进去的打新 `seq`。
     *
     * 一条坏数据不该让整批都推不上去：不合法的那几条**直接跳过**（不计进 `accepted`），
     * 其余照常处理 —— 客户端的推送也是分批、断点续传的。
     */
    router.post('/prefs', respond.wrap(function (req, res) {
        var userId = userIdOf(req);

        var items = (req.body || {}).items;
        if (!Array.isArray(items)) throw respond.apiError(400, i18n.m('items 必须是数组'));
        if (items.length > MAX_ITEMS) {
            throw respond.apiError(400, i18n.m('一次最多 {max} 行，收到 {got} 行', { max: MAX_ITEMS, got: items.length }));
        }

        var accepted = 0;
        handle.transaction(function () {
            items.forEach(function (item) {
                if (repo.writeRemote(handle, userId, item, { local: false })) accepted++;
            });
        }, { projectId: null });

        respond.ok(res, { accepted: accepted, seq: repo.latestSeq(handle) });
    }));

    return router;
}

module.exports = {
    createRouter: createRouter,
    createSyncRouter: createSyncRouter,
    MAX_ITEMS: MAX_ITEMS
};
