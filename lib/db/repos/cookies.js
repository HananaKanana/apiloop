/**
 * cookies 表读写（契约第 12 节）。
 *
 * **归属是 (project_id, user_id)**：同一个项目的两个成员登录的是不同账号，
 * 共用一个 cookie 库等于把两个人的登录态搅在一起。所以这里的每个函数都要求
 * 传这两个 id，没有「只按 id 查」的入口 —— 少一个参数就少一次越权。
 *
 * 唯一键是 `(project_id, user_id, domain, path, name)`，也就是 RFC 6265 里
 * 「同一个 cookie」的判定。upsert 会先按它查一遍：命中就更新值、保留 created_at
 * （发送顺序要按它排），没命中才插入。
 */

var helpers = require('./helpers');

var SELECT = 'SELECT * FROM cookies';

function toCookie(row) {
    if (!row) return null;
    return {
        id: row.id,
        projectId: row.project_id,
        userId: row.user_id,
        domain: row.domain,
        path: row.path,
        name: row.name,
        value: row.value,
        // 毫秒时间戳；null 表示会话 cookie
        expires: row.expires === null || row.expires === undefined ? null : row.expires,
        hostOnly: !!row.host_only,
        secure: !!row.secure,
        httpOnly: !!row.http_only,
        sameSite: row.same_site || null,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}

/** 定形定位的那三个字段 */
function locate(handle, projectId, userId, cookie) {
    return handle.db.prepare(
        SELECT + ' WHERE project_id = ? AND user_id = ? AND domain = ? AND path = ? AND name = ?'
    ).get(projectId, userId, String(cookie.domain), String(cookie.path), String(cookie.name));
}

function get(handle, id) {
    return toCookie(handle.db.prepare(SELECT + ' WHERE id = ?').get(id));
}

/**
 * 某个用户在这个项目里的全部 cookie。
 *
 * 不过滤过期：调用方（`/send` 和接口）都会先 `purgeExpired` 再读，
 * 这样「过期的不再发送」和「过期的从库里消失」是同一件事。
 */
function listFor(handle, projectId, userId) {
    return handle.db.prepare(
        SELECT + ' WHERE project_id = ? AND user_id = ? ORDER BY created_at, rowid'
    ).all(projectId, userId).map(toCookie);
}

/**
 * 有就更新、没有就插入。
 * @returns {object} 落库后的那一行
 */
function upsert(handle, projectId, userId, cookie) {
    var now = Date.now();
    var existing = locate(handle, projectId, userId, cookie);

    var fields = [
        String(cookie.value === undefined || cookie.value === null ? '' : cookie.value),
        cookie.expires === undefined || cookie.expires === null ? null : Number(cookie.expires),
        cookie.hostOnly === true ? 1 : 0,
        cookie.secure === true ? 1 : 0,
        cookie.httpOnly === true ? 1 : 0,
        cookie.sameSite || null
    ];

    if (existing) {
        // 只更新「会变的」：domain / path / name 是定位用的，created_at 决定发送顺序，
        // 两者都保持原样
        handle.db.prepare(
            'UPDATE cookies SET value = ?, expires = ?, host_only = ?, secure = ?, http_only = ?, ' +
            'same_site = ?, updated_at = ? WHERE id = ?'
        ).run(
            fields[0], fields[1], fields[2], fields[3], fields[4], fields[5], now, existing.id
        );
        return get(handle, existing.id);
    }

    var id = cookie.id || helpers.newId('ck');
    handle.db.prepare(
        'INSERT INTO cookies (id, project_id, user_id, domain, path, name, value, expires, ' +
        'host_only, secure, http_only, same_site, created_at, updated_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
        id, projectId, userId,
        String(cookie.domain), String(cookie.path), String(cookie.name),
        fields[0], fields[1], fields[2], fields[3], fields[4], fields[5],
        cookie.createdAt === undefined || cookie.createdAt === null ? now : Number(cookie.createdAt),
        now
    );

    return get(handle, id);
}

function remove(handle, id) {
    handle.db.prepare('DELETE FROM cookies WHERE id = ?').run(id);
}

/**
 * 按条件删。三种用法，可以同时给：
 * - `{ all: true }`：清空这个用户在这个项目下的全部（界面上「清空」）；
 * - `{ domain }`：只清这个域名下的；
 * - `{ keys: [cookie, ...] }`：按 `domain + path + name` 精确删（jar 回写时用）。
 *
 * **归属仍然必须带上**，否则就是一个「拿 id 删别人 cookie」的口子。
 */
function removeWhere(handle, projectId, userId, options) {
    var opts = options || {};

    if (opts.all === true) {
        handle.db.prepare('DELETE FROM cookies WHERE project_id = ? AND user_id = ?')
            .run(projectId, userId);
    }

    var statement = handle.db.prepare(
        'DELETE FROM cookies WHERE project_id = ? AND user_id = ? AND domain = ? AND path = ? AND name = ?'
    );

    if (opts.domain !== undefined && opts.domain !== null && opts.domain !== '') {
        handle.db.prepare('DELETE FROM cookies WHERE project_id = ? AND user_id = ? AND domain = ?')
            .run(projectId, userId, String(opts.domain));
    }

    (opts.keys || []).forEach(function (cookie) {
        if (!cookie || !cookie.name) return;
        statement.run(projectId, userId, String(cookie.domain),
            String(cookie.path === undefined || cookie.path === null ? '/' : cookie.path),
            String(cookie.name));
    });
}

/** 删掉已经过期的。返回删了几条 */
function purgeExpired(handle, projectId, userId, now) {
    var result = handle.db.prepare(
        'DELETE FROM cookies WHERE project_id = ? AND user_id = ? AND expires IS NOT NULL AND expires <= ?'
    ).run(projectId, userId, Number(now));

    return Number(result.changes) || 0;
}

module.exports = {
    get: get,
    listFor: listFor,
    upsert: upsert,
    remove: remove,
    removeWhere: removeWhere,
    purgeExpired: purgeExpired
};
