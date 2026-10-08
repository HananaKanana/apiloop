/**
 * 项目备份与恢复（第十四轮）。
 *
 * 三件事：
 *
 *   - `build`：把一个项目打包成一份 JSON（接口的 `GET /projects/:pid/backup` 就是它）。
 *     打包的是**同步用的那种原始行**（下划线列名、JSON 列保持字符串），所以恢复时能直接
 *     交给 `lib/trash.js` 的 `insertPayload` —— 和「复制为新项目」是同一套。
 *   - `parse`：校验一份备份文件、把内部引用对不上的地方**说出来**（不是整体失败）。
 *   - `restore`：装进一个新项目（`new`）或者覆盖一个现有项目（`overwrite`）。
 *
 * 三件容易想歪的事：
 *
 * 1. **保密变量的值不进备份**。行留着（key、`secret: true`），值一律写空串；
 *    `secret_values` 表本来就不导出。新格式的共享数据里保密行的值本来就是空的
 *    （见 `lib/secrets.js`），这里再显式清一遍是给**升级前的老数据**兜底 ——
 *    那时候标了保密的行的值还留在共享 JSON 里。
 * 2. **不带**：成员、分享链接、评论、历史、回收站、运行记录、Cookie、个人偏好。
 *    回收站的 `trash` 表是同步实体，备份里放进去只会在另一端插出重复记录。
 * 3. **overwrite 不删测试集进回收站**（第十四轮的主管结论）：回收站的 `kind` 有
 *    CHECK 约束（只有 folder / api / environment），加一种 kind 要重建 trash 表，
 *    而老客户端的 CHECK 不认新值、同步下去会插入失败。所以测试集**直接删除**，
 *    返回里给一个 `deletedSuites` 计数；界面（T20）在覆盖之前会先自动下载一份当前
 *    项目的备份，测试集在那一份里。
 *
 * 引用对不上（接口指向不存在的目录、测试集步骤指向不存在的接口……）**不整体失败**：
 * 该丢的丢、该落到根目录的落根目录，把每一处都写进 `warnings` 让用户自己看。
 */

var path = require('path');

var respond = require('./api/respond');
var dto = require('./api/dto');
var i18n = require('./i18n');
var json = require('./db/json');
var rows = require('./sync/rows');
var secrets = require('./secrets');
var trash = require('./trash');
var clone = require('./project-clone');
var access = require('./access');
var projectsRepo = require('./db/repos/projects');
var foldersRepo = require('./db/repos/folders');
var apisRepo = require('./db/repos/apis');
var environmentsRepo = require('./db/repos/environments');
var suitesRepo = require('./db/repos/suites');

/** 备份文件的身份：`format` 不对就当「不是我们的文件」，`version` 管兼容 */
var FORMAT = 'apiloop-backup';
var VERSION = 1;

/** 恢复的两种模式 */
var MODES = ['new', 'overwrite'];

function apiError(status, message) {
    return respond.apiError(status, message);
}

/** 当前应用版本，写进备份方便排查（读不到就算了） */
function appVersion() {
    try {
        return String(require(path.join(__dirname, '..', 'package.json')).version || '');
    } catch (err) {
        return '';
    }
}

/* ------------------------------------------------------------------ 导出 */

/**
 * 把变量列（JSON 字符串）里的保密行值清空。
 *
 * 行本身留着 —— 「这个项目有这么一个保密变量、值是空的」这件事要跟着备份走，
 * 不然恢复出来的人根本不知道要填哪几个。解析不了的原文照旧（脏数据不该让导出失败）。
 */
function blankSecrets(variablesText) {
    if (variablesText === null || variablesText === undefined || variablesText === '') return variablesText;

    var parsed;
    try {
        parsed = JSON.parse(variablesText);
    } catch (err) {
        return variablesText;
    }
    if (!Array.isArray(parsed)) return variablesText;

    var touched = false;
    var next = parsed.map(function (row) {
        if (!row || typeof row !== 'object' || row.secret !== true) return row;
        if (row.value === '' || row.value === undefined || row.value === null) return row;
        touched = true;
        return Object.assign({}, row, { value: '' });
    });

    return touched ? JSON.stringify(next) : variablesText;
}

