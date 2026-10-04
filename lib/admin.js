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
var trashApi = require('./api/trash');
var sendApi = require('./api/send');
var wsApi = require('./api/ws');
var postmanApi = require('./api/postman');
var harApi = require('./api/har');
var templatizeApi = require('./api/templatize');
var expectationsApi = require('./api/expectations');
var membersApi = require('./api/members');
var sharesApi = require('./api/shares');
var openapiApi = require('./api/openapi');
var searchApi = require('./api/search');
var commentsApi = require('./api/comments');
var copyApi = require('./api/copy');
var mockLogApi = require('./api/mock-log');
var cookiesApi = require('./api/cookies');
var settingsApi = require('./api/settings');
var prefsApi = require('./api/prefs');
var downloadsApi = require('./api/downloads');
var syncApi = require('./sync');

var WEB_DIR = path.join(__dirname, 'web');

// 管理台自己的 API 挂在保留前缀下面。前缀本身由 routes-store 定义——配路由时要拿它
// 做「不许占用」的校验，这里引用同一个值，避免两边各写一份、改一处漏一处。
var API_PATH = storeModule.RESERVED_PREFIX + '/api';
var RESERVED_PREFIX = storeModule.RESERVED_PREFIX;

// 安装包下载**不在 /api 下面**：它不能要求登录（链接要能直接发给同事），
// 而 api 那个 router 在 requireLogin 之后。所以单独一条挂载点。
var DOWNLOADS_PATH = RESERVED_PREFIX + '/downloads';

// HAR 导入的两个路径前缀。它们要用 50MB 的请求体上限，而全局是 4MB，
// 所以下面挂解析器时要按这个前缀分两处处理 —— 写成常量，别在两处各写一遍字符串。
var HAR_PATH_PREFIX = '/import/har';

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
 * @param {{handle: object, store: object, version: string, rootProjectId?: string,
 *          sync?: boolean, localSend?: boolean}} options
 *   `sync` 为真时挂上同步接口（只有云端要）；`localSend` 为真表示这个管理台跑在
 *   用户自己那台机器上（网关里的那一份）
 * @returns {{api: object, static: object, rootStatic: object}}
 */
/**
 * 拉 OpenAPI 定义的原文（给 `/import/openapi` 的 url 用）。
 * 实现在 `lib/openapi-fetch.js` —— 从 OpenAPI 同步更新那一节也要用它，
 * 两处各写一份的话超时和大小上限迟早会不一致。
 */
