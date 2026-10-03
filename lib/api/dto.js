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

var access = require('../access');
var respond = require('./respond');
var secrets = require('../secrets');
var projectsRepo = require('../db/repos/projects');

/** 请求体里允许出现的模式，和契约的 RequestSpec.body.mode 一致 */
var BODY_MODES = ['none', 'raw', 'urlencoded', 'formdata', 'binary', 'graphql'];

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
 * 参数 / 请求头 / 查询串的行：`{ key, value, type, required, desc, enabled }`。
 * 契约给了默认值，这里一律补全，前端不用自己兜底。
 */
function toRows(list) {
    if (!Array.isArray(list)) return [];

    var rows = [];
    list.forEach(function (item) {
        if (!item || typeof item !== 'object') return;

        var key = str(item.key);
        if (!key) return;

        rows.push({
            key: key,
            value: str(item.value),
            type: str(item.type) || 'string',
            required: item.required === true,
            desc: str(item.desc),
            enabled: item.enabled !== false
        });
    });
    return rows;
}

/** 表单行 = 普通行 + `kind`（text / file）与 `src`（本地文件路径，file 才有） */
function toFormRows(list) {
    if (!Array.isArray(list)) return [];

    var rows = [];
    list.forEach(function (item) {
        if (!item || typeof item !== 'object') return;

        var key = str(item.key);
        if (!key) return;

        // 不能拿 toRows 的结果再按下标回去找原对象：它会过滤掉空 key 的行，
        // 下标就对不上了，kind / src 会串到别的行上去。
        var kind = item.kind === 'file' ? 'file' : 'text';
        rows.push({
            key: key,
            value: str(item.value),
            type: str(item.type) || 'string',
            required: item.required === true,
            desc: str(item.desc),
            enabled: item.enabled !== false,
            kind: kind,
            src: kind === 'file' && item.src !== undefined && item.src !== null ? str(item.src) : null
        });
    });
    return rows;
}

/**
 * 请求体。只保留当前 mode 用得上的那几个字段 —— 切模式之后留着旧模式的残留，
 * 导出成 Postman 时会把两个模式的内容一起写出去。
 */
function toBody(value) {
    var body = plainObject(value) || {};
    var mode = BODY_MODES.indexOf(str(body.mode)) > -1 ? str(body.mode) : 'none';

    var result = { mode: mode };

    if (mode === 'raw') {
        result.raw = str(body.raw);
        result.language = str(body.language) || 'text';
    }
    if (mode === 'urlencoded' || mode === 'formdata') {
        result.form = toFormRows(body.form);
    }
    if (mode === 'binary') {
        var file = plainObject(body.file) || {};
        result.file = { src: file.src === undefined || file.src === null ? null : str(file.src) };
    }
    if (mode === 'graphql') {
        var graphql = plainObject(body.graphql) || {};
        result.graphql = { query: str(graphql.query), variables: str(graphql.variables) };
    }

    return result;
}

/** 请求参数三件套 */
function toParams(value) {
  var params = plainObject(value) || {};
  return {
    path: toRows(params.path),
    query: toRows(params.query),
    headers: toRows(params.headers)
  };
}

/* ------------------------------------------------------------------ 接口的状态与负责人 */

/**
 * 状态和负责人（第四轮第 1 节）存在 `apis.extra` 里，没占新列 —— 那一列本来就会同步，
 * 所以两台设备之间天然能对上，也不用动迁移。
 *
 * 取的时候**不认识的照原样给出去**：以后加了新状态，旧客户端至少不会把它弄丢
 * （界面按「未设置」显示，只有用户主动改过才会被换掉）。
 */
var API_STATUSES = ['designing', 'developing', 'done', 'deprecated'];

function extraOf(api) {
  var extra = api && api.extra;
  return extra && typeof extra === 'object' ? extra : {};
}

/** `apis.extra.status`，没设过是 null */
function apiStatusOf(api) {
  var value = extraOf(api).status;
  return typeof value === 'string' && value ? value : null;
}

/** `apis.extra.ownerId`，没设过是 null */
function apiOwnerOf(api) {
  var value = extraOf(api).ownerId;
  return typeof value === 'string' && value ? value : null;
}

/** 契约第 16 节：每段脚本最长 64KB */
var SCRIPT_MAX_BYTES = 64 * 1024;

/**
 * 读取路径用的脚本清洗：形状不对的丢掉就行。
 *
 * 库里可能存着写坏的行，读的时候宽容一点 —— 一条坏脚本不该让整个接口 500。
 * 写入路径要用 `toScriptsStrict`，那里的坏输入必须明确报 400。
 */
