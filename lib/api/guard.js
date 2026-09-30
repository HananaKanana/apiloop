/**
 * 项目权限拦截（契约第 10 节）。
 *
 * 一个中间件工厂：每条跟项目有关的路由，在它的 handler 之前挂上
 * `guard(level, locate)`。三层判断，顺序不能换：
 *
 *   1. `locate` 找不到资源 → 404；
 *   2. 资源不属于调用者参与的任何项目（`roleOf` 返回 null）→ **也是 404**；
 *   3. 是成员但角色不够 → 403「需要 <level> 权限」。
 *
 * 第 2 条和第 1 条必须长得一模一样：只要两种情况的响应有半点差别，拿 id 挨个试
 * 就能问出「这个项目/接口存在，只是我看不到」。所以信息都用同一句「<资源>不存在」。
 *
 * 通过之后把 `req.project` 与 `req.role` 挂到请求上，后面的 handler 直接用，
 * 不必再查一遍。
 *
 * 为什么是 `createGuard(ctx)` 而不是直接导出 `guard`：判定角色要能查库，而
 * handle 只有拿到 ctx 才有。调用形式仍然是 `guard(level, locate)`：
 *
 *   var g = require('./guard').createGuard(ctx);
 *   router.get('/apis/:id', g.guard('viewer', g.byParam('api')), handler);
 */

var dto = require('./dto');
var respond = require('./respond');
var access = require('../access');
var projectsRepo = require('../db/repos/projects');

/** 资源类型 → 报错时给用户看的名字。文案要和接口本身的说法一致 */
var KIND_LABELS = {
    folder: '目录',
    api: '接口',
    example: '示例',
    environment: '环境',
    expectation: '期望',
    history: '历史',
    cookie: 'Cookie'
};

function createGuard(ctx) {
    var handle = ctx.handle;

    /**
     * @param {'viewer'|'editor'|'owner'} level 这条路由要求的最低角色
     * @param {Function} locate (req) => projectId | null；带一个 label 属性说明资源名
     */
    function guard(level, locate) {
        var label = (locate && locate.label) || '项目';

        return function (req, res, next) {
            var projectId = null;
            try {
                projectId = locate ? locate(req) : null;
            } catch (err) {
                return next(err);
            }

            var project = projectId ? projectsRepo.getById(handle, projectId) : null;
            var role = project ? access.roleOf(handle, req.user, project.id) : null;

            if (!project || !role) return respond.fail(res, 404, label + '不存在');
            if (!access.atLeast(role, level)) {
                return respond.fail(res, 403, '需要 ' + level + ' 权限');
            }

            req.project = project;
            req.role = role;
            next();
        };
    }

    /** 路径参数 `:pid`，id 或 slug 都收（和 dto.findProject 一个口径） */
    function byPid(req) {
        var project = dto.findProject(handle, req.params.pid);
        return project ? project.id : null;
    }
    byPid.label = '项目';

    /**
     * 用路径参数 `:id` 定位某个资源，再反查它属于哪个项目。
     * 这一步不能省：`/examples/:id` 光看 id 是不知道属于谁的，
     * 少了它就是一个「拿别人项目里的 exampleId 就能改」的口子。
     */
    function byParam(kind) {
        var locate = function (req) {
            return access.projectIdOf(handle, kind, req.params.id);
        };
        locate.label = KIND_LABELS[kind] || '资源';
        return locate;
    }

    /**
     * 挂在根路径的那个项目。旧版管理台接口（/routes、/groups、/export…）
     * 全部只作用在它身上，所以统一用它定位。
     */
    function rootProject() {
        return ctx.rootProjectId || null;
    }
    rootProject.label = '项目';

    return {
        guard: guard,
        byPid: byPid,
        byParam: byParam,
        rootProject: rootProject
    };
}

module.exports = {
    createGuard: createGuard,
    KIND_LABELS: KIND_LABELS
};
