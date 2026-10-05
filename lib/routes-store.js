/**
 * 单个项目的门面。
 *
 * 2.0 里这个门面已经很薄了：管理台改数据走 `lib/api/*`（按契约第 3 节直接操作 repo），
 * 这里只剩下「读一遍编译成 mock 路由」和「整批替换」这些 mock 运行时与 CLI 还要用的
 * 能力。旧版管理台专用的增删改查与分组管理方法**已经删掉** —— 留着没有调用方，
 * 只会让人以为还有第二条写入路径。
 *
 * 内部把「一条 route」拆成两张表存：
 *
 *   route  ──►  apis（接口定义：方法、路径、mock 开关……）
 *            └► examples（示例响应：状态码、响应头、响应体）
 *
 * 拆开是因为「示例」一处数据两用 —— 调试时它是保存下来的响应，mock 时它就是
 * 返回的数据，这是「调通即 mock」在数据模型上的落点。P1 阶段两者还是一对一，
 * 由 apis.mock_example_id 指向当前生效的那条。
 *
 * 分组对应顶层的 folders（parent_id 为 NULL），所以重命名分组天然就改掉了组内
 * 所有接口的 group —— 它们本来就只存了 folder_id。
 *
 * 内存里的 routes 数组只是读缓存，库才是唯一真相。每次写都包在 handle.transaction
 * 里，提交后 handle 会广播变更事件，本 store 收到就重读一遍再向外面发自己的 change。
 */

var EventEmitter = require('events').EventEmitter;

var apisRepo = require('./db/repos/apis');
var examplesRepo = require('./db/repos/examples');
var expectationsRepo = require('./db/repos/expectations');
var foldersRepo = require('./db/repos/folders');
var projectsRepo = require('./db/repos/projects');
var runtimeModule = require('./mock-runtime');

// WS 是 P9 加进来的：WebSocket 接口存进目录树，但不注册成 HTTP 路由（契约第 17 节）
// SIO 是第九轮第 4 节加进来的：Socket.IO 接口，和 WS 一样不注册成 HTTP 路由，
// 也从 /send 拦掉（见 lib/api/send.js）
// GRPC 是第十一轮第 1 节加进来的：gRPC 接口，同样只存目录树，不从 /send 发
var METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'WS', 'SIO', 'GRPC', 'ALL'];
// sse / ws 是 P9 加进来的「流式示例」：body 是一段描述回放过程的 JSON（契约第 17 节）
var RESPONSE_TYPES = ['json', 'text', 'html', 'sse', 'ws'];
var FIELD_TYPES = ['string', 'text', 'number', 'price', 'boolean', 'id', 'uuid', 'phone',
    'email', 'name', 'city', 'date', 'datetime', 'image', 'url', 'array', 'object'];
// 管理台自己占用的前缀，不允许被配成 mock 路由。
// 改这里要确认 lib/admin.js 的 API_PATH 跟着走（它引用的是同一个值）。
var RESERVED_PREFIX = '/__admin';

/** 新建接口时自动建的那条示例 */
var DEFAULT_EXAMPLE_NAME = '默认';

function createId() {
    return 'r_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function toStringValue(value, fallback) {
    if (value === undefined || value === null) return fallback;
    return String(value);
}

function toBool(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'string') return value !== 'false' && value !== '0';
    return Boolean(value);
}

function toInt(value, fallback) {
    var num = parseInt(value, 10);
    return isNaN(num) ? fallback : num;
}

function normalizeFields(list) {
    if (!Array.isArray(list)) return [];
    return list.filter(function (item) {
        return item && String(item.key || '').trim() !== '';
    }).map(function (item) {
        var type = String(item.type || 'string');
        return {
            key: String(item.key).trim(),
            type: FIELD_TYPES.indexOf(type) === -1 ? 'string' : type,
            required: toBool(item.required, false),
            desc: toStringValue(item.desc, ''),
            example: toStringValue(item.example, '')
        };
    });
}

