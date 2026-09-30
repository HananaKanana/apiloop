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
var appInfo = require('./app-info');
var auth = require('./auth');
var adminAuth = require('./admin-auth');
var projectsRepo = require('./db/repos/projects');
var mockHostModule = require('./mock-host');
var projectsApi = require('./api/projects');
var environmentsApi = require('./api/environments');
var treeApi = require('./api/tree');
var sendApi = require('./api/send');
var postmanApi = require('./api/postman');
var templatizeApi = require('./api/templatize');
var expectationsApi = require('./api/expectations');
var membersApi = require('./api/members');
var mockLogApi = require('./api/mock-log');
var storeGuardModule = require('./api/guard');

var WEB_DIR = path.join(__dirname, 'web');

// 管理台自己的 API 挂在保留前缀下面。前缀本身由 routes-store 定义——配路由时要拿它
// 做「不许占用」的校验，这里引用同一个值，避免两边各写一份、改一处漏一处。
var API_PATH = storeModule.RESERVED_PREFIX + '/api';
var RESERVED_PREFIX = storeModule.RESERVED_PREFIX;

// 默认入口页。管理台同时挂在根路径，访问 /index.html 直接就是管理台，
// 访问 / 由 command.js 显式 302 过来。
var DEFAULT_PAGE = '/index.html';

// 导出用文件名。配置本体已经进了数据库，导出的 JSON 是给人分享、进 git 用的，
// 所以固定叫 routes.json —— 它也正是首次启动时能自动导入的那种格式。
var EXPORT_FILENAME = 'routes.json';

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
 * @param {{handle: object, store: object, version: string, rootProjectId?: string}} options
 * @returns {{api: object, static: object, rootStatic: object}}
 */
