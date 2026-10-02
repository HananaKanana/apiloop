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

/**
 * 注册限流：同一个来源 IP 一小时最多注册 REGISTER_LIMIT 个账号。
 * 注册是公开接口，不限的话谁都能往待审核列表里灌垃圾。只记在内存里，重启清零就够了。
 */
var REGISTER_LIMIT = 30;
var REGISTER_WINDOW_MS = 60 * 60 * 1000;
var registerHits = new Map();

function registerAllowed(ip) {
    var now = Date.now();
    var hits = (registerHits.get(ip) || []).filter(function (at) { return now - at < REGISTER_WINDOW_MS; });
    if (hits.length >= REGISTER_LIMIT) {
        registerHits.set(ip, hits);
        return false;
    }
    hits.push(now);
    registerHits.set(ip, hits);
    return true;
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

        // 密码对了才说「待审核」：没猜中密码的人看到的永远是上面那一句，探不出用户名
        if (record.pending) {
            return fail(res, 403, '账号还在等管理员审核，通过后才能登录');
        }

        auth.createSession(handle, record.id, res);
        ok(res, { user: usersRepo.getById(handle, record.id) });
    });

    /**
     * 自助注册（用户 2026-10-02）：建一个**待审核**的普通成员，管理员在「用户管理」里通过后才能登录。
     * 不发会话、不返回用户 id —— 注册成功只代表「申请提交了」。
     */
    router.post('/auth/register', function (req, res) {
        var body = req.body || {};
        var username = String(body.username === undefined || body.username === null ? '' : body.username).trim();
        var password = String(body.password === undefined || body.password === null ? '' : body.password);
        var displayName = String(body.displayName === undefined || body.displayName === null ? '' : body.displayName).trim();

        if (!USERNAME_PATTERN.test(username)) {
            return fail(res, 400, '用户名只能用字母、数字、下划线、点、连字符，长度 2~32');
        }
        if (password.length < auth.MIN_PASSWORD_LENGTH) {
            return fail(res, 400, '密码至少 ' + auth.MIN_PASSWORD_LENGTH + ' 位');
        }
        if (displayName.length > 64) {
            return fail(res, 400, '显示名太长了（最多 64 个字）');
        }
        if (usersRepo.getByUsername(handle, username)) {
            return fail(res, 400, '用户名已被占用，换一个吧');
        }
        if (!registerAllowed(String(req.ip || ''))) {
            return fail(res, 429, '注册太频繁了，请稍后再试');
        }

        handle.transaction(function () {
            usersRepo.create(handle, {
                username: username,
                password_hash: auth.hashPassword(password),
                display_name: displayName,
                role: 'member',
                pending: true
            });
        });

        ok(res, { pending: true });
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
        if (newPassword === oldPassword) {
            return fail(res, 400, '新密码不能和当前密码相同');
        }

        handle.transaction(function () {
            // 自己改的密码：清掉「必须先改密码」的标记（不传的话仓储层默认会打上）
            usersRepo.update(handle, req.user.id, {
                passwordHash: auth.hashPassword(newPassword),
                mustChangePassword: false
            });
        });

        // 改完密码把「其他」登录态清掉，当前这台设备不用重新登录
        sessionsRepo.removeByUser(handle, req.user.id);
        auth.createSession(handle, req.user.id, res);

        ok(res, {});
    });

    // 管理员重置或设置的密码，改掉之前下面所有接口（以及 admin.js 里后面挂的）都不让用
    router.use(auth.requirePasswordChanged);

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

    /** 待审核的人数：管理员的头像菜单上显示角标 */
    router.get('/users/pending-count', auth.requireAdmin, function (req, res) {
        ok(res, { count: usersRepo.countPending(handle) });
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
                role: body.role === 'admin' ? 'admin' : 'member',
                // 管理员定的初始密码（不管是生成的还是填的），用户第一次登录要先改掉
                must_change_password: true
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
        // 审核通过。只能从待审核变成通过，不能反过来（拒绝就是删掉）
        if (body.approve === true) patch.pending = false;

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

        // 重置会清掉这个人的所有会话 —— 对自己做的话，当前这个会话也没了，
        // 新密码还没显示出来人就被踢回登录页（2026-10-01 用户遇到）。改自己的走 PUT /auth/password
        if (target.id === req.user.id) {
            return fail(res, 400, '不能重置自己的密码，请用右上角头像菜单里的「修改密码」');
        }

        var password = auth.randomPassword(16);
        handle.transaction(function () {
            usersRepo.update(handle, target.id, {
                passwordHash: auth.hashPassword(password),
                mustChangePassword: true
            });
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