function normalizeHeaders(list) {
    if (!Array.isArray(list)) return [];
    return list.filter(function (item) {
        return item && String(item.key || '').trim() !== '';
    }).map(function (item) {
        return {
            key: String(item.key).trim(),
            value: toStringValue(item.value, '')
        };
    });
}

/**
 * 校验并补全一条路由配置，非法输入直接抛错（交给管理台 API 返回 400）。
 * @param {object} input
 * @param {object} [options] { keepId: boolean }
 * @returns {object}
 */
function normalizeRoute(input, options) {
    options = options || {};
    var source = input || {};
    var method = String(source.method || 'GET').toUpperCase();
    if (METHODS.indexOf(method) === -1) {
        throw new Error('不支持的请求方法: ' + source.method + '（可选 ' + METHODS.join('/') + '）');
    }

    var routePath = String(source.path === undefined || source.path === null ? '' : source.path).trim();
    if (!routePath) {
        throw new Error('接口路径不能为空');
    }
    if (routePath.charAt(0) !== '/') routePath = '/' + routePath;
    if (routePath === RESERVED_PREFIX || routePath.indexOf(RESERVED_PREFIX + '/') === 0) {
        throw new Error('路径不能以 ' + RESERVED_PREFIX + ' 开头，这是管理台占用的前缀');
    }

    // 括号不成对之类的路径会让 Express 注册时抛错。**必须在这里挡住** ——
    // 这条数据最后会进 buildRouter，而热更新可能发生在定时器回调里，
    // 那里没有兜底，一个坏路径能把整个进程带走。导入（legacy / 批量）都走
    // 这个函数，所以坏数据会被跳过；新版管理台走 lib/api/tree.js 的校验。
    var pathProblem = runtimeModule.validateRoutePath(routePath);
    if (pathProblem) {
        throw new Error('mock 路径不合法：' + pathProblem);
    }

    var responseType = String(source.responseType || 'json');
    if (RESPONSE_TYPES.indexOf(responseType) === -1) responseType = 'json';

    return {
        id: options.keepId && source.id ? String(source.id) : createId(),
        name: toStringValue(source.name, ''),
        group: toStringValue(source.group, ''),
        desc: toStringValue(source.desc, ''),
        enabled: toBool(source.enabled, true),
        method: method,
        path: routePath,
        /**
         * 「从 OpenAPI 来的」记号（第四轮第 3 节）。别的来源（cURL、Postman、手写）
         * 都没有这三样，`extra.openapi` 也就不会写。
         * `requestHeaders` 是文档声明的**请求头参数**（`headers` 那个字段是响应头，别混）。
         */
        openapiKey: toStringValue(source.openapiKey, ''),
        operationId: toStringValue(source.operationId, ''),
        requestHeaders: normalizeFields(source.requestHeaders),
        pathParams: normalizeFields(source.pathParams),
        // 响应字段说明（第六轮第 2 节）：从 OpenAPI 的 schema description 读出来的，
        // 落库时进 `apis.extra.responseFields`
        responseFields: Array.isArray(source.responseFields) ? source.responseFields : [],
        status: Math.min(599, Math.max(100, toInt(source.status, 200))),
        delay: Math.max(0, toInt(source.delay, 0)),
        cors: toBool(source.cors, false),
        headers: normalizeHeaders(source.headers),
        query: normalizeFields(source.query),
        body: normalizeFields(source.body),
        responseType: responseType,
        response: toStringValue(source.response, '')
    };
}

/* ------------------------------------------------------------ 字段行 ↔ 库里的列 */

/**
 * 行数组 → 名字数组（顺序保留、空名字丢掉）。
 *
 * 记进 `apis.extra.openapi.fields`：**当时文档给了哪些字段名**。
 * 同步更新时靠它区分「文档这次删掉的」和「用户自己加的」—— 后者不能删。
 */
