/**
 * 备份的「合并更新」（用户 2026-10-22）。
 *
 * 场景：一套环境在内网、连不了外网。内网里把接口跑通、存好示例（Mock 数据），导出备份文件；
 * 外网把文件导进来，用本机 Mock 直接拿到内网的数据。**同一个文件反复导入要幂等**，不能每次多出一套。
 *
 * 原来的两种恢复都不行：`new` 每次建一个新项目、全部换新 id；`overwrite` 把目标项目清空再装，
 * 外网自己加的东西也没了。这里是第三种：
 *
 * 1. **按 id 认同一条**：备份里每一行在目标项目里的 id 是 `hash(目标项目 id + 原 id)` 算出来的 ——
 *    同一个文件导几次都落在同一行上（有就更新、没有就新建）；同一个文件导进两个项目也不会撞。
 * 2. **以内网为准**：目录、接口、示例、Mock 期望、测试集按文件更新（外网改过的会被盖掉）。
 * 3. **外网自己的不动**：不是从这份来源导进来的行，一概不碰。
 * 4. **环境和变量只补不改**：内网环境里的 host 是内网地址，外网有自己的。已有的环境（按 id 或同名认）
 *    只补缺的变量，值不改；项目变量、目录变量同理。
 * 5. **内网删掉的**：每次合并都把「这次从这个来源导进来的 id」记在项目的 `extra.importSources` 里，
 *    下次对比出「上次有、这次没了」的，列出来；**默认不删**，调用方勾了才删（接口进回收站）。
 *
 * 全部走 `lib/sync/rows.js` 的原始行读写，同一个事务里做完：同步的触发器照常记流水，
 * 换到客户端里做的合并也会推上云端。
 */

var crypto = require('crypto');

var respond = require('./api/respond');
var i18n = require('./i18n');
var json = require('./db/json');
var rows = require('./sync/rows');
var trash = require('./trash');
var clone = require('./project-clone');
var access = require('./access');
var projectsRepo = require('./db/repos/projects');
var foldersRepo = require('./db/repos/folders');
var apisRepo = require('./db/repos/apis');
var environmentsRepo = require('./db/repos/environments');
var suitesRepo = require('./db/repos/suites');

/** 各种行在目标项目里的 id 前缀（和各 repo 的 newId 一致，界面上认得出是什么） */
var PREFIX = { folder: 'f', api: 'a', example: 'e', expectation: 'x', suite: 's', environment: 'env' };
var KINDS = ['folder', 'api', 'example', 'expectation', 'suite', 'environment'];

function apiError(status, message) {
    return respond.apiError(status, message);
}

/** 备份里的一行在目标项目里的 id：固定算法，同一个 (目标项目, 原 id) 永远是同一个结果 */
function derivedId(kind, targetProjectId, sourceId) {
    var digest = crypto.createHash('sha1').update(targetProjectId + ':' + kind + ':' + sourceId).digest('hex');
    return PREFIX[kind] + '_m' + digest.slice(0, 18);
}

/* ------------------------------------------------------------------ 变量：只补不改 */

function readVarRows(text) {
    var parsed = json.readJson(text, []);
    return Array.isArray(parsed) ? parsed : [];
}

/**
 * 把来源里有、目标里没有的变量行补进去（按 key 认）。值不改，保密行的值本来就是空的。
 * @returns {{text: string, added: number}} text 是要写回的 JSON；没补就是原样
 */
function addMissingVars(targetText, sourceText) {
    var target = readVarRows(targetText);
    var have = {};
    target.forEach(function (row) { if (row && row.key) have[row.key] = true; });
    var added = 0;
    readVarRows(sourceText).forEach(function (row) {
        if (!row || !row.key || have[row.key]) return;
        target.push(row);
        have[row.key] = true;
        added += 1;
    });
    return { text: added ? JSON.stringify(target) : targetText, added: added };
}

/* ------------------------------------------------------------------ 比较 */

