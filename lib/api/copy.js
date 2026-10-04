/**
 * 跨项目复制 / 移动（第六轮第 3 节）。
 *
 * 接口只能在项目内拖动。想把一组接口给另一个项目用、或者拆项目、或者拿一个现成项目
 * 当模板新建，以前只能导出再导入。这里三个接口：
 *
 *   - `POST /apis/:id/copy` / `POST /folders/:id/copy` —— 复制（或移动）到别的项目；
 *   - `POST /projects/:pid/duplicate` —— 复制整个项目为新项目。
 *
 * **核心复用回收站那一套**（`lib/trash.js`）：`collectFolder` / `collectApi` 收原始行，
 * `insertPayload` 换新 id 插到「指定项目 + 指定目录」下 —— 和「恢复」是同一份代码，
 * 所以复制出来的东西和恢复出来的东西形状一定一致（示例、Mock 期望的引用都会跟着换）。
 *
 * 移动 = **先复制到目标、再把原来的放进回收站**（不是真删）—— 移错了能从回收站找回来。
 */

var express = require('express');

var respond = require('./respond');
var dto = require('./dto');
var guardModule = require('./guard');
var access = require('../access');
var tree = require('../tree');
var trash = require('../trash');
var projectsRepo = require('../db/repos/projects');
var foldersRepo = require('../db/repos/folders');
var apisRepo = require('../db/repos/apis');
var suitesRepo = require('../db/repos/suites');