function createAdmin(options) {
    var handle = options.handle;
    var store = options.store;
    var version = options.version || '';
    // 挂在根路径的那个项目。缺省用 store 自己的项目，这样单独调它的测试不用额外传。
    var rootProjectId = options.rootProjectId || store.projectId || null;

    /** 当前 store 归属的项目 */
    function projectOf() {
        if (!store.projectId) return null;
        var project = projectsRepo.getById(handle, store.projectId);
        return project ? { id: project.id, slug: project.slug, name: project.name } : null;
    }

    /** 挂在根路径的那个项目（新接口用它，取代原来的 project 字段） */
    function rootProjectOf() {
        if (!rootProjectId) return null;
        var project = projectsRepo.getById(handle, rootProjectId);
        return project ? { id: project.id, slug: project.slug, name: project.name } : null;
    }

    // 新接口（lib/api/*）统一的上下文
    var ctx = { handle: handle, rootProjectId: rootProjectId };

    // 旧接口统一作用在根项目上，权限也统一按「根项目的角色」判：
    // 读要 viewer，写要 editor（契约第 10 节）
    var legacyGuard = storeGuardModule.createGuard(ctx);
    function guardRoot(level) {
        return legacyGuard.guard(level, legacyGuard.rootProject);
    }

    var api = express.Router();
    api.use(express.json({ limit: '4mb' }));

    // 管理台接口是必须登录的。没有 handle 就没法校验会话，这时**直接报错**，
    // 而不是默默跳过登录校验 —— 那种「出错就放行」的写法，以后有人漏传 handle
    // 就等于把接口全裸奔出去。
    if (!handle) {
        throw new Error('createAdmin 需要 handle：管理台接口必须校验登录态');
    }

    // 挂载顺序有讲究：先解析 session 把 req.user 填上，再走 auth 路由
    // （它内部把 /auth/login 排在 requireLogin 之前），然后统一要求登录，
    // 最后才是下面那一堆接口。
    api.use(auth.createSessionMiddleware(handle));
    api.use(adminAuth.createRouter(handle));
    api.use(auth.requireLogin);

    // 新接口一律挂在 requireLogin 之后 —— 它们自己不做鉴权，
    // 漏挂一次就等于把项目和环境裸奔出去。
    api.use(projectsApi.createRouter(ctx));
    api.use(environmentsApi.createRouter(ctx));
    api.use(treeApi.createRouter(ctx));
    api.use(sendApi.createRouter(ctx));
    api.use(postmanApi.createRouter(ctx));
    api.use(templatizeApi.createRouter(ctx));
    api.use(expectationsApi.createRouter(ctx));
    api.use(membersApi.createRouter(ctx));
    api.use(mockLogApi.createRouter(ctx));

    /* ---------------------------------------------------------- 元信息 */

    api.get('/meta', function (req, res) {
        ok(res, {
            configPath: store.filePath,
            version: version,
            appName: appInfo.APP_NAME,
            defaultPage: DEFAULT_PAGE,
            mockBase: mockHostModule.MOCK_PREFIX,
            user: req.user || null,
            project: projectOf(),
            rootProject: rootProjectOf(),
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

    api.get('/routes', guardRoot('viewer'), function (req, res) {
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

    api.post('/routes', guardRoot('editor'), function (req, res) {
        try {
            var route = store.create((req.body || {}).route || req.body || {});
            ok(res, { route: route });
        } catch (err) {
            fail(res, 400, err.message);
        }
    });

    api.put('/routes/:id', guardRoot('editor'), function (req, res) {
        try {
            var route = store.update(req.params.id, (req.body || {}).route || req.body || {});
            if (!route) return fail(res, 404, '接口不存在: ' + req.params.id);
            ok(res, { route: route });
        } catch (err) {
            fail(res, 400, err.message);
        }
    });

    api.delete('/routes/:id', guardRoot('editor'), function (req, res) {
        try {
            if (!store.remove(req.params.id)) return fail(res, 404, '接口不存在: ' + req.params.id);
            ok(res, {});
        } catch (err) {
            fail(res, 500, err.message);
        }
    });

    api.post('/routes/:id/duplicate', guardRoot('editor'), function (req, res) {
        try {
            var route = store.duplicate(req.params.id);
            if (!route) return fail(res, 404, '接口不存在: ' + req.params.id);
            ok(res, { route: route });
        } catch (err) {
            fail(res, 400, err.message);
        }
    });

    /* ---------------------------------------------------------- 分组管理 */

    api.get('/groups', guardRoot('viewer'), function (req, res) {
        try {
            ok(res, { groups: store.getGroups(), configPath: store.filePath });
        } catch (err) {
            fail(res, 500, err.message);
        }
    });

    api.post('/groups', guardRoot('editor'), function (req, res) {
        try {
            var group = store.addGroup((req.body || {}).name);
            ok(res, { group: group, groups: store.getGroups(), routes: store.getRoutes() });
        } catch (err) {
            fail(res, 400, err.message);
        }
    });

    api.post('/groups/reorder', guardRoot('editor'), function (req, res) {
        try {
            var names = (req.body || {}).names;
            if (!Array.isArray(names)) return fail(res, 400, 'names 必须是数组');
            ok(res, { groups: store.reorderGroups(names), routes: store.getRoutes() });
        } catch (err) {
            fail(res, 400, err.message);
        }
    });

    api.put('/groups/:name', guardRoot('editor'), function (req, res) {
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

    api.delete('/groups/:name', guardRoot('editor'), function (req, res) {
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

    api.post('/import/routes', guardRoot('editor'), function (req, res) {
        try {
            var list = (req.body || {}).routes;
            if (!Array.isArray(list) || !list.length) return fail(res, 400, '没有可导入的接口');
            ok(res, { routes: store.addMany(list) });
        } catch (err) {
            fail(res, 400, err.message);
        }
    });

    api.get('/export', guardRoot('viewer'), function (req, res) {
        try {
            var doc = { version: 1, groups: store.getGroups().map(function (g) { return g.name; }), routes: store.getRoutes() };
            ok(res, {
                filename: EXPORT_FILENAME,
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
