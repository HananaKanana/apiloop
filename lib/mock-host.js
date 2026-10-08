/**
 * mock 挂载：每个项目挂在 /mock-<项目ID>，另有一个「根项目」挂在根路径。
 *
 * 根项目存在的意义是兼容老用法 —— 老用户的接口本来就配在 /api/xxx 这种根路径下，
 * 升级后不该改 URL。多出来的项目则统一走 /mock-<项目ID> 前缀，这样两个项目都配了
 * /api/users 也不会打架。
 *
 * 前缀里用的是**项目 ID**（`p_xxx`），不再是 slug。原因见设计稿 `2026-10-01-local-first.md`
 * 第 6 节：本机模式下项目在本地建，slug 是「给人看的短名」，改名字不该改地址；
 * ID 建出来就不会变，而且**全局唯一**，同步到云端也不会撞。
 *
 * 注意 /mock-<ID> 只在那个项目**真的存在**时才拦。ID 不存在时请求继续往下走，
 * 交给根项目处理 —— 否则根项目里一条 /mock-xxx/whatever 的接口就永远访问不到了。
 */

var projectsRepo = require('./db/repos/projects');
var projectStores = require('./project-stores');
var runtimeModule = require('./mock-runtime');
var mockLog = require('./mock-log');

/**
 * 除根项目之外的项目统一挂在这个前缀下。
 * /meta 要把同一个值告诉前端（前端据此拼出每个项目的访问地址），所以它是导出常量，
 * 下面那条正则也由它拼出来，避免「常量改了正则没改」。
 *
 * 注意末尾是 `-` 而不是 `/`：前缀和 ID 之间没有分隔符，`/mock-p_abc/hello` 才对。
 */
var MOCK_PREFIX = '/mock-';

var MOCK_PATH = new RegExp(
    '^' + MOCK_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^/]+)((?:/.*)?)$'
);

/** 拆掉查询串：它要跟着路径一起被改写，不能被丢掉 */
function splitQuery(url) {
    var index = url.indexOf('?');
    if (index === -1) return { pathname: url, search: '' };
    return { pathname: url.slice(0, index), search: url.slice(index) };
}

/**
 * @returns {{projectId: string, rest: string}|null} 不是 /mock-<ID> 形状就返回 null
 *
 * `projectId` 只是**地址里写的那个串**，不保证库里真有这个项目 —— 认不认由调用方查库决定。
 */
function parseMockPath(url) {
    var parts = splitQuery(url || '');
    var match = MOCK_PATH.exec(parts.pathname);
    if (!match) return null;

    var rest = (match[2] || '') + parts.search;
    if (!rest || rest.charAt(0) !== '/') rest = '/' + rest;

    // 百分号编码可能是坏的（例如 /mock-%E0%A4%A/x）。decodeURIComponent 这时会抛
    // URIError，不接住的话会变成 500 并把堆栈漏出去 —— 当成普通路径交回给调用方。
    var projectId;
    try {
        projectId = decodeURIComponent(match[1]);
    } catch (err) {
        return null;
    }

    return { projectId: projectId, rest: rest };
}

/**
 * @param {object} handle lib/db 的 handle
 * @param {{rootProjectId?: string|null}} options
 */
