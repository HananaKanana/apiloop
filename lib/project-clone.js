/**
 * 把一个「内容包」装进一个项目里（第十四轮从 `lib/api/copy.js` 提出来）。
 *
 * 两件事本来就是同一件，只是内容从哪来、装到哪个项目不同：
 *
 *   - `POST /projects/:pid/duplicate`（第六轮第 3 节）：把**现有项目**的目录 / 接口 /
 *     示例 / Mock 期望 / 环境 / 测试集复制到一个**新项目**里；
 *   - `POST /backup/restore`（第十四轮）：把**一份备份文件**里的同样几样东西装进一个
 *     新项目（`mode: 'new'`）或者覆盖一个现有项目（`mode: 'overwrite'`）。
 *
 * 中间那一段 —— 换新 id、重写前置接口引用、把测试集步骤的 `apiId` 换成新项目里的 ——
 * 一个字都不该有两份，所以集中在这里。
 *
 * **核心仍然复用回收站那一套**（`lib/trash.js`）：`insertPayload` 按原始行插、换新 id、
 * 跟着改内部引用（`parent_id` / `folder_id` / `mock_example_id` / `example_id`）。
 * 于是「复制出来的」「恢复出来的」形状一定一致。
 *
 * **这里的函数一律不开事务**，由调用方包 `handle.transaction` —— 和 `lib/trash.js` 一个规矩。
 */

var dto = require('./api/dto');
var access = require('./access');
var trash = require('./trash');
var projectsRepo = require('./db/repos/projects');
var foldersRepo = require('./db/repos/folders');
var suitesRepo = require('./db/repos/suites');

/**
 * 项目 `extra` 里**该带过去**的部分。
 *
 * 不带 `openapiSources`：那是「这个项目从哪份文档同步过」的记录，里面的 folderId
 * 指的是**原项目**的目录，带过去就成了指向不存在目录的垃圾。
 * 别的（Mock 环境改过的变量、公共请求头、前置接口）都跟着走 ——
 * 前置接口的 `apiId` 由 `rewritePreflights` 换成新项目里那个。
 */
function copyExtra(extra) {
    var source = extra && typeof extra === 'object' ? extra : {};
    var next = Object.assign({}, source);
    delete next.openapiSources;
    return next;
}

/**
 * 前置接口（第十轮第 3 节）指向的是**项目里的某个接口**：复制 / 恢复到另一个项目之后
 * 那个 id 就不存在了。
 *
 * 换成新项目里对应的那一个；**没跟着复制过去的就整块去掉** —— 留着一个指向
 * 「接口已删除」的引用，发送时只会得到一句莫名其妙的报错，用户根本不知道是谁配的。
 * （`apiId` 为 null 是「这个目录下显式不用前置接口」，和 id 无关，原样带过去。）
 */
function rewritePreflight(extra, idMap) {
    var source = extra && typeof extra === 'object' ? extra : {};
    if (source.preflight === undefined) return null;

    var preflight = dto.toPreflight(source.preflight);

    // 显式「这个目录下不用前置接口」和 id 无关，原样带过去
    if (preflight && !preflight.apiId) return Object.assign({}, source, { preflight: preflight });

    if (preflight) {
        var mapped = idMap[preflight.apiId];
        // 指向的接口也跟着复制过去了：换成新 id
        if (mapped) return Object.assign({}, source, { preflight: Object.assign({}, preflight, { apiId: mapped }) });
    }

    // 指向的接口没复制过去（或者那一段本来就是坏的）：整块去掉，回到「跟着上层走」
    var withoutPreflight = Object.assign({}, source);
    delete withoutPreflight.preflight;
    return withoutPreflight;
}

/**
 * 把新项目（或复制过去的那批目录）上的前置接口设置重写一遍。
 *
 * 目录从库里重新读一遍：`insertPayload` 返回的是**原始行**（`extra` 还是 JSON 字符串），
 * 直接改它改不到点子上。
 *
 * @param {Array<string|object>} folders 目录 id，或者带 `id` 的对象（`insertPayload` 的返回值）
 */