var fetchSpecText = require('./openapi-fetch').fetchSpecText;

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

    // 新接口（lib/api/*）统一的上下文。项目权限由各自的 guard 负责，
    // 这里不再有「旧接口统一按根项目判权限」那一套 —— 旧接口在 2.0 里已经删掉了。
    //
    // `wsSessionOptions` 是给测试留的注入点（把 WebSocket 会话 60 秒的回收时间缩短），
    // 生产上不传，传 undefined 时 lib/ws-sessions 会用自己的默认值。
    var ctx = {
        handle: handle,
        rootProjectId: rootProjectId,
        wsSessionOptions: options.wsSessionOptions,
        // 这个管理台是不是跑在用户自己那台机器上（网关里的那一份传 true）。
        // 目前只有一个用处：把 EHOSTUNREACH 换成 macOS 的「本地网络」授权提示。
        localSend: options.localSend === true,
        // 云端自己的版本。安装包下载接口要用它（前端拿它和网关版本比，不一致就提示升级）
        version: version
    };

    var api = express.Router();

    /**
     * HAR 的请求体上限是 50MB（HAR 经常几十 MB），但**不能挂在这个位置**：
     * 这里在 `requireLogin` 之前，没登录的人也能让服务端缓冲并解析 50MB 的数据。
     * Docker 部署时服务默认对局域网开放，这个口子不该留着。
     *
     * 所以分两步：
     *   1. 全局 4MB 解析器跳过 `/import/har` 前缀（否则 4MB 会先把大请求拒掉）；
     *   2. 50MB 的解析器挂到 `requireLogin` **之后** —— 没登录的请求在读请求体
     *      之前就被拒了。
     */
    var json4mb = express.json({ limit: '4mb' });

    /**
     * 每个管理台响应都带上版本号，**包括没登录时的 401**。
     *
     * 本机网关要知道「云端现在是哪个版本」，好提示用户装新的安装包；而网关探云端时
     * 手里没有登录态（`/meta` 要登录），所以版本号得放在一个不用登录就能看到的地方。
     */
    api.use(function (req, res, next) {
        if (version) res.setHeader('X-Apiloop-Version', version);
        next();
    });

    api.use(function (req, res, next) {
        var path = req.path || '';
        if (path === HAR_PATH_PREFIX || path.indexOf(HAR_PATH_PREFIX + '/') === 0) return next();
        return json4mb(req, res, next);
    });

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

    /**
     * 公开的分享文档（`GET /public/shares/:id`）**必须挂在最前面**：打开链接的人不登录、
     * 也不该登录，它自己只按链接串查库，不读任何登录态。
     *
     * 位置比登录接口还靠前 —— `adminAuth.createRouter` 里有一条**不带路径**的
     * `router.use(auth.requireLogin)`（`lib/admin-auth.js`），挂在它后面的话，
     * 公开接口一样会被拦成 401。这一点很容易踩：`/auth/login` 之所以不受影响，
     * 只是因为它在同一个 router 里排在 requireLogin 前面。
     */
    api.use(sharesApi.createPublicRouter(ctx));

    api.use(adminAuth.createRouter(handle));
    api.use(auth.requireLogin);

    // 50MB 解析器必须在 requireLogin 之后，见上面那段说明。
    // 前缀匹配同时覆盖 /import/har 和 /import/har/preview。
    api.use(HAR_PATH_PREFIX, express.json({ limit: '50mb' }));

    // 新接口一律挂在 requireLogin 之后 —— 它们自己不做鉴权，
    // 漏挂一次就等于把项目和环境裸奔出去。
    api.use(projectsApi.createRouter(ctx));
    api.use(environmentsApi.createRouter(ctx));
    api.use(treeApi.createRouter(ctx));
    api.use(trashApi.createRouter(ctx));
    api.use(sendApi.createRouter(ctx));
    api.use(wsApi.createRouter(ctx));
    api.use(postmanApi.createRouter(ctx));
    api.use(harApi.createRouter(ctx));
    api.use(templatizeApi.createRouter(ctx));
    api.use(expectationsApi.createRouter(ctx));
    api.use(membersApi.createRouter(ctx));
    api.use(sharesApi.createRouter(ctx));
    // 从 OpenAPI 同步更新（第四轮第 3 节）：diff / apply
    api.use(openapiApi.createRouter(ctx));
    // 全局查找替换（第五轮第 2 节）
    api.use(searchApi.createRouter(ctx));
    // 接口评论和 @ 提醒（第五轮第 4 节）：只在云端，网关会转过来
    api.use(commentsApi.createRouter(ctx));
    // 跨项目复制 / 移动（第六轮第 3 节）
    api.use(copyApi.createRouter(ctx));
    api.use(mockLogApi.createRouter(ctx));
    api.use(cookiesApi.createRouter(ctx));
    api.use(settingsApi.createRouter(ctx));
    // 个人偏好（第七轮第 2 节）：项目分组 / 收藏 / 最近打开。只读写**当前用户自己**的行，
    // 网关上落到本机库（离线也能用），同步由同步引擎在后台做，所以不转发云端。
    api.use(prefsApi.createRouter(ctx));
    // 同步接口（L2）只在「云端」挂：网关里的本机管理台是同步的一端，不该再对外提供同步源。
    // 所以由调用方显式传 sync: true（lib/command.js 的 web 模式），别默认打开。
    if (options.sync) api.use(syncApi.createRouter(ctx));
    // 列安装包（要登录）。真正下载的那一半是另一个 router，见 createDownloadRouter
    api.use(downloadsApi.createRouter(ctx));

    /* ---------------------------------------------------------- 元信息 */

    api.get('/meta', function (req, res) {
        ok(res, {
            configPath: store.filePath,
            version: version,
            appName: appInfo.APP_NAME,
            defaultPage: DEFAULT_PAGE,
            mockBase: mockHostModule.MOCK_PREFIX,
            // 这个进程自己发不发请求（G1：Docker 部署默认不发，由本机网关发）。
            // 前端用它决定「发送」按钮能不能点、要不要提示「请从本机的 apiloop 打开」。
            serverSend: sendApi.serverSendEnabled(),
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

    /* ---------------------------------------------------------- 预览与解析 */

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

    /**
     * OpenAPI / Swagger：粘贴的文本（JSON 或 YAML），或者给一个地址由这里去拉
     * （用户 2026-10-02：swagger 常常是一个 URL，比如 /v3/api-docs、/swagger.json）。
     *
     * 地址由**这个进程**去取：客户端里就是本机网关，公司内网的 swagger 也拉得到。
     * 只认 http(s)，15 秒超时，最多 20MB。
     */
    api.post('/import/openapi', function (req, res) {
        var body = req.body || {};
        var url = String(body.url === undefined || body.url === null ? '' : body.url).trim();

        function parse(text) {
            if (!text || !String(text).trim()) return fail(res, 400, '请粘贴 OpenAPI/Swagger 定义');
            try {
                ok(res, { routes: importers.openapiToRoutes(String(text)) });
            } catch (err) {
                fail(res, 400, err.message);
            }
        }

        if (!url) return parse(body.text);
        if (!/^https?:\/\/[^\s]+$/i.test(url)) return fail(res, 400, '地址要以 http:// 或 https:// 开头');
        // 「云端不发请求」时也不替人拉地址（同样是服务器去访问用户给的地址）；粘贴内容、选文件照常
        if (!sendApi.serverSendEnabled()) {
            return fail(res, 409, '云端不替你拉取地址，请粘贴内容或选择文件，或者在 apiloop 客户端里填地址');
        }

        fetchSpecText(url).then(parse, function (err) {
            fail(res, 400, '拉取失败：' + err.message);
        });
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
        defaultPage: DEFAULT_PAGE,
        // 下载：挂在 DOWNLOADS_PATH 上，**不经过 requireLogin**
        downloads: downloadsApi.createDownloadRouter(),
        downloadsPath: DOWNLOADS_PATH
    };
}

module.exports = {
    createAdmin: createAdmin,
    previewRoute: previewRoute,
    API_PATH: API_PATH,
    DOWNLOADS_PATH: DOWNLOADS_PATH,
    RESERVED_PREFIX: RESERVED_PREFIX,
    DEFAULT_PAGE: DEFAULT_PAGE,
    WEB_DIR: WEB_DIR
};
