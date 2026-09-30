/**
 * 管理台后端：/__mock/api/* 的 JSON 接口 + /__mock 静态页面。
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
var MOUNT_PATH = '/__mock';
var API_PATH = MOUNT_PATH + '/api';

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
            mountPath: MOUNT_PATH,
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
            ok(res, { configPath: store.filePath, routes: store.getRoutes() });
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
            ok(res, {
                filename: path.basename(store.filePath),
                json: JSON.stringify({ version: 1, routes: store.getRoutes() }, null, 2)
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

    return { api: api, static: staticFiles, mountPath: MOUNT_PATH, apiPath: API_PATH };
}

module.exports = {
    createAdmin: createAdmin,
    previewRoute: previewRoute,
    MOUNT_PATH: MOUNT_PATH,
    API_PATH: API_PATH,
    WEB_DIR: WEB_DIR
};
