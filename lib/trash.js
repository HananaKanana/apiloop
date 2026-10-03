/**
 * 回收站业务逻辑（第三轮第 1 节，设计见 docs/plans/2026-10-03-round3.md）。
 *
 * **这里的函数一律不开事务**，由调用方（lib/api/tree.js、lib/api/environments.js、
 * lib/api/trash.js）负责包 `handle.transaction` —— 和 lib/tree.js 同一个规矩。
 *
 * 两件事：
 *
 *   - `capture*`：删东西之前，把**真正会被删掉的那些原始行**整包存进回收站。原始行就是
 *     同步用的那种格式（下划线列名、JSON 列保持字符串），用 `lib/sync/rows.js` 的
 *     get / list 取。必须和删除动作在**同一个事务**里，否则出现「删除成功但没记回收站」。
 *   - `restore`：按 payload 重新插回去。**换新 id**：老 id 已经在同步流水里标成删除，
 *     原样插回去会和各端的同步基线打架；换新 id 就是一次普通的新建。payload 内部的引用
 *     （parent_id / folder_id / api_id / mock_example_id / example_id）跟着改成新 id。
 *
 * 恢复位置：原来的父目录还在就放回去，否则放到项目根目录；position 放到同级最后。
 */

var rows = require('./sync/rows');
var foldersRepo = require('./db/repos/folders');
var apisRepo = require('./db/repos/apis');
var environmentsRepo = require('./db/repos/environments');
var trashRepo = require('./db/repos/trash');
var tree = require('./tree');
var helpers = require('./db/repos/helpers');

var apiError = require('./api/respond').apiError;

/** 回收站保留天数。和变更流水一个口径（30 天），见 lib/sync/purge.js */
var RETENTION_DAYS = 30;

/* ------------------------------------------------------------------ 位置文字 */

/** 目录链的名字（从根到该目录，含自己）。找不到的目录跳过 */
function folderChain(handle, folderId) {
    var names = [];
    var seen = {};
    var current = folderId ? foldersRepo.get(handle, folderId) : null;

    while (current && !seen[current.id]) {
        seen[current.id] = true;
        names.unshift(current.name || '');
        current = current.parentId ? foldersRepo.get(handle, current.parentId) : null;
    }
    return names;
}

/** 「删除时所在位置」的文字：目录链拼成「父 / 子」，没有目录就是「根目录」 */
function folderLocation(handle, folderId) {
    var names = folderChain(handle, folderId);
    return names.length ? names.join(' / ') : '根目录';
}

/* ------------------------------------------------------------------ 捕获 */

/** 按深度给一批目录 id 排序（父在前），让恢复时能按顺序插 */
function orderFoldersByDepth(handle, ids) {
    var known = {};
    ids.forEach(function (id) { known[id] = true; });

    var depthCache = {};
    function depth(id, guard) {
        if (depthCache[id] !== undefined) return depthCache[id];
        if (guard[id]) return 0;
        guard[id] = true;

        var folder = foldersRepo.get(handle, id);
        var parentId = folder ? folder.parentId : null;
        var value = parentId && known[parentId] ? depth(parentId, guard) + 1 : 0;

        depthCache[id] = value;
        return value;
    }

    return ids.slice().sort(function (a, b) {
        var diff = depth(a, {}) - depth(b, {});
        if (diff !== 0) return diff;
        return 0;
    });
}

function rawFolder(handle, id) { return rows.get(handle, 'folder', id); }
function rawApi(handle, id) { return rows.get(handle, 'api', id); }

/**
 * 删目录之前记回收站。
 *
 * @param {object} folder foldersRepo.get 的结果
 * @param {'move'|'delete'} mode move 只有这一个目录行；delete 连整棵子树
 * @param {object|null} user req.user（记 `deleted_by`）
 */
