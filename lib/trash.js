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
 * 收集一个目录（连同子树）的原始行。**不写回收站** —— 回收站的 `captureFolder`
 * 和跨项目复制（第六轮第 3 节）都用它。
 *
 * @param {'move'|'delete'} mode move 只有这一个目录行；delete 连整棵子树
 */
function collectFolder(handle, folder, mode) {
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

    return payload;
}

/** 收集一个接口的原始行：接口行 + 它的示例 + 期望。**不写回收站** */
function collectApi(handle, api) {
    var payload = { api: [], example: [], expectation: [] };

    var row = rawApi(handle, api.id);
    if (row) payload.api.push(row);

    rows.list(handle, 'example', api.projectId).forEach(function (example) {
        if (example.api_id === api.id) payload.example.push(example);
    });
    rows.list(handle, 'expectation', api.projectId).forEach(function (expectation) {
        if (expectation.api_id === api.id) payload.expectation.push(expectation);
    });

    return payload;
}

/**
 * 收集**整个项目**的目录 / 接口 / 示例 / 期望（第六轮第 3 节的「复制为新项目」用）。
 *
 * 和上面两个一样是「原始行」的形状，所以能用同一个 `insertPayload` 插到新项目里。
 * 项目本身的变量 / 公共请求头 / 鉴权 / 脚本不在这里 —— 那些是 projects 表上的字段，
 * 建新项目时直接带过去。
 */
function collectAll(handle, projectId) {
    var payload = { folder: [], api: [], example: [], expectation: [] };

    foldersRepo.list(handle, projectId).forEach(function (folder) {
        var row = rawFolder(handle, folder.id);
        if (row) payload.folder.push(row);
    });

    var apiSet = {};
    rows.list(handle, 'api', projectId).forEach(function (api) {
        payload.api.push(api);
        apiSet[api.id] = true;
    });
    rows.list(handle, 'example', projectId).forEach(function (example) {
        if (apiSet[example.api_id]) payload.example.push(example);
    });
    rows.list(handle, 'expectation', projectId).forEach(function (expectation) {
        if (apiSet[expectation.api_id]) payload.expectation.push(expectation);
    });

    return payload;
}

/** 收集环境行（复制为新项目用）。环境不在 `insertPayload` 管的四种实体里，单独插 */
function collectEnvironments(handle, projectId) {
    return environmentsRepo.list(handle, projectId).map(function (environment) {
        return rows.get(handle, 'environment', environment.id);
    }).filter(function (row) { return Boolean(row); });
}

/** 把环境行插到某个项目下（换新 id、position 按顺序重排） */
function insertEnvironments(handle, projectId, rawRows) {
    var ids = [];

    (rawRows || []).forEach(function (raw) {
        var next = Object.assign({}, raw, {
            id: helpers.newId('env'),
            project_id: projectId,
            position: environmentsRepo.nextPosition(handle, projectId)
        });
        rows.insert(handle, 'environment', next);
        ids.push(next.id);
    });

    return ids;
}

/**
 * 删目录之前记回收站。
 *
 * @param {object} folder foldersRepo.get 的结果
 * @param {'move'|'delete'} mode move 只有这一个目录行；delete 连整棵子树
 * @param {object|null} user req.user（记 `deleted_by`）
 */
function captureFolder(handle, folder, mode, user) {
    return trashRepo.insert(handle, folder.projectId, {
        kind: 'folder',
        name: folder.name,
        location: folderLocation(handle, folder.id),
        payload: collectFolder(handle, folder, mode),
        deletedBy: user && user.id,
        deletedAt: Date.now()
    });
}

