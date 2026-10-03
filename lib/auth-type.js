/**
 * 鉴权继承的解析（契约第 5 节第 2 步）。
 *
 * 「接口自己 → 所在目录 → 各级父目录 → 项目」第一个真正配置过的生效 —— 和发送时
 * `lib/api/send.js` 的 `inheritAuth` 同一套规则。两处各写一份的话迟早会不一致
 * （分享文档里显示「无鉴权」、导出 OpenAPI 里少一个 securityScheme），所以提到这里共用。
 *
 * **找到 `noauth` 也算找到**：它的意思正是「不加鉴权」，继续往上找会把上层目录的鉴权
 * 又捞回来，和用户写的相反。
 */

var foldersRepo = require('./db/repos/folders');

/** 目录链最多爬这么多层：数据万一成环也不能把请求转死 */
var MAX_DEPTH = 64;

/**
 * 这个接口实际用的鉴权对象（含 `type`，apikey 还有 `in`）。没有就返回 null。
 *
 * @param {object} handle
 * @param {object} project 项目行（project.auth）
 * @param {object} api 接口行（api.auth / api.folderId）
 * @returns {object|null}
 */
function resolveAuthOf(handle, project, api) {
    var own = api && api.auth;
    if (own && own.type && own.type !== 'inherit') return own;

    // 从接口所在目录往上：越靠前越近，第一个配过的就是它
    var current = api && api.folderId ? foldersRepo.get(handle, api.folderId) : null;
    var depth = 0;

    while (current && depth++ < MAX_DEPTH) {
        var auth = current.auth;
        if (auth && auth.type && auth.type !== 'inherit') return auth;
        current = current.parentId ? foldersRepo.get(handle, current.parentId) : null;
    }

    var projectAuth = project && project.auth;
    if (projectAuth && projectAuth.type && projectAuth.type !== 'inherit') return projectAuth;
    return null;
}

/**
 * 只要类型的那一份（分享文档、历史那一类只关心「是 bearer 还是 basic」）。
 *
 * @returns {string|null} `'bearer'` / `'basic'` / `'apikey'` / `'noauth'` / null
 */
function authTypeOf(handle, project, api) {
    var auth = resolveAuthOf(handle, project, api);
    return auth ? auth.type : null;
}

module.exports = {
    resolveAuthOf: resolveAuthOf,
    authTypeOf: authTypeOf,
    MAX_DEPTH: MAX_DEPTH
};
