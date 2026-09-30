/**
 * 把工作目录里的旧配置导入成一个项目。
 *
 * 触发时机是启动时：某个目录还没有绑定过项目，就在它里面找一遍旧文件。
 * 两个候选同时存在时**只认 routes.db**（它更新、信息更全）；原文件一律不动，
 * 导入过的路径记进 legacy_imports，下次启动不再重复导入。
 *
 * 为什么不是「一个事务包到底」：导入要复用 routes-store 门面的映射逻辑
 * （route → folder + api + example），而门面的每个写方法自己就是一条事务，
 * handle 又不支持嵌套事务。所以这里退成三步顺序执行，靠两道幂等闸门兜底：
 * 项目表上 source_dir 唯一，legacy_imports 上 source_path 唯一。任何一步失败，
 * 下次启动都会从失败的边界重新走，不会产生第二个项目。
 */

var fs = require('fs');
var path = require('path');

var legacyRoutesDb = require('./legacy/routes-db');
var routesStore = require('./routes-store');
var projectsRepo = require('./db/repos/projects');
var projectStores = require('./project-stores');

var LEGACY_DB = 'routes.db';
var LEGACY_JSON = 'routes.json';

/** 两个旧文件都在时优先 routes.db */
function findLegacyFile(dir) {
    var dbFile = path.join(dir, LEGACY_DB);
    if (fs.existsSync(dbFile)) return { path: dbFile, kind: 'db' };

    var jsonFile = path.join(dir, LEGACY_JSON);
    if (fs.existsSync(jsonFile)) return { path: jsonFile, kind: 'json' };

    return null;
}

/**
 * 读旧的 routes.json。容错逻辑与文案照搬 P0 时期 routes-store 的 migrateFromJson，
 * 单条接口解析失败只跳过那一条，不因为一条坏数据把整次导入废掉。
 */
function readLegacyJson(file) {
    var warnings = [];
    var text;

    try {
        text = fs.readFileSync(file, 'utf-8');
    } catch (err) {
        return { groups: [], routes: [], warnings: ['读取旧配置失败：' + err.message] };
    }
    if (!text.trim()) return { groups: [], routes: [], warnings: warnings };

    var parsed;
    try {
        parsed = JSON.parse(text);
    } catch (err) {
        warnings.push('旧配置 ' + path.basename(file) + ' 不是合法 JSON，已跳过迁移：' + err.message);
        return { groups: [], routes: [], warnings: warnings };
    }

    var list = Array.isArray(parsed) ? parsed : (parsed && parsed.routes);
    if (!Array.isArray(list)) {
        warnings.push('旧配置 ' + path.basename(file) +
            ' 格式不对（应为 { "routes": [...] } 或直接是数组），已跳过迁移');
        return { groups: [], routes: [], warnings: warnings };
    }

    return { groups: readGroupList(parsed), routes: list, warnings: warnings };
}

function readGroupList(parsed) {
    var list = Array.isArray(parsed) ? null : (parsed && parsed.groups);
    if (!Array.isArray(list)) return [];

    var seen = {};
    return list.map(function (name) {
        return String(name === undefined || name === null ? '' : name).trim();
    }).filter(function (name) {
        if (!name || seen[name]) return false;
        seen[name] = true;
        return true;
    });
}

function readLegacy(found) {
    if (found.kind === 'json') return readLegacyJson(found.path);

    var handle;
    try {
        handle = legacyRoutesDb.openDatabase(found.path);
    } catch (err) {
        return { groups: [], routes: [], warnings: ['读取旧配置 ' + path.basename(found.path) + ' 失败：' + err.message] };
    }
    try {
        var doc = legacyRoutesDb.readAll(handle);
        return { groups: doc.groups || [], routes: doc.routes || [], warnings: [] };
    } finally {
        legacyRoutesDb.close(handle);
    }
}

function findImportedProjectId(handle, sourcePath) {
    var row = handle.db.prepare('SELECT project_id FROM legacy_imports WHERE source_path = ?').get(sourcePath);
    return row ? row.project_id : null;
}

function addOwner(handle, projectId, userId) {
    if (!userId) return;
    handle.db.prepare(
        'INSERT OR IGNORE INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)'
    ).run(projectId, userId, 'owner');
}

/**
 * @param {object} handle lib/db 的 handle
 * @param {string} dir 要检查的目录
 * @param {{userId?: string, file?: string}} [options] file 对应 --config 显式指定的文件
 * @returns {{project: object|null, importedFrom: string|null, warnings: string[]}}
 */
function importLegacyDir(handle, dir, options) {
    options = options || {};
    var absoluteDir = path.resolve(dir);

    // 1. 这个目录已经绑定过项目（不管是导入来的还是手工建的）
    var existing = projectsRepo.getBySourceDir(handle, absoluteDir);
    if (existing) return { project: existing, importedFrom: null, warnings: [] };

    // 2. 找旧文件
    var found = options.file
        ? { path: path.resolve(options.file), kind: /\.json$/i.test(options.file) ? 'json' : 'db' }
        : findLegacyFile(absoluteDir);

    if (!found || !fs.existsSync(found.path)) {
        return { project: null, importedFrom: null, warnings: [] };
    }

    // 3. 这个文件之前导入过（比如用户把项目删了又重新启动）
    var importedId = findImportedProjectId(handle, found.path);
    if (importedId) {
        var imported = projectsRepo.getById(handle, importedId);
        if (imported) return { project: imported, importedFrom: null, warnings: [] };
    }

    var legacy = readLegacy(found);
    if (!legacy.routes.length && legacy.warnings.length) {
        // 一个字都没读出来就别建空项目了，只把问题报上去
        return { project: null, importedFrom: null, warnings: legacy.warnings };
    }

    // 4. 建项目（source_dir 唯一，是这里的第一道幂等闸门）
    var project = handle.transaction(function () {
        var created = projectsRepo.create(handle, {
            name: path.basename(absoluteDir) || absoluteDir,
            source_dir: absoluteDir
        });
        addOwner(handle, created.id, options.userId);
        return created;
    });

    // 5. 灌数据。先把显式声明的分组按原顺序建出来，再灌接口 —— 反过来会让
    //    「只声明了分组但没有接口」的那些分组丢掉，顺序也保不住。
    var store = projectStores.get(handle, project.id);
    var warnings = legacy.warnings.slice();

    try {
        legacy.groups.forEach(function (name) {
            if (store.getGroups().some(function (group) { return group.name === name; })) return;
            store.addGroup(name);
        });

        var routes = [];
        var skipped = 0;
        legacy.routes.forEach(function (item) {
            try {
                routes.push(routesStore.normalizeRoute(item, { keepId: true }));
            } catch (err) {
                skipped++;
            }
        });
        if (skipped > 0) warnings.push('旧配置里有 ' + skipped + ' 条接口无法解析，已跳过');
        if (routes.length) store.addMany(routes);
    } catch (err) {
        warnings.push('导入接口失败：' + err.message);
    }

    // 6. 记一笔导入来源（source_path 唯一，是第二道幂等闸门）
    handle.transaction(function () {
        handle.db.prepare('INSERT OR REPLACE INTO legacy_imports (source_path, project_id, imported_at) VALUES (?, ?, ?)')
            .run(found.path, project.id, Date.now());
    }, { projectId: project.id });

    return { project: project, importedFrom: found.path, warnings: warnings };
}

module.exports = {
    importLegacyDir: importLegacyDir,
    findLegacyFile: findLegacyFile
};
