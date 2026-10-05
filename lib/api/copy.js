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
var cloneModule = require('../project-clone');
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
            cloneModule.rewritePreflights(handle, target.id, inserted.folders, inserted.idMap);

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
     * 复制测试集、项目 `extra` 的处理、前置接口引用的重写，都搬到了
     * `lib/project-clone.js`（第十四轮）—— 「备份恢复」要做的是同一件事，
     * 两处各留一份迟早会对不上。这里只保留「往哪个项目复制」这一段。
     */

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
            return cloneModule.createProjectWithContent(handle, {
                name: name,
                description: source.description,
                variables: source.variables,
                auth: source.auth,
                scripts: source.scripts,
                extra: source.extra,
                ownerId: req.user ? req.user.id : null,
                payload: trash.collectAll(handle, source.id),
                environments: trash.collectEnvironments(handle, source.id),
                // 测试集也带过去（第八轮第 1 节）：步骤里的 apiId 由 project-clone 换成新项目里那些
                suites: suitesRepo.list(handle, source.id)
            });
        }, { projectId: null });

        respond.ok(res, { project: dto.toProjectDto(created, ctx, req.user) });
    }));

    return router;
}

module.exports = {
    createRouter: createRouter
};
