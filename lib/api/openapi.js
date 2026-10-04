/**
 * 从 OpenAPI 同步更新（第四轮第 3 节）的两个接口。
 *
 * 后端用 Swagger 维护接口、接口一改，以前只能整个重新导入（重复出一套，或者把自己
 * 写的脚本 / 示例 / Mock 覆盖掉）。这两个接口让「只更新变了的部分」成为可能。
 *
 * - `POST /projects/:pid/openapi/diff` —— 只算不改，给弹窗列三组；
 * - `POST /projects/:pid/openapi/apply` —— **重新拉一次、重新算一次**再执行。
 *
 * 为什么 apply 要重算而不是信前端传来的内容：中间可能隔了几分钟（用户在挑要同步哪些），
 * 这期间文档可能又变了；而且「算差异」和「改数据」用两份输入，很容易出现
 * 「列表里显示要改 A、实际改了 B」。所以两边共用 `lib/openapi-sync.js` 的同一份计算，
 * apply 只按前端勾的 **key / apiId** 从重算的结果里挑。
 *
 * 一个事务里做完；删掉的接口走回收站（`lib/trash.js` 的 `captureApi`），
 * 和 `DELETE /apis/:id` 是同一套写法。
 */

var express = require('express');

var respond = require('./respond');
var guardModule = require('./guard');
var tree = require('../tree');
var trash = require('../trash');
var importers = require('../importers');
var storeModule = require('../routes-store');
var sync = require('../openapi-sync');
var fetchSpecText = require('../openapi-fetch').fetchSpecText;
var sendApi = require('./send');
var apisRepo = require('../db/repos/apis');
var foldersRepo = require('../db/repos/folders');
var projectsRepo = require('../db/repos/projects');