function fieldNames(rows) {
    return (rows || []).map(function (row) {
        return String((row && row.key) || '');
    }).filter(function (name) { return name !== ''; });
}

/**
 * route 的入参行 → apis.params.query 的行。
 * 入参的 example 在这种行里叫 value，沿用 Postman 的叫法。
 */
function rowsToParamRows(rows) {
    return (rows || []).map(function (row) {
        return {
            key: row.key,
            value: row.example,
            type: row.type,
            required: row.required,
            desc: row.desc,
            enabled: true
        };
    });
}

function paramRowsToRows(rows) {
    return (rows || []).filter(function (row) {
        return row && String(row.key || '').trim() !== '';
    }).map(function (row) {
        return {
            key: String(row.key),
            type: FIELD_TYPES.indexOf(String(row.type)) === -1 ? 'string' : String(row.type),
            required: !!row.required,
            desc: row.desc === undefined || row.desc === null ? '' : String(row.desc),
            example: row.value === undefined || row.value === null ? '' : String(row.value)
        };
    });
}

/** route 的 body 行 → apis.body；没有行就是 none，不去猜 contentType */
function rowsToBody(rows) {
    var form = rowsToParamRows(rows);
    return { mode: form.length ? 'urlencoded' : 'none', form: form };
}

function bodyToRows(body) {
    if (!body || body.mode !== 'urlencoded' || !Array.isArray(body.form)) return [];
    return paramRowsToRows(body.form);
}

function normalizeGroupName(value) {
    return String(value === undefined || value === null ? '' : value).trim();
}

/**
 * 把若干 route 落成 folder + api + 示例。
 *
 * **不开事务** —— 调用方负责包在 handle.transaction 里。之所以提到模块级，是因为
 * 旧配置导入要把「建项目 + 灌数据 + 记来源」放进同一个事务，而门面的写方法各自
 * 就是一条事务、handle 又不支持嵌套。
 *
 * groups 会先按声明顺序建成顶层 folder，这样「声明了分组但没有接口」的那些不会被
 * 丢掉、顺序也能保住；route 上的 group 没声明过就顺手补建。
 *
 * @returns {Array} 落库后的 route（id 是重新生成的，调用方按它读回）
 */
function insertRoutes(handle, projectId, options) {
    var groups = (options && options.groups) || [];
    var inputs = (options && options.routes) || [];

    var folderIdByName = {};
    foldersRepo.list(handle, projectId).forEach(function (folder) {
        if (!folder.parentId) folderIdByName[folder.name] = folder.id;
    });

    function folderIdFor(groupName, createIfMissing) {
        var name = normalizeGroupName(groupName);
        if (!name) return null;
        if (folderIdByName[name]) return folderIdByName[name];
        if (!createIfMissing) return null;

        var created = foldersRepo.create(handle, projectId, { name: name });
        folderIdByName[name] = created.id;
        return created.id;
    }

    groups.forEach(function (name) { folderIdFor(name, true); });

    return inputs.map(function (input) {
        var route = normalizeRoute(input, { keepId: false });

        // 从 OpenAPI 导入的：记下「它是文档里的哪一条」+ 当时文档给了哪些字段名。
        // 同步更新（第四轮第 3 节）靠这两样认接口、并且区分「文档删掉的」和
        // 「用户自己加的」（后者不能删）。
        var extra = {};
        if (route.openapiKey) {
            extra.openapi = {
                key: route.openapiKey,
                fields: {
                    query: fieldNames(route.query),
                    path: fieldNames(route.pathParams),
                    headers: fieldNames(route.requestHeaders),
                    body: fieldNames(route.body)
                }
            };
            if (route.operationId) extra.openapi.operationId = route.operationId;
        }
        // 响应字段说明（第六轮第 2 节）：文档的 schema 里写了 description 才带上
        if (route.responseFields && route.responseFields.length) {
            extra.responseFields = route.responseFields;
        }

        apisRepo.insert(handle, projectId, {
            id: route.id,
            name: route.name,
            description: route.desc,
            folderId: folderIdFor(route.group, true),
            method: route.method,
            url: route.path,
            mockPath: route.path,
            params: {
                path: [],
                query: rowsToParamRows(route.query),
                headers: rowsToParamRows(route.requestHeaders)
            },
            body: rowsToBody(route.body),
            mockEnabled: route.enabled,
            mockDelay: route.delay,
            mockCors: route.cors,
            extra: extra
        });

        var example = examplesRepo.insert(handle, route.id, {
            name: DEFAULT_EXAMPLE_NAME,
            status: route.status,
            headers: route.headers,
            body: route.response,
            responseType: route.responseType,
            isTemplate: true,
            source: 'manual'
        });
        apisRepo.update(handle, route.id, { mockExampleId: example.id });

        return route;
    });
}