function captureFolder(handle, folder, mode, user) {
    var payload = { folder: [], api: [], example: [], expectation: [] };

    var folderIds = [folder.id];
    if (mode === 'delete') {
        tree.descendants(handle, folder.projectId, folder.id).forEach(function (child) {
            folderIds.push(child.id);
        });
    }

    orderFoldersByDepth(handle, folderIds).forEach(function (id) {
        var row = rawFolder(handle, id);
        if (row) payload.folder.push(row);
    });

    if (mode === 'delete') {
        var folderSet = {};
        folderIds.forEach(function (id) { folderSet[id] = true; });

        var apiSet = {};
        rows.list(handle, 'api', folder.projectId).forEach(function (api) {
            if (!folderSet[api.folder_id]) return;
            payload.api.push(api);
            apiSet[api.id] = true;
        });
        rows.list(handle, 'example', folder.projectId).forEach(function (example) {
            if (apiSet[example.api_id]) payload.example.push(example);
        });
        rows.list(handle, 'expectation', folder.projectId).forEach(function (expectation) {
            if (apiSet[expectation.api_id]) payload.expectation.push(expectation);
        });
    }

    return trashRepo.insert(handle, folder.projectId, {
        kind: 'folder',
        name: folder.name,
        location: folderLocation(handle, folder.id),
        payload: payload,
        deletedBy: user && user.id,
        deletedAt: Date.now()
    });
}

/** 删接口之前记回收站：接口行 + 它的示例 + 期望 */
function captureApi(handle, api, user) {
    var payload = { api: [], example: [], expectation: [] };

    var row = rawApi(handle, api.id);
    if (row) payload.api.push(row);

    rows.list(handle, 'example', api.projectId).forEach(function (example) {
        if (example.api_id === api.id) payload.example.push(example);
    });
    rows.list(handle, 'expectation', api.projectId).forEach(function (expectation) {
        if (expectation.api_id === api.id) payload.expectation.push(expectation);
    });

    return trashRepo.insert(handle, api.projectId, {
        kind: 'api',
        name: api.name,
        location: folderLocation(handle, api.folderId),
        payload: payload,
        deletedBy: user && user.id,
        deletedAt: Date.now()
    });
}

/** 删环境之前记回收站：就环境那一行 */
function captureEnvironment(handle, environment, user) {
    var payload = { environment: [] };

    var row = rows.get(handle, 'environment', environment.id);
    if (row) payload.environment.push(row);

    return trashRepo.insert(handle, environment.projectId, {
        kind: 'environment',
        name: environment.name,
        location: '环境',
        payload: payload,
        deletedBy: user && user.id,
        deletedAt: Date.now()
    });
}

/* ------------------------------------------------------------------ 恢复 */

/**
 * 恢复一条回收站记录。
 *
 * @returns {{restoredTo: string, folderId?: string, apiId?: string, environmentId?: string}}
 */
function restore(handle, item) {
    var payload = item.payload || {};

    if (item.kind === 'environment') return restoreEnvironment(handle, item, payload);
    if (item.kind === 'folder' || item.kind === 'api') return restoreNodes(handle, item, payload);

    throw apiError(400, '回收站里的数据类型不认识，无法恢复');
}

function restoreEnvironment(handle, item, payload) {
    var raw = (payload.environment || [])[0];
    if (!raw) throw apiError(400, '回收站里的数据已损坏，无法恢复');

    var name = String(raw.name || item.name || '');
    var taken = environmentsRepo.list(handle, item.projectId).some(function (environment) {
        return environment.name === name;
    });

    var row = Object.assign({}, raw, {
        id: helpers.newId('env'),
        name: taken ? name + '（恢复）' : name,
        position: environmentsRepo.nextPosition(handle, item.projectId)
    });
    rows.insert(handle, 'environment', row);

    trashRepo.remove(handle, item.id);
    return { restoredTo: '环境', environmentId: row.id };
}

