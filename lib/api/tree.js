/**
 * 目录树、接口与示例的接口（契约第 3 节）。
 *
 * 这里是「薄」的一层：校验参数、开事务、把结果转成 DTO。
 * 目录树的算法（移动、删除目录、复制）都在 lib/tree.js。
 *
 * 事务的划分只有一条规则：**改动哪个项目的数据就带哪个 projectId**，
 * mock 运行时靠这个事件刷新；不带的话接口改了但 mock 还是旧的。
 */

var express = require('express');

var respond = require('./respond');
var dto = require('./dto');
var tree = require('../tree');
var storeModule = require('../routes-store');
var urlUtils = require('../url-utils');
var foldersRepo = require('../db/repos/folders');
var apisRepo = require('../db/repos/apis');
var examplesRepo = require('../db/repos/examples');

var EXAMPLE_SOURCES = ['manual', 'recorded', 'imported'];

function createRouter(ctx) {
    var handle = ctx.handle;
    var router = express.Router();

    /* ---------------------------------------------------------- 小工具 */

    function mustProject(req) {
        var project = dto.findProject(handle, req.params.pid);
        if (!project) throw respond.apiError(404, '项目不存在：' + req.params.pid);
        return project;
    }

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
        return dto.toApiDto(apisRepo.get(handle, apiId), examplesRepo.listByApi(handle, apiId));
    }

    function resolveMethod(value) {
        var method = dto.str(value).toUpperCase();
        if (storeModule.METHODS.indexOf(method) === -1) {
            throw respond.apiError(400, '不支持的请求方法：' + value);
        }
        return method;
    }

    function exampleFields(input) {
        var example = dto.plainObject(input) || {};
        var patch = {};

        if (example.name !== undefined) patch.name = dto.str(example.name);
        if (example.status !== undefined) patch.status = Number(example.status) || 200;
        if (example.headers !== undefined) patch.headers = dto.toRows(example.headers);
        if (example.body !== undefined) patch.body = dto.str(example.body);
        if (example.responseType !== undefined) {
            patch.responseType = ['json', 'text', 'html'].indexOf(example.responseType) > -1
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

    router.get('/projects/:pid/tree', respond.wrap(function (req, res) {
        var project = mustProject(req);
        respond.ok(res, treePayload(project.id));
    }));

    router.post('/projects/:pid/folders', respond.wrap(function (req, res) {
        var project = mustProject(req);
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

    router.put('/folders/:id', respond.wrap(function (req, res) {
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

        var updated = handle.transaction(function () {
            return foldersRepo.update(handle, folder.id, patch);
        }, { projectId: folder.projectId });

        respond.ok(res, { folder: dto.toFolderDto(updated) });
    }));

    router.delete('/folders/:id', respond.wrap(function (req, res) {
        var folder = mustFolder(req.params.id);
        var mode = (req.query || {}).apis === 'delete' ? 'delete' : 'move';

        handle.transaction(function () {
            tree.removeFolder(handle, folder.id, mode);
        }, { projectId: folder.projectId });

        respond.ok(res, {});
    }));

    router.post('/projects/:pid/move', respond.wrap(function (req, res) {
        var project = mustProject(req);
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

    router.get('/apis/:id', respond.wrap(function (req, res) {
        mustApi(req.params.id);
        respond.ok(res, { api: apiPayload(req.params.id) });
    }));

    router.post('/projects/:pid/apis', respond.wrap(function (req, res) {
        var project = mustProject(req);
        var input = dto.plainObject((req.body || {}).api || req.body) || {};
        var mock = dto.plainObject(input.mock) || {};

        // 新接口还没有任何示例，所以这时候要求开 mock 是自相矛盾的
        if (mock.enabled === true) throw respond.apiError(400, '请先保存一个示例');
        if (mock.exampleId !== undefined && mock.exampleId !== null && mock.exampleId !== '') {
            throw respond.apiError(400, '这个示例不属于该接口');
        }

        var folderId = resolveFolderId(project.id, input.folderId);
        var url = dto.str(input.url);

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
                scripts: dto.toScripts(input.scripts),
                mockEnabled: false,
                // 没给 mock.path 就按 url 推一个 —— 契约里的默认值
                mockPath: mock.path === undefined
                    ? urlUtils.deriveMockPath(url)
                    : (mock.path === null ? null : dto.str(mock.path)),
                mockDelay: Math.max(0, Number(mock.delay) || 0),
                mockCors: mock.cors === true,
                position: apisRepo.nextPositionIn(handle, project.id, folderId)
            });
        }, { projectId: project.id });

        respond.ok(res, { api: apiPayload(created.id) });
    }));

    router.put('/apis/:id', respond.wrap(function (req, res) {
        var api = mustApi(req.params.id);
        var input = dto.plainObject((req.body || {}).api || req.body) || {};
        var mock = dto.plainObject(input.mock);
        var patch = {};

        if (input.name !== undefined) patch.name = dto.str(input.name);
        if (input.description !== undefined) patch.description = dto.str(input.description);
        if (input.method !== undefined) patch.method = resolveMethod(input.method);
        if (input.params !== undefined) patch.params = dto.toParams(input.params);
        if (input.body !== undefined) patch.body = dto.toBody(input.body);
        if (input.auth !== undefined) patch.auth = dto.toAuth(input.auth);
        if (input.scripts !== undefined) patch.scripts = dto.toScripts(input.scripts);

        /* ---- mock.path 跟随规则 ----
         * 改了 url 又没显式给 mock.path 时，只有旧的 mock.path 还等于「从旧 url 推出来的」
         * 那个值（说明用户从没手动改过它），才跟着重新推导；否则保持不动。
         * 用户手动改过的路径不能被 URL 一改就冲掉。 */
        if (input.url !== undefined) {
            var nextUrl = dto.str(input.url);
            patch.url = nextUrl;

            if (!mock || mock.path === undefined) {
                if (api.mockPath === urlUtils.deriveMockPath(api.url)) {
                    patch.mockPath = urlUtils.deriveMockPath(nextUrl);
                }
            }
        }

        if (mock) {
            if (mock.path !== undefined) {
                patch.mockPath = mock.path === null || mock.path === '' ? null : dto.str(mock.path);
            }
            if (mock.delay !== undefined) patch.mockDelay = Math.max(0, Number(mock.delay) || 0);
            if (mock.cors !== undefined) patch.mockCors = mock.cors === true;
        }

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

        respond.ok(res, { api: apiPayload(api.id) });
    }));

    router.delete('/apis/:id', respond.wrap(function (req, res) {
        var api = mustApi(req.params.id);

        handle.transaction(function () {
            var folderId = api.folderId;
            apisRepo.remove(handle, api.id);
            // 删掉之后同级会留下 position 空洞，顺手收拢
            apisRepo.setPositionsIn(handle, tree.apiIds(handle, api.projectId, folderId));
        }, { projectId: api.projectId });

        respond.ok(res, {});
    }));

    router.post('/apis/:id/duplicate', respond.wrap(function (req, res) {
        var api = mustApi(req.params.id);

        var createdId = handle.transaction(function () {
            return tree.duplicateApi(handle, api.id);
        }, { projectId: api.projectId });

        respond.ok(res, { api: apiPayload(createdId) });
    }));

    /* ---------------------------------------------------------- 示例 */

    router.post('/apis/:id/examples', respond.wrap(function (req, res) {
        var api = mustApi(req.params.id);
        var input = (req.body || {}).example || {};

        var created = handle.transaction(function () {
            var example = examplesRepo.insert(handle, api.id, exampleFields(input));

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

    router.put('/examples/:id', respond.wrap(function (req, res) {
        var example = mustExample(req.params.id);
        var api = apisRepo.get(handle, example.apiId);
        var input = (req.body || {}).example || req.body || {};

        var updated = handle.transaction(function () {
            return examplesRepo.update(handle, example.id, exampleFields(input));
        }, { projectId: api.projectId });

        respond.ok(res, { example: dto.toExampleDto(updated) });
    }));

    router.delete('/examples/:id', respond.wrap(function (req, res) {
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

    router.post('/projects/:pid/import/routes', respond.wrap(function (req, res) {
        var project = mustProject(req);
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
