/**
 * 密码哈希、会话、以及登录相关的中间件。只依赖 Node 自带的 crypto，不加新依赖。
 *
 * 两条安全约定：
 * - 库里只存 token 的 sha256，明文 token 只在种 cookie 那一刻存在；
 * - 密码用 scrypt 加盐哈希，校验用 timingSafeEqual，不用 ===。
 */

var crypto = require('crypto');

var appInfo = require('./app-info');
var usersRepo = require('./db/repos/users');
var sessionsRepo = require('./db/repos/sessions');

var SCRYPT_N = 16384;
var SCRYPT_R = 8;
var SCRYPT_P = 1;
var KEY_LENGTH = 64;
var SALT_LENGTH = 16;

var SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
var MIN_PASSWORD_LENGTH = 6;

var MAX_FAILURES = 5;
var LOCK_MS = 60 * 1000;

/* ------------------------------------------------------------ 密码 */

/** @returns {string} scrypt$N$r$p$<salt b64>$<hash b64> */
function hashPassword(plain) {
    var salt = crypto.randomBytes(SALT_LENGTH);
    var hash = crypto.scryptSync(String(plain), salt, KEY_LENGTH, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
    return ['scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString('base64'), hash.toString('base64')].join('$');
}

function verifyPassword(plain, stored) {
    if (!stored) return false;

    var parts = String(stored).split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

    var salt;
    var expected;
    try {
        salt = Buffer.from(parts[4], 'base64');
        expected = Buffer.from(parts[5], 'base64');
    } catch (err) {
        return false;
    }
    if (!salt.length || !expected.length) return false;

    var actual;
    try {
        actual = crypto.scryptSync(String(plain), salt, expected.length, {
            N: parseInt(parts[1], 10),
            r: parseInt(parts[2], 10),
            p: parseInt(parts[3], 10)
        });
    } catch (err) {
        return false;
    }
    if (actual.length !== expected.length) return false;

    return crypto.timingSafeEqual(actual, expected);
}

/** 随机密码。去掉了 0/O/1/l/I 这些看着容易认错的字符 */
function randomPassword(length) {
    var alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    var bytes = crypto.randomBytes(length || 16);
    var out = '';
    for (var i = 0; i < bytes.length; i++) {
        out += alphabet.charAt(bytes[i] % alphabet.length);
    }
    return out;
}

/* ------------------------------------------------------------ 初始管理员 */

/**
 * 库里一个用户都没有时建一个 admin。
 * 密码优先取环境变量，没有就随机生成 16 位 —— 只有真的建了账号才返回凭据。
 */
function bootstrapAdmin(handle) {
    if (usersRepo.list(handle).length) return null;

    var fromEnv = process.env[appInfo.ENV_ADMIN_PASSWORD];
    var password = fromEnv || randomPassword(16);
    var username = 'admin';

    var user = handle.transaction(function () {
        return usersRepo.create(handle, {
            username: username,
            password_hash: hashPassword(password),
            display_name: '管理员',
            role: 'admin',
            // 随机生成的密码打在日志里，登录后要先改掉；部署时用环境变量指定的，是管理员自己定的，不用改
            must_change_password: !fromEnv
        });
    });

    return { username: user.username, password: password };
}

/* ------------------------------------------------------------ 会话 */

/** 手写 cookie 解析，不为这一个函数引入 cookie-parser */
function parseCookies(header) {
    var out = {};
    if (!header) return out;

    String(header).split(';').forEach(function (pair) {
        var index = pair.indexOf('=');
        if (index === -1) return;

        var key = pair.slice(0, index).trim();
        if (!key) return;

        var value = pair.slice(index + 1).trim();
        try {
            out[key] = decodeURIComponent(value);
        } catch (err) {
            out[key] = value;
        }
    });
    return out;
}

function tokenHash(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/**
 * 种 cookie 并落库。token 用 base64url，本身就是 URL 安全的，不用再转义。
 * @returns {string} 明文 token（只在这里出现一次）
 */
function createSession(handle, userId, res) {
    var token = crypto.randomBytes(32).toString('base64url');
    var expiresAt = Date.now() + SESSION_TTL_MS;

    handle.transaction(function () {
        sessionsRepo.create(handle, {
            token_hash: tokenHash(token),
            user_id: userId,
            expires_at: expiresAt
        });
    });

    res.setHeader('Set-Cookie', appInfo.SESSION_COOKIE + '=' + token +
        '; HttpOnly; SameSite=Lax; Path=/; Max-Age=' + Math.floor(SESSION_TTL_MS / 1000));
    return token;
}

function clearSessionCookie(res) {
    res.setHeader('Set-Cookie', appInfo.SESSION_COOKIE + '=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
}

/**
 * 解析登录态挂到 req.user（查不到就是 null）。
 * session 过期、用户被禁用或已删除，一律视为未登录 —— 被禁用的账号不再能用旧 cookie。
 */
function createSessionMiddleware(handle) {
    return function (req, res, next) {
        req.user = null;
        req.sessionTokenHash = null;

        var cookies = parseCookies(req.headers && req.headers.cookie);
        var token = cookies[appInfo.SESSION_COOKIE];
        if (!token) return next();

        var hash = tokenHash(token);
        var session = sessionsRepo.get(handle, hash);
        if (!session) return next();

        if (session.expiresAt <= Date.now()) {
            sessionsRepo.remove(handle, hash);
            return next();
        }

        var user = usersRepo.getById(handle, session.userId);
        if (!user || user.disabled) return next();

        req.user = user;
        req.sessionTokenHash = hash;
        next();
    };
}

function requireLogin(req, res, next) {
    if (!req.user) return res.status(401).json({ ok: false, error: '请先登录' });
    next();
}

/**
 * 密码是管理员重置或设置的（`mustChangePassword`）：改掉之前，只放行这几个接口。
 * 只靠页面跳转拦不住直接调接口的人，所以服务端也要拦。
 */
var PASSWORD_PENDING_ALLOWED = ['/auth/me', '/auth/password', '/auth/logout', '/meta'];

function requirePasswordChanged(req, res, next) {
    if (req.user && req.user.mustChangePassword && PASSWORD_PENDING_ALLOWED.indexOf(req.path) === -1) {
        return res.status(403).json({ ok: false, error: '请先修改密码', code: 'PASSWORD_CHANGE_REQUIRED' });
    }
    next();
}

function requireAdmin(req, res, next) {
    if (!req.user) return res.status(401).json({ ok: false, error: '请先登录' });
    if (req.user.role !== 'admin') return res.status(403).json({ ok: false, error: '需要管理员权限' });
    next();
}

/* ------------------------------------------------------------ 登录失败限流 */

var failures = new Map();

function isLocked(username) {
    var entry = failures.get(username);
    if (!entry) return false;

    // 还没被锁过（until 为 0）时必须原样保留计数，不能顺手删掉 ——
    // 删了的话每次登录都从 1 重新数，永远攒不到 MAX_FAILURES。
    if (!entry.until) return false;

    if (entry.until > Date.now()) return true;

    // 锁已过期，清掉重新开始计数
    failures.delete(username);
    return false;
}

function recordFailure(username) {
    var entry = failures.get(username) || { count: 0, until: 0 };
    entry.count++;
    if (entry.count >= MAX_FAILURES) {
        entry.until = Date.now() + LOCK_MS;
        entry.count = 0;
    }
    failures.set(username, entry);
}

function clearFailures(username) {
    failures.delete(username);
}

module.exports = {
    hashPassword: hashPassword,
    requirePasswordChanged: requirePasswordChanged,
    verifyPassword: verifyPassword,
    randomPassword: randomPassword,
    bootstrapAdmin: bootstrapAdmin,
    parseCookies: parseCookies,
    createSession: createSession,
    clearSessionCookie: clearSessionCookie,
    createSessionMiddleware: createSessionMiddleware,
    requireLogin: requireLogin,
    requireAdmin: requireAdmin,
    isLocked: isLocked,
    recordFailure: recordFailure,
    clearFailures: clearFailures,
    MIN_PASSWORD_LENGTH: MIN_PASSWORD_LENGTH
};
