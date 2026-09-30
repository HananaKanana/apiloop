/**
 * 单个项目的门面。
 *
 * 对外的方法名和返回形状与 P0 时期的 routes-store 完全一致，所以 admin.js 和前端
 * 基本不用动；内部把「一条 route」拆成两张表存：
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
var foldersRepo = require('./db/repos/folders');

var METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'ALL'];
var RESPONSE_TYPES = ['json', 'text', 'html'];
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

        apisRepo.insert(handle, projectId, {
            id: route.id,
            name: route.name,
            description: route.desc,
            folderId: folderIdFor(route.group, true),
            method: route.method,
            url: route.path,
            mockPath: route.path,
            params: { path: [], query: rowsToParamRows(route.query), headers: [] },
            body: rowsToBody(route.body),
            mockEnabled: route.enabled,
            mockDelay: route.delay,
            mockCors: route.cors
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

            return {
                id: api.id,
                name: api.name,
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
                response: active ? active.body : ''
            };
        });
    }

    function refresh() {
        routes = readRoutes();
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

    /** 找顶层分组对应的 folder；createIfMissing 为真时顺手建一个 */
    function folderIdForGroup(groupName, createIfMissing) {
        var name = normalizeGroupName(groupName);
        if (!name) return null;

        var folders = foldersRepo.list(handle, projectId);
        for (var i = 0; i < folders.length; i++) {
            if (!folders[i].parentId && folders[i].name === name) return folders[i].id;
        }
        if (!createIfMissing) return null;
        return foldersRepo.create(handle, projectId, { name: name }).id;
    }

    function activeExampleIdOf(apiId, preferredId) {
        var examples = examplesRepo.listByApi(handle, apiId);
        if (preferredId) {
            var hit = examples.filter(function (item) { return item.id === preferredId; })[0];
            if (hit) return hit.id;
        }
        return examples.length ? examples[0].id : null;
    }

    var store = {
        projectId: projectId,

        /** meta 接口在用；现在是全局库的路径，所有项目共用 */
        filePath: handle.file,

        /** 首次加载：从库里读一遍，不发 change */
        load: function () {
            routes = readRoutes();
            return routes;
        },

        getRoutes: function () {
            return routes;
        },

        getRoute: function (id) {
            for (var i = 0; i < routes.length; i++) {
                if (routes[i].id === id) return routes[i];
            }
            return null;
        },

        create: function (input) {
            var inserted = write(function () {
                return insertRoutes(handle, projectId, { routes: [input] });
            });
            return store.getRoute(inserted[0].id);
        },

        update: function (id, input) {
            var current = apisRepo.get(handle, id);
            if (!current || current.projectId !== projectId) return null;

            var route = normalizeRoute(input, { keepId: true });
            route.id = id;

            write(function () {
                var patch = {
                    folderId: folderIdForGroup(route.group, true),
                    name: route.name,
                    description: route.desc,
                    method: route.method,
                    mockPath: route.path,
                    params: {
                        // path / headers 不在这张映射表里，原样保留
                        path: (current.params && current.params.path) || [],
                        query: rowsToParamRows(route.query),
                        headers: (current.params && current.params.headers) || []
                    },
                    body: rowsToBody(route.body),
                    mockEnabled: route.enabled,
                    mockDelay: route.delay,
                    mockCors: route.cors
                };
                // url 只在它还和 mock_path 同步时才跟着改，避免把导入进来的原始请求地址覆盖掉
                if (current.url === current.mockPath) patch.url = route.path;

                apisRepo.update(handle, id, patch);

                var activeId = activeExampleIdOf(id, current.mockExampleId);
                if (activeId) {
                    examplesRepo.update(handle, activeId, {
                        status: route.status,
                        headers: route.headers,
                        body: route.response,
                        responseType: route.responseType
                    });
                } else {
                    var created = examplesRepo.insert(handle, id, {
                        name: DEFAULT_EXAMPLE_NAME,
                        status: route.status,
                        headers: route.headers,
                        body: route.response,
                        responseType: route.responseType,
                        isTemplate: true,
                        source: 'manual'
                    });
                    apisRepo.update(handle, id, { mockExampleId: created.id });
                }
            });
            return store.getRoute(id);
        },

        remove: function (id) {
            var current = apisRepo.get(handle, id);
            if (!current || current.projectId !== projectId) return false;
            write(function () { apisRepo.remove(handle, id); });
            return true;
        },

        duplicate: function (id) {
            var source = store.getRoute(id);
            if (!source) return null;

            var original = apisRepo.get(handle, id);
            var copy = normalizeRoute(source, { keepId: false });
            copy.name = source.name ? source.name + ' 副本' : '';

            write(function () {
                apisRepo.insert(handle, projectId, {
                    id: copy.id,
                    name: copy.name,
                    description: original.description,
                    folderId: original.folderId,
                    method: copy.method,
                    url: original.url,
                    mockPath: copy.path,
                    params: {
                        path: (original.params && original.params.path) || [],
                        query: rowsToParamRows(copy.query),
                        headers: (original.params && original.params.headers) || []
                    },
                    body: rowsToBody(copy.body),
                    auth: original.auth,
                    scripts: original.scripts,
                    mockEnabled: copy.enabled,
                    mockDelay: copy.delay,
                    mockCors: copy.cors,
                    extra: original.extra
                });

                // 示例要整份复制，并把 mock_example_id 指向复制出来的那条默认示例
                var originals = examplesRepo.listByApi(handle, id);
                var copiedDefaultId = null;

                originals.forEach(function (example) {
                    var copied = examplesRepo.insert(handle, copy.id, {
                        name: example.name,
                        status: example.status,
                        headers: example.headers,
                        body: example.body,
                        responseType: example.responseType,
                        isTemplate: example.isTemplate,
                        source: example.source
                    });
                    if (example.id === original.mockExampleId) copiedDefaultId = copied.id;
                });

                if (!copiedDefaultId) {
                    var fallback = examplesRepo.listByApi(handle, copy.id);
                    copiedDefaultId = fallback.length ? fallback[0].id : examplesRepo.insert(handle, copy.id, {
                        name: DEFAULT_EXAMPLE_NAME,
                        status: copy.status,
                        headers: copy.headers,
                        body: copy.response,
                        responseType: copy.responseType,
                        isTemplate: true,
                        source: 'manual'
                    }).id;
                }
                apisRepo.update(handle, copy.id, { mockExampleId: copiedDefaultId });
            });

            return store.getRoute(copy.id);
        },

        /** 批量新增（导入用） */
        addMany: function (list) {
            if (!list || !list.length) return [];

            var inserted = write(function () {
                return insertRoutes(handle, projectId, { routes: list });
            });

            return inserted.map(function (route) { return store.getRoute(route.id); })
                .filter(function (route) { return !!route; });
        },

        /* ---------------------------------------------------------- 分组（= 顶层 folder） */

        /** 生效的分组列表，带每个分组的接口数 */
        getGroups: function () {
            return foldersRepo.list(handle, projectId).map(function (folder) {
                return { name: folder.name, count: apisRepo.countByFolder(handle, folder.id) };
            });
        },

        addGroup: function (name) {
            var clean = normalizeGroupName(name);
            if (!clean) throw new Error('分组名不能为空');
            if (folderIdForGroup(clean, false)) throw new Error('分组已存在: ' + clean);

            write(function () { foldersRepo.create(handle, projectId, { name: clean }); });
            return { name: clean, count: 0 };
        },

        /**
         * 重命名分组。接口只存了 folder_id，所以改名天然就同步了组内所有接口的
         * group，不需要逐个去改。
         */
        renameGroup: function (oldName, newName) {
            var from = normalizeGroupName(oldName);
            var to = normalizeGroupName(newName);

            var folderId = folderIdForGroup(from, false);
            if (!folderId) throw new Error('分组不存在: ' + oldName);
            if (!to) throw new Error('新分组名不能为空');
            if (to !== from && folderIdForGroup(to, false)) throw new Error('分组已存在: ' + to);

            var moved = apisRepo.countByFolder(handle, folderId);
            write(function () { foldersRepo.rename(handle, folderId, to); });
            return { name: to, count: moved, moved: moved };
        },

        /**
         * 调整分组顺序（侧边栏展示顺序）。
         * 只传部分分组也接受：没提到的按原顺序排在后面，重复项忽略。
         */
        reorderGroups: function (names) {
            if (!Array.isArray(names)) throw new Error('names 必须是数组');
            var current = store.getGroups().map(function (group) { return group.name; });

            var wanted = names.map(normalizeGroupName).filter(Boolean);
            wanted.forEach(function (name) {
                if (current.indexOf(name) === -1) throw new Error('分组不存在: ' + name);
            });

            var seen = {};
            var orderedIds = [];
            var folders = foldersRepo.list(handle, projectId);
            var idByName = {};
            folders.forEach(function (folder) { idByName[folder.name] = folder.id; });

            // 提名的按提名顺序排前面，没提名的按原顺序接在后面。
            // 这里必须按 names 的顺序取 id，不能按 folder 当前顺序过滤 —— 那样顺序根本没变。
            wanted.forEach(function (name) {
                if (seen[name]) return;
                seen[name] = true;
                orderedIds.push(idByName[name]);
            });
            folders.forEach(function (folder) {
                if (!seen[folder.name]) orderedIds.push(folder.id);
            });

            write(function () { foldersRepo.setPositions(handle, projectId, orderedIds); });
            return store.getGroups();
        },

        /**
         * 删除分组。
         * @param {string} name
         * @param {string} [mode] 'move'（默认，接口移到未分组）| 'delete'（连同接口一起删）
         */
        removeGroup: function (name, mode) {
            var target = normalizeGroupName(name);
            var folderId = folderIdForGroup(target, false);
            if (!folderId) throw new Error('分组不存在: ' + name);

            var affected = apisRepo.countByFolder(handle, folderId);
            var deleting = mode === 'delete';

            write(function () {
                if (deleting) {
                    apisRepo.removeByFolder(handle, folderId);
                } else {
                    apisRepo.list(handle, projectId).forEach(function (api) {
                        if (api.folderId === folderId) apisRepo.update(handle, api.id, { folderId: null });
                    });
                }
                foldersRepo.remove(handle, folderId);
            });

            return { name: target, affected: affected, mode: deleting ? 'delete' : 'move' };
        },

        /** 直接把整个列表写回（例如导入落库、mock init 灌示例） */
        replaceAll: function (list) {
            write(function () {
                // 先把现有接口和分组清空，语义与 P0 时期的 replaceAll 一致
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