function rewritePreflights(handle, projectId, folders, idMap) {
    var project = projectsRepo.getById(handle, projectId);
    if (project) {
        var projectExtra = rewritePreflight(project.extra, idMap);
        if (projectExtra) projectsRepo.update(handle, projectId, { extra: projectExtra });
    }

    (folders || []).forEach(function (item) {
        var id = typeof item === 'string' ? item : (item && item.id);
        var folder = id ? foldersRepo.get(handle, id) : null;
        if (!folder) return;

        var folderExtra = rewritePreflight(folder.extra, idMap);
        if (folderExtra) foldersRepo.update(handle, folder.id, { extra: folderExtra });
    });
}

/**
 * 插入测试集，并**把步骤里的 `apiId` 换成新项目里那些接口的 id**（第八轮第 1 节）。
 *
 * 不换的话新项目里每个步骤都是「接口已删除」。接口没跟着过来的步骤直接去掉
 * （那种步骤留着也跑不了）；步骤自己的断言 / 提取 / 等待 / 失败策略原样带过去。
 *
 * @param {Array<{name, description, steps, data, settings}>} suites **已经解析过的**测试集
 *   （`suitesRepo.list` 的返回值，或者备份文件里解析出来的那一份）
 */
function insertSuites(handle, projectId, suites, idMap) {
    (suites || []).forEach(function (suite) {
        var steps = (suite.steps || []).map(function (step) {
            var mapped = idMap && idMap[String(step.apiId)];
            if (!mapped) return null;
            return Object.assign({}, step, { apiId: mapped });
        }).filter(function (step) { return Boolean(step); });

        suitesRepo.create(handle, projectId, {
            name: suite.name,
            description: suite.description,
            steps: steps,
            data: suite.data,
            settings: suite.settings
        });
    });
}

/**
 * 把一份内容装进**已经存在**的项目里。
 *
 * 顺序：目录 / 接口 / 示例 / 期望（一次 `insertPayload`）→ 前置接口重写 → 环境 → 测试集。
 * 环境必须排在目录 / 接口后面吗？不必 —— 它们之间没有引用关系，只是照 `rows.ORDER`
 * 的父子顺序来，读起来顺。
 *
 * @param {{payload: object, environments?: Array, suites?: Array}} input
 * @returns {{folders: Array, apis: Array, idMap: object}} `insertPayload` 的结果
 */
function insertContent(handle, projectId, input) {
    var options = input || {};

    var inserted = trash.insertPayload(handle, options.payload, {
        projectId: projectId,
        targetFolderId: null
    });

    // 前置接口（第十轮第 3 节）：项目 / 目录上指向的接口换成新项目里的那些
    rewritePreflights(handle, projectId, inserted.folders, inserted.idMap);
    trash.insertEnvironments(handle, projectId, options.environments || []);
    insertSuites(handle, projectId, options.suites || [], inserted.idMap || {});

    return inserted;
}

/**
 * 建一个新项目，再把一份内容装进去。
 *
 * **新项目里只有 `ownerId` 一个人是 owner**（成员不复制 / 不恢复）。
 * 保密变量的**名字**在（变量行照样带），值是空的：值本来就只存在各自那里
 * （`secret_values` 表），从来不在共享数据里，也不进备份文件。
 *
 * @param {{name: string, description?: string, variables?: Array, auth?: object,
 *          scripts?: Array, extra?: object, ownerId?: string, payload: object,
 *          environments?: Array, suites?: Array}} input
 *   `variables` / `auth` / `scripts` / `extra` 是**已经解析过的 JS 值**（不是 JSON 字符串）——
 *   `projectsRepo.create` 自己会序列化。
 * @returns {object} 新建的项目（`projectsRepo.getById` 的结果）
 */
function createProjectWithContent(handle, input) {
    var options = input || {};

    var project = projectsRepo.create(handle, {
        name: options.name,
        description: options.description,
        variables: options.variables,
        auth: options.auth,
        scripts: options.scripts,
        extra: copyExtra(options.extra),
        created_by: options.ownerId || null
    });

    access.addOwner(handle, project.id, options.ownerId);
    insertContent(handle, project.id, options);

    return projectsRepo.getById(handle, project.id);
}

module.exports = {
    copyExtra: copyExtra,
    rewritePreflight: rewritePreflight,
    rewritePreflights: rewritePreflights,
    insertSuites: insertSuites,
    insertContent: insertContent,
    createProjectWithContent: createProjectWithContent
};