/** 删接口之前记回收站：接口行 + 它的示例 + 期望 */
function captureApi(handle, api, user) {
    return trashRepo.insert(handle, api.projectId, {
        kind: 'api',
        name: api.name,
        location: folderLocation(handle, api.folderId),
        payload: collectApi(handle, api),
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

/**
 * 把一批原始行插到某个项目 / 某个目录下：**换新 id、改内部引用**。
 *
 * 回收站恢复和跨项目复制（第六轮第 3 节）共用这一份：
 *   - **恢复**：`projectId` 是原项目、**不传 `targetFolderId`** —— 顶层节点放回原来的父目录
 *     （父目录已经不在了就放项目根目录）；
 *   - **跨项目复制**：`projectId` 是目标项目、传 `targetFolderId`（null = 目标项目的根目录）——
 *     顶层节点放到那个目录下，payload 里所有行的 `project_id` 换成目标项目。
 *
 * 两种情况 position 都是「放到同级最后」；payload 内部的顺序（目录按深度、接口按原 position）
 * 决定了它们的相对顺序，所以按顺序插就不会乱。
 *
 * @param {{projectId: string, targetFolderId?: string|null}} options
 * @returns {{folderId: string|null, apiId: string|null, folders: Array, apis: Array}}
 */
function insertPayload(handle, payload, options) {
    var projectId = options.projectId;
    var useTarget = Object.prototype.hasOwnProperty.call(options, 'targetFolderId');
    var targetFolderId = options.targetFolderId || null;
    var idMap = {};

    /* 目录：父在前（子目录插入时父目录已经在了，外键），同一层按原来的 position */
    var folderRows = sortByDepthThenPosition((payload && payload.folder) || []);
    var insertedFolders = [];

    folderRows.forEach(function (raw) {
        var oldId = String(raw.id);
        var parentId = raw.parent_id || null;

        var next = Object.assign({}, raw);
        next.id = helpers.newId('f');
        // 跨项目复制时这一行要归到目标项目下（恢复时本来就是同一个项目，等于没改）
        next.project_id = projectId;

        if (parentId && idMap[parentId]) {
            next.parent_id = idMap[parentId];
        } else if (useTarget) {
            next.parent_id = targetFolderId;
        } else {
            next.parent_id = parentId && foldersRepo.get(handle, parentId) ? parentId : null;
        }

        next.position = foldersRepo.nextPositionIn(handle, projectId, next.parent_id);

        rows.insert(handle, 'folder', next);
        idMap[oldId] = next.id;
        insertedFolders.push(next);
    });

    /* 接口：挂回原目录（没了就根目录 / 目标目录），mock 示例 id 等示例插完再补 */
    var apiRows = ((payload && payload.api) || []).slice().sort(function (a, b) {
        return (Number(a.position) || 0) - (Number(b.position) || 0);
    });
    var insertedApis = [];
    var mockFix = [];

    apiRows.forEach(function (raw) {
        var oldId = String(raw.id);
        var folderId = raw.folder_id || null;

        var next = Object.assign({}, raw);
        next.id = helpers.newId('a');
        next.project_id = projectId;

        if (folderId && idMap[folderId]) {
            next.folder_id = idMap[folderId];
        } else if (useTarget) {
            next.folder_id = targetFolderId;
        } else {
            next.folder_id = folderId && foldersRepo.get(handle, folderId) ? folderId : null;
        }

        next.position = apisRepo.nextPositionIn(handle, projectId, next.folder_id);
        // 指向的示例马上要换成新 id，先置空，等示例插完再补
        next.mock_example_id = null;

        rows.insert(handle, 'api', next);
        idMap[oldId] = next.id;
        insertedApis.push(next);
        if (raw.mock_example_id) mockFix.push({ apiId: next.id, oldExampleId: String(raw.mock_example_id) });
    });

    /* 示例：挂在插出来的接口上 */
    var exampleMap = {};
    ((payload && payload.example) || []).forEach(function (raw) {
        var apiOldId = String(raw.api_id);
        if (!idMap[apiOldId]) return;

        var next = Object.assign({}, raw, { id: helpers.newId('e'), api_id: idMap[apiOldId] });
        rows.insert(handle, 'example', next);
        exampleMap[String(raw.id)] = next.id;
    });

    /* 期望：接口和示例都换新 id */
    ((payload && payload.expectation) || []).forEach(function (raw) {
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

    return {
        folderId: insertedFolders.length ? insertedFolders[0].id : null,
        apiId: insertedApis.length ? insertedApis[0].id : null,
        folders: insertedFolders,
        apis: insertedApis,
        /**
         * 老 id → 新 id（第六轮第 3 节的「复制为新项目」要用：测试集的步骤引用的是
         * `apiId`，复制完得换成新项目里那些接口的 id）。恢复那边用不到，但白拿着。
         */
        idMap: idMap
    };
}

/** 目录 / 接口的恢复：按 payload 里的原始行重新插（换新 id、改内部引用） */
function restoreNodes(handle, item, payload) {
    var inserted = insertPayload(handle, payload, { projectId: item.projectId });

    trashRepo.remove(handle, item.id);

    var result = {};
    if (item.kind === 'folder') {
        var topFolder = inserted.folders[0];
        result.restoredTo = folderLocation(handle, topFolder ? topFolder.parent_id : null);
        result.folderId = inserted.folderId;
    } else {
        var topApi = inserted.apis[0];
        result.restoredTo = folderLocation(handle, topApi ? topApi.folder_id : null);
        result.apiId = inserted.apiId;
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
    // 收集原始行（不写回收站）：回收站和跨项目复制共用
    collectFolder: collectFolder,
    collectApi: collectApi,
    collectAll: collectAll,
    collectEnvironments: collectEnvironments,
    // 换新 id 插到指定项目 / 目录下：回收站恢复和跨项目复制共用
    insertPayload: insertPayload,
    insertEnvironments: insertEnvironments,
    captureFolder: captureFolder,
    captureApi: captureApi,
    captureEnvironment: captureEnvironment,
    restore: restore,
    purgeTrash: purgeTrash
};
