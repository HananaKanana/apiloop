/**
 * sessions 表读写。
 *
 * 库里只存 token 的 sha256，明文 token 只在给浏览器种 cookie 那一刻存在。
 */

function toSession(row) {
    if (!row) return null;
    return {
        tokenHash: row.token_hash,
        userId: row.user_id,
        createdAt: row.created_at,
        expiresAt: row.expires_at
    };
}

function create(handle, input) {
    handle.db.prepare(
        'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
    ).run(
        String(input.token_hash),
        String(input.user_id),
        input.created_at || Date.now(),
        Number(input.expires_at)
    );
    return get(handle, input.token_hash);
}

function get(handle, tokenHash) {
    return toSession(handle.db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(String(tokenHash)));
}

function remove(handle, tokenHash) {
    handle.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(String(tokenHash));
}

/** 用户被禁用、删除、改密码、重置密码时，把他所有登录态一起清掉 */
function removeByUser(handle, userId) {
    handle.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

function removeExpired(handle, now) {
    handle.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now || Date.now());
}

module.exports = {
    create: create,
    get: get,
    remove: remove,
    removeByUser: removeByUser,
    removeExpired: removeExpired
};
