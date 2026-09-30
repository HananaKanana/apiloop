/**
 * 目录树业务逻辑：移动、删除目录、复制接口、树的读取。
 *
 * **这里的函数一律不开事务**，由调用方（lib/api/tree.js）负责包 handle.transaction。
 * 理由和 routes-store 里的 insertRoutes 一样：一个业务动作可能由好几步组成，
 * 而 handle 不支持嵌套事务，谁来起事务必须只有一个。
 *
 * 一个贯穿全文件的约定：**position 只在同一个父目录内部有意义**。
 * 所以凡是跟顺序有关的操作都走「同级」这套函数（listChildren / setPositionsIn），
 * 不要拿 repo 的 list() 全项目结果当同级用 —— 那会把嵌套目录的顺序打乱。
 */

var foldersRepo = require('./db/repos/folders');
var apisRepo = require('./db/repos/apis');
var examplesRepo = require('./db/repos/examples');

// 校验失败是 400、找不到是 404，状态码是业务的一部分，
// 所以直接用 api 层的 apiError 造，免得在两个地方各定义一套。
var apiError = require('./api/respond').apiError;

/* ------------------------------------------------------------------ 同级 */

function folderIds(handle, projectId, parentId) {
    return foldersRepo.listChildren(handle, projectId, parentId).map(function (folder) {
        return folder.id;
    });
}

function apiIds(handle, projectId, folderId) {
    return apisRepo.listChildren(handle, projectId, folderId).map(function (api) {
        return api.id;
    });
}

/**
 * 把 id 放到列表的第 index 位。已经在列表里就先摘掉再插 --
 * 这正是「移动到第 index 位」的语义：先抽出来，再插进去。
 * index 不是有效数字、或者超出范围，都放到末尾。
 */
function insertAt(list, id, index) {
    var next = list.filter(function (item) { return item !== id; });
    var at = next.length;

    if (index !== undefined && index !== null && index !== '' && Number.isFinite(Number(index))) {
        at = Math.max(0, Math.min(next.length, Math.floor(Number(index))));
    }

    next.splice(at, 0, id);
    return next;
}

/* ------------------------------------------------------------------ 查询 */

/**
 * 从近到远列出祖先目录（不含自己）。
 * 供移动时的环检测，以及 Task 4 的鉴权继承使用。
 */
function ancestors(handle, folderId) {
    var result = [];
    var seen = {};
    var current = foldersRepo.get(handle, folderId);

    while (current && current.parentId && !seen[current.parentId]) {
        seen[current.parentId] = true;

        var parent = foldersRepo.get(handle, current.parentId);
        if (!parent) break;

        result.push(parent);
        current = parent;
    }
    return result;
}

/** 所有子孙目录（不含自己），用于「递归删除」和环检测 */
function descendants(handle, projectId, folderId) {
    var childrenOf = {};
    foldersRepo.list(handle, projectId).forEach(function (folder) {
        var key = folder.parentId || '';
        if (!childrenOf[key]) childrenOf[key] = [];
        childrenOf[key].push(folder);
    });

    var result = [];
    (function walk(id) {
        (childrenOf[id] || []).forEach(function (child) {
            result.push(child);
            walk(child.id);
        });
    })(folderId);

    return result;
}

/** 按 id 或 slug 之外的方式取项目下的节点，顺便把「不属于本项目」也挡掉 */
function mustFolder(handle, projectId, folderId, message) {
    if (!folderId) return null;
    var folder = foldersRepo.get(handle, folderId);
    if (!folder || folder.projectId !== projectId) {
        throw apiError(400, message || '目标目录不存在或不属于这个项目');
    }
    return folder;
}

/**
 * 整棵树。两个扁平列表，各自按「同一父节点内 position 升序」排好，
 * 顶层（parentId 为 null）在最前 —— 前端照着这个顺序塞进树里即可。
 *
 * 这里返回的是 repo 行对象，转 DTO 由路由层做。
 */
function listTree(handle, projectId) {
    function compare(parentKey) {
        return function (a, b) {
            var pa = a[parentKey] || '';
            var pb = b[parentKey] || '';
            if (pa !== pb) return pa < pb ? -1 : 1;
            if (a.position !== b.position) return a.position - b.position;
            return 0;
        };
    }

    return {
        folders: foldersRepo.list(handle, projectId).sort(compare('parentId')),
        apis: apisRepo.list(handle, projectId).sort(compare('folderId'))
    };
}

