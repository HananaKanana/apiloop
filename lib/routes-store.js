/**
 * 路由配置存储：读写 SQLite 库文件（lib/db.js），供管理台 API 和运行时共用。
 *
 * 内存里的 routes / declaredGroups 数组就是唯一真相，库文件只是它的持久化
 * 镜像：读是全量读，写是全量写。分组增删改排序这些逻辑因此完全不用改。
 *
 * 首次建库时，如果同目录下存在旧的 routes.json，会自动导入一次（原 JSON 保留）。
 * 同时监听库文件所在目录，外部用 sqlite3 命令行改数据也能触发 change 事件热更新。
 */

var fs = require('fs');
var path = require('path');
var EventEmitter = require('events').EventEmitter;
var db = require('./db');

var METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'ALL'];
var RESPONSE_TYPES = ['json', 'text', 'html'];
var FIELD_TYPES = ['string', 'text', 'number', 'price', 'boolean', 'id', 'uuid', 'phone',
    'email', 'name', 'city', 'date', 'datetime', 'image', 'url', 'array', 'object'];
// 管理台自己占用的前缀，不允许被配成 mock 路由。
// 改这里要确认 lib/admin.js 的 API_PATH 跟着走（它引用的是同一个值）。
var RESERVED_PREFIX = '/__admin';

var DEFAULT_FILE = 'routes.db';

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

/**
 * @param {{file?: string, watch?: boolean}} options
 */
