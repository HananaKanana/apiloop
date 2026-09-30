/**
 * /auth/* 与 /users/* 两组接口。
 *
 * 返回格式沿用 admin.js 的 { ok: true, ... } / { ok: false, error }。
 * 路由内部自己排顺序：/auth/login 在 requireLogin 之前，其余全部要求登录。
 */

var express = require('express');

var auth = require('./auth');
var usersRepo = require('./db/repos/users');
var sessionsRepo = require('./db/repos/sessions');

var USERNAME_PATTERN = /^[a-zA-Z0-9_.-]{2,32}$/;

function ok(res, payload) {
    var body = { ok: true };
    Object.keys(payload || {}).forEach(function (key) { body[key] = payload[key]; });
    res.json(body);
}

function fail(res, status, message) {
    res.status(status).json({ ok: false, error: message });
}

/** 会「把管理员锁在门外」的操作一律先过这一关 */
function guardAdminChange(handle, actor, target, patch) {
    var demoting = target.role === 'admin' && patch.role === 'member';
    var disabling = patch.disabled === true;
    var stillActiveAdmin = target.role === 'admin' && !target.disabled;

    if (!stillActiveAdmin) return null;
    if (!demoting && !disabling) return null;

    if (target.id === actor.id) {
        return '不能对自己做删除、禁用或降级';
    }
    if (usersRepo.countAdmins(handle, { excludeId: target.id }) === 0) {
        return '至少要保留一个可用（未禁用）的管理员';
    }
    return null;
}