/** 这些列比较内容时不看：位置跟着目标项目走，时间、版本号是库自己记的 */
var IGNORE = { position: true, created_at: true, updated_at: true, rev: true, project_id: true };

function sameContent(kind, existing, next) {
    var cols = rows.columns ? rows.columns(kind) : null;
    var keys = (cols && cols.length ? cols : Object.keys(next)).filter(function (col) {
        return !IGNORE[col] && next[col] !== undefined;
    });
    return keys.every(function (col) {
        var a = existing[col] === undefined ? null : existing[col];
        var b = next[col] === undefined ? null : next[col];
        return String(a) === String(b);
    });
}

/* ------------------------------------------------------------------ 计划 */

function sortFolders(folderRows) {
    var byId = {};
    folderRows.forEach(function (raw) { byId[String(raw.id)] = raw; });
    function depth(raw) {
        var level = 0;
        var seen = {};
        var parentId = raw.parent_id;
        while (parentId && byId[parentId] && !seen[parentId] && level < 64) {
            seen[parentId] = true;
            level += 1;
            parentId = byId[parentId].parent_id;
        }
        return level;
    }
    return folderRows.slice().sort(function (a, b) {
        return (depth(a) - depth(b)) || ((Number(a.position) || 0) - (Number(b.position) || 0));
    });
}

function labelOf(kind, row) {
    if (!row) return '';
    if (kind === 'api') return (row.method ? row.method + ' ' : '') + (row.name || row.url || '');
    return row.name || '';
}

/**
 * 算出要做的事（不写库）。预览和执行用同一份计算，免得「预览说改 A、实际改了 B」。
 *
 * @returns {{ ops: Array, counts: object, removable: Array, sourceKey: string, ids: object }}
 */
