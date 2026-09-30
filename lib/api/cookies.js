/**
 * Cookie 接口（契约第 12 节，权限见第 10 节）。
 *
 * **每个用户只能看到、只能删自己的 cookie。** Cookie 往往就是登录凭证 ——
 * 同一个项目的两个成员登录的是不同账号，共用一个库等于把两个人的登录态搅在一起。
 * 所以这里的每一次读写都把 `req.user.id` 带进去，没有任何「按 id 直接查库」的入口。
 *
 * 删一条时，「不是我的」和「不存在」必须给出**完全一样**的 404：
 * 否则同一个项目的另一个成员只要看状态码，就能问出「这个 id 存在，只是不归你」。
 * 文案也刻意和 guard 抛的那句一模一样。
 */

var express = require('express');

var respond = require('./respond');
var dto = require('./dto');
var guardModule = require('./guard');
var cookies = require('../cookies');
var cookiesRepo = require('../db/repos/cookies');

/** 删一条不属于自己的 cookie 时用的报错，和 guard 的 404 文案保持一致 */
function cookieMissing() {
    return respond.apiError(404, 'Cookie不存在');
}

function createRouter(ctx) {
    var handle = ctx.handle;
    var router = express.Router();

    var g = guardModule.createGuard(ctx);
    var guard = g.guard;
    var byPid = g.byPid;
    var byParam = g.byParam;

    function toDto(cookie) {
        return {
            id: cookie.id,
            domain: cookie.domain,
            path: cookie.path,
            name: cookie.name,
            value: cookie.value,
            expires: cookie.expires,
            hostOnly: cookie.hostOnly,
            secure: cookie.secure,
            httpOnly: cookie.httpOnly,
            sameSite: cookie.sameSite,
            createdAt: cookie.createdAt,
            updatedAt: cookie.updatedAt
        };
    }

    /** 当前用户在这个项目里的 cookie；顺手把过期的清掉 */
    function listMine(projectId, userId) {
        var now = Date.now();

        // 契约要求「已过期的不返回」。与其只是不返回，不如让它从库里消失 ——
        // cookie 的过期时间本来就是「到点就该没了」的意思。
        handle.transaction(function () {
            cookiesRepo.purgeExpired(handle, projectId, userId, now);
        });

        return cookiesRepo.listFor(handle, projectId, userId).filter(function (cookie) {
            return !cookies.isExpired(cookie, now);
        }).map(toDto);
    }

    /**
     * 手动新增/修改一条 cookie 的入参。
     *
     * `domain` 以 `.` 开头表示域 cookie（会发给子域名），否则是 host-only ——
     * 和浏览器里 `document.cookie` 的约定一致，也最不容易在不知情时把 cookie
     * 发给一堆子域名。
     *
     * 这里**不套 parseSetCookie 那套安全规则**：那条「Domain 必须含点」是拦
     * 别人响应里塞过来的 cookie 的，而这条数据是用户自己敲进来的，
     * 允许他给 `localhost` 配 cookie。
     */
    function cleanInput(input) {
        var cookie = dto.plainObject(input);
        if (!cookie) throw respond.apiError(400, '缺少 cookie');

        var rawDomain = dto.str(cookie.domain).trim().toLowerCase().replace(/\.$/, '');
        var domain = rawDomain.replace(/^\./, '');
        if (!domain) throw respond.apiError(400, '请填写 domain');

        var name = dto.str(cookie.name).trim();
        if (!name) throw respond.apiError(400, '请填写 cookie 名');
        if (/[\s;,=]/.test(name)) throw respond.apiError(400, 'cookie 名里不能有空格或 , ; =');

        var path = dto.str(cookie.path).trim() || '/';
        if (path.charAt(0) !== '/') throw respond.apiError(400, 'path 必须以 / 开头');

        var expires = null;
        if (cookie.expires !== undefined && cookie.expires !== null && cookie.expires !== '') {
            expires = Number(cookie.expires);
            if (!Number.isFinite(expires)) throw respond.apiError(400, 'expires 必须是毫秒时间戳');
        }

        return {
            domain: domain,
            path: path,
            name: name,
            value: dto.str(cookie.value),
            expires: expires,
            hostOnly: rawDomain.charAt(0) !== '.',
            secure: cookie.secure === true,
            httpOnly: cookie.httpOnly === true,
            sameSite: null
        };
    }

    router.get('/projects/:pid/cookies', guard('viewer', byPid), respond.wrap(function (req, res) {
        respond.ok(res, { cookies: listMine(req.project.id, req.user.id) });
    }));

    router.post('/projects/:pid/cookies', guard('viewer', byPid), respond.wrap(function (req, res) {
        var input = cleanInput((req.body || {}).cookie || req.body);

        var saved = handle.transaction(function () {
            return cookiesRepo.upsert(handle, req.project.id, req.user.id, input);
        });

        respond.ok(res, { cookie: toDto(saved) });
    }));

    /**
     * 删一条自己的。定位用 `byParam('cookie')`：它先反查出这条 cookie 属于哪个项目，
     * 不是成员就是 404 —— 「别人的项目里的 cookie」在这一步就被挡住了。
     */
    router.delete('/cookies/:id', guard('viewer', byParam('cookie')), respond.wrap(function (req, res) {
        var cookie = cookiesRepo.get(handle, req.params.id);

        // 到这里已经确定「项目看得见」，剩下的就是「这条是不是我的」。
        // 不是我的，与不存在同罪同罚 —— 同一个项目的成员之间也不该能互相试探。
        if (!cookie || cookie.userId !== req.user.id) throw cookieMissing();

        handle.transaction(function () {
            cookiesRepo.remove(handle, cookie.id);
        });

        respond.ok(res, {});
    }));

    /** 清空自己的；带 `domain` 时只清这个域名的 */
    router.delete('/projects/:pid/cookies', guard('viewer', byPid), respond.wrap(function (req, res) {
        var domain = dto.str((req.query || {}).domain).trim();

        handle.transaction(function () {
            cookiesRepo.removeWhere(handle, req.project.id, req.user.id,
                domain ? { domain: domain } : { all: true });
        });

        respond.ok(res, {});
    }));

    return router;
}

module.exports = {
    createRouter: createRouter
};
