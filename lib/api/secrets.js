/**
 * 保密值的同步接口（第三轮第 7 节，设计见 docs/plans/2026-10-03-round3.md）。
 *
 * **只有云端要用**：客户端（网关）的同步引擎调这两个接口，把自己的保密值推上来、
 * 把别的设备写的拉下去。页面不调它们，所以它们**不在 `account.cloudOnlyPath` 里**
 * （那条路是给页面用的「只有云端才有的功能」转发）。
 *
 * 挂载点在 `lib/sync/index.js` 里 —— 那个 router 只在云端挂（`createAdmin` 的 `sync: true`），
 * 正好和「只在云端用」对上，也省得再去动 `lib/admin.js`（那是两个会话共用的文件）。
 *
 * **只管当前登录用户自己的行**：`user_id` 一律取 `req.user.id`，请求体里也没有这个字段 ——
 * A 的行拿不到，A 也推不进 B 的行。
 */

var express = require('express');

var respond = require('./respond');
var repo = require('../db/repos/secret-values');
var i18n = require('../i18n');

/** 一次最多多少行。和网关那边的分批大小对齐（lib/gateway/sync/secrets.js） */
var MAX_ITEMS = 500;

function createRouter(ctx) {
    var handle = ctx.handle;
    var router = express.Router();

    function toItem(row) {
        return {
            scope: row.scope,
            scopeId: row.scopeId,
            key: row.key,
            // 墓碑的值一律空 —— 别把删掉的值又带出去
            value: row.deleted ? '' : row.value,
            deleted: row.deleted,
            updatedAt: row.updatedAt,
            seq: row.seq
        };
    }

    /** 按游标增量拉。含墓碑（别的设备关掉保密 / 删掉变量，这边也要跟着删） */
    router.get('/secrets', respond.wrap(function (req, res) {
        var userId = req.user ? req.user.id : null;
        if (!userId) throw respond.apiError(401, i18n.m('请先登录'));

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
    router.post('/secrets', respond.wrap(function (req, res) {
        var userId = req.user ? req.user.id : null;
        if (!userId) throw respond.apiError(401, i18n.m('请先登录'));

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
    MAX_ITEMS: MAX_ITEMS
};
