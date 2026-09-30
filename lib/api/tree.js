/**
 * 目录树、接口与示例的接口（契约第 3 节，权限见第 10 节）。
 *
 * 这里是「薄」的一层：校验参数、开事务、把结果转成 DTO。
 * 目录树的算法（移动、删除目录、复制）都在 lib/tree.js。
 *
 * 权限只有两档：读（目录树、接口详情）要 viewer，其余写操作要 editor。
 * 跟资源相关的路由一律用 `byParam(kind)` 定位到项目 —— 只看 id 是不够的，
 * `/examples/:id` 光凭 id 不知道属于谁，那正是一个越权口子。
 *
 * 事务的划分只有一条规则：**改动哪个项目的数据就带哪个 projectId**，
 * mock 运行时靠这个事件刷新；不带的话接口改了但 mock 还是旧的。
 */

var express = require('express');

var respond = require('./respond');
var dto = require('./dto');
var guardModule = require('./guard');
var tree = require('../tree');
var storeModule = require('../routes-store');
var urlUtils = require('../url-utils');
var runtimeModule = require('../mock-runtime');
var mockSse = require('../mock-sse');
var foldersRepo = require('../db/repos/folders');
var apisRepo = require('../db/repos/apis');
var examplesRepo = require('../db/repos/examples');
var expectationsRepo = require('../db/repos/expectations');

var EXAMPLE_SOURCES = ['manual', 'recorded', 'imported'];