function toScripts(list) {
    if (!Array.isArray(list)) return [];

    var scripts = [];
    list.forEach(function (item) {
        if (!item || typeof item !== 'object') return;
        var listen = str(item.listen);
        if (listen !== 'prerequest' && listen !== 'test') return;
        scripts.push({ listen: listen, exec: str(item.exec) });
    });
    return scripts;
}

/**
 * 写入路径用的脚本校验（契约第 16 节）：不合法直接抛 400。
 *
 * 这里**不能**像读路径那样「把不认识的丢掉」—— 用户刚在编辑器里写完一段脚本，
 * 保存时被静默吞掉，他会以为存上了。
 */
function toScriptsStrict(value) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw respond.apiError(400, 'scripts 必须是数组');

    return value.map(function (item) {
        if (!item || typeof item !== 'object') {
            throw respond.apiError(400, '每段脚本必须是 { listen, exec } 对象');
        }

        var listen = str(item.listen);
        if (listen !== 'prerequest' && listen !== 'test') {
            throw respond.apiError(400, 'listen 只能是 prerequest 或 test，收到：' + (item.listen === undefined ? '空' : item.listen));
        }

        var exec = str(item.exec);
        if (Buffer.byteLength(exec, 'utf8') > SCRIPT_MAX_BYTES) {
            throw respond.apiError(400, '脚本最长 64KB，超出 ' +
                (Buffer.byteLength(exec, 'utf8') - SCRIPT_MAX_BYTES) + ' 字节');
        }

        return { listen: listen, exec: exec };
    });
}

/**
 * 变量行过一遍「保密变量」：把**当前用户自己的**值填回保密行。
 *
 * 共享数据里保密行的值是空串（值在 secret_values，见 lib/secrets.js），不填回去的话
 * 页面看到的就是空的 —— 自己填的值自己都看不到。别人调用时读不到（表里没有他的行），
 * 填出来仍是空串，正好就是「同事看到变量名、值是空的」。
 */
function withSecrets(handle, user, scope, scopeId, rows) {
  if (!handle || !user) return toVarRows(rows);
  return toVarRows(secrets.merge(handle, user.id, scope, scopeId, rows));
}

/**
 * 项目 / 目录的公共请求头（第五轮第 1 节）。
 *
 * 存在 `extra.headers` 里，行的形状和接口自己的请求头一样 —— 前端要能把两边直接拼起来，
 * 发送时也是同一套合并规则（见 `lib/common-headers.js`）。
 *
 * **这里不 require common-headers**：那个模块要用 dto 的 `toRows`，两头互相 require 会成环
 * （`module.exports = {}` 被后赋的新对象顶掉，拿到的是空壳）。读这一份读的是同一列，规则一致。
 */
function headersOf(entity) {
  var extra = entity && entity.extra;
  if (!extra || typeof extra !== 'object') return [];
  return toRows(extra.headers);
}

/** 目录 DTO：projectId 与 extra 是内部字段，前端用不上 */
function toFolderDto(folder, ctx, user) {
  if (!folder) return null;
  return {
    id: folder.id,
    parentId: folder.parentId,
    name: folder.name,
    description: folder.description,
    position: folder.position,
    auth: folder.auth || null,
    variables: withSecrets(ctx && ctx.handle, user, 'folder', folder.id, folder.variables),
    // 这个目录下的所有接口发送时都会带上的请求头（可被更内层 / 接口自己覆盖）
    headers: headersOf(folder),
    scripts: toScripts(folder.scripts)
  };
}

/** 示例 DTO。`extra` 是 Postman 往返用的，界面不展示，导出时直接查库拿 */
function toExampleDto(example) {
    if (!example) return null;
    return {
        id: example.id,
        apiId: example.apiId,
        name: example.name,
        position: example.position,
        status: example.status,
        headers: toRows(example.headers),
        body: example.body,
        responseType: example.responseType,
        isTemplate: example.isTemplate,
        source: example.source,
        createdAt: example.createdAt
    };
}

/** 期望 DTO。`conditions` 的形状由 lib/api/expectations.js 负责清洗 */
function toExpectationDto(expectation) {
    if (!expectation) return null;
    return {
        id: expectation.id,
        apiId: expectation.apiId,
        name: expectation.name,
        position: expectation.position,
        enabled: expectation.enabled,
        exampleId: expectation.exampleId,
        conditions: expectation.conditions
    };
}

