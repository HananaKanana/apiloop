/**
 * 把工作目录里的旧配置导入成一个项目。
 *
 * 触发时机是启动时：某个目录还没有绑定过项目，就在它里面找一遍旧文件。
 * 两个候选同时存在时**只认 routes.db**（它更新、信息更全）；原文件一律不动，
 * 导入过的路径记进 legacy_imports，下次启动不再重复导入。
 *
 * 「建项目 → 加 owner → 灌数据 → 记来源」**整块放在同一个事务里**：任何一步抛错
 * 都整体回滚，不会留下一个「空空的、而且因为 source_dir 已存在而再也不会重新导入」
 * 的项目。为此灌数据用的是 routes-store 里那个**不开事务**的 insertRoutes ——
 * 门面的写方法各自就是一条事务，handle 又不支持嵌套，套不进来。
 *
 * 出错时把错误抛给调用方，由它打印并按「没有旧配置」继续启动。
 */

var fs = require('fs');
var path = require('path');

var legacyRoutesDb = require('./legacy/routes-db');
var routesStore = require('./routes-store');
var projectsRepo = require('./db/repos/projects');

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

    // 4. 建项目 → 加 owner → 灌数据 → 记来源，一个事务做完。
    //    任何一步抛错都整体回滚，不会留下「空空的、而且因为 source_dir 已存在
    //    而再也不会重新导入」的项目。insertRoutes 会先按声明顺序建出分组，
    //    再灌接口 —— 反过来的话「只声明了分组但没有接口」的那些会丢、顺序也保不住。
    var project = handle.transaction(function () {
        var created = projectsRepo.create(handle, {
            name: path.basename(absoluteDir) || absoluteDir,
            source_dir: absoluteDir
        });
        addOwner(handle, created.id, options.userId);

        routesStore.insertRoutes(handle, created.id, {
            groups: legacy.groups,
            routes: legacy.routes
        });

        handle.db.prepare('INSERT OR REPLACE INTO legacy_imports (source_path, project_id, imported_at) VALUES (?, ?, ?)')
            .run(found.path, created.id, Date.now());

        return created;
    }, { projectId: null });

    return { project: project, importedFrom: found.path, warnings: legacy.warnings.slice() };
}

module.exports = {
    importLegacyDir: importLegacyDir,
    findLegacyFile: findLegacyFile
};