function plan(handle, project, parsed) {
    var pid = project.id;
    var sourceKey = String(parsed.project.id || '');
    if (!sourceKey) throw apiError(400, i18n.m('备份文件里没有项目 id，没法合并'));

    var idMap = {};
    var ops = [];
    var counts = { added: 0, updated: 0, unchanged: 0, varsAdded: 0 };
    var ids = {};
    KINDS.forEach(function (kind) { ids[kind] = []; });

    function mapId(kind, sourceId) {
        if (sourceId === null || sourceId === undefined || sourceId === '') return null;
        var key = kind + ':' + sourceId;
        if (!idMap[key]) idMap[key] = derivedId(kind, pid, String(sourceId));
        return idMap[key];
    }

    /** 新建还是更新：按算出来的 id 看库里有没有（有但不属于这个项目，说明撞了 —— 实际不会发生，保险起见跳过） */
    function upsert(kind, next, fields) {
        ids[kind].push(next.id);
        var existing = rows.get(handle, kind, next.id);
        if (existing && rows.projectIdOf(handle, kind, existing) !== pid) return;
        if (!existing) {
            ops.push({ op: 'insert', kind: kind, row: next, label: labelOf(kind, next) });
            counts.added += 1;
            return;
        }
        var patch = Object.assign({}, next);
        (fields && fields.keepOnUpdate || []).forEach(function (col) { delete patch[col]; });
        if (sameContent(kind, existing, patch)) {
            counts.unchanged += 1;
            return;
        }
        ops.push({ op: 'update', kind: kind, id: next.id, row: patch, label: labelOf(kind, next) });
        counts.updated += 1;
    }

    /* 目录：父在前。父目录不在备份里 → 放根目录 */
    var sourceFolders = sortFolders(parsed.folders);
    var folderSourceIds = {};
    sourceFolders.forEach(function (raw) { folderSourceIds[String(raw.id)] = true; });
    sourceFolders.forEach(function (raw) {
        var next = Object.assign({}, raw, {
            id: mapId('folder', raw.id),
            project_id: pid,
            parent_id: raw.parent_id && folderSourceIds[String(raw.parent_id)] ? mapId('folder', raw.parent_id) : null
        });
        delete next.rev;
        var existing = rows.get(handle, 'folder', next.id);
        // 目录变量：只补不改（和环境一样，里面可能是内网地址）
        if (existing) {
            var merged = addMissingVars(existing.variables, raw.variables);
            next.variables = merged.text;
            counts.varsAdded += merged.added;
        }
        // 前置接口指向的接口换成目标项目里的 id（extra 里其余的原样）
        var extra = json.readJson(raw.extra, {});
        if (extra && extra.preflight && extra.preflight.apiId) {
            extra.preflight = Object.assign({}, extra.preflight, { apiId: mapId('api', extra.preflight.apiId) });
            next.extra = JSON.stringify(extra);
        }
        upsert('folder', next, { keepOnUpdate: ['position'] });
    });

    /* 接口 */
    var sourceApis = parsed.apis.slice().sort(function (a, b) { return (Number(a.position) || 0) - (Number(b.position) || 0); });
    var apiSourceIds = {};
    sourceApis.forEach(function (raw) { apiSourceIds[String(raw.id)] = true; });
    var exampleSourceIds = {};
    parsed.examples.forEach(function (raw) { exampleSourceIds[String(raw.id)] = true; });

    sourceApis.forEach(function (raw) {
        var next = Object.assign({}, raw, {
            id: mapId('api', raw.id),
            project_id: pid,
            folder_id: raw.folder_id && folderSourceIds[String(raw.folder_id)] ? mapId('folder', raw.folder_id) : null,
            mock_example_id: raw.mock_example_id && exampleSourceIds[String(raw.mock_example_id)]
                ? mapId('example', raw.mock_example_id) : null
        });
        delete next.rev;
        upsert('api', next, { keepOnUpdate: ['position'] });
    });

    /* 示例、期望 */
    parsed.examples.forEach(function (raw) {
        if (!apiSourceIds[String(raw.api_id)]) return;
        var next = Object.assign({}, raw, { id: mapId('example', raw.id), api_id: mapId('api', raw.api_id) });
        delete next.rev;
        upsert('example', next, { keepOnUpdate: ['position'] });
    });
    parsed.expectations.forEach(function (raw) {
        if (!apiSourceIds[String(raw.api_id)]) return;
        var next = Object.assign({}, raw, {
            id: mapId('expectation', raw.id),
            api_id: mapId('api', raw.api_id),
            example_id: raw.example_id && exampleSourceIds[String(raw.example_id)] ? mapId('example', raw.example_id) : null
        });
        delete next.rev;
        upsert('expectation', next, { keepOnUpdate: ['position'] });
    });

    /* 测试集：步骤里的接口换成目标项目的（parse 已经去掉了指向不存在接口的步骤） */
    parsed.suites.forEach(function (raw) {
        var steps = (Array.isArray(raw.steps) ? raw.steps : json.readJson(raw.steps, [])).map(function (step) {
            return Object.assign({}, step, { apiId: mapId('api', step.apiId) });
        });
        var next = Object.assign({}, raw, { id: mapId('suite', raw.id), project_id: pid, steps: JSON.stringify(steps) });
        delete next.rev;
        upsert('suite', next, { keepOnUpdate: ['position'] });
    });

    /* 环境：只补不改。先按算出来的 id 认，再按名字认（外网自己建的同名环境），都没有才新建 */
    var targetEnvs = rows.list(handle, 'environment', pid);
    parsed.environments.forEach(function (raw) {
        var id = mapId('environment', raw.id);
        ids.environment.push(id);
        var existing = targetEnvs.filter(function (env) { return env.id === id; })[0] ||
            targetEnvs.filter(function (env) { return env.name === raw.name; })[0];
        if (!existing) {
            var next = Object.assign({}, raw, { id: id, project_id: pid });
            delete next.rev;
            ops.push({ op: 'insert', kind: 'environment', row: next, label: raw.name || '' });
            counts.added += 1;
            return;
        }
        var merged = addMissingVars(existing.variables, raw.variables);
        if (merged.added) {
            ops.push({ op: 'update', kind: 'environment', id: existing.id, row: { variables: merged.text }, label: existing.name });
            counts.varsAdded += merged.added;
        } else {
            counts.unchanged += 1;
        }
    });

    /* 项目变量：只补不改 */
    var projectRow = rows.get(handle, 'project', pid);
    var projectVars = addMissingVars(projectRow.variables, parsed.project.variables);
    if (projectVars.added) counts.varsAdded += projectVars.added;

    /* 内网删掉的：上次从这个来源导进来、这次文件里没有了、库里还在的 */
    var extra = json.readJson(projectRow.extra, {}) || {};
    var previous = (extra.importSources && extra.importSources[sourceKey] && extra.importSources[sourceKey].ids) || {};
    var removable = [];
    ['api', 'folder', 'example', 'expectation', 'suite'].forEach(function (kind) {
        var now = {};
        ids[kind].forEach(function (id) { now[id] = true; });
        (previous[kind] || []).forEach(function (id) {
            if (now[id]) return;
            var row = rows.get(handle, kind, id);
            if (!row || rows.projectIdOf(handle, kind, row) !== pid) return;
            removable.push({ kind: kind, id: id, name: labelOf(kind, row) });
        });
    });

    return {
        ops: ops,
        counts: counts,
        removable: removable,
        sourceKey: sourceKey,
        ids: ids,
        projectVars: projectVars,
        extra: extra
    };
}