function blankFolderSecrets(row) {
    return Object.assign({}, row, { variables: blankSecrets(row.variables) });
}

/**
 * 打包一个项目。
 *
 * @param {object} handle
 * @param {string} projectId
 * @returns {object} 备份文件的内容（可以直接 JSON.stringify）
 */
function build(handle, projectId) {
    var project = rows.get(handle, 'project', projectId);
    if (!project) throw apiError(404, i18n.m('项目不存在'));

    return {
        format: FORMAT,
        version: VERSION,
        exportedAt: Date.now(),
        appVersion: appVersion(),
        project: {
            id: project.id,
            name: project.name,
            description: project.description,
            variables: blankSecrets(project.variables),
            // 鉴权和脚本界面上可编辑，跟着走；`slug` / `created_by` 这些服务端自己决定的列不带
            auth: project.auth,
            scripts: project.scripts,
            extra: project.extra
        },
        folders: rows.list(handle, 'folder', projectId).map(blankFolderSecrets),
        apis: rows.list(handle, 'api', projectId),
        examples: rows.list(handle, 'example', projectId),
        expectations: rows.list(handle, 'expectation', projectId),
        environments: rows.list(handle, 'environment', projectId).map(blankFolderSecrets),
        suites: rows.list(handle, 'suite', projectId)
    };
}

/**
 * 项目名 → 能进文件名的样子。
 *
 * 非法字符去掉（文件名里不能有 `/`、`:` 之类），字符数也不放任 ——
 * 一个超长项目名会让某些系统直接拒绝保存。
 */