function createRouter(ctx) {
    var handle = ctx.handle;
    var router = express.Router();

    var g = guardModule.createGuard(ctx);
    var guard = g.guard;
    var byPid = g.byPid;
    var byParam = g.byParam;

    /* ---------------------------------------------------------- 小工具 */

    function mustFolder(id) {
        var folder = foldersRepo.get(handle, id);
        if (!folder) throw respond.apiError(404, '目录不存在：' + id);
        return folder;
    }

    function mustApi(id) {
        var api = apisRepo.get(handle, id);
        if (!api) throw respond.apiError(404, '接口不存在：' + id);
        return api;
    }

    function mustExample(id) {
        var example = examplesRepo.get(handle, id);
        if (!example) throw respond.apiError(404, '示例不存在：' + id);
        return example;
    }

    /** 项目下的目录 id 必须真的属于这个项目，否则会把接口挂到别人的树上 */
    function resolveFolderId(projectId, value) {
        if (value === undefined || value === null || value === '') return null;

        var folderId = dto.str(value);
        var folder = foldersRepo.get(handle, folderId);
        if (!folder || folder.projectId !== projectId) {
            throw respond.apiError(400, '目录不存在或不属于这个项目');
        }
        return folderId;
    }

    function treePayload(projectId) {
        var result = tree.listTree(handle, projectId);
        return {
            folders: result.folders.map(dto.toFolderDto),
            apis: result.apis.map(dto.toApiSummary)
        };
    }

    function apiPayload(apiId) {
        return dto.toApiDto(
            apisRepo.get(handle, apiId),
            examplesRepo.listByApi(handle, apiId),
            expectationsRepo.listByApi(handle, apiId)
        );
    }

    function resolveMethod(value) {
        var method = dto.str(value).toUpperCase();
        if (storeModule.METHODS.indexOf(method) === -1) {
            throw respond.apiError(400, '不支持的请求方法：' + value);
        }
        return method;
    }

    /**
     * mock 路径的合法性。空值不算问题（表示「不挂 mock」）。
     *
     * 为什么必须挡在写入这一层：路径最后会进 mock-runtime 的 buildRouter，
     * 而热更新可能发生在 setInterval 的回调里 —— 那里没有 Express 的兜底，
     * 一个括号不成对的路径足以让整个进程退出。
     *
     * @returns {string|null} 不合法时返回可以直接给用户看的整句
     */
    function mockPathProblem(path) {
        if (path === undefined || path === null || path === '') return null;

        var reason = runtimeModule.validateRoutePath(path);
        return reason ? ('mock 路径不合法：' + reason) : null;
    }

    /**
     * 示例 body 的按类型校验（契约第 17 节）。
     *
     * 只在写入时做：库里已经存在的坏数据由 mock 运行时逐条兜底，
     * 读取路径不能因为一条旧数据就让整个接口 500。
     *
     * @param {string} responseType 最终生效的类型（patch 没给就用库里那个）
     * @param {string} body
     */
    function assertExampleBody(responseType, body) {
        var reason = null;

        if (responseType === 'sse') reason = mockSse.validate(body);

        if (reason) throw respond.apiError(400, reason);
    }

    function exampleFields(input) {
        var example = dto.plainObject(input) || {};
        var patch = {};

        if (example.name !== undefined) patch.name = dto.str(example.name);
        if (example.status !== undefined) {
            // 越界的 status 会让 mock 运行时 res.status() 抛错；带 delay 的那条路
            // 跑在 setTimeout 里，抛出去就是进程崩溃。所以在入口就挡掉。
            if (!tree.isValidStatus(example.status)) {
                throw respond.apiError(400, '状态码必须是 ' + tree.STATUS_MIN + '~' + tree.STATUS_MAX + ' 的整数');
            }
            patch.status = Number(example.status);
        }
        if (example.headers !== undefined) patch.headers = dto.toRows(example.headers);
        if (example.body !== undefined) patch.body = dto.str(example.body);
        if (example.responseType !== undefined) {
            // 列表来自 routes-store，加新类型时只改一处
            patch.responseType = storeModule.RESPONSE_TYPES.indexOf(example.responseType) > -1
                ? example.responseType : 'json';
        }
        if (example.isTemplate !== undefined) patch.isTemplate = example.isTemplate !== false;
        if (example.source !== undefined) {
            patch.source = EXAMPLE_SOURCES.indexOf(example.source) > -1 ? example.source : 'manual';
        }
        if (example.position !== undefined) patch.position = Number(example.position) || 0;
        if (example.extra !== undefined) patch.extra = dto.toExtra(example.extra);

        return patch;
    }

    /* ---------------------------------------------------------- 树 */

    router.get('/projects/:pid/tree', guard('viewer', byPid), respond.wrap(function (req, res) {
        respond.ok(res, treePayload(req.project.id));
    }));

    router.post('/projects/:pid/folders', guard('editor', byPid), respond.wrap(function (req, res) {
        var project = req.project;
        var body = req.body || {};
        var name = dto.str(body.name).trim();
        if (!name) throw respond.apiError(400, '请填写目录名');

        var parentId = resolveFolderId(project.id, body.parentId);

        var created = handle.transaction(function () {
            var siblings = foldersRepo.listChildren(handle, project.id, parentId);
            var duplicated = siblings.some(function (folder) { return folder.name === name; });
            if (duplicated) throw respond.apiError(400, '同一目录下已存在同名目录');

            return foldersRepo.create(handle, project.id, {
                name: name,
                parentId: parentId,
                auth: dto.toAuth(body.auth),
                variables: dto.toVarRows(body.variables),
                position: foldersRepo.nextPositionIn(handle, project.id, parentId)
            });
        }, { projectId: project.id });

        respond.ok(res, { folder: dto.toFolderDto(created) });
    }));

    router.put('/folders/:id', guard('editor', byParam('folder')), respond.wrap(function (req, res) {
        var folder = mustFolder(req.params.id);
        var body = req.body || {};
        var patch = {};

        if (body.name !== undefined) {
            var name = dto.str(body.name).trim();
            if (!name) throw respond.apiError(400, '目录名不能为空');
            patch.name = name;
        }
        if (body.description !== undefined) patch.description = dto.str(body.description);
        if (body.auth !== undefined) patch.auth = dto.toAuth(body.auth);
        if (body.variables !== undefined) patch.variables = dto.toVarRows(body.variables);
        // 契约第 16 节：脚本从「只读展示」改成可编辑
        if (body.scripts !== undefined) patch.scripts = dto.toScriptsStrict(body.scripts);

        var updated = handle.transaction(function () {
            return foldersRepo.update(handle, folder.id, patch);
        }, { projectId: folder.projectId });

        respond.ok(res, { folder: dto.toFolderDto(updated) });
    }));

    router.delete('/folders/:id', guard('editor', byParam('folder')), respond.wrap(function (req, res) {
        var folder = mustFolder(req.params.id);
        var mode = (req.query || {}).apis === 'delete' ? 'delete' : 'move';

        handle.transaction(function () {
            tree.removeFolder(handle, folder.id, mode);
        }, { projectId: folder.projectId });

        respond.ok(res, {});
    }));

    router.post('/projects/:pid/move', guard('editor', byPid), respond.wrap(function (req, res) {
        var project = req.project;
        var body = req.body || {};

        handle.transaction(function () {
            tree.move(handle, project.id, {
                kind: body.kind,
                id: body.id,
                parentId: body.parentId === undefined ? null : body.parentId,
                index: body.index
            });
        }, { projectId: project.id });

        respond.ok(res, treePayload(project.id));
    }));

    /* ---------------------------------------------------------- 接口 */

    router.get('/apis/:id', guard('viewer', byParam('api')), respond.wrap(function (req, res) {
        mustApi(req.params.id);
        respond.ok(res, { api: apiPayload(req.params.id) });
    }));

    router.post('/projects/:pid/apis', guard('editor', byPid), respond.wrap(function (req, res) {
        var project = req.project;
        var input = dto.plainObject((req.body || {}).api || req.body) || {};
        var mock = dto.plainObject(input.mock) || {};

        // 新接口还没有任何示例，所以这时候要求开 mock 是自相矛盾的
        if (mock.enabled === true) throw respond.apiError(400, '请先保存一个示例');
        if (mock.exampleId !== undefined && mock.exampleId !== null && mock.exampleId !== '') {
            throw respond.apiError(400, '这个示例不属于该接口');
        }

        var folderId = resolveFolderId(project.id, input.folderId);
        var url = dto.str(input.url);
        var warnings = [];

        // mock.path：显式给的要校验；由 url 推出来的不合法时**不能让整个请求失败** ——
        // 用户只是想存下这个接口，路径能不能挂 mock 是次要的
        var explicitPath = mock.path === undefined || mock.path === null || mock.path === ''
            ? null
            : dto.str(mock.path);
        var mockPath = null;

        if (explicitPath !== null) {
            var explicitProblem = mockPathProblem(explicitPath);
            if (explicitProblem) throw respond.apiError(400, explicitProblem);
            mockPath = explicitPath;
        } else {
            var derivedPath = urlUtils.deriveMockPath(url);
            var derivedProblem = mockPathProblem(derivedPath);
            if (derivedProblem) {
                warnings.push(derivedProblem + '（由 url 推导而来），已留空，请手动填写 mock 路径');
            } else {
                mockPath = derivedPath;
            }
        }

        var created = handle.transaction(function () {
            return apisRepo.insert(handle, project.id, {
                name: dto.str(input.name),
                description: dto.str(input.description),
                folderId: folderId,
                method: input.method === undefined ? 'GET' : resolveMethod(input.method),
                url: url,
                params: dto.toParams(input.params),
                body: dto.toBody(input.body),
                auth: dto.toAuth(input.auth),
                scripts: dto.toScriptsStrict(input.scripts),
                mockEnabled: false,
                mockPath: mockPath,
                mockDelay: Math.max(0, Number(mock.delay) || 0),
                mockCors: mock.cors === true,
                position: apisRepo.nextPositionIn(handle, project.id, folderId)
            });
        }, { projectId: project.id });

        var payload = { api: apiPayload(created.id) };
        if (warnings.length) payload.warnings = warnings;
        respond.ok(res, payload);
    }));

    router.put('/apis/:id', guard('editor', byParam('api')), respond.wrap(function (req, res) {
        var api = mustApi(req.params.id);
        var input = dto.plainObject((req.body || {}).api || req.body) || {};
        var mock = dto.plainObject(input.mock);
        var patch = {};
        var warnings = [];

        if (input.name !== undefined) patch.name = dto.str(input.name);
        if (input.description !== undefined) patch.description = dto.str(input.description);
        if (input.method !== undefined) patch.method = resolveMethod(input.method);
        if (input.params !== undefined) patch.params = dto.toParams(input.params);
        if (input.body !== undefined) patch.body = dto.toBody(input.body);
        if (input.auth !== undefined) patch.auth = dto.toAuth(input.auth);
        if (input.scripts !== undefined) patch.scripts = dto.toScriptsStrict(input.scripts);

        /* ---- mock.path 跟随规则 ----
         * 改了 url 又没显式给 mock.path 时，只有旧的 mock.path 还等于「从旧 url 推出来的」
         * 那个值（说明用户从没手动改过它），才跟着重新推导；否则保持不动。
         * 用户手动改过的路径不能被 URL 一改就冲掉。 */
        if (input.url !== undefined) {
            var nextUrl = dto.str(input.url);
            patch.url = nextUrl;

            if (!mock || mock.path === undefined) {
                if (api.mockPath === urlUtils.deriveMockPath(api.url)) {
                    var derivedPath = urlUtils.deriveMockPath(nextUrl);
                    var derivedProblem = mockPathProblem(derivedPath);
                    // 推导结果不合法就保持原值 —— url 该存的存，路径留给用户手动填，
                    // 不能因为一句 url 就把接口弄成挂不上的状态却不说一声
                    if (derivedProblem) {
                        warnings.push(derivedProblem + '（由新 url 推导而来），mock.path 保持原值');
                    } else {
                        patch.mockPath = derivedPath;
                    }
                }
            }
        }

        if (mock && mock.path !== undefined) {
            if (mock.path === null || mock.path === '') {
                patch.mockPath = null;
            } else {
                var explicitPath = dto.str(mock.path);
                var explicitProblem = mockPathProblem(explicitPath);
                if (explicitProblem) throw respond.apiError(400, explicitProblem);
                patch.mockPath = explicitPath;
            }
        }

        if (mock && mock.delay !== undefined) patch.mockDelay = Math.max(0, Number(mock.delay) || 0);
        if (mock && mock.cors !== undefined) patch.mockCors = mock.cors === true;

        /* ---- 启用 mock 的前提 ---- */
        var examples = examplesRepo.listByApi(handle, api.id);
        var nextEnabled = api.mockEnabled;
        var nextExampleId = api.mockExampleId;

        if (mock && mock.exampleId !== undefined) {
            if (mock.exampleId === null || mock.exampleId === '') {
                nextExampleId = null;
            } else {
                nextExampleId = dto.str(mock.exampleId);
                var belongs = examples.some(function (item) { return item.id === nextExampleId; });
                if (!belongs) throw respond.apiError(400, '这个示例不属于该接口');
            }
        }

        if (mock && mock.enabled !== undefined) nextEnabled = mock.enabled === true;

        if (nextEnabled) {
            if (!examples.length) throw respond.apiError(400, '请先保存一个示例');
            // 没指定就自动指向第一个；指定了的话上面已经校验过归属
            if (!nextExampleId) nextExampleId = examples[0].id;
        }

        if (nextExampleId && !examples.some(function (item) { return item.id === nextExampleId; })) {
            throw respond.apiError(400, '这个示例不属于该接口');
        }

        // 只在真的变了的时候才写，免得每次改个名字都顺带把 mock 配置重写一遍
        if (nextEnabled !== api.mockEnabled) patch.mockEnabled = nextEnabled;
        if (nextExampleId !== api.mockExampleId) patch.mockExampleId = nextExampleId;

        /* ---- 换目录 / 换位置 ---- */
        var targetFolderId = input.folderId === undefined
            ? api.folderId
            : resolveFolderId(api.projectId, input.folderId);
        var hasIndex = input.position !== undefined && input.position !== null;
        var folderChanged = targetFolderId !== (api.folderId || null);

        handle.transaction(function () {
            apisRepo.update(handle, api.id, patch);

            // 只在真的换了目录、或者显式给了位置时才重排 ——
            // 否则每保存一次都会把接口挪到同级末尾
            if (folderChanged || hasIndex) {
                tree.placeApi(handle, api.projectId, api.id, targetFolderId, hasIndex ? input.position : undefined);
            }
        }, { projectId: api.projectId });

        var payload = { api: apiPayload(api.id) };
        if (warnings.length) payload.warnings = warnings;
        respond.ok(res, payload);
    }));

    router.delete('/apis/:id', guard('editor', byParam('api')), respond.wrap(function (req, res) {
        var api = mustApi(req.params.id);

        handle.transaction(function () {
            var folderId = api.folderId;
            apisRepo.remove(handle, api.id);
            // 删掉之后同级会留下 position 空洞，顺手收拢
            apisRepo.setPositionsIn(handle, tree.apiIds(handle, api.projectId, folderId));
        }, { projectId: api.projectId });

        respond.ok(res, {});
    }));

    router.post('/apis/:id/duplicate', guard('editor', byParam('api')), respond.wrap(function (req, res) {
        var api = mustApi(req.params.id);

        var createdId = handle.transaction(function () {
            return tree.duplicateApi(handle, api.id);
        }, { projectId: api.projectId });

        respond.ok(res, { api: apiPayload(createdId) });
    }));

    /* ---------------------------------------------------------- 示例 */

    router.post('/apis/:id/examples', guard('editor', byParam('api')), respond.wrap(function (req, res) {
        var api = mustApi(req.params.id);
        var input = (req.body || {}).example || {};

        var fields = exampleFields(input);
        assertExampleBody(fields.responseType || 'json', fields.body === undefined ? '' : fields.body);

        var created = handle.transaction(function () {
            var example = examplesRepo.insert(handle, api.id, fields);

            // 这是该接口的第一个示例、而 mock 还没指向任何一个 —— 自动指上，
            // 省得用户再点一次「用作 mock」
            var all = examplesRepo.listByApi(handle, api.id);
            if (all.length === 1 && !api.mockExampleId) {
                apisRepo.update(handle, api.id, { mockExampleId: example.id });
            }
            return example;
        }, { projectId: api.projectId });

        respond.ok(res, { example: dto.toExampleDto(created), api: apiPayload(api.id) });
    }));

    router.put('/examples/:id', guard('editor', byParam('example')), respond.wrap(function (req, res) {
        var example = mustExample(req.params.id);
        var api = apisRepo.get(handle, example.apiId);
        var input = (req.body || {}).example || req.body || {};

        var fields = exampleFields(input);
        if (fields.responseType !== undefined || fields.body !== undefined) {
            assertExampleBody(
                fields.responseType === undefined ? example.responseType : fields.responseType,
                fields.body === undefined ? example.body : fields.body
            );
        }

        var updated = handle.transaction(function () {
            return examplesRepo.update(handle, example.id, fields);
        }, { projectId: api.projectId });

        respond.ok(res, { example: dto.toExampleDto(updated) });
    }));

    router.delete('/examples/:id', guard('editor', byParam('example')), respond.wrap(function (req, res) {
        var example = mustExample(req.params.id);
        var api = apisRepo.get(handle, example.apiId);

        handle.transaction(function () {
            var wasMock = api.mockExampleId === example.id;
            examplesRepo.remove(handle, example.id);

            if (wasMock) {
                var rest = examplesRepo.listByApi(handle, api.id);
                // 还有别的示例就改指第一个；一个都不剩就只能把 mock 关掉，
                // 否则这条路由会挂着一个指向不存在示例的 mock
                apisRepo.update(handle, api.id, rest.length
                    ? { mockExampleId: rest[0].id }
                    : { mockEnabled: false, mockExampleId: null });
            }
        }, { projectId: api.projectId });

        respond.ok(res, { api: apiPayload(api.id) });
    }));

    /* ---------------------------------------------------------- 批量导入 route */

    router.post('/projects/:pid/import/routes', guard('editor', byPid), respond.wrap(function (req, res) {
        var project = req.project;
        var body = req.body || {};
        var routes = body.routes;

        if (!Array.isArray(routes) || !routes.length) {
            throw respond.apiError(400, '没有可导入的接口');
        }

        var folderId = resolveFolderId(project.id, body.folderId);

        var createdIds;
        try {
            createdIds = handle.transaction(function () {
                // 指定了目录时把 group 清空：insertRoutes 会按 group 建顶层目录，
                // 不清空就会凭空多出一堆目录，接口反而没落在指定的那个下面。
                var source = folderId
                    ? routes.map(function (item) {
                        return Object.assign({}, item, { group: '' });
                    })
                    : routes;

                var inserted = storeModule.insertRoutes(handle, project.id, { routes: source });

                if (folderId) {
                    inserted.forEach(function (route) {
                        apisRepo.update(handle, route.id, { folderId: folderId });
                    });
                }

                // insertRoutes 用的是项目级的下一个 position，导完可能带洞、还跟别的目录交错；
                // 重排一遍让「同级 position 连续」这个约定继续成立
                tree.reindexProject(handle, project.id);

                return inserted.map(function (route) { return route.id; });
            }, { projectId: project.id });
        } catch (err) {
            // 参数问题（比如 route 的 method 不合法）是 400，不是服务端出错
            throw respond.apiError(400, err.message);
        }

        respond.ok(res, {
            apis: createdIds.map(function (id) {
                return dto.toApiSummary(apisRepo.get(handle, id));
            })
        });
    }));

    return router;
}

module.exports = {
    createRouter: createRouter
};