/* ------------------------------------------------------------------ 执行 */

function apply(handle, project, parsed, planned, options) {
    var wanted = {};
    (options.remove || []).forEach(function (id) { wanted[String(id)] = true; });
    var removed = 0;

    planned.ops.forEach(function (item) {
        if (item.op === 'insert') {
            var row = Object.assign({}, item.row);
            if (item.kind === 'folder') row.position = foldersRepo.nextPositionIn(handle, project.id, row.parent_id || null);
            else if (item.kind === 'api') row.position = apisRepo.nextPositionIn(handle, project.id, row.folder_id || null);
            else if (item.kind === 'environment') row.position = environmentsRepo.nextPosition(handle, project.id);
            else if (item.kind === 'suite') row.position = suitesRepo.nextPosition(handle, project.id);
            rows.insert(handle, item.kind, row, { actorId: options.user && options.user.id });
        } else {
            var patch = Object.assign({}, item.row);
            // 换了目录的：排到新目录的最后
            if (item.kind === 'api') {
                var current = rows.get(handle, 'api', item.id);
                if (current && (current.folder_id || null) !== (patch.folder_id || null)) {
                    patch.position = apisRepo.nextPositionIn(handle, project.id, patch.folder_id || null);
                }
            } else if (item.kind === 'folder') {
                var currentFolder = rows.get(handle, 'folder', item.id);
                if (currentFolder && (currentFolder.parent_id || null) !== (patch.parent_id || null)) {
                    patch.position = foldersRepo.nextPositionIn(handle, project.id, patch.parent_id || null);
                }
            }
            rows.update(handle, item.kind, item.id, patch);
        }
    });

    /* 内网删掉的：只删勾了的。接口进回收站；目录只在空了的时候删（还有别的东西就留着） */
    var order = { expectation: 0, example: 1, suite: 2, api: 3, folder: 4 };
    planned.removable.slice().sort(function (a, b) { return order[a.kind] - order[b.kind]; }).forEach(function (item) {
        if (!wanted[item.id]) return;
        if (item.kind === 'api') {
            var api = apisRepo.get(handle, item.id);
            if (!api) return;
            trash.captureApi(handle, api, options.user || null);
            apisRepo.remove(handle, item.id);
        } else if (item.kind === 'folder') {
            var hasChild = foldersRepo.list(handle, project.id).some(function (f) { return f.parentId === item.id; }) ||
                apisRepo.list(handle, project.id).some(function (a) { return a.folderId === item.id; });
            if (hasChild) return;
            rows.remove(handle, 'folder', item.id);
        } else {
            rows.remove(handle, item.kind, item.id);
        }
        removed += 1;
    });

    /* 项目：补变量 + 记下这次从这个来源导进来的 id（下次比出「内网删掉的」） */
    var extra = planned.extra;
    var sources = Object.assign({}, extra.importSources || {});
    var keptPrevious = {};
    // 这次没删、库里还在的旧 id 也留着，下次还能再提示
    var previous = (sources[planned.sourceKey] && sources[planned.sourceKey].ids) || {};
    KINDS.forEach(function (kind) {
        var set = {};
        planned.ids[kind].forEach(function (id) { set[id] = true; });
        (previous[kind] || []).forEach(function (id) {
            if (set[id]) return;
            var row = rows.get(handle, kind, id);
            if (row) set[id] = true;
        });
        keptPrevious[kind] = Object.keys(set);
    });
    sources[planned.sourceKey] = {
        name: String(parsed.project.name || ''),
        at: Date.now(),
        ids: keptPrevious
    };
    var projectPatch = { extra: JSON.stringify(Object.assign({}, extra, { importSources: sources })) };
    if (planned.projectVars.added) projectPatch.variables = planned.projectVars.text;
    rows.update(handle, 'project', project.id, projectPatch);

    return removed;
}