function createMockHost(handle, options) {
    options = options || {};
    var rootProjectId = options.rootProjectId || null;

    var runtimes = new Map();
    var idCache = new Map();
    var closed = false;

    function runtimeFor(projectId) {
        if (!projectId) return null;

        var runtime = runtimes.get(projectId);
        if (!runtime) {
            runtime = runtimeModule.createRuntime(projectStores.get(handle, projectId));
            runtimes.set(projectId, runtime);
        }
        return runtime;
    }

    /**
     * 地址里写的 ID → 库里真有这个项目时返回它的 ID，否则 null。
     *
     * 只缓存命中的。未命中的不缓存 —— 否则先请求了一个还不存在的 ID，
     * 之后那个项目建出来了也会一直 404。
     */
    function projectIdForId(id) {
        var cached = idCache.get(id);
        if (cached) return cached;

        var project = projectsRepo.getById(handle, id);
        if (!project) return null;

        idCache.set(id, project.id);
        return project.id;
    }

    function onHandleChange() {
        if (closed) return;
        // 项目可能被新建或删除，ID 映射一律作废重查。
        // 这里不区分事件类型：清一个 Map 很便宜，漏清却会让路由一直指错项目。
        idCache.clear();
    }
    handle.events.on('change', onHandleChange);

    /**
     * `/mock-<ID>/...` 下**没有**匹配到任何接口的请求。
     *
     * 这条日志才是联调时最值钱的：地址拼错了、ID 写错了、方法不对，用户看到的
     * 只是浏览器里一个 404，完全不知道是自己配的接口没命中，还是项目根本没挂上去。
     * 根路径下没命中的请求不记 —— 那里混着大量静态文件请求，记了只会淹没真正的问题。
     *
     * 响应此刻还没产生（后面可能接 router.js、静态文件或兜底 404），所以状态码
     * 只能在 `finish` 里取，响应预览留空。快照要在 req.url 被还原之前取。
     */
    function recordUnmatched(projectId, req, res, startedAt) {
        var snapshot = mockLog.snapshotRequest(req);

        res.on('finish', function () {
            try {
                mockLog.record(projectId, {
                    method: snapshot.method,
                    url: snapshot.url,
                    query: snapshot.query,
                    headers: snapshot.headers,
                    bodyPreview: snapshot.bodyPreview,
                    matched: null,
                    status: res.statusCode,
                    durationMs: Date.now() - startedAt,
                    responsePreview: ''
                });
            } catch (err) {
                // 记日志是顺带的，绝不能把 mock 链路带崩
                console.warn('[apiloop] 记录 mock 调用日志失败，已跳过：' +
                    ((err && err.message) || err));
            }
        });
    }

    /**
     * 把请求交给某个项目的 runtime。
     * 带前缀时要临时改写 req.url / req.baseUrl，并在 runtime 的 next 里还原 ——
     * 不还原的话，请求落到后面的中间件时看到的会是改写过的路径。
     *
     * @param {string|null} projectId 这个 runtime 属于哪个项目；根项目那条路传 null
     */
    function dispatch(runtime, parsed, req, res, next, projectId) {
        if (!parsed) {
            runtime.middleware(req, res, next);
            return;
        }

        var startedAt = Date.now();
        var originalUrl = req.url;
        var originalBaseUrl = req.baseUrl;

        req.url = parsed.rest;
        req.baseUrl = (originalBaseUrl || '') + MOCK_PREFIX + parsed.projectId;

        runtime.middleware(req, res, function (err) {
            // runtime 调到 next 就是「这一层没匹配上」。带 err 的不记：
            // 那是出错了，会走 Express 的错误处理，不是「接口不存在」。
            if (!err && projectId) recordUnmatched(projectId, req, res, startedAt);

            req.url = originalUrl;
            req.baseUrl = originalBaseUrl;
            next(err);
        });
    }

    return {
        middleware: function (req, res, next) {
            var parsed = parseMockPath(req.url);

            if (parsed) {
                var projectId = projectIdForId(parsed.projectId);
                if (projectId) {
                    dispatch(runtimeFor(projectId), parsed, req, res, next, projectId);
                    return;
                }
                // 项目不存在：不拦，交给根项目（根项目里可能就有 /mock-... 的接口）
            }

            if (rootProjectId) {
                var rootRuntime = runtimeFor(rootProjectId);
                if (rootRuntime) {
                    // parsed 传 null：根路径下没命中的请求不进日志
                    dispatch(rootRuntime, null, req, res, next, null);
                    return;
                }
            }

            next();
        },

        /**
         * 把一个地址解析成「哪个项目 + 项目内部是什么路径」。
         *
         * 规则和上面的中间件**完全一致**（`/mock-<ID>` 只在项目真的存在时才认，
         * 否则整个交给根项目）。WebSocket 的 mock 服务端用它 —— 两处各写一套的话，
         * 同一个地址在 HTTP 和 WS 下会落到不同的项目上。
         *
         * @param {string} url
         * @returns {{projectId: string, pathname: string}|null}
         */
        resolve: function (url) {
            var text = String(url || '');
            var parsed = parseMockPath(text);

            if (parsed) {
                var projectId = projectIdForId(parsed.projectId);
                if (projectId) return { projectId: projectId, pathname: splitQuery(parsed.rest).pathname };
            }

            if (rootProjectId) {
                return { projectId: rootProjectId, pathname: splitQuery(text).pathname };
            }
            return null;
        },

        close: function () {
            if (closed) return;
            closed = true;
            handle.events.removeListener('change', onHandleChange);
            runtimes.clear();
            idCache.clear();
        }
    };
}

/**
 * 云端开不开 Mock（用户 2026-10-08）：**默认关**，免得 Mock 的流量把云端拖垮；
 * 要开就设 `APILOOP_CLOUD_MOCK=1`。只管 `web`（云端）模式 —— 客户端里的本机 Mock
 * 和 start / open 这两个单机命令不受影响。
 */
function cloudMockEnabled() {
    return process.env.APILOOP_CLOUD_MOCK === '1';
}

module.exports = {
    createMockHost: createMockHost,
    cloudMockEnabled: cloudMockEnabled,
    parseMockPath: parseMockPath,
    MOCK_PREFIX: MOCK_PREFIX
};
