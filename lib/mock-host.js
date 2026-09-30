/**
 * mock 挂载：每个项目挂在 /mock/<slug>，另有一个「根项目」挂在根路径。
 *
 * 根项目存在的意义是兼容老用法 —— 老用户的接口本来就配在 /api/xxx 这种根路径下，
 * 升级后不该改 URL。多出来的项目则统一走 /mock/<slug> 前缀，这样两个项目都配了
 * /api/users 也不会打架。
 *
 * 注意 /mock/<slug> 只在 slug **真的存在**时才拦。slug 不存在时请求继续往下走，
 * 交给根项目处理 —— 否则根项目里一条 /mock/whatever 的接口就永远访问不到了。
 */

var projectsRepo = require('./db/repos/projects');
var projectStores = require('./project-stores');
var runtimeModule = require('./mock-runtime');

var MOCK_PATH = /^\/mock\/([^\/]+)((?:\/.*)?)$/;

/** 拆掉查询串：它要跟着路径一起被改写，不能被丢掉 */
function splitQuery(url) {
    var index = url.indexOf('?');
    if (index === -1) return { pathname: url, search: '' };
    return { pathname: url.slice(0, index), search: url.slice(index) };
}

/**
 * @returns {{slug: string, rest: string}|null} 不是 /mock/<slug> 形状就返回 null
 */
function parseMockPath(url) {
    var parts = splitQuery(url || '');
    var match = MOCK_PATH.exec(parts.pathname);
    if (!match) return null;

    var rest = (match[2] || '') + parts.search;
    if (!rest || rest.charAt(0) !== '/') rest = '/' + rest;

    // 百分号编码可能是坏的（例如 /mock/%E0%A4%A/x）。decodeURIComponent 这时会抛
    // URIError，不接住的话会变成 500 并把堆栈漏出去 —— 当成普通路径交回给调用方。
    var slug;
    try {
        slug = decodeURIComponent(match[1]);
    } catch (err) {
        return null;
    }

    return { slug: slug, rest: rest };
}

/**
 * @param {object} handle lib/db 的 handle
 * @param {{rootProjectId?: string|null}} options
 */
function createMockHost(handle, options) {
    options = options || {};
    var rootProjectId = options.rootProjectId || null;

    var runtimes = new Map();
    var slugCache = new Map();
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
     * 只缓存命中的 slug。未命中的不缓存 —— 否则先请求了一个还不存在的 slug，
     * 之后那个项目建出来了也会一直 404。
     */
    function projectIdForSlug(slug) {
        var cached = slugCache.get(slug);
        if (cached) return cached;

        var project = projectsRepo.getBySlug(handle, slug);
        if (!project) return null;

        slugCache.set(slug, project.id);
        return project.id;
    }

    function onHandleChange() {
        if (closed) return;
        // 项目可能被新建、改名或删除，slug 映射一律作废重查。
        // 这里不区分事件类型：清一个 Map 很便宜，漏清却会让路由一直指错项目。
        slugCache.clear();
    }
    handle.events.on('change', onHandleChange);

    /**
     * 把请求交给某个项目的 runtime。
     * 带前缀时要临时改写 req.url / req.baseUrl，并在 runtime 的 next 里还原 ——
     * 不还原的话，请求落到后面的中间件时看到的会是改写过的路径。
     */
    function dispatch(runtime, parsed, req, res, next) {
        if (!parsed) {
            runtime.middleware(req, res, next);
            return;
        }

        var originalUrl = req.url;
        var originalBaseUrl = req.baseUrl;

        req.url = parsed.rest;
        req.baseUrl = (originalBaseUrl || '') + '/mock/' + parsed.slug;

        runtime.middleware(req, res, function (err) {
            req.url = originalUrl;
            req.baseUrl = originalBaseUrl;
            next(err);
        });
    }

    return {
        middleware: function (req, res, next) {
            var parsed = parseMockPath(req.url);

            if (parsed) {
                var projectId = projectIdForSlug(parsed.slug);
                if (projectId) {
                    dispatch(runtimeFor(projectId), parsed, req, res, next);
                    return;
                }
                // slug 不存在：不拦，交给根项目（根项目里可能就有 /mock/... 的接口）
            }

            if (rootProjectId) {
                var rootRuntime = runtimeFor(rootProjectId);
                if (rootRuntime) {
                    dispatch(rootRuntime, null, req, res, next);
                    return;
                }
            }

            next();
        },

        rootProject: function () {
            return rootProjectId ? projectsRepo.getById(handle, rootProjectId) : null;
        },

        close: function () {
            if (closed) return;
            closed = true;
            handle.events.removeListener('change', onHandleChange);
            runtimes.clear();
            slugCache.clear();
        }
    };
}

module.exports = {
    createMockHost: createMockHost,
    parseMockPath: parseMockPath
};