function createRouter(handle) {
    var router = express.Router();

    /* ---------------------------------------------------------- 公开：登录 */

    router.post('/auth/login', function (req, res) {
        var body = req.body || {};
        var username = String(body.username === undefined || body.username === null ? '' : body.username).trim();
        var password = String(body.password === undefined || body.password === null ? '' : body.password);

        if (!username || !password) return fail(res, 400, '请输入用户名和密码');

        var key = username.toLowerCase();
        if (auth.isLocked(key)) {
            return fail(res, 429, '登录失败次数过多，请 60 秒后再试');
        }

        var record = usersRepo.getAuthRecordByUsername(handle, username);
        // 用户不存在、密码不对、账号被禁用，对外都是同一句话，不透露是哪一项错
        var passed = !!record && !record.disabled && auth.verifyPassword(password, record.passwordHash);

        if (!passed) {
            auth.recordFailure(key);
            return fail(res, 401, '用户名或密码错误');
        }

        auth.clearFailures(key);
        auth.createSession(handle, record.id, res);
        ok(res, { user: usersRepo.getById(handle, record.id) });
    });

    /* ---------------------------------------------------------- 以下都要登录 */

    router.use(auth.requireLogin);

    router.post('/auth/logout', function (req, res) {
        if (req.sessionTokenHash) sessionsRepo.remove(handle, req.sessionTokenHash);
        auth.clearSessionCookie(res);
        ok(res, {});
    });

    router.get('/auth/me', function (req, res) {
        ok(res, { user: req.user });
    });

    router.put('/auth/password', function (req, res) {
        var body = req.body || {};
        var oldPassword = String(body.oldPassword === undefined || body.oldPassword === null ? '' : body.oldPassword);
        var newPassword = String(body.newPassword === undefined || body.newPassword === null ? '' : body.newPassword);

        if (newPassword.length < auth.MIN_PASSWORD_LENGTH) {
            return fail(res, 400, '新密码至少 ' + auth.MIN_PASSWORD_LENGTH + ' 位');
        }

        var record = usersRepo.getAuthRecordByUsername(handle, req.user.username);
        if (!record || !auth.verifyPassword(oldPassword, record.passwordHash)) {
            return fail(res, 400, '原密码不正确');
        }

        handle.transaction(function () {
            usersRepo.update(handle, req.user.id, { passwordHash: auth.hashPassword(newPassword) });
        });

        // 改完密码把「其他」登录态清掉，当前这台设备不用重新登录
        sessionsRepo.removeByUser(handle, req.user.id);
        auth.createSession(handle, req.user.id, res);

        ok(res, {});
    });

    /* ---------------------------------------------------------- 搜人（登录即可） */

    /**
     * 加项目成员时用来搜人。**刻意不挂在 requireAdmin 上**：普通 owner 也要能把
     * 同事加进自己的项目；只露出 id / 用户名 / 显示名，不返回角色和登录状态。
     */
    router.get('/users/lookup', function (req, res) {
        var keyword = (req.query || {}).q;
        var found = usersRepo.search(handle, keyword, 20);

        ok(res, {
            users: found.map(function (user) {
                return { id: user.id, username: user.username, displayName: user.displayName };
            })
        });
    });

    /* ---------------------------------------------------------- 用户管理（仅管理员） */

    router.get('/users', auth.requireAdmin, function (req, res) {
        ok(res, { users: usersRepo.list(handle) });
    });

    router.post('/users', auth.requireAdmin, function (req, res) {
        var body = req.body || {};
        var username = String(body.username === undefined || body.username === null ? '' : body.username).trim();

        if (!USERNAME_PATTERN.test(username)) {
            return fail(res, 400, '用户名只能用字母、数字、下划线、点、连字符，长度 2~32');
        }
        if (usersRepo.getByUsername(handle, username)) {
            return fail(res, 400, '用户名已存在: ' + username);
        }

        var generated = null;
        var password = body.password ? String(body.password) : null;
        if (password) {
            if (password.length < auth.MIN_PASSWORD_LENGTH) {
                return fail(res, 400, '密码至少 ' + auth.MIN_PASSWORD_LENGTH + ' 位');
            }
        } else {
            generated = auth.randomPassword(16);
            password = generated;
        }

        var user = handle.transaction(function () {
            return usersRepo.create(handle, {
                username: username,
                password_hash: auth.hashPassword(password),
                display_name: body.displayName ? String(body.displayName) : '',
                role: body.role === 'admin' ? 'admin' : 'member'
            });
        });

        // 自动生成的密码只在这里返回一次
        ok(res, generated ? { user: user, password: generated } : { user: user });
    });

    router.put('/users/:id', auth.requireAdmin, function (req, res) {
        var target = usersRepo.getById(handle, req.params.id);
        if (!target) return fail(res, 404, '用户不存在: ' + req.params.id);

        var body = req.body || {};
        var patch = {};
        if (body.displayName !== undefined) patch.displayName = String(body.displayName);
        if (body.role !== undefined) patch.role = body.role === 'admin' ? 'admin' : 'member';
        if (body.disabled !== undefined) patch.disabled = !!body.disabled;

        var blocked = guardAdminChange(handle, req.user, target, patch);
        if (blocked) return fail(res, 400, blocked);

        var updated = handle.transaction(function () {
            return usersRepo.update(handle, target.id, patch);
        });

        // 被禁用的人不能继续用已经登录的会话
        if (patch.disabled === true) sessionsRepo.removeByUser(handle, target.id);

        ok(res, { user: updated });
    });

    router.post('/users/:id/reset-password', auth.requireAdmin, function (req, res) {
        var target = usersRepo.getById(handle, req.params.id);
        if (!target) return fail(res, 404, '用户不存在: ' + req.params.id);

        var password = auth.randomPassword(16);
        handle.transaction(function () {
            usersRepo.update(handle, target.id, { passwordHash: auth.hashPassword(password) });
        });
        sessionsRepo.removeByUser(handle, target.id);

        ok(res, { user: target, password: password });
    });

    router.delete('/users/:id', auth.requireAdmin, function (req, res) {
        var target = usersRepo.getById(handle, req.params.id);
        if (!target) return fail(res, 404, '用户不存在: ' + req.params.id);

        if (target.id === req.user.id) {
            return fail(res, 400, '不能对自己做删除、禁用或降级');
        }
        if (target.role === 'admin' && !target.disabled &&
            usersRepo.countAdmins(handle, { excludeId: target.id }) === 0) {
            return fail(res, 400, '至少要保留一个可用（未禁用）的管理员');
        }

        handle.transaction(function () {
            sessionsRepo.removeByUser(handle, target.id);
            usersRepo.remove(handle, target.id);
        });

        ok(res, {});
    });

    return router;
}

module.exports = {
    createRouter: createRouter
};