/**
 * 合并导入。
 *
 * @param {object} input `{ parsed, projectId?, name?, user, preview?, remove? }`
 *   - 没有 projectId：先建一个空项目（名字用 name 或备份里的项目名），再合并进去 —— 第一次导入用；
 *   - `preview: true`：只算不写，返回计数和「内网已删除」的列表；
 *   - `remove`：要删的那些（预览返回的 id）。
 */
function merge(handle, input) {
    var parsed = input.parsed;
    var user = input.user || null;

    if (input.projectId) {
        var project = projectsRepo.getById(handle, input.projectId);
        if (!project) throw apiError(404, i18n.m('项目不存在：{id}', { id: String(input.projectId) }));
        var role = access.roleOf(handle, user, project.id);
        if (!access.atLeast(role, 'editor')) throw apiError(403, i18n.m('合并导入需要这个项目的编辑权限'));

        if (input.preview) {
            var planned = plan(handle, project, parsed);
            return { project: project, counts: planned.counts, removable: planned.removable, warnings: parsed.warnings };
        }

        var outcome = handle.transaction(function () {
            var p = plan(handle, project, parsed);
            var removed = apply(handle, project, parsed, p, { user: user, remove: input.remove });
            return { counts: Object.assign({}, p.counts, { removed: removed }), removable: p.removable };
        }, { projectId: project.id });

        return {
            project: projectsRepo.getById(handle, project.id),
            counts: outcome.counts,
            warnings: parsed.warnings
        };
    }

    // 第一次：建一个空项目再合并。预览时没有项目可比，全是新增
    if (input.preview) {
        var total = parsed.folders.length + parsed.apis.length + parsed.examples.length +
            parsed.expectations.length + parsed.suites.length + parsed.environments.length;
        return { project: null, counts: { added: total, updated: 0, unchanged: 0, varsAdded: 0 }, removable: [], warnings: parsed.warnings };
    }

    var created = handle.transaction(function () {
        var fresh = clone.createProjectWithContent(handle, {
            name: String(input.name || '').trim() || String(parsed.project.name || '').trim() || i18n.m('恢复的项目'),
            description: String(parsed.project.description || ''),
            variables: json.readJson(parsed.project.variables, []),
            auth: json.readJson(parsed.project.auth, null),
            scripts: json.readJson(parsed.project.scripts, []),
            extra: json.readJson(parsed.project.extra, {}),
            ownerId: user && user.id,
            payload: { folder: [], api: [], example: [], expectation: [] },
            environments: [],
            suites: []
        });
        var p = plan(handle, fresh, parsed);
        apply(handle, fresh, parsed, p, { user: user, remove: [] });
        return { project: fresh, counts: p.counts };
    }, { projectId: null });

    return {
        project: projectsRepo.getById(handle, created.project.id),
        counts: created.counts,
        warnings: parsed.warnings
    };
}

module.exports = {
    merge: merge,
    derivedId: derivedId
};
