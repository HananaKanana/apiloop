/**
 * Postman 导入导出（契约第 6 节）。
 *
 * 解析与生成都在 lib/postman.js，目录树的读写都在 lib/tree.js，这里只负责
 * 「决定导到哪里、开事务、拼响应」。
 *
 * 整个导入**必须是一个事务**：导到一半出错（比如第 50 个接口写库失败）时，
 * 项目不能留下半截 —— 半个项目比导不进来更难收拾。
 */

var express = require('express');

var respond = require('./respond');
var dto = require('./dto');
var tree = require('../tree');
var postman = require('../postman');
var projectsRepo = require('../db/repos/projects');
var foldersRepo = require('../db/repos/folders');
var environmentsRepo = require('../db/repos/environments');

function createRouter(ctx) {
    var handle = ctx.handle;
    var router = express.Router();

    function parseText(text) {
        if (!text || !String(text).trim()) {
            throw respond.apiError(400, '请粘贴 Postman 文件内容');
        }
        try {
            return postman.parse(text);
        } catch (err) {
            // 解析失败是用户贴错了东西，不是服务端出错
            throw respond.apiError(400, err.message);
        }
    }

    function parsedName(parsed) {
        if (parsed.kind === 'collection') return parsed.collection.name;
        return parsed.environment.name;
    }

    /** 「导入到哪里」的项目：缺 projectId 或找不到都是 400 */
    function resolveTargetProject(projectId) {
        if (!projectId) throw respond.apiError(400, '请指定要导入到哪个项目');

        var project = projectsRepo.getById(handle, String(projectId));
        if (!project) throw respond.apiError(400, '项目不存在：' + projectId);
        return project;
    }

    /**
     * 项目变量与 Globals 合并，同名的覆盖
     */
    function mergeVariables(current, incoming) {
        var rows = (current || []).map(function (row) { return Object.assign({}, row); });

        (incoming || []).forEach(function (row) {
            if (!row || !row.key) return;

            var hit = null;
            for (var i = 0; i < rows.length; i++) {
                if (rows[i].key === row.key) { hit = rows[i]; break; }
            }

            if (hit) {
                hit.value = row.value;
                hit.enabled = row.enabled !== false;
                return;
            }
            rows.push(Object.assign({}, row));
        });

        return rows;
    }

    function safeFileName(name) {
        var cleaned = dto.str(name).replace(/[/\\:*?"<>|\u0000-\u001f]/g, '').trim();
        return cleaned || 'apiloop';
    }

    /* ---------------------------------------------------------- 预览 */

    router.post('/import/postman/preview', respond.wrap(function (req, res) {
        var parsed = parseText((req.body || {}).text);

        // 只是看一眼，不写库
        respond.ok(res, {
            kind: parsed.kind,
            name: parsedName(parsed),
            stats: parsed.stats,
            warnings: parsed.warnings.slice()
        });
    }));

    /* ---------------------------------------------------------- 导入 */

    router.post('/import/postman', respond.wrap(function (req, res) {
        var body = req.body || {};
        var parsed = parseText(body.text);
        var warnings = parsed.warnings.slice();
        var project = null;

        if (parsed.kind === 'collection') {
            var collection = parsed.collection;
            var mode = body.mode === 'into' ? 'into' : 'new';

            if (mode === 'into') {
                var target = resolveTargetProject(body.projectId);

                // into 模式：建一个与集合同名的顶层目录，集合上的 auth / variables /
                // scripts / extra 都存到这个目录上
                project = handle.transaction(function () {
                    var folder = foldersRepo.create(handle, target.id, {
                        name: collection.name,
                        description: collection.description,
                        parentId: null,
                        auth: collection.auth,
                        variables: collection.variables,
                        scripts: collection.scripts,
                        extra: collection.extra,
                        position: foldersRepo.nextPositionIn(handle, target.id, null)
                    });
                    var written = tree.writeTree(handle, target.id, folder.id, collection.children);
                    warnings = warnings.concat(written.warnings);
                    return target;
                }, { projectId: target.id });
            } else {
                // new 模式：新建一个项目。事务的 projectId 传 null —— 它影响所有项目
                // （新建项目会让 slug 映射变化）
                project = handle.transaction(function () {
                    var created = projectsRepo.create(handle, {
                        name: collection.name,
                        description: collection.description,
                        variables: collection.variables,
                        auth: collection.auth,
                        scripts: collection.scripts,
                        extra: collection.extra,
                        created_by: req.user ? req.user.id : null
                    });
                    var written = tree.writeTree(handle, created.id, null, collection.children);
                    warnings = warnings.concat(written.warnings);
                    return created;
                }, { projectId: null });
            }
        } else if (parsed.kind === 'environment') {
            var envTarget = resolveTargetProject(body.projectId);

            project = handle.transaction(function () {
                environmentsRepo.create(handle, envTarget.id, {
                    name: parsed.environment.name,
                    variables: parsed.environment.variables
                });
                return envTarget;
            }, { projectId: envTarget.id });
        } else {
            // globals：并入项目变量，同名的覆盖
            var globalsTarget = resolveTargetProject(body.projectId);

            project = handle.transaction(function () {
                return projectsRepo.update(handle, globalsTarget.id, {
                    variables: mergeVariables(globalsTarget.variables, parsed.environment.variables)
                });
            }, { projectId: globalsTarget.id });
        }

        respond.ok(res, {
            project: dto.toProjectDto(projectsRepo.getById(handle, project.id), ctx),
            stats: parsed.stats,
            warnings: warnings
        });
    }));

    /* ---------------------------------------------------------- 导出 */

    router.get('/projects/:pid/export/postman', respond.wrap(function (req, res) {
        var project = dto.findProject(handle, req.params.pid);
        if (!project) throw respond.apiError(404, '项目不存在：' + req.params.pid);

        var collection = tree.readTree(handle, project.id);

        respond.ok(res, {
            filename: safeFileName(project.slug) + '.postman_collection.json',
            json: JSON.stringify(postman.toCollection(collection), null, 2)
        });
    }));

    router.get('/environments/:id/export/postman', respond.wrap(function (req, res) {
        var environment = environmentsRepo.get(handle, req.params.id);
        if (!environment) throw respond.apiError(404, '环境不存在：' + req.params.id);

        respond.ok(res, {
            filename: safeFileName(environment.name) + '.postman_environment.json',
            json: JSON.stringify(postman.toEnvironment(environment), null, 2)
        });
    }));

    return router;
}

module.exports = {
    createRouter: createRouter
};
