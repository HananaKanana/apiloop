/**
 * 「把一棵 collection 写成一个项目」的公共实现（契约第 6 节的 collection 分支）。
 *
 * 抽出来是为了让 Postman 导入和 HAR 导入走**同一段**写库逻辑：事务边界、mock 设置、
 * 权限、目录结构只要有一处不同，两边就会慢慢分叉。规则本身在 lib/tree.js 的
 * `writeTree`，这里只负责「导到哪里、开事务、把 warnings 带回去」。
 *
 * 注意这条路由**没有挂 guard** —— 「导到哪个项目」是它自己从 body 里读的，所以探测面
 * 也得它自己堵，见 `resolveTargetProject` 的注释。
 */

var respond = require('./respond');
var access = require('../access');
var tree = require('../tree');
var commonHeaders = require('../common-headers');
var projectsRepo = require('../db/repos/projects');
var foldersRepo = require('../db/repos/folders');

function createCollectionImporter(ctx) {
    var handle = ctx.handle;

    /**
     * 「导入到哪里」的项目。
     *
     * `into` 模式要求调用者至少是目标项目的 editor。
     *
     * 项目找不到、和「项目在但我不是成员」，必须给出**完全一样**的响应，连文案都不能
     * 差一个字，否则拿 projectId 扫一遍就能试出哪个项目存在。
     *
     * 契约第 6 节规定这一步用 400（「缺少 projectId，或者 projectId 找不到」），所以
     * 「不是成员」也归进同一支，而不是第 10 节那种 404。
     */
    function resolveTargetProject(req) {
        var projectId = (req.body || {}).projectId;
        if (!projectId) throw respond.apiError(400, '请指定要导入到哪个项目');

        var project = projectsRepo.getById(handle, String(projectId));
        var role = project ? access.roleOf(handle, req.user, project.id) : null;

        if (!project || !role) throw respond.apiError(400, '项目不存在：' + projectId);

        // 到这一步已经确定「项目在、我也在里面」，角色不够可以放心说 403。
        if (!access.atLeast(role, 'editor')) {
            throw respond.apiError(403, '需要 editor 权限');
        }

        return project;
    }

    /**
     * 把 collection 写进项目，**整个导入是一个事务**：导到一半出错时项目不能留下半截。
     *
     * @param {object} req 用来取 projectId 和当前用户
     * @param {object} collection `{ name, description, variables, auth, scripts, extra, children }`
     * @param {'new'|'into'} mode
     * @returns {{project: object, warnings: string[]}}
     */
    function importCollection(req, collection, mode) {
        var warnings = [];

        if (mode === 'into') {
            var target = resolveTargetProject(req);

            // into 模式：建一个与集合同名的顶层目录，集合上的 auth / variables /
            // scripts / extra 都存到这个目录上（公共请求头也一并落到 extra.headers）
            var intoProject = handle.transaction(function () {
                var folder = foldersRepo.create(handle, target.id, {
                    name: collection.name,
                    description: collection.description,
                    parentId: null,
                    auth: collection.auth,
                    variables: collection.variables,
                    scripts: collection.scripts,
                    extra: commonHeaders.withHeaders(collection.extra, collection.headers),
                    position: foldersRepo.nextPositionIn(handle, target.id, null)
                });
                var written = tree.writeTree(handle, target.id, folder.id, collection.children);
                warnings = warnings.concat(written.warnings);
                return target;
            }, { projectId: target.id });

            return { project: intoProject, warnings: warnings };
        }

        // new 模式：新建一个项目。事务的 projectId 传 null —— 它影响所有项目
        // （新建项目会让 slug 映射变化）
        var created = handle.transaction(function () {
            var project = projectsRepo.create(handle, {
                name: collection.name,
                description: collection.description,
                variables: collection.variables,
                auth: collection.auth,
                scripts: collection.scripts,
                // 公共请求头（第五轮第 1 节）：文件里是自己的字段名，读回来存进 extra.headers
                extra: commonHeaders.withHeaders(collection.extra, collection.headers),
                created_by: req.user ? req.user.id : null
            });
            // 和 POST /projects 一样：导入者自动成为新项目的 owner
            access.addOwner(handle, project.id, req.user ? req.user.id : null);
            var written = tree.writeTree(handle, project.id, null, collection.children);
            warnings = warnings.concat(written.warnings);
            return project;
        }, { projectId: null });

        return { project: created, warnings: warnings };
    }

    return {
        resolveTargetProject: resolveTargetProject,
        importCollection: importCollection
    };
}

module.exports = {
    createCollectionImporter: createCollectionImporter
};