/**
 * @param {{handle: object, projectId: string}} options
 * @returns {object} store
 */
function createStore(options) {
    options = options || {};

    var handle = options.handle;
    if (!handle) throw new Error('createStore 需要 handle');
    var projectId = options.projectId;
    if (!projectId) throw new Error('createStore 需要 projectId');

    var emitter = new EventEmitter();
    var routes = [];
    /// Mock 故障模拟的设置（第七轮第 1 节）：跟着 routes 一起刷新，请求热路径上直接用
    var faults = null;
    var closed = false;

    /* ---------------------------------------------------------- 读 */

    function readRoutes() {
        var folderNames = {};
        foldersRepo.list(handle, projectId).forEach(function (folder) {
            folderNames[folder.id] = folder.name;
        });

        return apisRepo.list(handle, projectId).map(function (api) {
            var examples = examplesRepo.listByApi(handle, api.id);
            var active = null;

            if (api.mockExampleId) {
                active = examples.filter(function (item) { return item.id === api.mockExampleId; })[0] || null;
            }
            if (!active) active = examples[0] || null;

            var exampleById = {};
            examples.forEach(function (item) { exampleById[item.id] = item; });

            // 期望在运行时是「条件 + 一条示例的完整内容」。这里就把示例展开好，
            // mock 那边只管匹配，不用再去查库 —— 匹配跑在每一条 mock 请求上。
            var expectations = expectationsRepo.listByApi(handle, api.id).filter(function (item) {
                return item.enabled;
            }).map(function (item) {
                var example = exampleById[item.exampleId];
                // 示例被删时数据库会级联删掉这条期望，这里纯属兜底：
                // 没有示例的期望返回不了任何东西，留着只会在运行时白匹配一次。
                if (!example) return null;

                return {
                    name: item.name,
                    conditions: item.conditions,
                    status: example.status,
                    headers: example.headers,
                    responseType: example.responseType,
                    response: example.body
                };
            }).filter(Boolean);

            return {
                id: api.id,
                name: api.name,
                // 故障模拟的「作用范围=目录」要在运行时判断，所以这里得带上（第七轮第 1 节）
                folderId: api.folderId || null,
                group: api.folderId ? (folderNames[api.folderId] || '') : '',
                desc: api.description,
                // 没有示例的接口不算「启用」—— 放出去只会返回空响应
                enabled: api.mockEnabled && !!active,
                method: api.method,
                path: api.mockPath || api.url || '/',
                status: active ? active.status : 200,
                delay: api.mockDelay,
                cors: api.mockCors,
                headers: active ? active.headers : [],
                query: paramRowsToRows((api.params && api.params.query) || []),
                body: bodyToRows(api.body),
                responseType: active ? active.responseType : 'json',
                response: active ? active.body : '',
                expectations: expectations
            };
        });
    }

    /**
     * Mock 故障模拟（第七轮第 1 节）：把项目的 `extra.mockFaults` 读成运行时好用的形状。
     *
     * 只读**启用着的**规则，并把「作用范围是目录」展开成一份**目录 id 集合**
     * （算上子目录）—— 请求热路径上不该再去查目录表。关掉总开关就直接返回 null，
     * 这样 `createHandler` 里一次判断就能跳过整块逻辑。
     *
     * 设置改了会触发 handle 的 change（项目行在 extra 里），refresh 时重新读一遍。
     */
    function readFaults() {
        var project = projectsRepo.getById(handle, projectId);
        var faults = project && project.extra ? project.extra.mockFaults : null;

        if (!faults || faults.enabled !== true) return null;

        var scope = faults.scope && typeof faults.scope === 'object' ? faults.scope : {};
        var folderIds = {};

        if (scope.type === 'folders') {
            var all = foldersRepo.list(handle, projectId);
            var byId = {};
            all.forEach(function (folder) { byId[folder.id] = folder; });

            (Array.isArray(scope.ids) ? scope.ids : []).forEach(function (id) {
                var rootId = String(id);
                folderIds[rootId] = true;

                // 子目录：顺着 parentId 往上找，能连到选中的目录就算在里面
                all.forEach(function (folder) {
                    var current = folder;
                    var guard = 0;
                    while (current && current.parentId && guard < 64) {
                        guard += 1;
                        if (current.parentId === rootId) {
                            folderIds[folder.id] = true;
                            return;
                        }
                        current = byId[current.parentId];
                    }
                });
            });
        }

        return {
            scope: {
                type: scope.type === 'folders' || scope.type === 'apis' ? scope.type : 'all',
                ids: Array.isArray(scope.ids) ? scope.ids.map(String) : []
            },
            folderIds: folderIds,
            rules: (Array.isArray(faults.rules) ? faults.rules : []).filter(function (rule) {
                return rule && rule.enabled !== false;
            })
        };
    }

    function refresh() {
        routes = readRoutes();
        faults = readFaults();
        emitter.emit('change', routes);
        return routes;
    }

    /**
     * 收到库层变更就重读。
     * 这个订阅是常驻的，不跟着 startWatching 走 —— 自己的写也要靠它刷新缓存，
     * 否则只 load() 没 startWatching 的调用方写完再读会拿到旧数据。
     */
    function onHandleChange(event) {
        if (closed) return;
        if (event && event.projectId !== null && event.projectId !== undefined && event.projectId !== projectId) {
            return;
        }
        refresh();
    }
    handle.events.on('change', onHandleChange);

    /* ---------------------------------------------------------- 写 */

    /** 所有写操作都走这里：包事务，提交后 handle 会广播，刷新由 onHandleChange 负责 */
    function write(fn) {
        return handle.transaction(fn, { projectId: projectId });
    }

    var store = {
        projectId: projectId,

        /** meta 接口在用；现在是全局库的路径，所有项目共用 */
        filePath: handle.file,

        /** 首次加载：从库里读一遍，不发 change */
        load: function () {
            routes = readRoutes();
            faults = readFaults();
            return routes;
        },

        getRoutes: function () {
            return routes;
        },

        /** Mock 故障模拟的设置（第七轮第 1 节）；关着或没设过是 null */
        getFaults: function () {
            return faults;
        },

        /** 直接把整个列表写回（`mock init` 灌示例接口用） */
        replaceAll: function (list) {
            write(function () {
                // 先把现有接口和分组清空
                apisRepo.list(handle, projectId).forEach(function (api) {
                    apisRepo.remove(handle, api.id);
                });
                foldersRepo.list(handle, projectId).forEach(function (folder) {
                    foldersRepo.remove(handle, folder.id);
                });
                insertRoutes(handle, projectId, { routes: list || [] });
            });

            return store.getRoutes();
        },

        on: function (event, handler) {
            emitter.on(event, handler);
            return store;
        },

        off: function (event, handler) {
            emitter.removeListener(event, handler);
            return store;
        },

        /** 开始感知「别的进程改了库」；同一个 handle 上重复调用是安全的 */
        startWatching: function () {
            handle.startPolling();
        },

        /**
         * 空操作。
         * 外部变更轮询是 handle 级别的，一个 handle 上可能挂着多个项目的 store，
         * 所以不能由哪一家来关 —— 它的生命周期归启动流程管（handle.stopPolling）。
         * 本 store 自己的订阅在 close() 里摘掉。
         */
        stopWatching: function () {
            // 故意留空
        },

        /** 只摘掉本 store 的订阅，不关 handle —— handle 归启动流程管 */
        close: function () {
            if (closed) return;
            closed = true;
            handle.events.removeListener('change', onHandleChange);
        }
    };

    return store;
}