function createRouter(ctx) {
    var handle = ctx.handle;
    var router = express.Router();

    var g = guardModule.createGuard(ctx);
    var guard = g.guard;
    var byPid = g.byPid;

    /** /send 那套同样的错误转换：respond.wrap 只兜同步抛出的，这两个接口是异步的 */
    function failFrom(res, err) {
        if (res.headersSent || res.writableEnded) return;

        var status = Number(err && err.status);
        if (Number.isFinite(status) && status >= 400 && status < 600) {
            return respond.fail(res, status, err.message, err.code);
        }
        console.error('[openapi]', err && err.stack ? err.stack : err);
        return respond.fail(res, 500, '服务端出错：' + ((err && err.message) || '未知错误'));
    }

    /** 目录 id 必须属于这个项目 */
    function resolveFolderId(projectId, value) {
        if (value === undefined || value === null || value === '') return null;

        var folderId = String(value);
        var folder = foldersRepo.get(handle, folderId);
        if (!folder || folder.projectId !== projectId) {
            throw respond.apiError(400, '目录不存在或不属于这个项目');
        }
        return folderId;
    }

    function toStringList(value) {
        if (!Array.isArray(value)) return [];
        return value.map(function (item) { return String(item); });
    }

    /* ------------------------------------------------ 记住的来源（openapiSources） */

    /**
     * `projects.extra.openapiSources = [{ folderId, url, lastSyncedAt }]`，
     * 按 `folderId` 区分（导入到哪个目录就记在哪个目录上；整个项目是 null）。
     * 粘贴内容导入的 url 记空串。
     */
    function readSources(project) {
        var extra = project.extra && typeof project.extra === 'object' ? project.extra : {};
        return Array.isArray(extra.openapiSources) ? extra.openapiSources : [];
    }

    function rememberedUrl(project, folderId) {
        var key = folderId || null;
        var found = '';
        readSources(project).forEach(function (item) {
            if (!item) return;
            if ((item.folderId || null) === key) found = String(item.url || '');
        });
        return found;
    }

    function saveSource(project, folderId, url) {
        var extra = project.extra && typeof project.extra === 'object' ? project.extra : {};
        var key = folderId || null;

        var kept = readSources(project).filter(function (item) {
            return ((item && item.folderId) || null) !== key;
        });
        kept.push({ folderId: key, url: String(url || ''), lastSyncedAt: Date.now() });

        // **先读出原来的 extra 再合并**：别的地方（mockVariables 之类）还在里面
        var nextExtra = Object.assign({}, extra, { openapiSources: kept });
        projectsRepo.update(handle, project.id, { extra: nextExtra });
        return nextExtra;
    }

    /* ------------------------------------------------ 拉 + 解析 */

    /**
     * 拿到定义原文。地址优先，其次粘贴的内容；两样都没给时用**这个目录上次用过的地址**
     * （「记住上次用的地址」在服务端也留一份，换台电脑打开也知道该拉哪儿）。
     */
    function loadSpec(project, body, folderId) {
        var url = String(body.url === undefined || body.url === null ? '' : body.url).trim();
        var text = String(body.text === undefined || body.text === null ? '' : body.text);

        if (!url && !text.trim()) {
            url = rememberedUrl(project, folderId);
            if (!url) throw respond.apiError(400, '填一个地址，或者把定义粘进来');
        }

        if (!url) return Promise.resolve({ text: text, url: '' });
        if (!/^https?:\/\/[^\s]+$/i.test(url)) {
            throw respond.apiError(400, '地址要以 http:// 或 https:// 开头');
        }
        // 「云端不发请求」时也不替人拉地址（同样是服务器去访问用户给的地址）；粘贴内容照常
        if (!sendApi.serverSendEnabled()) {
            throw respond.apiError(409, '云端不替你拉取地址，请把定义粘贴进来，或者在 apiloop 客户端里同步', 'SERVER_SEND_DISABLED');
        }

        return fetchSpecText(url).then(function (fetched) {
            return { text: fetched, url: url };
        }, function (err) {
            throw respond.apiError(400, '拉取失败：' + err.message);
        });
    }

    function parseRoutes(text) {
        try {
            return importers.openapiToRoutes(text);
        } catch (err) {
            // 文档本身的问题（缺 paths、YAML 解析失败）是 400，不是服务端出错
            throw respond.apiError(400, err.message);
        }
    }

    /** 算差异要的三样：文档解析出来的 route、现有的接口、目录 */
    function computeFor(project, routes, folderId) {
        return sync.computeDiff({
            routes: routes,
            apis: apisRepo.list(handle, project.id),
            folders: foldersRepo.list(handle, project.id),
            folderId: folderId
        });
    }

    /* ------------------------------------------------ 检查更新 */

    router.post('/projects/:pid/openapi/diff', guard('editor', byPid), function (req, res) {
        var project = req.project;
        var body = req.body || {};
        var folderId;

        try {
            folderId = resolveFolderId(project.id, body.folderId);
        } catch (err) {
            return failFrom(res, err);
        }

        var spec;
        try {
            spec = loadSpec(project, body, folderId);
        } catch (err) {
            return failFrom(res, err);
        }

        return spec.then(function (loaded) {
            var result = computeFor(project, parseRoutes(loaded.text), folderId);

            respond.ok(res, {
                // 整份 route 不给前端（里面带着响应体模板，没必要发），
                // apply 那边会自己重新解析一次
                added: result.added.map(function (item) {
                    return {
                        key: item.key,
                        method: item.method,
                        path: item.path,
                        name: item.name,
                        folderId: item.folderId,
                        folderName: item.folderName
                    };
                }),
                changed: result.changed.map(function (item) {
                    return {
                        apiId: item.apiId,
                        name: item.name,
                        method: item.method,
                        url: item.url,
                        key: item.key,
                        changes: item.changes
                    };
                }),
                removed: result.removed,
                source: {
                    url: loaded.url,
                    folderId: folderId,
                    folderName: folderId ? (foldersRepo.get(handle, folderId) || {}).name || '' : ''
                }
            });
        }).catch(function (err) {
            return failFrom(res, err);
        });
    });

    /* ------------------------------------------------ 同步所选 */

    /**
     * 新增：和导入一样建（`insertRoutes` 会按 tag 找 / 建顶层目录、顺手插一个默认示例、
     * 并把 `extra.openapi` 记上）。指定了目录时把 group 清掉、建完再挪进那个目录 ——
     * 和 `/import/routes` 是同一个口径。
     */
    function createApi(project, route, folderId) {
        var source = folderId ? [Object.assign({}, route, { group: '' })] : [route];
        var inserted = storeModule.insertRoutes(handle, project.id, { routes: source });

        inserted.forEach(function (item) {
            if (folderId) apisRepo.update(handle, item.id, { folderId: folderId });
        });
        return inserted[0];
    }

    router.post('/projects/:pid/openapi/apply', guard('editor', byPid), function (req, res) {
        var project = req.project;
        var body = req.body || {};
        var folderId;

        try {
            folderId = resolveFolderId(project.id, body.folderId);
        } catch (err) {
            return failFrom(res, err);
        }

        var addKeys = toStringList(body.add);
        var updateIds = toStringList(body.update);
        var removeIds = toStringList(body.remove);

        var spec;
        try {
            spec = loadSpec(project, body, folderId);
        } catch (err) {
            return failFrom(res, err);
        }

        return spec.then(function (loaded) {
            // **重新算一遍**，不信前端传的内容
            var result = computeFor(project, parseRoutes(loaded.text), folderId);

            var outcome;
            try {
                outcome = handle.transaction(function () {
                    var counts = { added: 0, updated: 0, removed: 0 };

                    result.added.forEach(function (item) {
                        if (addKeys.indexOf(item.key) === -1) return;
                        createApi(project, item.route, folderId);
                        counts.added += 1;
                    });

                    result.changed.forEach(function (item) {
                        if (updateIds.indexOf(item.apiId) === -1) return;

                        var api = apisRepo.get(handle, item.apiId);
                        if (!api || api.projectId !== project.id) return;

                        var planned = sync.planUpdate(api, item.route);
                        if (!planned.changes.length) return;

                        apisRepo.update(handle, api.id, planned.patch);
                        counts.updated += 1;
                    });

                    result.removed.forEach(function (item) {
                        if (removeIds.indexOf(item.apiId) === -1) return;

                        var api = apisRepo.get(handle, item.apiId);
                        if (!api || api.projectId !== project.id) return;

                        // 进回收站，不是真删（和 DELETE /apis/:id 一样：同一个事务里先记再删）
                        trash.captureApi(handle, api, req.user);
                        apisRepo.remove(handle, api.id);
                        counts.removed += 1;
                    });

                    saveSource(project, folderId, loaded.url);
                    tree.reindexProject(handle, project.id);

                    return counts;
                }, { projectId: project.id });
            } catch (err) {
                throw respond.apiError(400, err.message);
            }

            respond.ok(res, outcome);
        }).catch(function (err) {
            return failFrom(res, err);
        });
    });

    return router;
}

module.exports = {
    createRouter: createRouter
};