/** 目录 / 接口的恢复：按 payload 里的原始行重新插，换新 id、改内部引用 */
function restoreNodes(handle, item, payload) {
    var projectId = item.projectId;
    var idMap = {};

    /*
     * 目录：父在前（子目录插入时父目录已经在了，外键），同一层按原来的 position。
     * 插入时 position 一律「放到同级最后」，所以必须按原顺序插，否则恢复出来同级顺序是乱的。
     */
    var folderRows = sortByDepthThenPosition(payload.folder || []);
    var topFolder = null;
    folderRows.forEach(function (raw) {
        var oldId = String(raw.id);
        var parentId = raw.parent_id || null;

        var next = Object.assign({}, raw);
        next.id = helpers.newId('f');
        next.parent_id = parentId && idMap[parentId]
            ? idMap[parentId]
            : (parentId && foldersRepo.get(handle, parentId) ? parentId : null);
        next.position = foldersRepo.nextPositionIn(handle, projectId, next.parent_id);

        rows.insert(handle, 'folder', next);
        idMap[oldId] = next.id;
        if (!topFolder) topFolder = next;
    });

    /* 接口：挂回原目录（没了就根目录），mock 示例 id 等示例插完再补 */
    // payload 里的接口是按 rowid 取的，不是目录里的顺序；同理按原 position 插
    var apiRows = (payload.api || []).slice().sort(function (a, b) {
        return (Number(a.position) || 0) - (Number(b.position) || 0);
    });
    var topApi = null;
    var mockFix = [];
    apiRows.forEach(function (raw) {
        var oldId = String(raw.id);
        var folderId = raw.folder_id || null;

        var next = Object.assign({}, raw);
        next.id = helpers.newId('a');
        next.folder_id = folderId && idMap[folderId]
            ? idMap[folderId]
            : (folderId && foldersRepo.get(handle, folderId) ? folderId : null);
        next.position = apisRepo.nextPositionIn(handle, projectId, next.folder_id);
        // 指向的示例马上要换成新 id，先置空，等示例插完再补
        next.mock_example_id = null;

        rows.insert(handle, 'api', next);
        idMap[oldId] = next.id;
        if (!topApi) topApi = next;
        if (raw.mock_example_id) mockFix.push({ apiId: next.id, oldExampleId: String(raw.mock_example_id) });
    });

    /* 示例：挂在恢复出来的接口上 */
    var exampleMap = {};
    (payload.example || []).forEach(function (raw) {
        var apiOldId = String(raw.api_id);
        if (!idMap[apiOldId]) return;

        var next = Object.assign({}, raw, { id: helpers.newId('e'), api_id: idMap[apiOldId] });
        rows.insert(handle, 'example', next);
        exampleMap[String(raw.id)] = next.id;
    });

    /* 期望：接口和示例都换新 id */
    (payload.expectation || []).forEach(function (raw) {
        var apiOldId = String(raw.api_id);
        if (!idMap[apiOldId]) return;

        var next = Object.assign({}, raw, {
            id: helpers.newId('x'),
            api_id: idMap[apiOldId],
            example_id: raw.example_id && exampleMap[String(raw.example_id)]
                ? exampleMap[String(raw.example_id)]
                : null
        });
        rows.insert(handle, 'expectation', next);
    });

    /* 补回 mock 指向的示例 */
    mockFix.forEach(function (fix) {
        var newExampleId = exampleMap[fix.oldExampleId];
        if (newExampleId) rows.update(handle, 'api', fix.apiId, { mock_example_id: newExampleId });
    });

    trashRepo.remove(handle, item.id);

    var result = {};
    if (item.kind === 'folder') {
        result.restoredTo = folderLocation(handle, topFolder ? topFolder.parent_id : null);
        result.folderId = topFolder ? topFolder.id : null;
    } else {
        result.restoredTo = folderLocation(handle, topApi ? topApi.folder_id : null);
        result.apiId = topApi ? topApi.id : null;
    }
    return result;
}

/** payload 里的目录行：按「在 payload 里的深度」、再按原 position 排 */
function sortByDepthThenPosition(folderRows) {
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
        var diff = depth(a) - depth(b);
        if (diff !== 0) return diff;
        return (Number(a.position) || 0) - (Number(b.position) || 0);
    });
}

/* ------------------------------------------------------------------ 清理 */

/**
 * 删掉超过保留期的回收站记录，返回删了几条。
 *
 * 云端在定时清理变更流水时一起跑（lib/command.js）；未绑定的本机空间没有云端，
 * 在网关启动时清一次。删除本身会走 trash 的触发器记一条流水，所以清完会同步给别的设备。
 */
function purgeTrash(handle, now) {
    var moment = Number(now);
    if (!Number.isFinite(moment)) moment = Date.now();

    var cutoff = moment - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    var result = handle.db.prepare('DELETE FROM trash WHERE deleted_at < ?').run(cutoff);
    return Number(result && result.changes) || 0;
}

module.exports = {
    RETENTION_DAYS: RETENTION_DAYS,
    folderLocation: folderLocation,
    captureFolder: captureFolder,
    captureApi: captureApi,
    captureEnvironment: captureEnvironment,
    restore: restore,
    purgeTrash: purgeTrash
};
