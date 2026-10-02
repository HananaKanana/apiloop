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
var guardModule = require('./guard');
var importCollectionModule = require('./import-collection');
var tree = require('../tree');
var postman = require('../postman');
var projectsRepo = require('../db/repos/projects');
var environmentsRepo = require('../db/repos/environments');

function createRouter(ctx) {
    var handle = ctx.handle;
    var router = express.Router();

    var g = guardModule.createGuard(ctx);
    var guard = g.guard;
    var byPid = g.byPid;
    var byParam = g.byParam;

    // collection 的写库逻辑和 HAR 导入共用，见 lib/api/import-collection.js
    var importer = importCollectionModule.createCollectionImporter(ctx);

    function parseText(text) {
        if (!text || !String(text).trim()) {
            throw respond.apiError(400, '请粘贴 JSON 文件内容');
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
            var mode = body.mode === 'into' ? 'into' : 'new';
            var written = importer.importCollection(req, parsed.collection, mode);
            project = written.project;
            warnings = warnings.concat(written.warnings);
        } else if (parsed.kind === 'environment') {
            var envTarget = importer.resolveTargetProject(req);

            project = handle.transaction(function () {
                environmentsRepo.create(handle, envTarget.id, {
                    name: parsed.environment.name,
                    variables: parsed.environment.variables
                });
                return envTarget;
            }, { projectId: envTarget.id });
        } else {
            // globals：并入项目变量，同名的覆盖
            var globalsTarget = importer.resolveTargetProject(req);

            project = handle.transaction(function () {
                return projectsRepo.update(handle, globalsTarget.id, {
                    variables: mergeVariables(globalsTarget.variables, parsed.environment.variables)
                });
            }, { projectId: globalsTarget.id });
        }

        respond.ok(res, {
            project: dto.toProjectDto(projectsRepo.getById(handle, project.id), ctx, req.user),
            stats: parsed.stats,
            warnings: warnings
        });
    }));

    /* ---------------------------------------------------------- 导出 */

    router.get('/projects/:pid/export/postman', guard('viewer', byPid), respond.wrap(function (req, res) {
        var project = req.project;

        var collection = tree.readTree(handle, project.id);
        var skipped = 0;

        /**
         * Postman 的集合格式里没有 WebSocket 接口（契约第 17 节），导出时跳过它们。
         * 静默丢掉的话，用户会以为导出是完整的 —— 所以回一条 warnings 说明少了几个。
         */
        function withoutWs(node) {
            var children = (node.children || []).map(function (child) {
                if (child.type === 'api' && String(child.method || '').toUpperCase() === 'WS') {
                    skipped += 1;
                    return null;
                }
                if (child.type === 'folder') return withoutWs(child);
                return child;
            }).filter(Boolean);

            return Object.assign({}, node, { children: children });
        }

        var payload = {
            filename: safeFileName(project.slug) + '.collection.json',
            json: JSON.stringify(postman.toCollection(withoutWs(collection)), null, 2)
        };
        if (skipped > 0) {
            payload.warnings = [skipped + ' 个 WebSocket 接口没有导出：集合的 JSON 格式里没有 WebSocket'];
        }

        respond.ok(res, payload);
    }));

    router.get('/environments/:id/export/postman', guard('viewer', byParam('environment')), respond.wrap(function (req, res) {
        var environment = environmentsRepo.get(handle, req.params.id);
        if (!environment) throw respond.apiError(404, '环境不存在：' + req.params.id);

        respond.ok(res, {
            filename: safeFileName(environment.name) + '.environment.json',
            json: JSON.stringify(postman.toEnvironment(environment), null, 2)
        });
    }));

    return router;
}

module.exports = {
    createRouter: createRouter
};
