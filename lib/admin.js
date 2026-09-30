/**
 * 管理台后端：/__admin/api/* 的 JSON 接口 + 根路径下的管理台静态页面。
 *
 * 所有接口统一返回 { ok: true, ... } 或 { ok: false, error: '...' }，
 * 失败时带 400/404/500 状态码，前端据此提示。
 */

var express = require('express');
var path = require('path');
var engine = require('./mock-engine');
var storeModule = require('./routes-store');
var importers = require('./importers');

var WEB_DIR = path.join(__dirname, 'web');

// 管理台自己的 API 挂在保留前缀下面。前缀本身由 routes-store 定义——配路由时要拿它
// 做「不许占用」的校验，这里引用同一个值，避免两边各写一份、改一处漏一处。
var API_PATH = storeModule.RESERVED_PREFIX + '/api';
var RESERVED_PREFIX = storeModule.RESERVED_PREFIX;

// 默认入口页。管理台同时挂在根路径，访问 /index.html 直接就是管理台，
// 访问 / 由 command.js 显式 302 过来。
var DEFAULT_PAGE = '/index.html';

var RESPONSE_TYPES = [
    { value: 'json', label: 'JSON' },
    { value: 'text', label: '纯文本' },
    { value: 'html', label: 'HTML' }
];

function ok(res, payload) {
    var body = { ok: true };
    Object.keys(payload || {}).forEach(function (key) { body[key] = payload[key]; });
    res.json(body);
}

function fail(res, status, message) {
    res.status(status).json({ ok: false, error: message });
}

/** 预览用的是未保存的草稿，字段可能还没填完，这里宽松处理 */
function safeNormalize(route) {
    try {
        return storeModule.normalizeRoute(route, { keepId: true });
    } catch (err) {
        return {
            id: (route && route.id) || 'draft',
            method: (route && route.method) || 'GET',
            path: (route && route.path) || '/',
            status: Number(route && route.status) || 200,
            delay: 0,
            cors: false,
            headers: [],
            query: [],
            body: [],
            responseType: (route && route.responseType) || 'json',
            response: String((route && route.response) || '')
        };
    }
}

function previewRoute(draft) {
    var route = safeNormalize(draft);
    var result = engine.render(route.response, {});
    var text = result.text;
    var jsonValid = true;
    var jsonError = null;

    if (route.responseType === 'json') {
        text = engine.repairJson(text);
        try {
            JSON.parse(text);
        } catch (err) {
            jsonValid = false;
            jsonError = err.message;
        }
    }

    return {
        rendered: text,
        warnings: result.warnings,
        jsonValid: jsonValid,
        jsonError: jsonError
    };
}

/**
 * @param {{store: object, version: string}} options
 * @returns {{api: import('express').Router, static: import('express').Router}}
 */
