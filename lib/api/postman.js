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
var sendApi = require('./send');
var tree = require('../tree');
var postman = require('../postman');
var secrets = require('../secrets');
var authInherit = require('../auth-type');
var openapiExport = require('../openapi-export');
var projectsRepo = require('../db/repos/projects');
var environmentsRepo = require('../db/repos/environments');
var foldersRepo = require('../db/repos/folders');
var apisRepo = require('../db/repos/apis');
var examplesRepo = require('../db/repos/examples');

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

    // 新路径叫 json（用户 2026-10-02：界面和文档里不出现 Postman）；老路径留着，已装的旧客户端还在用
    router.post(['/import/json/preview', '/import/postman/preview'], respond.wrap(function (req, res) {
        var parsed = parseText((req.body || {}).text);

        // 只是看一眼，不写库
        respond.ok(res, {
            kind: parsed.kind,
            // 认出来的是哪种文件（postman / yapi / apifox）：界面上要说一句，
            // 用户经常不知道自己拿到的是什么格式（第九轮第 1 节）
            format: parsed.format || 'postman',
            name: parsedName(parsed),
            stats: parsed.stats,
            warnings: parsed.warnings.slice()
        });
    }));

    /* ---------------------------------------------------------- 导入 */

    router.post(['/import/json', '/import/postman'], respond.wrap(function (req, res) {
        var body = req.body || {};
        var parsed = parseText(body.text);
        var warnings = parsed.warnings.slice();
        var project = null;

        if (parsed.kind === 'collection') {
            var mode = body.mode === 'into' ? 'into' : 'new';
            var written = importer.importCollection(req, parsed.collection, mode);
            project = written.project;
            warnings = warnings.concat(written.warnings);

            /*
             * Apifox 的导出里环境和接口在同一个文件（第九轮第 1 节）：集合建好之后
             * 顺手把环境也建出来。放进同一个事务的下一段，出错时上面那次已经提交了 ——
             * 但环境建不上不影响接口，所以不把两件事绑在一起。
             */
            if (parsed.environments && parsed.environments.length) {
                var envTarget = project;
                handle.transaction(function () {
                    parsed.environments.forEach(function (env) {
                        environmentsRepo.create(handle, envTarget.id, {
                            name: env.name,
                            variables: env.variables
                        });
                    });
                    return envTarget;
                }, { projectId: envTarget.id });
            }
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

        /**
         * 导入的数据里 `type: 'secret'` 是**带明文的**（Postman 文件就是这么存的）。
         * 上面三条路都是直接写库、不经「保存变量」的接口，所以这里补一刀：把保密行的值
         * 收进各自的 `secret_values`、共享数据里留空（见 lib/secrets.js）。
         */
        if (req.user) secrets.splitAll(handle, req.user.id, project.id);

        respond.ok(res, {
            project: dto.toProjectDto(projectsRepo.getById(handle, project.id), ctx, req.user),
            stats: parsed.stats,
            warnings: warnings
        });
    }));

    /* ---------------------------------------------------------- 导出 */

    router.get(['/projects/:pid/export/json', '/projects/:pid/export/postman'], guard('viewer', byPid), respond.wrap(function (req, res) {
        var project = req.project;

        var collection = tree.readTree(handle, project.id);
        var skipped = 0;

        /**
         * Postman 的集合格式里没有 WebSocket 接口（契约第 17 节），导出时跳过它们。
         * 静默丢掉的话，用户会以为导出是完整的 —— 所以回一条 warnings 说明少了几个。
         */
        function withoutWs(node) {
            var children = (node.children || []).map(function (child) {
                var childMethod = child.type === 'api' ? String(child.method || '').toUpperCase() : '';
                // SIO（第九轮第 4 节）和 WS 一样不在集合格式里；
                // GRPC（第十一轮第 1 节）、MQTT（第十三轮）、TCP / UDP（第十五轮）也一样，一起跳过
                if (childMethod === 'WS' || childMethod === 'SIO' ||
                    childMethod === 'GRPC' || childMethod === 'MQTT' ||
                    childMethod === 'TCP' || childMethod === 'UDP') {
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
            payload.warnings = [skipped + ' 个 WebSocket / Socket.IO / gRPC / MQTT / TCP / UDP 接口没有导出：集合的 JSON 格式里没有它们'];
        }

        respond.ok(res, payload);
    }));

    router.get(['/environments/:id/export/json', '/environments/:id/export/postman'], guard('viewer', byParam('environment')), respond.wrap(function (req, res) {
        var environment = environmentsRepo.get(handle, req.params.id);
        if (!environment) throw respond.apiError(404, '环境不存在：' + req.params.id);

        respond.ok(res, {
            filename: safeFileName(environment.name) + '.environment.json',
            json: JSON.stringify(postman.toEnvironment(environment), null, 2)
        });
    }));

    /**
     * 导出 OpenAPI（第四轮第 2 节）。
     *
     * 转换规则一个字都不在这个文件里 —— 全在 `lib/openapi-export.js`（纯函数）。
     * 这里只做三件事：划定范围（整个项目 / 某个目录连同子目录）、把库里的东西读成
     * 那个纯函数要的形状、把结果拼成可下载的文本。
     *
     * 下载方式和 `export/json` 一样：`{ filename, text }`，前端自己生成 Blob。
     */
    router.get('/projects/:pid/export/openapi', guard('viewer', byPid), respond.wrap(function (req, res) {
        var project = req.project;
        var query = req.query || {};
        var format = String(query.format || 'yaml').toLowerCase() === 'json' ? 'json' : 'yaml';

        var folderId = query.folderId === undefined || query.folderId === null || String(query.folderId) === ''
            ? null
            : String(query.folderId);
        var folder = folderId ? foldersRepo.get(handle, folderId) : null;
        if (folderId && (!folder || folder.projectId !== project.id)) {
            throw respond.apiError(400, '目录不存在或不属于这个项目');
        }

        // 范围：目录（连同子目录）或整个项目
        var folders = folder
            ? [folder].concat(tree.descendants(handle, project.id, folder.id))
            : foldersRepo.list(handle, project.id);

        var ids = {};
        folders.forEach(function (item) { ids[item.id] = true; });

        var apis = apisRepo.list(handle, project.id).filter(function (api) {
            return folder ? ids[api.folderId] === true : true;
        });

        // 公共请求头的继承和发送时同一套规则（见 lib/common-headers.js）
        var shared = sendApi.createShared(ctx);

        var built = openapiExport.buildDocument({
            title: folder ? project.name + ' - ' + folder.name : project.name,
            description: project.description,
            folders: folders.map(function (item) {
                // 只给纯函数要的三样，别的（auth / variables）不进文档
                return { id: item.id, parentId: item.parentId, name: item.name };
            }),
            apis: apis.map(function (api) {
                return {
                    id: api.id,
                    folderId: api.folderId,
                    name: api.name,
                    description: api.description,
                    method: api.method,
                    url: api.url,
                    params: api.params,
                    body: api.body,
                    // 鉴权按发送时的规则往上找，**只给类型相关的部分**，值不进文档
                    auth: authInherit.resolveAuthOf(handle, project, api),
                    // 项目 / 目录上配的公共请求头也导成 header 参数（被接口自己盖掉的不算）
                    inheritedHeaders: shared.resolveHeaders(project, api.id, (api.params || {}).headers).inherited,
                    // 响应字段说明（第六轮第 2 节）：导出时按路径贴到响应 schema 的属性上
                    responseFields: dto.apiResponseFieldsOf(api),
                    examples: examplesRepo.listByApi(handle, api.id).map(function (item) {
                        return {
                            name: item.name,
                            status: item.status,
                            body: item.body,
                            responseType: item.responseType
                        };
                    })
                };
            })
        });

        respond.ok(res, {
            filename: safeFileName(folder ? folder.name : project.name) + '.openapi.' + format,
            format: format,
            text: openapiExport.toText(built.doc, format, built.skipped)
        });
    }));

    return router;
}

module.exports = {
    createRouter: createRouter
};
