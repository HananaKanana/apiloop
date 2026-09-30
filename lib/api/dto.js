/**
 * repo 行对象 → 接口 DTO，以及入参清洗。
 *
 * 为什么要多这一层：repo 返回的是**表的形状**，接口给的是**契约的形状**，两者并不相同 ——
 * 契约里的 Project 有 `isRoot`（跟进程有关，库里没有），又刻意不要 `scripts` / `extra`
 * （前端用不上）；Api 要把 apis 的平铺列收进一个 `mock: {...}` 子对象。
 * 把这些差异集中在这里，路由文件就只剩「校验 + 调 repo + 回 DTO」。
 *
 * 另一件事是**入参清洗**：客户端传来的数组和对象一律不可信，行列形状、布尔列都要
 * 规整过再写库，否则脏数据会一层层流到前端。
 */

var projectsRepo = require('../db/repos/projects');

function str(value) {
    if (value === null || value === undefined) return '';
    return String(value);
}

/**
 * 变量行：`{ key, value, enabled, secret?, desc? }`。
 * 空 key 的行没有意义，直接丢掉 —— 界面上新建一行还没填名字是常事。
 */
function toVarRows(list) {
    if (!Array.isArray(list)) return [];

    var rows = [];
    list.forEach(function (item) {
        if (!item || typeof item !== 'object') return;

        var key = str(item.key);
        if (!key) return;

        var row = { key: key, value: str(item.value), enabled: item.enabled !== false };
        if (item.secret) row.secret = true;
        if (item.desc) row.desc = str(item.desc);
        rows.push(row);
    });
    return rows;
}

/** 只留下能安全 JSON 化的键；不是对象就当没传 */
function plainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

    var result = {};
    Object.keys(value).forEach(function (key) {
        var item = value[key];
        if (item === undefined || typeof item === 'function') return;
        result[key] = item;
    });
    return result;
}

/** 鉴权：`null | { type, ... }`。没有 type 的不认，避免存进去一个没法用的对象 */
function toAuth(value) {
    var auth = plainObject(value);
    if (!auth || !auth.type) return null;
    return auth;
}

/** 扩展字段：各层没被映射到的原始字段，原样存 */
function toExtra(value) {
    return plainObject(value) || {};
}

/**
 * 项目 DTO。`scripts` 与 `extra` 是给导入导出用的，界面上不展示，不往外发。
 * `isRoot` 表示在这个进程里挂在根路径（而不是 /mock/<slug>）。
 */
function toProjectDto(project, ctx) {
    if (!project) return null;
    return {
        id: project.id,
        slug: project.slug,
        name: project.name,
        description: project.description,
        sourceDir: project.sourceDir,
        isDefault: project.isDefault,
        isRoot: !!ctx && ctx.rootProjectId === project.id,
        variables: toVarRows(project.variables),
        auth: project.auth || null,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt
    };
}

function toEnvironmentDto(environment) {
    if (!environment) return null;
    return {
        id: environment.id,
        projectId: environment.projectId,
        name: environment.name,
        position: environment.position,
        variables: toVarRows(environment.variables)
    };
}

/**
 * 按 id 或 slug 找项目。
 *
 * 契约里路径参数叫 `:pid`，没说是不是 slug；两种都收，因为 /meta 的 rootProject
 * 同时给了 id 和 slug，前端抓着哪个都能用。
 */
function findProject(handle, pid) {
    var key = str(pid);
    if (!key) return null;
    return projectsRepo.getById(handle, key) || projectsRepo.getBySlug(handle, key);
}

module.exports = {
    str: str,
    toVarRows: toVarRows,
    toAuth: toAuth,
    toExtra: toExtra,
    plainObject: plainObject,
    toProjectDto: toProjectDto,
    toEnvironmentDto: toEnvironmentDto,
    findProject: findProject
};
