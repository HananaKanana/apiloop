/**
 * projects 表读写，外加 slug 生成规则。
 */

var helpers = require('./helpers');
var json = require('../json');

var SELECT = 'SELECT * FROM projects';

var COLUMNS = {
    slug: 'slug',
    name: 'name',
    description: 'description',
    sourceDir: 'source_dir',
    isDefault: 'is_default',
    variables: 'variables',
    auth: 'auth',
    scripts: 'scripts',
    extra: 'extra',
    updatedAt: 'updated_at'
};

/** slug 的字符集：只留小写字母、数字和连字符 */
var SLUG_PATTERN = /[^a-z0-9-]/g;

function toProject(row) {
    if (!row) return null;
    return {
        id: row.id,
        slug: row.slug,
        name: row.name,
        description: row.description,
        sourceDir: row.source_dir,
        isDefault: !!row.is_default,
        variables: json.readJson(row.variables, []),
        auth: row.auth === null || row.auth === undefined ? null : json.readJson(row.auth, null),
        scripts: json.readJson(row.scripts, []),
        extra: json.readJson(row.extra, {}),
        createdBy: row.created_by,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}

/**
 * 由字符串推一个稳定的 6 位 base36 短码（FNV-1a 32 位）。
 *
 * 计划里这一步写的是「6 位随机」，但随机会让 normalizeSlug 变成非纯函数：
 * 同一个中文目录名每调一次得到一个不同的 slug，于是「重名加 -2」这条规则永远
 * 触发不了（Review Focus 第 3 条要求它能触发）。改成按输入取值，既确定，
 * 又能让同名目录自然走到 -2。
 *
 * 用 Math.imul 而不是 hash * 0x01000193：后者乘积会超过 2^53，double 精度
 * 截断后就不是 FNV-1a 了。
 */
function shortCode(text) {
    var hash = 0x811c9dc5;
    for (var i = 0; i < text.length; i++) {
        hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
    }
    var code = hash.toString(36);
    while (code.length < 6) code = '0' + code;
    return code.slice(-6);
}

/**
 * 把任意字符串收拾成一个可用的 slug 片段（不查重）。纯函数：同样的输入永远
 * 得到同样的结果。
 *
 * 目录名常常是中文，归一化之后会变成空串，这时退回 p-<按名字算出的短码>。
 * 另外要躲开 `mock` —— 它是 mock 前缀本身，拿来做 slug 会让 /mock/mock/... 很别扭。
 */
function normalizeSlug(base) {
    var raw = String(base === undefined || base === null ? '' : base);
    var slug = raw
        .toLowerCase()
        .replace(SLUG_PATTERN, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '');

    if (slug.length > 32) slug = slug.slice(0, 32).replace(/-+$/g, '');

    if (!slug) slug = 'p-' + shortCode(raw);

    if (slug === 'mock' || slug.indexOf('__') === 0) slug = 'p-' + slug;
    return slug;
}

/**
 * 生成一个库里还没被占用的 slug：base、base-2、base-3……
 * 加后缀时会把 base 截短，保证总长仍然不超过 32。
 */
function uniqueSlug(handle, base) {
    var slug = normalizeSlug(base);
    var candidate = slug;
    var index = 1;

    while (handle.db.prepare('SELECT 1 FROM projects WHERE slug = ?').get(candidate)) {
        index++;
        var suffix = '-' + index;
        candidate = slug.slice(0, Math.max(1, 32 - suffix.length)) + suffix;
    }
    return candidate;
}

function create(handle, input) {
    var now = Date.now();
    var id = input.id || helpers.newId('p');
    var slug = input.slug ? uniqueSlug(handle, input.slug) : uniqueSlug(handle, input.name);

    handle.db.prepare(
        'INSERT INTO projects (id, slug, name, description, source_dir, is_default, variables, auth, scripts, extra, created_by, created_at, updated_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
        id,
        slug,
        String(input.name || slug),
        String(input.description || ''),
        input.source_dir ? String(input.source_dir) : null,
        input.is_default ? 1 : 0,
        json.writeJson(input.variables || []),
        input.auth ? json.writeJson(input.auth) : null,
        json.writeJson(input.scripts || []),
        json.writeJson(input.extra || {}),
        input.created_by || null,
        now,
        now
    );
    return getById(handle, id);
}

function getById(handle, id) {
    return toProject(handle.db.prepare(SELECT + ' WHERE id = ?').get(id));
}

function getBySlug(handle, slug) {
    return toProject(handle.db.prepare(SELECT + ' WHERE slug = ?').get(String(slug)));
}

function getBySourceDir(handle, sourceDir) {
    return toProject(handle.db.prepare(SELECT + ' WHERE source_dir = ?').get(String(sourceDir)));
}

function getDefault(handle) {
    return toProject(handle.db.prepare(SELECT + ' WHERE is_default = 1 ORDER BY created_at LIMIT 1').get());
}

function list(handle) {
    return handle.db.prepare(SELECT + ' ORDER BY is_default DESC, created_at').all()
        .map(function (row) { return toProject(row); });
}

function update(handle, id, patch) {
    var touched = helpers.applyUpdate(handle, 'projects', COLUMNS, id, patch, function (key, value) {
        if (key === 'variables' || key === 'scripts' || key === 'extra') return json.writeJson(value);
        if (key === 'auth') return value === undefined || value === null ? null : json.writeJson(value);
        if (key === 'isDefault') return value ? 1 : 0;
        if (key === 'sourceDir') return value === undefined || value === null ? null : String(value);
        return value === undefined || value === null ? '' : String(value);
    });
    if (touched) {
        handle.db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(Date.now(), id);
    }
    return getById(handle, id);
}

function remove(handle, id) {
    handle.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
}

module.exports = {
    create: create,
    getById: getById,
    getBySlug: getBySlug,
    getBySourceDir: getBySourceDir,
    getDefault: getDefault,
    list: list,
    update: update,
    remove: remove,
    normalizeSlug: normalizeSlug,
    uniqueSlug: uniqueSlug
};