function createRouter(ctx) {
    var handle = ctx.handle;
    var router = express.Router();

    var g = guardModule.createGuard(ctx);
    var guard = g.guard;
    var byPid = g.byPid;
    var byParam = g.byParam;

    /** 目标项目必须存在、而且我在里面是 editor 及以上（往里写东西） */
    function mustTargetProject(req, value) {
        var project = value ? projectsRepo.getById(handle, String(value)) : null;
        var role = project ? access.roleOf(handle, req.user, project.id) : null;

        // 看不到的项目和不存在返回一样：不能让人拿 id 试出「这个项目存在」
        if (!project || !role) throw respond.apiError(404, '目标项目不存在');
        if (!access.atLeast(role, 'editor')) throw respond.apiError(403, '在目标项目里需要 editor 权限');
        return project;
    }

    /** 目标目录必须在目标项目里（不传就是根目录） */
    function resolveTargetFolder(project, value) {
        if (value === undefined || value === null || value === '') return null;

        var folderId = dto.str(value);
        var folder = foldersRepo.get(handle, folderId);
        if (!folder || folder.projectId !== project.id) {
            throw respond.apiError(400, '目标目录不存在或不属于这个项目');
        }
        return folderId;
    }

    function folderNameOf(folderId) {
        var folder = folderId ? foldersRepo.get(handle, folderId) : null;
        return folder ? folder.name : '';
    }

    /**
     * 复制 / 移动一个接口或一个目录。
     *
     * 权限：**源项目** viewer 就能复制，editor 才能移动（移动会动源项目的数据）；
     * **目标项目**要 editor。
     */
    function copyNode(req, res, kind) {
        var body = req.body || {};
        var move = body.move === true;

        if (move && !access.atLeast(req.role, 'editor')) {
            throw respond.apiError(403, '移动需要源项目的 editor 权限');
        }

        var target = mustTargetProject(req, body.projectId);
        var targetFolderId = resolveTargetFolder(target, body.folderId);

        var source = kind === 'api'
            ? apisRepo.get(handle, req.params.id)
            : foldersRepo.get(handle, req.params.id);

        if (!source) throw respond.apiError(404, (kind === 'api' ? '接口' : '目录') + '不存在');

        // 只做「跨项目」：同一个项目里拖动目录树就行。服务端也要拦 —— 把目录移进它自己的子目录时，
        // 先插的复制品挂在子目录下，紧接着删源目录的整棵子树，复制品的目录被级联删掉、接口掉到根目录
        if (target.id === source.projectId) {
            throw respond.apiError(400, '同一个项目里请直接在目录树里拖动');
        }

        var outcome = handle.transaction(function () {
            var payload = kind === 'api'
                ? trash.collectApi(handle, source)
                : trash.collectFolder(handle, source, 'delete');

            var inserted = trash.insertPayload(handle, payload, {
                projectId: target.id,
                targetFolderId: targetFolderId
            });

            // 前置接口（第十轮第 3 节）：目录上指向的那几个接口，换成目标项目里的
            rewritePreflights(handle, target.id, inserted.folders, inserted.idMap);

            if (move) {
                if (kind === 'api') {
                    // 和 DELETE /apis/:id 一个写法：同一个事务里先记回收站再删
                    trash.captureApi(handle, source, req.user);
                    var folderId = source.folderId;
                    apisRepo.remove(handle, source.id);
                    apisRepo.setPositionsIn(handle, tree.apiIds(handle, source.projectId, folderId));
                } else {
                    trash.captureFolder(handle, source, 'delete', req.user);
                    tree.removeFolder(handle, source.id, 'delete');
                }
            }

            return inserted;
        }, { projectId: null });   // 两个项目都变了，让所有 store 都刷新（见 lib/db/index.js）

        respond.ok(res, {
            projectId: target.id,
            projectName: target.name,
            folderId: targetFolderId,
            folderName: folderNameOf(targetFolderId),
            folderIds: outcome.folders.map(function (item) { return item.id; }),
            apiIds: outcome.apis.map(function (item) { return item.id; }),
            apiCount: outcome.apis.length,
            folderCount: outcome.folders.length,
            move: move
        });
    }

    router.post('/apis/:id/copy', guard('viewer', byParam('api')), respond.wrap(function (req, res) {
        copyNode(req, res, 'api');
    }));

    router.post('/folders/:id/copy', guard('viewer', byParam('folder')), respond.wrap(function (req, res) {
        copyNode(req, res, 'folder');
    }));

    /**
     * 测试集也跟着复制（第八轮第 1 节）。
     *
     * 步骤里存的是 `apiId`，所以**必须换成新项目里那些接口的 id** —— 不换的话新项目里
     * 每个步骤都是「接口已删除」。接口在复制时被过滤掉的步骤直接去掉（那种步骤留着也跑不了）。
     * 步骤自己的断言 / 提取 / 等待 / 失败策略原样带过去。
     */
    function copySuites(handle, sourceProjectId, targetProjectId, apiIdMap) {
        suitesRepo.list(handle, sourceProjectId).forEach(function (suite) {
            var steps = (suite.steps || []).map(function (step) {
                var mapped = apiIdMap[String(step.apiId)];
                if (!mapped) return null;
                return Object.assign({}, step, { apiId: mapped });
            }).filter(function (step) { return Boolean(step); });

            suitesRepo.create(handle, targetProjectId, {
                name: suite.name,
                description: suite.description,
                steps: steps,
                data: suite.data,
                settings: suite.settings
            });
        });
    }

    /**
     * 项目 `extra` 里**该带过去**的部分。
     *
     * 不带 `openapiSources`：那是「这个项目从哪份文档同步过」的记录，里面的 folderId
     * 指的是**原项目**的目录，带过去就成了指向不存在目录的垃圾。
     * 别的（Mock 环境改过的变量、公共请求头、前置接口）都跟着走 ——
     * 前置接口的 `apiId` 由 `rewritePreflights` 换成新项目里那个。
     */
    function copyExtra(extra) {
        var source = extra && typeof extra === 'object' ? extra : {};
        var next = Object.assign({}, source);
        delete next.openapiSources;
        return next;
    }

    /**
     * 前置接口（第十轮第 3 节）指向的是**项目里的某个接口**：复制到别的项目之后那个 id
     * 就不存在了。
     *
     * 换成新项目里对应的那一个；**没跟着复制过去的就整块去掉** —— 留着一个指向
     * 「接口已删除」的引用，发送时只会得到一句莫名其妙的报错，用户根本不知道是谁配的。
     * （`apiId` 为 null 是「这个目录下显式不用前置接口」，和 id 无关，原样带过去。）
     */
    function rewritePreflight(extra, idMap) {
        var source = extra && typeof extra === 'object' ? extra : {};
        if (source.preflight === undefined) return null;

        var preflight = dto.toPreflight(source.preflight);

        // 显式「这个目录下不用前置接口」和 id 无关，原样带过去
        if (preflight && !preflight.apiId) return Object.assign({}, source, { preflight: preflight });

        if (preflight) {
            var mapped = idMap[preflight.apiId];
            // 指向的接口也跟着复制过去了：换成新 id
            if (mapped) return Object.assign({}, source, { preflight: Object.assign({}, preflight, { apiId: mapped }) });
        }

        // 指向的接口没复制过去（或者那一段本来就是坏的）：整块去掉，回到「跟着上层走」
        var withoutPreflight = Object.assign({}, source);
        delete withoutPreflight.preflight;
        return withoutPreflight;
    }

    /**
     * 把新项目（或复制过去的那批目录）上的前置接口设置重写一遍。
     *
     * 目录从库里重新读一遍：`insertPayload` 返回的是**原始行**（`extra` 还是 JSON 字符串），
     * 直接改它改不到点子上。
     *
     * @param {Array<string|object>} folders 目录 id，或者带 `id` 的对象（`insertPayload` 的返回值）
     */
    function rewritePreflights(handle, projectId, folders, idMap) {
        var project = projectsRepo.getById(handle, projectId);
        if (project) {
            var projectExtra = rewritePreflight(project.extra, idMap);
            if (projectExtra) projectsRepo.update(handle, projectId, { extra: projectExtra });
        }

        (folders || []).forEach(function (item) {
            var id = typeof item === 'string' ? item : (item && item.id);
            var folder = id ? foldersRepo.get(handle, id) : null;
            if (!folder) return;

            var folderExtra = rewritePreflight(folder.extra, idMap);
            if (folderExtra) foldersRepo.update(handle, folder.id, { extra: folderExtra });
        });
    }

    /**
     * 复制为新项目（整个项目）。
     *
     * **能看就能复制一份给自己**（viewer 也行）—— 复制出来的是自己的新项目，不动源项目。
     *
     * 带过去：目录 / 接口 / 示例 / Mock 期望 / 环境 / 项目变量 / 公共请求头 / 鉴权和脚本。
     * **不带**：成员（新项目只有你一个 owner）、历史、分享链接、评论、保密值 ——
     * 保密变量的**名字**在（变量行照样复制），值是空的：值本来就只存在各自那里
     * （`secret_values`），从来不在共享数据里。
     */
    router.post('/projects/:pid/duplicate', guard('viewer', byPid), respond.wrap(function (req, res) {
        var source = req.project;
        var body = req.body || {};
        var name = dto.str(body.name).trim() || (source.name + ' 副本');

        var created = handle.transaction(function () {
            var project = projectsRepo.create(handle, {
                name: name,
                description: source.description,
                variables: source.variables,
                auth: source.auth,
                scripts: source.scripts,
                extra: copyExtra(source.extra),
                created_by: req.user ? req.user.id : null
            });

            // 新项目里只有自己一个 owner（成员不复制）
            access.addOwner(handle, project.id, req.user && req.user.id);

            var inserted = trash.insertPayload(handle, trash.collectAll(handle, source.id), {
                projectId: project.id,
                targetFolderId: null
            });
            // 前置接口（第十轮第 3 节）：项目 / 目录上指向的接口换成新项目里的那些
            rewritePreflights(handle, project.id, inserted.folders, inserted.idMap);
            trash.insertEnvironments(handle, project.id, trash.collectEnvironments(handle, source.id));
            // 测试集也带过去（第八轮第 1 节）：步骤里的 apiId 要换成新项目里那些接口的 id
            copySuites(handle, source.id, project.id, inserted.idMap || {});

            return projectsRepo.getById(handle, project.id);
        }, { projectId: null });

        respond.ok(res, { project: dto.toProjectDto(created, ctx, req.user) });
    }));

    return router;
}

module.exports = {
    createRouter: createRouter
};
