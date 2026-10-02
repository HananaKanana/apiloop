/**
 * users 表读写。
 *
 * 所有对外返回的用户对象都不带 password_hash，只有登录时用的
 * getAuthRecordByUsername 是例外 —— 少一个地方漏出哈希是一个地方。
 */

var helpers = require('./helpers');

var SELECT = 'SELECT * FROM users';

var COLUMNS = {
    username: 'username',
    passwordHash: 'password_hash',
    displayName: 'display_name',
    role: 'role',
    disabled: 'disabled',
    mustChangePassword: 'must_change_password',
    pending: 'pending',
    updatedAt: 'updated_at'
};

function toUser(row, options) {
    if (!row) return null;
    var user = {
        id: row.id,
        username: row.username,
        displayName: row.display_name,
        role: row.role,
        disabled: !!row.disabled,
        mustChangePassword: !!row.must_change_password,
        pending: !!row.pending,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
    if (options && options.withHash) user.passwordHash = row.password_hash;
    return user;
}

function create(handle, input) {
    var now = Date.now();
    var id = input.id || helpers.newId('u');
    handle.db.prepare(
        'INSERT INTO users (id, username, password_hash, display_name, role, disabled, must_change_password, ' +
        'pending, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
        id,
        String(input.username),
        String(input.password_hash || ''),
        String(input.display_name || ''),
        input.role === 'admin' ? 'admin' : 'member',
        0,
        input.must_change_password ? 1 : 0,
        input.pending ? 1 : 0,
        now,
        now
    );
    return getById(handle, id);
}

function getById(handle, id) {
    return toUser(handle.db.prepare(SELECT + ' WHERE id = ?').get(id));
}

/** username 列是 COLLATE NOCASE，所以这里天然大小写不敏感 */
function getByUsername(handle, username) {
    return toUser(handle.db.prepare(SELECT + ' WHERE username = ?').get(String(username)));
}

/** 唯一会带出 password_hash 的入口，只在登录校验时用 */
function getAuthRecordByUsername(handle, username) {
    var row = handle.db.prepare(SELECT + ' WHERE username = ?').get(String(username));
    return toUser(row, { withHash: true });
}

function list(handle) {
    return handle.db.prepare(SELECT + ' ORDER BY created_at, username').all()
        .map(function (row) { return toUser(row); });
}

/**
 * 改了密码却没说 `mustChangePassword` 时，**默认要求这个用户下次登录先改密码**：
 * 只有用户自己在「修改密码」里改的，才显式传 `mustChangePassword: false`。
 * 管理台重置、命令行 `user reset-password` 都走这个默认值 —— 以后再多一个
 * 「替别人改密码」的入口，忘了传也是安全的那一边。
 */
function update(handle, id, patch) {
    if (patch && patch.passwordHash !== undefined && patch.mustChangePassword === undefined) {
        patch = Object.assign({}, patch, { mustChangePassword: true });
    }
    var touched = helpers.applyUpdate(handle, 'users', COLUMNS, id, patch, function (key, value) {
        if (key === 'disabled' || key === 'mustChangePassword' || key === 'pending') return value ? 1 : 0;
        return value === undefined || value === null ? '' : String(value);
    });
    if (touched) {
        handle.db.prepare('UPDATE users SET updated_at = ? WHERE id = ?').run(Date.now(), id);
    }
    return getById(handle, id);
}

function remove(handle, id) {
    handle.db.prepare('DELETE FROM users WHERE id = ?').run(id);
}

/**
 * 数一数还有几个「能用的管理员」（admin 且未禁用）。
 * 删除、禁用、降级最后一个管理员之前都要先问一次这个数。
 * @param {{excludeId?: string}} [options] 把某个用户排除在外（比如正在操作他自己）
 */
function countAdmins(handle, options) {
    var excludeId = options && options.excludeId;
    var row = excludeId
        ? handle.db.prepare("SELECT count(*) AS c FROM users WHERE role = 'admin' AND disabled = 0 AND id <> ?").get(excludeId)
        : handle.db.prepare("SELECT count(*) AS c FROM users WHERE role = 'admin' AND disabled = 0").get();
    return row ? row.c : 0;
}

/** 注册了、等管理员审核的人数（管理员菜单上的角标） */
function countPending(handle) {
    var row = handle.db.prepare('SELECT count(*) AS c FROM users WHERE pending = 1').get();
    return row ? row.c : 0;
}

/**
 * 最早创建的那个 admin。
 * 项目成员表要有人当 owner，而「建项目」这件事常常发生在还没有任何用户的时候
 * （比如 `apiloop init`）—— 启动时用这个把空着 ownership 的项目补上。
 */
function firstAdmin(handle) {
    return toUser(handle.db.prepare(SELECT + " WHERE role = 'admin' ORDER BY created_at, id LIMIT 1").get());
}

/**
 * 按用户名或显示名模糊搜人（加项目成员时用）。
 *
 * - 禁用的、注册了还没审核的一律不出现：他们登不进来，加进来只会让成员表看着莫名其妙；
 * - LIKE 里的 `%` 和 `_` 当字面量处理（转义后配 ESCAPE），否则搜一个 `_`
 *   就把所有人都捞出来；
 * - 关键字为空返回空数组，不返回「前 20 个用户」—— 那等于给任何登录用户
 *   开放了一份用户名单。
 */
function search(handle, keyword, limit) {
    var text = String(keyword === undefined || keyword === null ? '' : keyword).trim();
    if (!text) return [];

    var pattern = '%' + text.replace(/[\\%_]/g, '\\$&') + '%';
    var size = Number(limit) > 0 ? Math.floor(Number(limit)) : 20;

    return handle.db.prepare(
        "SELECT * FROM users WHERE disabled = 0 AND pending = 0 AND (" +
        "    username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\'" +
        ') ORDER BY username LIMIT ?'
    ).all(pattern, pattern, size).map(function (row) { return toUser(row); });
}

module.exports = {
    countPending: countPending,
    create: create,
    getById: getById,
    getByUsername: getByUsername,
    getAuthRecordByUsername: getAuthRecordByUsername,
    list: list,
    search: search,
    update: update,
    remove: remove,
    countAdmins: countAdmins,
    firstAdmin: firstAdmin
};