/* ------------------------------------------------------------------ 摆放 */

/**
 * 把一个目录放到 parentId 下的第 index 位，并重排涉及的父目录。
 * 不做合法性校验（环、跨项目），那是 move 的事。
 */
function placeFolder(handle, projectId, folderId, parentId, index) {
    var folder = foldersRepo.get(handle, folderId);
    var from = folder.parentId;

    foldersRepo.update(handle, folderId, { parentId: parentId || null });

    var ordered = insertAt(folderIds(handle, projectId, parentId || null), folderId, index);
    foldersRepo.setPositionsIn(handle, ordered);

    // 跨父目录移动时，原父目录也得重排，否则会留下一个 position 空洞
    if (from !== (parentId || null)) {
        foldersRepo.setPositionsIn(handle, folderIds(handle, projectId, from));
    }

    return ordered;
}

/** 同上，接口版 */
function placeApi(handle, projectId, apiId, folderId, index) {
    var api = apisRepo.get(handle, apiId);
    var from = api.folderId;

    apisRepo.update(handle, apiId, { folderId: folderId || null });

    var ordered = insertAt(apiIds(handle, projectId, folderId || null), apiId, index);
    apisRepo.setPositionsIn(handle, ordered);

    if (from !== (folderId || null)) {
        apisRepo.setPositionsIn(handle, apiIds(handle, projectId, from));
    }

    return ordered;
}

/**
 * 移动节点。校验都在这里做，通过之后交给 place*。
 *
 * 目录的环检测：从目标父目录沿着祖先往上找，**碰到被移动的目录自己就拒绝**。
 * 只检查「目标不是自己」是不够的 —— 把目录拖进自己的孙子里同样会把这一支从树上切掉，
 * 变成一个谁都找不到的环。
 */
function move(handle, projectId, options) {
    var options2 = options || {};
    var kind = options2.kind;
    var id = options2.id;
    var parentId = options2.parentId || null;

    if (kind !== 'folder' && kind !== 'api') {
        throw apiError(400, 'kind 只能是 folder 或 api');
    }

    if (kind === 'folder') {
        var folder = foldersRepo.get(handle, id);
        if (!folder || folder.projectId !== projectId) throw apiError(404, '目录不存在：' + id);
        if (parentId === id) throw apiError(400, '不能把目录移动到它自己下面');

        mustFolder(handle, projectId, parentId);

        var chain = ancestors(handle, parentId);
        var cyclic = chain.some(function (item) { return item.id === id; });
        if (cyclic) throw apiError(400, '不能把目录移动到它的子目录下面');

        return placeFolder(handle, projectId, id, parentId, options2.index);
    }

    var api = apisRepo.get(handle, id);
    if (!api || api.projectId !== projectId) throw apiError(404, '接口不存在：' + id);

    mustFolder(handle, projectId, parentId);

    return placeApi(handle, projectId, id, parentId, options2.index);
}

/* ------------------------------------------------------------------ 删除目录 */

/**
 * 删除目录。
 *
 * - `move`（默认）：直接子目录和直接子接口挂到父目录下，**保留它们原有的相对顺序**，
 *   并排在父目录已有同类节点之后，然后删掉这个目录。
 * - `delete`：连子孙一起删。接口必须**先删**：folders 的 parent_id 是 ON DELETE CASCADE，
 *   但 apis.folder_id 是 ON DELETE SET NULL，不先删的话那些接口会变成游离在
 *   根目录下的孤儿 —— 目录没了，接口还在，还挺难解释。
 */
