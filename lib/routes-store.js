/**
 * 路由配置存储：读写 routes.json，供管理台 API 和运行时共用。
 *
 * 文件结构：
 * {
 *   "version": 1,
 *   "routes": [ { ...Route } ]
 * }
 *
 * 写入采用「临时文件 + rename」的原子替换，避免管理台保存时把文件写坏。
 * 同时监听文件所在目录，外部编辑 routes.json 也能触发 change 事件实现热更新。
 */

var fs = require('fs');
var path = require('path');
var EventEmitter = require('events').EventEmitter;

var METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'ALL'];
var RESPONSE_TYPES = ['json', 'text', 'html'];
var FIELD_TYPES = ['string', 'text', 'number', 'price', 'boolean', 'id', 'uuid', 'phone',
    'email', 'name', 'city', 'date', 'datetime', 'image', 'url', 'array', 'object'];
var RESERVED_PREFIX = '/__mock';

var DEFAULT_FILE = 'routes.json';

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
    var loadedText = null;
    var watcher = null;
    var watchTimer = null;

    function readFromDisk() {
        if (!fs.existsSync(filePath)) {
            return { version: 1, routes: [] };
        }
        var text = fs.readFileSync(filePath, 'utf-8');
        if (text.trim() === '') return { version: 1, routes: [] };
        var parsed;
        try {
            parsed = JSON.parse(text);
        } catch (err) {
            throw new Error('routes.json 不是合法的 JSON：' + err.message);
        }
        var list = Array.isArray(parsed) ? parsed : (parsed && parsed.routes);
        if (!Array.isArray(list)) {
            throw new Error('routes.json 格式不对，应为 { "routes": [...] } 或直接是数组');
        }
        loadedText = text;
        return { version: 1, routes: list };
    }

    function serialize() {
        return JSON.stringify({ version: 1, routes: routes }, null, 2) + '\n';
    }

    function persist() {
        var text = serialize();
        if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
        var tmpPath = filePath + '.tmp';
        fs.writeFileSync(tmpPath, text);
        fs.renameSync(tmpPath, filePath);
        loadedText = text;
    }

    /** 落盘并把变更广播出去（管理台保存与外部编辑都走这里） */
    function commit() {
        persist();
        emitter.emit('change', routes);
        return routes;
    }

    function reloadFromDisk() {
        var data = readFromDisk();
        routes = data.routes;
        emitter.emit('change', routes);
        return routes;
    }

    var store = {
        filePath: filePath,

        /** 首次加载；文件不存在时保持空列表（不主动建文件） */
        load: function () {
            var data = readFromDisk();
            routes = data.routes;
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
            var route = normalizeRoute(input, { keepId: false });
            routes.push(route);
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
            commit();
            return added;
        },

        /** 直接把整个列表写回（例如路由排序） */
        replaceAll: function (list) {
            routes = (list || []).map(function (item) {
                return normalizeRoute(item, { keepId: true });
            });
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
         * 监听配置文件变化（外部编辑 routes.json 也能热更新）。
         * 监听目录而不是文件，这样文件被删除/重建也能捕获。
         * 是否监听只由 startWatching / stopWatching 决定，不隐式依赖构造参数。
         */
        startWatching: function () {
            if (watcher) return;
            if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
            var targetName = path.basename(filePath);
            try {
                watcher = fs.watch(dirPath, function (eventType, filename) {
                    if (filename && String(filename) !== targetName) return;
                    if (String(filename) === path.basename(filePath) + '.tmp') return;
                    clearTimeout(watchTimer);
                    watchTimer = setTimeout(function () {
                        // 自己刚写过的内容不用再读一遍
                        var text;
                        try {
                            text = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
                        } catch (err) {
                            return;
                        }
                        if (text === loadedText) return;
                        try {
                            reloadFromDisk();
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
    DEFAULT_FILE: DEFAULT_FILE
};