function createAdmin(options) {
    var store = options.store;
    var version = options.version || '';

    var api = express.Router();
    api.use(express.json({ limit: '4mb' }));

    /* ---------------------------------------------------------- 元信息 */

    api.get('/meta', function (req, res) {
        ok(res, {
            configPath: store.filePath,
            version: version,
            defaultPage: DEFAULT_PAGE,
            methods: storeModule.METHODS,
            responseTypes: RESPONSE_TYPES,
            fieldTypes: engine.FIELD_TYPES,
            placeholders: engine.PLACEHOLDERS.map(function (item) {
                return {
                    name: item.name,
                    args: item.args,
                    group: item.group,
                    desc: item.desc,
                    example: item.insert
                };
            }),
            templates: engine.TEMPLATES
        });
    });

    /* ---------------------------------------------------------- 增删改查 */

    api.get('/routes', function (req, res) {
        try {
            ok(res, {
                configPath: store.filePath,
                groups: store.getGroups(),
                routes: store.getRoutes()
            });
        } catch (err) {
            fail(res, 500, err.message);
        }
    });

    api.post('/routes', function (req, res) {
        try {
            var route = store.create((req.body || {}).route || req.body || {});
            ok(res, { route: route });
        } catch (err) {
            fail(res, 400, err.message);
        }
    });

    api.put('/routes/:id', function (req, res) {
        try {
            var route = store.update(req.params.id, (req.body || {}).route || req.body || {});
            if (!route) return fail(res, 404, '接口不存在: ' + req.params.id);
            ok(res, { route: route });
        } catch (err) {
            fail(res, 400, err.message);
        }
    });

    api.delete('/routes/:id', function (req, res) {
        try {
            if (!store.remove(req.params.id)) return fail(res, 404, '接口不存在: ' + req.params.id);
            ok(res, {});
        } catch (err) {
            fail(res, 500, err.message);
        }
    });

    api.post('/routes/:id/duplicate', function (req, res) {
        try {
            var route = store.duplicate(req.params.id);
            if (!route) return fail(res, 404, '接口不存在: ' + req.params.id);
            ok(res, { route: route });
        } catch (err) {
            fail(res, 400, err.message);
        }
    });

    /* ---------------------------------------------------------- 分组管理 */

    api.get('/groups', function (req, res) {
        try {
            ok(res, { groups: store.getGroups(), configPath: store.filePath });
        } catch (err) {
            fail(res, 500, err.message);
        }
    });

    api.post('/groups', function (req, res) {
        try {
            var group = store.addGroup((req.body || {}).name);
            ok(res, { group: group, groups: store.getGroups(), routes: store.getRoutes() });
        } catch (err) {
            fail(res, 400, err.message);
        }
    });

    api.post('/groups/reorder', function (req, res) {
        try {
            var names = (req.body || {}).names;
            if (!Array.isArray(names)) return fail(res, 400, 'names 必须是数组');
            ok(res, { groups: store.reorderGroups(names), routes: store.getRoutes() });
        } catch (err) {
            fail(res, 400, err.message);
        }
    });

    api.put('/groups/:name', function (req, res) {
        try {
            var result = store.renameGroup(req.params.name, (req.body || {}).name);
            ok(res, {
                group: { name: result.name, count: result.count },
                moved: result.moved,
                groups: store.getGroups(),
                routes: store.getRoutes()
            });
        } catch (err) {
            fail(res, 400, err.message);
        }
    });

    api.delete('/groups/:name', function (req, res) {
        try {
            var mode = (req.query || {}).routes === 'delete' ? 'delete' : 'move';
            var result = store.removeGroup(req.params.name, mode);
            ok(res, { removed: result, groups: store.getGroups(), routes: store.getRoutes() });
        } catch (err) {
            fail(res, 400, err.message);
        }
    });

    /* ---------------------------------------------------------- 预览 / 导入 / 导出 */

    api.post('/preview', function (req, res) {
        try {
            var draft = (req.body || {}).route || req.body || {};
            ok(res, previewRoute(draft));
        } catch (err) {
            fail(res, 400, err.message);
        }
    });

    api.post('/import/curl', function (req, res) {
        try {
            var text = (req.body || {}).text;
            if (!text || !String(text).trim()) return fail(res, 400, '请粘贴 cURL 命令');
            ok(res, { routes: [importers.curlToRoute(text)] });
        } catch (err) {
            fail(res, 400, err.message);
        }
    });

    api.post('/import/openapi', function (req, res) {
        try {
            var text = (req.body || {}).text;
            if (!text || !String(text).trim()) return fail(res, 400, '请粘贴 OpenAPI/Swagger 定义');
            ok(res, { routes: importers.openapiToRoutes(text) });
        } catch (err) {
            fail(res, 400, err.message);
        }
    });

    api.post('/import/routes', function (req, res) {
        try {
            var list = (req.body || {}).routes;
            if (!Array.isArray(list) || !list.length) return fail(res, 400, '没有可导入的接口');
            ok(res, { routes: store.addMany(list) });
        } catch (err) {
            fail(res, 400, err.message);
        }
    });

    api.get('/export', function (req, res) {
        try {
            var doc = { version: 1, groups: store.getGroups().map(function (g) { return g.name; }), routes: store.getRoutes() };
            ok(res, {
                filename: path.basename(store.filePath),
                json: JSON.stringify(doc, null, 2)
            });
        } catch (err) {
            fail(res, 500, err.message);
        }
    });

    /* ---------------------------------------------------------- 兜底 */

    api.use(function (req, res) {
        fail(res, 404, '管理台接口不存在: ' + req.method + ' ' + req.originalUrl);
    });

    api.use(function (err, req, res, next) {
        if (res.headersSent) return next(err);
        fail(res, 400, '请求处理失败：' + err.message);
    });

    var staticFiles = express.static(WEB_DIR);

    // 挂在根路径的那一份。关掉 index 选项是有意的：否则 express.static 会把
    // 「/」当成目录首页直接返回 200，command.js 里那条 / → /index.html 的跳转
    // 就永远不会执行。关掉之后 / 不归它管，交给显式的跳转。
    var rootStaticFiles = express.static(WEB_DIR, { index: false });

    return {
        api: api,
        static: staticFiles,
        rootStatic: rootStaticFiles,
        apiPath: API_PATH,
        defaultPage: DEFAULT_PAGE
    };
}

module.exports = {
    createAdmin: createAdmin,
    previewRoute: previewRoute,
    API_PATH: API_PATH,
    RESERVED_PREFIX: RESERVED_PREFIX,
    DEFAULT_PAGE: DEFAULT_PAGE,
    WEB_DIR: WEB_DIR
};
