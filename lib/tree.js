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
var projectsRepo = require('./db/repos/projects');
var runtimeModule = require('./mock-runtime');
var commonHeaders = require('./common-headers');

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

/* ------------------------------------------------------------------ 树的读写 */

/** HTTP 状态码的合法范围。示例的 status 必须落在这里面 —— 越界的值会让
 *  mock 运行时的 res.status() 抛 ERR_HTTP_INVALID_STATUS_CODE，带 delay 时进程直接挂 */
var STATUS_MIN = 100;
var STATUS_MAX = 599;

function isValidStatus(value) {
    var status = Number(value);
    return Number.isInteger(status) && status >= STATUS_MIN && status <= STATUS_MAX;
}

/**
 * 把一次写入过程中「被修正过」的东西汇总成给用户看的警告。
 * 导入这类批量操作不能因为个别脏数据整体失败，但也不能默默吞掉。
 */
function buildWriteWarnings(bag) {
    var warnings = [];

    if (bag.badPaths.length) {
        warnings.push('有 ' + bag.badPaths.length + ' 个接口的 mock 路径不合法，路径已原样保存但不会挂到 mock 上：' +
            bag.badPaths.join('、'));
    }
    if (bag.badStatuses.length) {
        warnings.push('有 ' + bag.badStatuses.length + ' 个接口的示例状态码不在 ' + STATUS_MIN + '~' + STATUS_MAX +
            ' 之间，已改成 200：' + bag.badStatuses.join('、'));
    }

    return warnings;
}

function writeNodes(handle, projectId, parentFolderId, children, bag) {
    var parent = parentFolderId || null;

    (children || []).forEach(function (node) {
        if (!node) return;

        if (node.type === 'folder') {
            var folder = foldersRepo.create(handle, projectId, {
                name: node.name,
                description: node.description,
                parentId: parent,
                auth: node.auth,
                variables: node.variables,
                scripts: node.scripts,
                // 公共请求头（第五轮第 1 节）住在 extra.headers 里，导入的文件里是自己的字段名。
                // 文件里没带这一项时原样保留 extra，别把别的东西顺手删了
                extra: node.headers === undefined
                    ? node.extra
                    : commonHeaders.withHeaders(node.extra, node.headers),
                position: foldersRepo.nextPositionIn(handle, projectId, parent)
            });
            bag.folders++;

            writeNodes(handle, projectId, folder.id, node.children, bag);
            return;
        }

        if (node.type !== 'api') return;

        // 路径照原样存下来（用户的数据不该被我们改），但不合法的不能挂到 mock 上，
        // 否则热更新时 Express 注册会抛错，轮询方那边连进程都保不住
        var mockPath = node.mockPath === undefined ? null : node.mockPath;
        var pathProblem = mockPath ? runtimeModule.validateRoutePath(mockPath) : null;
        if (pathProblem) bag.badPaths.push(node.name || '(未命名接口)');

        var api = apisRepo.insert(handle, projectId, {
            name: node.name,
            description: node.description,
            folderId: parent,
            method: node.method || 'GET',
            url: node.url === undefined || node.url === null ? '' : String(node.url),
            params: node.params,
            body: node.body,
            auth: node.auth,
            scripts: node.scripts,
            mockPath: mockPath,
            // 断言与提取变量（第六轮第 1 节）：文件里带了的写进 extra
            extra: checksExtra(node),
            // 先关着：契约要求「有示例才开」，而且还得看路径合不合法
            mockEnabled: false,
            position: apisRepo.nextPositionIn(handle, projectId, parent)
        });
        bag.apis++;

        var exampleIds = [];
        var statusFixed = false;

        (node.examples || []).forEach(function (item) {
            var status = item.status;
            if (!isValidStatus(status)) {
                status = 200;
                statusFixed = true;
            }

            var example = examplesRepo.insert(handle, api.id, {
                name: item.name,
                status: status,
                headers: item.headers,
                body: item.body,
                responseType: item.responseType,
                // Postman 里的示例是**真实响应的记录**，不是带 {{@...}} 的模板
                isTemplate: false,
                source: item.source || 'imported',
                extra: item.extra
            });
            exampleIds.push(example.id);
            bag.examples++;
        });

        if (statusFixed) bag.badStatuses.push(node.name || '(未命名接口)');

        apisRepo.update(handle, api.id, exampleIds.length && !pathProblem
            ? { mockEnabled: true, mockExampleId: exampleIds[0] }
            : { mockEnabled: false });
    });
}