/**
 * `mock init` 用的示例配置，让管理台打开就有东西可看。
 */
function createSampleRoutes() {
    return {
        version: 1,
        groups: ['用户'],
        routes: [
            {
                id: createId(),
                name: '用户列表',
                group: '用户',
                desc: '示例：分页列表，响应体里的 {{@...}} 会在每次请求时生成随机数据',
                enabled: true,
                method: 'GET',
                path: '/api/users',
                status: 200,
                delay: 0,
                cors: true,
                headers: [],
                query: [
                    { key: 'page', type: 'number', required: false, desc: '页码', example: '1' },
                    { key: 'pageSize', type: 'number', required: false, desc: '每页条数', example: '10' },
                    { key: 'keyword', type: 'string', required: false, desc: '搜索关键词', example: '张三' }
                ],
                body: [],
                responseType: 'json',
                response: '{\n  "code": 0,\n  "msg": "ok",\n  "data": {\n    "list": [\n{{@repeat(3)}}      {\n        "id": "{{@id}}",\n        "name": "{{@cname}}",\n        "phone": "{{@phone}}",\n        "city": "{{@city}}",\n        "createdAt": "{{@datetime}}"\n      }\n{{/repeat}}    ],\n    "total": {{@int(50,500)}},\n    "page": "{{@query(page)}}",\n    "pageSize": "{{@query(pageSize)}}"\n  }\n}'
            },
            {
                id: createId(),
                name: '用户详情',
                group: '用户',
                desc: '示例：路径参数回显',
                enabled: true,
                method: 'GET',
                path: '/api/users/:id',
                status: 200,
                delay: 0,
                cors: true,
                headers: [],
                query: [],
                body: [],
                responseType: 'json',
                response: '{\n  "code": 0,\n  "msg": "ok",\n  "data": {\n    "id": "{{@params(id)}}",\n    "name": "{{@cname}}",\n    "job": "{{@job}}",\n    "company": "{{@company}}",\n    "email": "{{@email}}",\n    "avatar": "{{@image(80x80)}}"\n  }\n}'
            },
            {
                id: createId(),
                name: '创建用户',
                group: '用户',
                desc: '示例：POST + 回显提交的内容',
                enabled: true,
                method: 'POST',
                path: '/api/users',
                status: 200,
                delay: 0,
                cors: true,
                headers: [],
                query: [],
                body: [
                    { key: 'name', type: 'name', required: true, desc: '姓名', example: '张三' },
                    { key: 'phone', type: 'phone', required: true, desc: '手机号', example: '13800138000' }
                ],
                responseType: 'json',
                response: '{\n  "code": 0,\n  "msg": "创建成功",\n  "data": {\n    "id": "{{@id}}",\n    "name": "{{@body(name)}}",\n    "phone": "{{@body(phone)}}"\n  }\n}'
            }
        ]
    };
}

module.exports = {
    createStore: createStore,
    insertRoutes: insertRoutes,
    normalizeRoute: normalizeRoute,
    createSampleRoutes: createSampleRoutes,
    METHODS: METHODS,
    RESPONSE_TYPES: RESPONSE_TYPES,
    FIELD_TYPES: FIELD_TYPES,
    RESERVED_PREFIX: RESERVED_PREFIX
};