function safeFileName(projectName) {
    return String(projectName === undefined || projectName === null ? '' : projectName)
        .replace(/[/\\:*?"<>|\u0000-\u001f]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 60);
}

/** 文件名：`apiloop-<项目名>-<yyyyMMdd-HHmm>.json` */
function fileName(projectName, ts) {
    var stamp = new Date(Number(ts) || Date.now());
    var pad = function (n) { return String(n).padStart(2, '0'); };
    var when = stamp.getFullYear() + pad(stamp.getMonth() + 1) + pad(stamp.getDate()) +
        '-' + pad(stamp.getHours()) + pad(stamp.getMinutes());

    return 'apiloop-' + (safeFileName(projectName) || i18n.m('项目')) + '-' + when + '.json';
}

/**
 * `Content-Disposition` 的值。
 *
 * 中文文件名没法放进 `filename=`（老浏览器按 latin-1 解，出来是乱码），所以按
 * RFC 5987 再给一份 `filename*`：`filename=` 只留 ASCII 兜底，`filename*` 给真正的名字。
 */
function disposition(name) {
    var ascii = String(name).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    return 'attachment; filename="' + ascii + '"; filename*=UTF-8\'\'' + encodeURIComponent(name);
}

/* ------------------------------------------------------------------ 校验 */

function toArray(value, label, warnings) {
    if (value === undefined || value === null) return [];
    if (Array.isArray(value)) return value.filter(function (item) { return item && typeof item === 'object'; });

    warnings.push(label + i18n.m('不是数组，已忽略'));
    return [];
}

function labelOf(row, fallback) {
    var name = dto.str(row && row.name).trim();
    return name || fallback;
}

/**
 * 校验一份备份文件。
 *
 * 只挡「这不是我们的文件」和「来自更新的版本」这两种；**内部引用对不上不报错**，
 * 逐条记进 `warnings`，让用户看到「哪几个东西没恢复出来」。
 *
 * @returns {{project: object, folders: Array, apis: Array, examples: Array, expectations: Array,
 *            environments: Array, suites: Array, warnings: string[]}}
 */
function parse(input) {
    var source = input && typeof input === 'object' && !Array.isArray(input) ? input : null;
    if (!source) throw apiError(400, i18n.m('这不是 apiloop 的备份文件'));

    if (dto.str(source.format) !== FORMAT) throw apiError(400, i18n.m('这不是 apiloop 的备份文件'));

    var version = Number(source.version);
    // 版本号读不出来也当「不是我们的文件」—— 一个连版本都不写的 JSON 说明不了来路
    if (!Number.isFinite(version) || version < 1) {
        throw apiError(400, i18n.m('这不是 apiloop 的备份文件'));
    }
    if (version > VERSION) throw apiError(400, i18n.m('备份来自更新的版本，请先升级'));

    var project = dto.plainObject(source.project);
    if (!project) throw apiError(400, i18n.m('这不是 apiloop 的备份文件'));

    var warnings = [];
    var folders = toArray(source.folders, i18n.m('目录'), warnings);
    var apis = toArray(source.apis, i18n.m('接口'), warnings);
    var examples = toArray(source.examples, i18n.m('示例'), warnings);
    var expectations = toArray(source.expectations, i18n.m('期望'), warnings);
    var environments = toArray(source.environments, i18n.m('环境'), warnings);
    var suites = toArray(source.suites, i18n.m('测试集'), warnings);

    /* -------- 目录：父目录不在备份里就落到项目根目录 -------- */
    var folderIds = {};
    folders.forEach(function (folder) { folderIds[String(folder.id)] = true; });

    folders.forEach(function (folder) {
        var parentId = folder.parent_id;
        if (!parentId || folderIds[String(parentId)]) return;
        warnings.push(i18n.m('目录「{name}」的上级目录不在备份里，已放到项目根目录',
            { name: labelOf(folder, i18n.m('未命名目录')) }));
    });

    /* -------- 接口：目录不在就落到根目录 -------- */
    var apiIds = {};
    apis.forEach(function (api) { apiIds[String(api.id)] = true; });

    apis.forEach(function (api) {
        var folderId = api.folder_id;
        if (!folderId || folderIds[String(folderId)]) return;
        warnings.push(i18n.m('接口「{name}」所在的目录不在备份里，已放到项目根目录',
            { name: labelOf(api, i18n.m('未命名接口')) }));
    });

    /* -------- 示例 / 期望：所属接口不在就整条丢掉（插回去也是一个孤儿） -------- */
    var exampleIds = {};
    var keptExamples = examples.filter(function (example) {
        if (apiIds[String(example.api_id)]) {
            exampleIds[String(example.id)] = true;
            return true;
        }
        warnings.push(i18n.m('示例「{name}」所属的接口不在备份里，已跳过',
            { name: labelOf(example, i18n.m('未命名示例')) }));
        return false;
    });

    var keptExpectations = expectations.filter(function (expectation) {
        if (apiIds[String(expectation.api_id)]) return true;
        warnings.push(i18n.m('Mock 期望「{name}」所属的接口不在备份里，已跳过',
            { name: labelOf(expectation, i18n.m('未命名期望')) }));
        return false;
    });

    apis.forEach(function (api) {
        var exampleId = api.mock_example_id;
        if (!exampleId || exampleIds[String(exampleId)]) return;
        warnings.push(i18n.m('接口「{name}」指定用于 Mock 的示例不在备份里，Mock 已关掉',
            { name: labelOf(api, i18n.m('未命名接口')) }));
    });

    /* -------- 测试集：步骤指向的接口不在就丢掉那一步 -------- */
    var keptSuites = suites.map(function (suite) {
        var steps = json.readJson(suite.steps, []);
        if (!Array.isArray(steps)) steps = [];

        var dropped = 0;
        var kept = steps.filter(function (step) {
            if (step && apiIds[String(step.apiId)]) return true;
            dropped += 1;
            return false;
        });

        if (dropped) {
            warnings.push(i18n.m('测试集「') + labelOf(suite, i18n.m('未命名测试集')) + i18n.m('」里有 ') + dropped +
                i18n.m(' 个步骤指向的接口不在备份里，已去掉'));
        }
        return Object.assign({}, suite, { steps: kept });
    });

    return {
        project: project,
        folders: folders,
        apis: apis,
        examples: keptExamples,
        expectations: keptExpectations,
        environments: environments,
        suites: keptSuites,
        warnings: warnings
    };
}

/* ------------------------------------------------------------------ 恢复 */

/** 备份里的原始行 → `insertPayload` / `insertSuites` 吃的形状 */
function payloadOf(parsed) {
    return {
        folder: parsed.folders,
        api: parsed.apis,
        example: parsed.examples,
        expectation: parsed.expectations
    };
}

/**
 * 测试集：原始行的 `steps` / `data` / `settings` 是 JSON 字符串，`suitesRepo.create`
 * 要的是对象，这里转一下（和 `suitesRepo.get` 读出来的形状一致）。
 */
function suitesForInsert(parsed) {
    return parsed.suites.map(function (suite) {
        return {
            name: suite.name,
            description: suite.description,
            // `parse` 里已经把步骤过了一遍（丢掉指向不存在接口的），所以这里可能已经是数组
            steps: Array.isArray(suite.steps) ? suite.steps : json.readJson(suite.steps, []),
            data: suite.data === null || suite.data === undefined ? null : json.readJson(suite.data, null),
            settings: json.readJson(suite.settings, {})
        };
    });
}

/** 备份里的项目字段 → `projectsRepo.create` / `update` 吃的 JS 值 */
function projectFields(project) {
    return {
        name: dto.str(project.name).trim() || i18n.m('恢复的项目'),
        description: dto.str(project.description),
        variables: json.readJson(project.variables, []),
        auth: json.readJson(project.auth, null),
        scripts: json.readJson(project.scripts, []),
        extra: json.readJson(project.extra, {})
    };
}

/** `mode: 'new'`：建一个新项目装进去。**任何登录用户都能做**（动的是自己的新项目） */
function restoreAsNew(handle, input, parsed) {
    var fields = projectFields(parsed.project);
    var name = dto.str(input.name).trim() || (fields.name + i18n.m('（恢复）'));

    var created = handle.transaction(function () {
        return clone.createProjectWithContent(handle, {
            name: name,
            description: fields.description,
            variables: fields.variables,
            auth: fields.auth,
            scripts: fields.scripts,
            extra: fields.extra,
            ownerId: input.userId || null,
            payload: payloadOf(parsed),
            environments: parsed.environments,
            suites: suitesForInsert(parsed)
        });
    }, { projectId: null });

    return { project: created, warnings: parsed.warnings };
}

/**
 * `mode: 'overwrite'`：拿备份覆盖一个现有项目。
 *
 * **只有这个项目的 owner（或系统管理员）能做** —— 这一步会把项目里现有的东西
 * 全部换掉，editor 不够。
 *
 * 顺序：现有目录 / 接口 / 环境**记回收站**（能救回来，用现有那套函数）→ 删干净 →
 * 项目行按备份更新 → 装备份里的内容。测试集不回回收站（见文件头第 3 条），
 * 直接删、返回 `deletedSuites` 计数。**整个写库在一个事务里**，中途失败全部回滚。
 *
 * 成员、分享链接、评论、历史、Cookie 都不动 —— 覆盖的是「项目里的接口内容」，
 * 不是这个项目的身份。
 */
function restoreOverwrite(handle, input, parsed) {
    var project = projectsRepo.getById(handle, input.projectId);
    if (!project) throw apiError(404, i18n.m('项目不存在：{id}', { id: dto.str(input.projectId) }));

    var role = access.roleOf(handle, input.user, project.id);
    if (!access.atLeast(role, 'owner')) {
        throw apiError(403, i18n.m('覆盖恢复需要这个项目的 owner 权限'));
    }

    var fields = projectFields(parsed.project);

    var outcome = handle.transaction(function () {
        var trashed = { folders: 0, apis: 0, environments: 0 };

        /* 1. 现在的内容进回收站。
         *    顶层目录**整棵子树收一条**（还原时一次就能把整棵树拉回来），根目录下那些
         *    不在任何目录里的接口逐个收 —— 两批合起来正好覆盖全部，不会重复。 */
        foldersRepo.list(handle, project.id).forEach(function (folder) {
            if (folder.parentId) return;
            trash.captureFolder(handle, folder, 'delete', input.user);
            trashed.folders += 1;
        });

        var rootApis = apisRepo.list(handle, project.id).filter(function (api) { return !api.folderId; });
        rootApis.forEach(function (api) {
            trash.captureApi(handle, api, input.user);
            trashed.apis += 1;
        });

        var environments = environmentsRepo.list(handle, project.id);
        environments.forEach(function (environment) {
            trash.captureEnvironment(handle, environment, input.user);
            trashed.environments += 1;
        });

        /* 2. 删干净。接口先删 —— `apis.folder_id` 是 SET NULL，先删目录会把接口丢到根目录，
         *    那时再逐个删要多走一遍，而且回收站里已经记过它们了。 */
        var folderIds = foldersRepo.list(handle, project.id).map(function (folder) { return folder.id; });
        apisRepo.list(handle, project.id).forEach(function (api) { apisRepo.remove(handle, api.id); });
        folderIds.forEach(function (id) { foldersRepo.remove(handle, id); });
        environments.forEach(function (environment) { environmentsRepo.remove(handle, environment.id); });

        // 目录 / 环境的保密值跟着清掉（和删目录那条路一样，见 lib/api/tree.js）
        folderIds.forEach(function (id) { secrets.forgetScope(handle, 'folder', id); });
        environments.forEach(function (environment) {
            secrets.forgetScope(handle, 'environment', environment.id);
        });

        /* 3. 测试集直接删（回收站不支持这个 kind），数量报给调用方 */
        var oldSuites = suitesRepo.list(handle, project.id);
        oldSuites.forEach(function (suite) { suitesRepo.remove(handle, suite.id); });

        /* 4. 项目自己的字段用备份里的（成员 / 分享不动） */
        projectsRepo.update(handle, project.id, fields);

        /* 5. 把备份的内容装进来 */
        clone.insertContent(handle, project.id, {
            payload: payloadOf(parsed),
            environments: parsed.environments,
            suites: suitesForInsert(parsed)
        });

        return { trashed: trashed, deletedSuites: oldSuites.length };
    }, { projectId: project.id });

    return {
        project: projectsRepo.getById(handle, project.id),
        trashed: outcome.trashed,
        deletedSuites: outcome.deletedSuites,
        warnings: parsed.warnings
    };
}

/**
 * 恢复。
 *
 * @param {object} input `{ backup, mode, name?, projectId?, userId?, user? }`
 *   `user` 用来判权限和记回收站的 `deleted_by`，`userId` 是它的 id（新建项目时记 owner）
 * @returns {{project: object, warnings: string[], trashed?: object, deletedSuites?: number}}
 */
function restore(handle, input) {
    var options = input || {};
    var mode = options.mode === undefined || options.mode === null || options.mode === ''
        ? 'new'
        : dto.str(options.mode);
    if (MODES.indexOf(mode) === -1) throw apiError(400, i18n.m('mode 只能是 new 或 overwrite'));

    var parsed = parse(options.backup);

    if (mode === 'overwrite') return restoreOverwrite(handle, options, parsed);
    return restoreAsNew(handle, options, parsed);
}

module.exports = {
    FORMAT: FORMAT,
    VERSION: VERSION,
    MODES: MODES,
    build: build,
    parse: parse,
    restore: restore,
    safeFileName: safeFileName,
    fileName: fileName,
    disposition: disposition
};