/**
 * 把一棵「接口树」写进项目。节点形状就是 lib/postman.js 的 parse 结果：
 * `{ type:'folder', ... , children }` 或 `{ type:'api', ..., examples }`。
 *
 * 不开事务，由调用方包 —— 整个 Postman 导入必须是一个事务：导入到一半出错时
 * 项目不能留下半截（Review Focus 第 5 条）。
 *
 * 遇到脏数据不整体失败，而是就地修正并记进 `warnings`：
 * 状态码越界改成 200；mock 路径不合法则原样保存但不挂到 mock 上。
 *
 * @param {string|null} parentFolderId 这批节点挂在哪个目录下，null 表示顶层
 * @returns {{folders: number, apis: number, examples: number, warnings: string[]}}
 */
function writeTree(handle, projectId, parentFolderId, children) {
    var bag = { folders: 0, apis: 0, examples: 0, badPaths: [], badStatuses: [] };
    writeNodes(handle, projectId, parentFolderId, children, bag);

    return {
        folders: bag.folders,
        apis: bag.apis,
        examples: bag.examples,
        warnings: buildWriteWarnings(bag)
    };
}

/**
 * 导入时把断言 / 提取变量（第六轮第 1 节）并进接口的 `extra`。
 * 文件里没带这两项时返回空对象 —— 不要顺手把别的东西清掉。
 */
function checksExtra(node) {
    var extra = {};
    if (Array.isArray(node.assertions) && node.assertions.length) extra.assertions = node.assertions;
    if (Array.isArray(node.extracts) && node.extracts.length) extra.extracts = node.extracts;
    return extra;
}

function toExampleNode(example) {
    return {
        name: example.name,
        status: example.status,
        headers: example.headers,
        body: example.body,
        responseType: example.responseType,
        source: example.source,
        extra: example.extra
    };
}

function toApiNode(handle, api) {
    return {
        type: 'api',
        name: api.name,
        description: api.description,
        method: api.method,
        url: api.url,
        params: api.params,
        body: api.body,
        auth: api.auth,
        scripts: api.scripts,
        mockPath: api.mockPath,
        examples: examplesRepo.listByApi(handle, api.id).map(toExampleNode),
        extra: api.extra
    };
}

/**
 * 读出一棵接口树，形状直接能交给 postman.toCollection。
 *
 * 排序按契约：同一个父目录下先列子目录、再列接口，各自按 position —— listChildren
 * 里已经排好了，这里只需要把两组拼起来。
 */
function readTree(handle, projectId) {
    var project = projectsRepo.getById(handle, projectId);
    if (!project) throw apiError(404, '项目不存在：' + projectId);

    function childrenOf(parentFolderId) {
        var parent = parentFolderId || null;
        var folders = foldersRepo.listChildren(handle, projectId, parent).map(function (folder) {
            return {
                type: 'folder',
                name: folder.name,
                description: folder.description,
                auth: folder.auth,
                variables: folder.variables,
                scripts: folder.scripts,
                extra: folder.extra,
                children: childrenOf(folder.id)
            };
        });
        var apis = apisRepo.listChildren(handle, projectId, parent).map(function (api) {
            return toApiNode(handle, api);
        });
        return folders.concat(apis);
    }

    return {
        name: project.name,
        description: project.description,
        variables: project.variables,
        auth: project.auth,
        scripts: project.scripts,
        extra: project.extra,
        children: childrenOf(null)
    };
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
    apiIds: apiIds,
    writeTree: writeTree,
    readTree: readTree,
    isValidStatus: isValidStatus,
    STATUS_MIN: STATUS_MIN,
    STATUS_MAX: STATUS_MAX
};
