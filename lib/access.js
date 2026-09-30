/**
 * 项目权限的判定（契约第 10 节）。
 *
 * 这里只回答两个问题，不做拦截：
 *   1. 某个用户在某个项目里是什么角色（`roleOf`）；
 *   2. 某个资源属于哪个项目（`projectIdOf`）。
 *
 * 拦截在 lib/api/guard.js —— 分开是因为前者是纯计算、谁都能调（列表过滤、DTO 的
 * myRole 都要用），后者操心 HTTP 状态码。
 *
 * **admin 是系统角色，不在成员表里**：它对所有项目都返回 `'admin'`，
 * 权限上等同于 owner（ROLE_RANK 里 rating 最高）。这样「管理员还没被加进任何项目」
 * 也不会把自己锁在门外。
 */

var membersRepo = require('./db/repos/members');
var projectsRepo = require('./db/repos/projects');
var foldersRepo = require('./db/repos/folders');
var apisRepo = require('./db/repos/apis');
var examplesRepo = require('./db/repos/examples');
var environmentsRepo = require('./db/repos/environments');
var expectationsRepo = require('./db/repos/expectations');
var historyRepo = require('./db/repos/history');

var ROLE_RANK = { viewer: 1, editor: 2, owner: 3, admin: 4 };

/** 资源的类型名 → 反查所属项目的方式 */
var KINDS = ['folder', 'api', 'example', 'environment', 'expectation', 'history'];

/**
 * @param {object} handle
 * @param {object|null} user req.user
 * @param {string} projectId
 * @returns {'admin'|'owner'|'editor'|'viewer'|null} 不是成员就是 null
 */
function roleOf(handle, user, projectId) {
    if (!user || !projectId) return null;
    if (user.role === 'admin') return 'admin';

    var member = membersRepo.get(handle, projectId, user.id);
    return member ? member.role : null;
}

/** 角色够不够。role 为 null（不是成员）永远不够 */
function atLeast(role, level) {
    var rank = ROLE_RANK[role];
    var need = ROLE_RANK[level];
    if (!rank || !need) return false;
    return rank >= need;
}

/**
 * 把一个资源反查到它所属的项目 id。查不到返回 null。
 *
 * 示例和期望自己不存项目 id，要先经过所属的 api 绕一次 —— 这一层不能省，
 * 否则「拿别人项目里的 exampleId 调用 /examples/:id」就是一个越权口子。
 *
 * @param {string} kind 'folder' | 'api' | 'example' | 'environment' | 'expectation' | 'history'
 */
function projectIdOf(handle, kind, id) {
    if (!id || KINDS.indexOf(kind) === -1) return null;

    if (kind === 'folder') {
        var folder = foldersRepo.get(handle, id);
        return folder ? folder.projectId : null;
    }
    if (kind === 'api') {
        var api = apisRepo.get(handle, id);
        return api ? api.projectId : null;
    }
    if (kind === 'environment') {
        var environment = environmentsRepo.get(handle, id);
        return environment ? environment.projectId : null;
    }
    if (kind === 'history') {
        var entry = historyRepo.get(handle, id);
        return entry ? entry.projectId : null;
    }

    var apiId = null;
    if (kind === 'example') {
        var example = examplesRepo.get(handle, id);
        apiId = example ? example.apiId : null;
    } else {
        var expectation = expectationsRepo.get(handle, id);
        apiId = expectation ? expectation.apiId : null;
    }
    if (!apiId) return null;

    var owner = apisRepo.get(handle, apiId);
    return owner ? owner.projectId : null;
}

/**
 * 建项目、导入旧配置时把创建者写成 owner。
 * userId 为空时什么也不做 —— 首次启动（还没有任何用户）就会走到这一支。
 */
function addOwner(handle, projectId, userId) {
    if (!projectId || !userId) return;
    membersRepo.upsert(handle, projectId, userId, 'owner');
}

/**
 * 启动时兜一次：凡是**一个 owner 都没有**的项目，补给最早创建的 admin。
 *
 * 为什么需要它：项目可能在「还没有任何用户」的时候建出来 —— `apiloop init` 就是
 * 这种情况（它先建项目、后由 `apiloop web` 建管理员），那时没人能当 owner。
 * 迁移 v4 只处理升级那一刻的存量项目，管不到这种之后新建的。
 *
 * 一个人都没有的项目留在库里并不致命（admin 照样看得到），但契约要求
 * 「任何操作都不能让一个项目的 owner 变成 0 个」，这里把它收拢到同一个口径上。
 *
 * @returns {number} 补了几个项目
 */
function fillMissingOwners(handle, userId) {
    if (!userId) return 0;

    var fixed = 0;
    projectsRepo.list(handle).forEach(function (project) {
        if (membersRepo.countOwners(handle, project.id) > 0) return;
        addOwner(handle, project.id, userId);
        fixed++;
    });
    return fixed;
}

module.exports = {
    ROLE_RANK: ROLE_RANK,
    roleOf: roleOf,
    atLeast: atLeast,
    projectIdOf: projectIdOf,
    addOwner: addOwner,
    fillMissingOwners: fillMissingOwners
};
