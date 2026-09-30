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
     * 目录上的脚本无处可存：folders 表没有 scripts 列，契约的 Folder DTO 也没有
     * 这个字段（项目与接口都有，只有目录缺一个）。这里不偷偷塞进 extra，而是
     * 明确告诉用户丢了多少 —— 静默丢数据比报错更难排查。
     */
    function countFolderScripts(nodes) {
        var total = 0;
        (nodes || []).forEach(function (node) {
            if (!node || node.type !== 'folder') return;
            if (Array.isArray(node.scripts)) total += node.scripts.length;
            total += countFolderScripts(node.children);
        });
        return total;
    }

    /** 项目变量与 Globals 合并，同名的覆盖 */
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
        var warnings = parsed.warnings.slice();

        // 目录脚本存不下这件事在两种模式下都会发生，所以预览阶段就先说 ——
        // 等导完再告诉用户「你的脚本丢了」，那时已经晚了。
        var folderScripts = parsed.kind === 'collection'
            ? countFolderScripts(parsed.collection.children)
            : 0;
        if (folderScripts > 0) {
            warnings.push('有 ' + folderScripts + ' 个脚本挂在目录上，而目录没有存放脚本的地方，导入时会丢弃');
        }

        // 只是看一眼，不写库
        respond.ok(res, {
            kind: parsed.kind,
            name: parsedName(parsed),
            stats: parsed.stats,
            warnings: warnings
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
            var folderScripts = countFolderScripts(collection.children);
            if (folderScripts > 0) {
                warnings.push('有 ' + folderScripts + ' 个脚本挂在目录上，而目录没有存放脚本的地方，已丢弃');
            }

            if (mode === 'into') {
                var target = resolveTargetProject(body.projectId);

                // into 模式下集合级的脚本本该落在那个同名目录上，而目录没有脚本列
                if (Array.isArray(collection.scripts) && collection.scripts.length) {
                    warnings.push('集合上有 ' + collection.scripts.length +
                        ' 个脚本，目录没有存放脚本的地方，已丢弃');
                }

                // into 模式：建一个与集合同名的顶层目录，集合上的 auth / variables /
                // extra 都存到这个目录上
                project = handle.transaction(function () {
                    var folder = foldersRepo.create(handle, target.id, {
                        name: collection.name,
                        description: collection.description,
                        parentId: null,
                        auth: collection.auth,
                        variables: collection.variables,
                        extra: collection.extra,
                        position: foldersRepo.nextPositionIn(handle, target.id, null)
                    });
                    tree.writeTree(handle, target.id, folder.id, collection.children);
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
                    tree.writeTree(handle, created.id, null, collection.children);
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