function createStore(options) {
    options = options || {};
    var filePath = path.resolve(options.file || path.join(process.cwd(), DEFAULT_FILE));
    var dirPath = path.dirname(filePath);
    var emitter = new EventEmitter();
    var routes = [];
    // 分组现在是可管理的实体：declaredGroups 记录显式的分组名与顺序，
    // 实际生效的分组 = declaredGroups ∪ 路由上用到的分组（老文件只有 routes，靠这条兼容）
    var declaredGroups = [];
    // SQLite 句柄，首次 load() 时打开（库文件不存在则顺带创建）
    var handle = null;
    // 最近一次读/写之后的内存快照。文件监听靠它区分「外部改动」和「自己刚写完」，
    // 否则每次保存都会被自己触发一轮重载。
    var loadedSnapshot = null;
    // 旧的 routes.json 被自动导入时记下来源路径，供 CLI 提示用；没迁移就是 null
    var migratedFrom = null;
    // 迁移过程中的问题（坏 JSON、个别接口解析失败等），由调用方决定怎么提示
    var migrationWarnings = [];
    var watcher = null;
    var watchTimer = null;

    function normalizeGroupName(value) {
        return String(value === undefined || value === null ? '' : value).trim();
    }

    function readGroupList(parsed) {
        var list = Array.isArray(parsed) ? null : (parsed && parsed.groups);
        if (!Array.isArray(list)) return [];
        var seen = {};
        return list.map(normalizeGroupName).filter(function (name) {
            if (!name || seen[name]) return false;
            seen[name] = true;
            return true;
        });
    }

    /** 打开库文件；返回是否是「刚新建的空库」（据此决定要不要做旧配置迁移） */
    function ensureDb() {
        if (handle) return false;
        var fresh = !fs.existsSync(filePath);
        handle = db.openDatabase(filePath);
        return fresh;
    }

    /**
     * 库文件旁边那份同名 JSON：routes.db ↔ routes.json。
     * 注意要排除「算出来就是库文件自己」的情况——配置名如果就叫 routes.json，
     * 这个函数会指回它本身，拿一个 SQLite 文件当 JSON 解析必然报错。
     */
    function legacyJsonPath() {
        var ext = path.extname(filePath);
        var candidate = ext === '.db'
            ? filePath.slice(0, filePath.length - ext.length) + '.json'
            : path.join(dirPath, 'routes.json');
        if (path.resolve(candidate) === path.resolve(filePath)) return null;
        return candidate;
    }

    /**
     * 首次建库时，如果旁边有旧的 routes.json 就把它导进来，原始 JSON 保留不删。
     * 单条接口解析失败只跳过那一条，不因为一条坏数据把整次迁移废掉。
     *
     * 迁移过程中的问题记进 migrationWarnings 而不是 emit('error')：EventEmitter
     * 在没有 error 监听器时 emit('error') 会直接抛，而迁移发生在 load() 里，
     * 那时调用方通常还没来得及挂监听。
     */
    function migrateFromJson() {
        var legacy = legacyJsonPath();
        if (!legacy || !fs.existsSync(legacy)) return;

        var text;
        try {
            text = fs.readFileSync(legacy, 'utf-8');
        } catch (err) {
            migrationWarnings.push('读取旧配置失败：' + err.message);
            return;
        }
        if (!text.trim()) return;

        var parsed;
        try {
            parsed = JSON.parse(text);
        } catch (err) {
            migrationWarnings.push('旧配置 ' + path.basename(legacy) + ' 不是合法 JSON，已跳过迁移：' + err.message);
            return;
        }

        var list = Array.isArray(parsed) ? parsed : (parsed && parsed.routes);
        if (!Array.isArray(list)) {
            migrationWarnings.push('旧配置 ' + path.basename(legacy) +
                ' 格式不对（应为 { "routes": [...] } 或直接是数组），已跳过迁移');
            return;
        }

        var converted = [];
        var skipped = 0;
        list.forEach(function (item) {
            try {
                converted.push(normalizeRoute(item, { keepId: true }));
            } catch (err) {
                skipped++;
            }
        });

        db.writeAll(handle, { groups: readGroupList(parsed), routes: converted });
        migratedFrom = legacy;
        if (skipped > 0) {
            migrationWarnings.push('旧配置里有 ' + skipped + ' 条接口无法解析，已跳过');
        }
    }

    /** 显式声明的分组 + 路由里出现的分组，按声明顺序在前、出现顺序在后 */
    function effectiveGroupsOf(list, declared) {
        var result = (declared || []).slice();
        var seen = {};
        result.forEach(function (name) { seen[name] = true; });
        (list || []).forEach(function (route) {
            var name = normalizeGroupName(route.group);
            if (name && !seen[name]) {
                seen[name] = true;
                result.push(name);
            }
        });
        return result;
    }

    function effectiveGroups() {
        return effectiveGroupsOf(routes, declaredGroups);
    }

    function snapshotOf(list, declared) {
        return JSON.stringify({ groups: effectiveGroupsOf(list, declared), routes: list });
    }

    function snapshot() {
        return snapshotOf(routes, declaredGroups);
    }

    function countRoutesInGroup(name) {
        return routes.filter(function (route) {
            return normalizeGroupName(route.group) === name;
        }).length;
    }

    /** 路由里新出现的分组自动登记，免得手输一次就丢 */
    function registerGroupsFromRoutes() {
        declaredGroups = effectiveGroups();
    }

    function persist() {
        ensureDb();
        db.writeAll(handle, { groups: effectiveGroups(), routes: routes });
        loadedSnapshot = snapshot();
    }

    /** 落库并把变更广播出去 */
    function commit() {
        persist();
        emitter.emit('change', routes);
        return routes;
    }

    function reloadFromDb() {
        var doc = db.readAll(handle);
        routes = doc.routes;
        declaredGroups = doc.groups;
        loadedSnapshot = snapshot();
        emitter.emit('change', routes);
        return routes;
    }

    var store = {
        filePath: filePath,

        /** 首次加载：打开（不存在则创建）库文件，并在新建时尝试迁移旧的 routes.json */
        load: function () {
            var fresh = ensureDb();
            if (fresh) migrateFromJson();
            var doc = db.readAll(handle);
            routes = doc.routes;
            declaredGroups = doc.groups;
            loadedSnapshot = snapshot();
            return routes;
        },

        /** 这次加载是否从旧的 routes.json 迁移过；没有则返回 null */
        getMigratedFrom: function () {
            return migratedFrom;
        },

        /** 迁移过程中的问题，字符串数组；调用方负责提示 */
        getMigrationWarnings: function () {
            return migrationWarnings.slice();
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
            var route = normalizeRoute(input, { keepId: false });
            routes.push(route);
            registerGroupsFromRoutes();
            commit();
            return route;
        },

        update: function (id, input) {
            var index = -1;
            for (var i = 0; i < routes.length; i++) {
                if (routes[i].id === id) { index = i; break; }
            }
            if (index === -1) return null;
            var route = normalizeRoute(input, { keepId: true });
            route.id = id;
            routes[index] = route;
            registerGroupsFromRoutes();
            commit();
            return route;
        },

        remove: function (id) {
            var before = routes.length;
            routes = routes.filter(function (item) { return item.id !== id; });
            if (routes.length === before) return false;
            commit();
            return true;
        },

        duplicate: function (id) {
            var source = store.getRoute(id);
            if (!source) return null;
            var copy = normalizeRoute(source, { keepId: false });
            copy.name = source.name ? source.name + ' 副本' : '';
            routes.push(copy);
            commit();
            return copy;
        },

        /** 批量新增（导入用），返回落库后的路由 */
        addMany: function (list) {
            var added = (list || []).map(function (item) {
                return normalizeRoute(item, { keepId: false });
            });
            routes = routes.concat(added);
            registerGroupsFromRoutes();
            commit();
            return added;
        },

        /* ---------------------------------------------------------- 分组管理 */

        /** 生效的分组列表，带每个分组的接口数 */
        getGroups: function () {
            return effectiveGroups().map(function (name) {
                return { name: name, count: countRoutesInGroup(name) };
            });
        },

        addGroup: function (name) {
            var clean = normalizeGroupName(name);
            if (!clean) throw new Error('分组名不能为空');
            if (effectiveGroups().indexOf(clean) > -1) {
                throw new Error('分组已存在: ' + clean);
            }
            declaredGroups = effectiveGroups().concat([clean]);
            commit();
            return { name: clean, count: 0 };
        },

        /** 重命名分组，该分组下所有接口一起改名 */
        renameGroup: function (oldName, newName) {
            var from = normalizeGroupName(oldName);
            var to = normalizeGroupName(newName);
            var groups = effectiveGroups();

            if (!from || groups.indexOf(from) === -1) {
                throw new Error('分组不存在: ' + oldName);
            }
            if (!to) throw new Error('新分组名不能为空');
            if (to !== from && groups.indexOf(to) > -1) {
                throw new Error('分组已存在: ' + to);
            }

            var moved = 0;
            routes.forEach(function (route) {
                if (normalizeGroupName(route.group) === from) {
                    route.group = to;
                    moved++;
                }
            });

            declaredGroups = groups.map(function (name) {
                return name === from ? to : name;
            });
            commit();
            return { name: to, count: moved, moved: moved };
        },

        /**
         * 调整分组顺序（侧边栏展示顺序）。
         * 只传部分分组也接受：没提到的按原顺序排在后面，重复项忽略。
         */
        reorderGroups: function (names) {
            if (!Array.isArray(names)) throw new Error('names 必须是数组');
            var current = effectiveGroups();
            var wanted = (names || []).map(normalizeGroupName).filter(Boolean);

            wanted.forEach(function (name) {
                if (current.indexOf(name) === -1) throw new Error('分组不存在: ' + name);
            });

            var seen = {};
            var ordered = [];
            wanted.forEach(function (name) {
                if (!seen[name]) {
                    seen[name] = true;
                    ordered.push(name);
                }
            });
            current.forEach(function (name) {
                if (!seen[name]) ordered.push(name);
            });

            declaredGroups = ordered;
            commit();
            return store.getGroups();
        },

        /**
         * 删除分组。
         * @param {string} name
         * @param {string} [mode] 'move'（默认，接口移到未分组）| 'delete'（连同接口一起删）
         */
        removeGroup: function (name, mode) {
            var target = normalizeGroupName(name);
            var groups = effectiveGroups();
            if (!target || groups.indexOf(target) === -1) {
                throw new Error('分组不存在: ' + name);
            }

            var affected = routes.filter(function (route) {
                return normalizeGroupName(route.group) === target;
            }).length;

            if (mode === 'delete') {
                routes = routes.filter(function (route) {
                    return normalizeGroupName(route.group) !== target;
                });
            } else {
                routes.forEach(function (route) {
                    if (normalizeGroupName(route.group) === target) route.group = '';
                });
            }

            declaredGroups = groups.filter(function (item) { return item !== target; });
            commit();
            return { name: target, affected: affected, mode: mode === 'delete' ? 'delete' : 'move' };
        },

        /** 直接把整个列表写回（例如路由排序） */
        replaceAll: function (list) {
            routes = (list || []).map(function (item) {
                return normalizeRoute(item, { keepId: true });
            });
            registerGroupsFromRoutes();
            return commit();
        },

        on: function (event, handler) {
            emitter.on(event, handler);
            return store;
        },

        off: function (event, handler) {
            emitter.removeListener(event, handler);
            return store;
        },

        /**
         * 监听库文件变化（外部用 sqlite3 命令行改数据也能热更新）。
         * 监听目录而不是文件，这样库文件被删除/重建也能捕获。
         * 是否监听只由 startWatching / stopWatching 决定，不隐式依赖构造参数。
         */
        startWatching: function () {
            if (watcher) return;
            if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
            var targetName = path.basename(filePath);
            // SQLite 落盘时会顺带产生这些旁路文件，它们自己变了不代表数据变了
            var sidecars = ['-journal', '-wal', '-shm', '-mj'].map(function (suffix) {
                return targetName + suffix;
            });

            try {
                watcher = fs.watch(dirPath, function (eventType, filename) {
                    var name = filename ? String(filename) : '';
                    if (name && name !== targetName && sidecars.indexOf(name) === -1) return;
                    clearTimeout(watchTimer);
                    watchTimer = setTimeout(function () {
                        var doc;
                        try {
                            ensureDb();
                            doc = db.readAll(handle);
                        } catch (err) {
                            emitter.emit('error', err);
                            return;
                        }
                        // 自己刚写进去的内容不用再读一遍：快照一致就跳过，
                        // 否则每次保存都会被自己触发一轮重载
                        if (snapshotOf(doc.routes, doc.groups) === loadedSnapshot) return;
                        try {
                            reloadFromDb();
                        } catch (err) {
                            emitter.emit('error', err);
                        }
                    }, 120);
                });
            } catch (err) {
                emitter.emit('error', err);
            }
        },

        stopWatching: function () {
            clearTimeout(watchTimer);
            if (watcher) {
                watcher.close();
                watcher = null;
            }
        },

        /** 关掉库句柄。服务退出或测试收尾时调，避免文件句柄悬着 */
        close: function () {
            store.stopWatching();
            db.close(handle);
            handle = null;
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
    normalizeRoute: normalizeRoute,
    createSampleRoutes: createSampleRoutes,
    METHODS: METHODS,
    RESPONSE_TYPES: RESPONSE_TYPES,
    FIELD_TYPES: FIELD_TYPES,
    RESERVED_PREFIX: RESERVED_PREFIX,
    DEFAULT_FILE: DEFAULT_FILE
};