/**
 * 项目成员 DTO（契约第 10 节）。
 * `projectId` 是 repo 那边的内部字段 —— 调用方本来就知道问的是哪个项目。
 */
function toMemberDto(member) {
    if (!member) return null;
    return {
        userId: member.userId,
        username: member.username,
        displayName: member.displayName,
        role: member.role,
        disabled: member.disabled
    };
}

/** 树上的接口条目：只够画侧边栏，不带请求体和示例 */
function toApiSummary(api) {
  if (!api) return null;
  return {
    id: api.id,
    folderId: api.folderId,
    name: api.name,
    method: api.method,
    url: api.url,
    position: api.position,
    mockEnabled: api.mockEnabled,
    mockPath: api.mockPath,
    // 目录树要画状态小色点、要按「我负责的」筛，所以这里就得带上
    status: apiStatusOf(api),
    ownerId: apiOwnerOf(api)
  };
}

/**
 * 完整接口：请求定义 + mock 配置 + 全部示例 + 全部期望。
 * `expectations` 由调用方按 position 排好传进来（repo 的 listByApi 已经排过）。
 */
function toApiDto(api, examples, expectations) {
    if (!api) return null;
    return {
        id: api.id,
        projectId: api.projectId,
        folderId: api.folderId,
        name: api.name,
        description: api.description,
        method: api.method,
        url: api.url,
        params: toParams(api.params),
        body: toBody(api.body),
        auth: api.auth || null,
        scripts: toScripts(api.scripts),
        mock: {
            enabled: api.mockEnabled,
            path: api.mockPath,
            delay: api.mockDelay,
            cors: api.mockCors,
            exampleId: api.mockExampleId
        },
        // 状态与负责人（第四轮第 1 节），存在 extra 里
        status: apiStatusOf(api),
        ownerId: apiOwnerOf(api),
        examples: (examples || []).map(toExampleDto),
        expectations: (expectations || []).map(toExpectationDto),
        createdAt: api.createdAt,
        updatedAt: api.updatedAt
    };
}

/**
 * 项目 DTO。`extra` 是给导入导出用的，界面上不展示，不往外发；`scripts` 现在可编辑，要发出去。
 * `isRoot` 表示在这个进程里挂在根路径（而不是 /mock/<slug>）。
 * `myRole` 是**调用者**在这个项目里的角色（契约第 10 节），前端据此决定哪些按钮能点。
 */
function toProjectDto(project, ctx, user) {
    if (!project) return null;
    return {
        id: project.id,
        slug: project.slug,
        name: project.name,
        description: project.description,
        sourceDir: project.sourceDir,
        isDefault: project.isDefault,
        isRoot: !!ctx && ctx.rootProjectId === project.id,
        myRole: ctx ? access.roleOf(ctx.handle, user, project.id) : null,
        variables: withSecrets(ctx && ctx.handle, user, 'project', project.id, project.variables),
        auth: project.auth || null,
        // 整个项目的接口发送时都会带上的请求头（可被目录 / 接口自己覆盖）
        headers: headersOf(project),
        scripts: toScripts(project.scripts),
        // 内置 Mock 环境改过的变量表（值里的 $MOCK_BASE 由页面换成 mock 地址）；没改过是 null
        mockVariables: project.extra && Array.isArray(project.extra.mockVariables)
            ? toVarRows(project.extra.mockVariables)
            : null,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt
    };
}

function toEnvironmentDto(environment, ctx, user) {
  if (!environment) return null;
  return {
    id: environment.id,
    projectId: environment.projectId,
    name: environment.name,
    position: environment.position,
    variables: withSecrets(ctx && ctx.handle, user, 'environment', environment.id, environment.variables)
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
    API_STATUSES: API_STATUSES,
    apiStatusOf: apiStatusOf,
    apiOwnerOf: apiOwnerOf,
    toRows: toRows,
    toFormRows: toFormRows,
    toBody: toBody,
    toParams: toParams,
    toScripts: toScripts,
    toScriptsStrict: toScriptsStrict,
    SCRIPT_MAX_BYTES: SCRIPT_MAX_BYTES,
    toAuth: toAuth,
    toExtra: toExtra,
    plainObject: plainObject,
    toProjectDto: toProjectDto,
    toEnvironmentDto: toEnvironmentDto,
    toFolderDto: toFolderDto,
    toExampleDto: toExampleDto,
    toExpectationDto: toExpectationDto,
    toMemberDto: toMemberDto,
    toApiSummary: toApiSummary,
    toApiDto: toApiDto,
    findProject: findProject
};