function removeFolder(handle, folderId, mode) {
    var folder = foldersRepo.get(handle, folderId);
    if (!folder) throw apiError(404, '目录不存在：' + folderId);

    var projectId = folder.projectId;
    var parentId = folder.parentId;

    if (mode === 'delete') {
        var targets = [folder.id].concat(descendants(handle, projectId, folderId).map(function (item) {
            return item.id;
        }));
        targets.forEach(function (targetId) { apisRepo.removeByFolder(handle, targetId); });

        foldersRepo.remove(handle, folderId);
        foldersRepo.setPositionsIn(handle, folderIds(handle, projectId, parentId));
        return { mode: 'delete', removed: targets.length };
    }

    // 父目录现有的同类节点要在移上来的之前，所以这两份顺序必须在改 parent_id **之前**取
    var keepFolders = folderIds(handle, projectId, parentId).filter(function (item) { return item !== folderId; });
    var keepApis = apiIds(handle, projectId, parentId);

    var movedFolders = folderIds(handle, projectId, folderId);
    var movedApis = apiIds(handle, projectId, folderId);

    movedFolders.forEach(function (childId) {
        foldersRepo.update(handle, childId, { parentId: parentId });
    });
    movedApis.forEach(function (childId) {
        apisRepo.update(handle, childId, { folderId: parentId });
    });

    foldersRepo.setPositionsIn(handle, keepFolders.concat(movedFolders));
    apisRepo.setPositionsIn(handle, keepApis.concat(movedApis));

    foldersRepo.remove(handle, folderId);

    return { mode: 'move', movedFolders: movedFolders.length, movedApis: movedApis.length };
}

/* ------------------------------------------------------------------ 复制接口 */

/**
 * 复制一个接口连同它的全部示例。
 *
 * 副本紧跟在原接口后面（不是追加到末尾）：界面上新增的东西出现在原物旁边才符合直觉。
 * mock_example_id 必须指向**复制出来的**那条示例，照抄原来的 id 会指向原接口的示例。
 *
 * @returns {string} 新接口的 id
 */
function duplicateApi(handle, apiId) {
    var api = apisRepo.get(handle, apiId);
    if (!api) throw apiError(404, '接口不存在：' + apiId);

    var examples = examplesRepo.listByApi(handle, apiId);

    var created = apisRepo.insert(handle, api.projectId, {
        name: api.name + ' 副本',
        description: api.description,
        folderId: api.folderId,
        method: api.method,
        url: api.url,
        params: api.params,
        body: api.body,
        auth: api.auth,
        scripts: api.scripts,
        mockEnabled: api.mockEnabled,
        mockPath: api.mockPath,
        mockDelay: api.mockDelay,
        mockCors: api.mockCors,
        extra: api.extra
    });

    var idMap = {};
    examples.forEach(function (example) {
        var copy = examplesRepo.insert(handle, created.id, {
            name: example.name,
            position: example.position,
            status: example.status,
            headers: example.headers,
            body: example.body,
            responseType: example.responseType,
            isTemplate: example.isTemplate,
            source: example.source,
            extra: example.extra
        });
        idMap[example.id] = copy.id;
    });

    var mockExampleId = idMap[api.mockExampleId] || null;
    if (!mockExampleId && examples.length) mockExampleId = idMap[examples[0].id];
    apisRepo.update(handle, created.id, { mockExampleId: mockExampleId });

    // 挪到原接口后面
    var order = apiIds(handle, api.projectId, api.folderId);
    var index = order.indexOf(apiId);
    apisRepo.setPositionsIn(handle, insertAt(order, created.id, index === -1 ? order.length : index + 1));

    return created.id;
}

/* ------------------------------------------------------------------ 重排 */

/**
 * 把项目里每个父目录、每个目录下的 position 都重写成 0..n-1。
 *
 * 批量导入之后用：routes-store.insertRoutes 用的是**项目级**的下一个 position，
 * 导进来的接口在同一目录里顺序虽然对，但 position 值会带洞、还跟别的目录交错。
 * 值本身不影响排序，但「同级连续」是这个模型的约定，维持住能让后面的移动、
 * 前端的拖动都少一堆边界情况。
 */
function reindexProject(handle, projectId) {
    var parents = [null];
    foldersRepo.list(handle, projectId).forEach(function (folder) { parents.push(folder.id); });

    parents.forEach(function (parentId) {
        foldersRepo.setPositionsIn(handle, folderIds(handle, projectId, parentId));
    });

    var folders = [null].concat(foldersRepo.list(handle, projectId).map(function (folder) { return folder.id; }));
    folders.forEach(function (folderId) {
        apisRepo.setPositionsIn(handle, apiIds(handle, projectId, folderId));
    });
}

module.exports = {
    listTree: listTree,
    move: move,
    removeFolder: removeFolder,
    duplicateApi: duplicateApi,
    ancestors: ancestors,
    descendants: descendants,
    placeFolder: placeFolder,
    placeApi: placeApi,
    reindexProject: reindexProject,
    folderIds: folderIds,
    apiIds: apiIds
};
