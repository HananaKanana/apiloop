/**
 * 路由运行时：把 routes.json 里的配置编译成 Express 路由，并支持热更新。
 *
 * 保存配置后 store 会发 change 事件，这里重建一个 Router 并原子替换，
 * 不需要重启进程；未完成的请求仍走旧 Router，不会被打断。
 */

var express = require('express');
var engine = require('./mock-engine');
var mockLog = require('./mock-log');
var mockSse = require('./mock-sse');

var CONTENT_TYPES = {
    json: 'application/json; charset=utf-8',
    text: 'text/plain; charset=utf-8',
    html: 'text/html; charset=utf-8'
};

/**
 * 已经报过警的「接口 id + 路径」。buildRouter 每次热更新都会跑一遍，
 * 不去重的话一条坏路由会在日志里刷屏，真正的错误反而看不见。
 */
var warnedPaths = {};

function routeLabel(route) {
    return '「' + (route.name || route.id || route.path) + '」';
}

function warnOnce(route, reason) {
    var key = (route.id || route.path) + '|' + route.path;
    if (warnedPaths[key]) return;
    warnedPaths[key] = true;

    console.warn('[apiloop] 接口 ' + routeLabel(route) + ' 的 mock 路径 ' +
        JSON.stringify(route.path) + ' 无法注册，已跳过：' + reason);
}

/**
 * 管理台自己占用的路径前缀，任何项目都不许拿来做 mock 路径。
 *
 * 这些请求在走到用户的路由之前就先被管理台接走了，配成 mock 也永远不会命中 ——
 * 与其让人对着一条「怎么配都不生效」的接口排查，不如在写入时就拒绝。
 *
 * **不区分项目是不是挂在根路径**：一个项目以后可能被 `--project` 指定成根项目，
 * 规则按路径字符串来定，比按「此刻挂在哪」来定稳定得多。
 *
 * 注意 `/__admin` 同时也是 `lib/routes-store.js` 里的 `RESERVED_PREFIX`
 * （`lib/admin.js` 用它拼出管理台接口的挂载点），两处必须一致。之所以不共用一个
 * 常量，是因为 routes-store 已经依赖本模块，反过来 require 会成环。
 */
var RESERVED_PREFIXES = ['/__admin', '/__apiloop'];

/**
 * 命中保留前缀时返回那个前缀，否则返回 null。
 *
 * **比较前先转小写**：Express 的路由默认 `caseSensitive: false`，管理台是用
 * `app.use('/__admin/api', …)` 挂上去的，所以 `/__ADMIN/api/...` 一样会被它接走。
 * 区分大小写比就等于留了个绕过这条规则的口子 —— 配一条 `/__ADMIN/x` 照样永远打不通。
 */
function reservedPrefixOf(path) {
    var value = String(path === undefined || path === null ? '' : path).trim().toLowerCase();

    for (var i = 0; i < RESERVED_PREFIXES.length; i++) {
        var prefix = RESERVED_PREFIXES[i];
        if (value === prefix || value.indexOf(prefix + '/') === 0) return prefix;
    }

    return null;
}

/**
 * 校验一个路径能不能被 Express 编译成路由。
 *
 * 用一个临时 Router 真的注册一下 —— **刻意不 require path-to-regexp**：
 * 它是 express 的间接依赖，版本随时可能变，直接依赖它等于把别人的内部结构
 * 写进我们的契约里。
 *
 * @param {string} path
 * @returns {string|null} null 表示合法，否则是给用户看的原因
 */
function validateRoutePath(path) {
    var value = path === undefined || path === null ? '' : String(path);

    var reserved = reservedPrefixOf(value);
    if (reserved) {
        return '以 ' + reserved + ' 开头的路径由管理台占用';
    }

    try {
        express.Router().get(value, function () {});
        return null;
    } catch (err) {
        return err && err.message ? err.message : '无法识别的路径';
    }
}

function applyCors(res) {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', '*');
    res.set('Access-Control-Allow-Headers', '*');
    // 跨域时前端 JS 默认只能读到几个「安全」响应头，X-Apiloop-Mock 不在其中 ——
    // 不显式暴露的话，「这条命中的是哪条期望」在浏览器里永远看不到。
    res.set('Access-Control-Expose-Headers', 'X-Apiloop-Mock');
}

/* ---------------------------------------------------------------- 期望匹配 */

/**
 * 匹配出错时只打印一次的那张表。匹配跑在**每一条** mock 请求上，
 * 一次坏数据不去重就会把日志刷满，真正要看的东西反而找不着。
 */
var warnedMatchErrors = {};

function warnMatchOnce(reason) {
    if (warnedMatchErrors[reason]) return;
    warnedMatchErrors[reason] = true;
    console.warn('[apiloop] mock 期望匹配出错，已退回默认示例：' + reason);
}

/**
 * 写日志失败时的去重表。日志是「顺带记一下」的东西，它的失败绝不能影响 mock
 * 响应，也不能把日志刷满 —— 真正要排查的是接口本身。
 */
var warnedLogErrors = {};

function warnLogOnce(reason) {
    if (warnedLogErrors[reason]) return;
    warnedLogErrors[reason] = true;
    console.warn('[apiloop] 记录 mock 调用日志失败，已跳过：' + reason);
}

function toText(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
}

/** 能当数字用的才是数字：空串、'abc' 一律不算 */
function toNumberOrNull(value) {
    var text = String(value === null || value === undefined ? '' : value).trim();
    if (!text) return null;
    var num = Number(text);
    return isFinite(num) ? num : null;
}

/**
 * 请求体是不是一个 JSON 对象。
 *
 * **表单、纯文本、没有请求体一律不算** —— 契约里 body 条件只针对 JSON 请求体，
 * 拿表单字段去比 `a.b` 这种嵌套 key 本来也没有意义。注意这里不看「解析出来的
 * req.body 是不是对象」就够了：urlencoded 解析出来也是对象，那会把表单误判成 JSON。
 */
function isJsonBody(req) {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return false;
    return !!(req.is && req.is('json'));
}

function hasOwn(source, key) {
    return Object.prototype.hasOwnProperty.call(source, key);
}

/** 按 `in` 决定去哪个来源取值。body 的嵌套取值复用引擎的 readInput */
function pickValue(condition, req) {
    var key = condition.key;

    if (condition.in === 'query') {
        var query = req.query || {};
        return hasOwn(query, key) ? { found: true, value: query[key] } : { found: false };
    }
    if (condition.in === 'header') {
        // HTTP 头名不区分大小写，Express 统一存成小写
        var headers = req.headers || {};
        var lower = String(key).toLowerCase();
        return hasOwn(headers, lower) ? { found: true, value: headers[lower] } : { found: false };
    }
    if (condition.in === 'path') {
        var params = req.params || {};
        return hasOwn(params, key) ? { found: true, value: params[key] } : { found: false };
    }

    var source = engine.readInput(req.body, key);
    if (source === '' || source === undefined || source === null) return { found: false };
    return { found: true, value: source };
}

/**
 * 一个条件是否命中。多个条件之间是「且」，由 matchesAll 负责组合。
 *
 * 取不到值时（key 不存在）只有 `notExists` 命中，其余一律不命中 ——
 * 契约里「取到的值一律转成字符串比较」说的是**取到了**的情况，
 * 拿一个不存在的 key 去比 `ne`，把空串判成「不等于」太容易误伤。
 */
function matchesCondition(condition, req) {
    var op = condition.op;

    if (condition.in === 'body' && !isJsonBody(req)) return false;

    var picked = pickValue(condition, req);
    var text = picked.found ? toText(picked.value) : '';

    if (op === 'exists') return picked.found;
    if (op === 'notExists') return !picked.found;

    if (!picked.found) return false;

    if (op === 'eq') return text === toText(condition.value);
    if (op === 'ne') return text !== toText(condition.value);
    if (op === 'contains') return text.indexOf(toText(condition.value)) > -1;

    if (op === 'gt' || op === 'lt') {
        // 任一方不是数字就算不命中
        var left = toNumberOrNull(text);
        var right = toNumberOrNull(condition.value);
        if (left === null || right === null) return false;
        return op === 'gt' ? left > right : left < right;
    }

    if (op === 'regex') {
        // 保存时校验过，手改数据库仍可能写进坏正则，这里自己接住
        try {
            return new RegExp(toText(condition.value)).test(text);
        } catch (err) {
            return false;
        }
    }

    return false;
}

function matchesAll(expectation, req) {
    var conditions = expectation.conditions;
    if (!Array.isArray(conditions) || !conditions.length) return false;

    return conditions.every(function (condition) {
        return condition && matchesCondition(condition, req);
    });
}

/**
 * 按 position 顺序依次检查，**第一条命中的生效**；一条都没命中返回 null，
 * 调用方用默认示例。
 *
 * 整个函数包在 try/catch 里：这是跑在每个 mock 请求上的代码，出错只能退回默认示例。
 * 绝不能把异常抛出去 —— 没延迟时 Express 还能接住，带 delay 的那条路在 setTimeout
 * 回调里，抛出去就是整个进程退出。
 *
 * @param {Array} expectations 路由上带的期望（见 routes-store 的 readRoutes）
 * @param {object} req
 * @returns {object|null}
 */
function matchExpectation(expectations, req) {
    if (!expectations || !expectations.length) return null;

    try {
        for (var i = 0; i < expectations.length; i++) {
            if (matchesAll(expectations[i], req)) return expectations[i];
        }
    } catch (err) {
        warnMatchOnce((err && err.message) || String(err));
        return null;
    }

    return null;
}

function renderRoute(route, req, source) {
    var spec = source || route;

    var result = engine.render(spec.response, {
        query: req.query || {},
        body: req.body || {},
        params: req.params || {},
        headers: req.headers || {}
    });

    var text = result.text;
    if (spec.responseType === 'json') {
        // 用户写 {{@repeat}} 时元素之间往往没有逗号，这里做容错修复
        text = engine.repairJson(text);
        try {
            JSON.parse(text);
        } catch (err) {
            console.warn('[server-mock] 路由 ' + (route.name || route.path) +
                ' 渲染出的响应不是合法 JSON：' + err.message);
        }
    }

    return { text: text, warnings: result.warnings };
}

/**
 * 生成响应。
 *
 * 整个函数体包在 try/catch 里：`res.status(route.status)` 遇到越界的状态码会抛
 * ERR_HTTP_INVALID_STATUS_CODE，而**带 delay 的那条路是在 setTimeout 回调里跑的** ——
 * 那里没有 Express 的兜底，异常会直接把进程带走。没延迟时 Express 能接住，
 * 但也会变成 500 而不是我们能解释清楚的提示。
 */
function createHandler(route, projectId) {
    // 接口没写名字时用路径兜底：日志里显示一片空白，等于没记
    var apiName = route.name || route.path;

    return function (req, res) {
        // 请求快照必须在这里取：mock-host 剥 /mock/<slug> 前缀时会改写 req.url，
        // 而契约要的 url 是含前缀的完整原始地址（它用 originalUrl，不受影响，
        // 但 query / body 也顺手一次取完）。
        var snapshot = mockLog.snapshotRequest(req);
        var startedAt = Date.now();

        /** 命中的接口；没有匹配到的请求由 mock-host 记，这里是 null */
        var matchedInfo = null;
        var responsePreview = '';
        var recorded = false;

        /**
         * 落在 res 的 `finish` 上，而不是 send 的末尾：
         * 1) `durationMs` 要包含 `delay`（那是 setTimeout 里的，send 开始时计时就漏了它），
         *    也要包含真正把响应写出去的时间；
         * 2) `status` 直接取 `res.statusCode`，不用回头去猜用户配的是什么。
         * 只记一次 —— finish 只会触发一次，但别指望这个前提。
         */
        function recordOnce() {
            if (recorded) return;
            recorded = true;

            try {
                mockLog.record(projectId, {
                    method: snapshot.method,
                    url: snapshot.url,
                    query: snapshot.query,
                    headers: snapshot.headers,
                    bodyPreview: snapshot.bodyPreview,
                    matched: matchedInfo,
                    status: res.statusCode,
                    durationMs: Date.now() - startedAt,
                    responsePreview: responsePreview
                });
            } catch (err) {
                // 记日志失败绝不能影响已经发出去的响应
                warnLogOnce((err && err.message) || String(err));
            }
        }

        res.on('finish', recordOnce);

        if (route.cors) applyCors(res);

        /**
         * 回放一个 `sse` 类型的示例（契约第 17 节）。
         *
         * 和普通响应最大的区别：**响应头先发出去，然后按 delay 一条条推**。
         * 所以调用日志要在发出响应头时就记一条 —— 等 `finish` 的话，
         * 一个 `repeat: true` 的示例会让这条日志永远不出现。
         */
        function sendSse(source, matched) {
            var parsed = mockSse.parseSpec(source.response);

            if (!parsed.ok) {
                // 库里可能存着坏数据（手改库、旧版本写的），运行时必须兜住：
                // 既不能崩，也不能让这次请求就那么挂着
                console.warn('[apiloop] 接口 ' + routeLabel(route) + ' 的 SSE 示例不合法：' + parsed.reason);
                responsePreview = mockLog.preview('SSE 示例不合法：' + parsed.reason);
                try {
                    res.status(500).type('text/plain; charset=utf-8')
                        .send('mock 的 SSE 示例不合法：' + parsed.reason);
                } catch (err) {
                    console.error('[apiloop] SSE 兜底响应也发不出去：' + err.message);
                }
                return;
            }

            responsePreview = mockLog.preview('（SSE 回放，' + parsed.spec.events.length + ' 条事件' +
                (parsed.spec.repeat ? '，循环' : '') + '）');

            mockSse.replay(res, parsed.spec, {
                status: source.status,
                headers: source.headers,
                mockHeader: matched
                    ? 'expectation:' + encodeURIComponent(matched.name)
                    : 'default',
                /** 每条的 data 在**发送的那一刻**渲染，所以每次请求的随机值都不一样 */
                render: function (data) {
                    return engine.render(data, {
                        query: req.query || {},
                        body: req.body || {},
                        params: req.params || {},
                        headers: req.headers || {}
                    }).text;
                },
                onHeaders: recordOnce,
                onError: function (err) {
                    console.error('[apiloop] 接口 ' + routeLabel(route) +
                        ' 回放 SSE 失败：' + ((err && err.message) || err));
                }
            });
        }

        var send = function () {
            try {
                // 命中期望就用期望那条示例的内容，没命中就用路由上的默认值
                var matched = matchExpectation(route.expectations, req);
                var source = matched || route;

                // matched 在渲染**之前**定下来：渲染失败走下面那个 500 兜底时，
                // 「命中了哪个接口」仍然是事实，该记下来。
                matchedInfo = matched
                    ? { apiId: route.id, apiName: apiName, via: 'expectation', expectationName: matched.name }
                    : { apiId: route.id, apiName: apiName, via: 'default' };

                if (source.responseType === 'sse') {
                    sendSse(source, matched);
                    return;
                }

                var rendered = renderRoute(route, req, source);
                // 只截一份**拷贝**，发给客户端的仍然是完整的 rendered.text
                responsePreview = mockLog.preview(rendered.text);

                res.status(source.status);
                res.set('Content-Type', CONTENT_TYPES[source.responseType] || CONTENT_TYPES.json);
                (source.headers || []).forEach(function (header) {
                    res.set(header.key, header.value);
                });
                // 放在自定义响应头之后设，免得被用户配的同名头盖掉。
                // 联调时能一眼看出命中的是哪一条期望。
                res.set('X-Apiloop-Mock', matched
                    ? 'expectation:' + encodeURIComponent(matched.name)
                    : 'default');
                res.send(rendered.text);
            } catch (err) {
                console.error('[apiloop] 接口 ' + routeLabel(route) + ' 生成响应失败：' +
                    ((err && err.message) || err));

                if (res.headersSent) {
                    try { res.end(); } catch (endError) { /* 连接已经断了 */ }
                    return;
                }
                try {
                    res.status(500).type('text/plain; charset=utf-8')
                        .send('mock 响应生成失败：' + ((err && err.message) || err));
                } catch (sendError) {
                    console.error('[apiloop] 回退响应也发不出去：' + sendError.message);
                }
            }
        };

        if (route.delay > 0) {
            setTimeout(send, route.delay);
        } else {
            send();
        }
    };
}

/**
 * 由路由配置构建一个 Express Router
 *
 * 逐条注册、逐条 try/catch：一条路径不合法的接口不能把整张路由表拖垮 ——
 * 之前那种写法会让进程直接退出，而接口是用户随时可以写进来的数据。
 *
 * @param {Array} routes
 * @param {string} [projectId] 这批路由属于哪个项目 —— 调用日志按它分桶；
 *   不传就是不记日志（单独 buildRouter 的调用方，比如测试）
 * @returns {import('express').Router}
 */
function buildRouter(routes, projectId) {
    var router = express.Router();

    (routes || []).forEach(function (route) {
        if (!route.enabled) return;

        // WS 接口不注册 HTTP 路由（契约第 17 节）：它由 lib/mock-ws.js 从 upgrade 事件上接走。
        // 放在这里跳过，而不是让它掉进下面那个 try/catch —— 那样会打出一句
        // 「mock 路径无法注册」的假警告。
        if (String(route.method || '').toUpperCase() === 'WS') return;

        var handler = createHandler(route, projectId);
        var method = String(route.method || 'GET').toLowerCase();

        try {
            if (method === 'all') {
                router.all(route.path, handler);
            } else {
                router[method](route.path, handler);
            }
        } catch (err) {
            // 路径不合法（括号不成对之类），或者方法压根不是 Router 上的函数
            warnOnce(route, (err && err.message) || err);
            return;
        }

        // 开了跨域的路由顺带处理预检请求，否则浏览器 OPTIONS 会 404。
        // 这个自动生成的 204 **不进调用日志**：它不是用户调的接口，只是浏览器
        // 在真正发请求前的一次握手；记进去会让每条跨域请求在日志里变成两条。
        if (route.cors && method !== 'options' && method !== 'all') {
            try {
                router.options(route.path, function (req, res) {
                    applyCors(res);
                    res.status(204).end();
                });
            } catch (err) {
                warnOnce(route, (err && err.message) || err);
            }
        }
    });

    return router;
}

/**
 * @param {object} store routes-store 实例
 */
function createRuntime(store) {
    var projectId = store.projectId || null;
    var current = buildRouter(store.getRoutes(), projectId);

    function rebuild() {
        current = buildRouter(store.getRoutes(), projectId);
        return current;
    }

    store.on('change', rebuild);

    return {
        middleware: function (req, res, next) {
            current(req, res, next);
        },
        rebuild: rebuild,
        buildRouter: buildRouter,
        /** 供调试/测试查看当前生效的路由数量 */
        count: function () {
            return store.getRoutes().filter(function (route) { return route.enabled; }).length;
        }
    };
}

module.exports = {
    createRuntime: createRuntime,
    buildRouter: buildRouter,
    renderRoute: renderRoute,
    matchExpectation: matchExpectation,
    validateRoutePath: validateRoutePath,
    reservedPrefixOf: reservedPrefixOf,
    RESERVED_PREFIXES: RESERVED_PREFIXES,
    CONTENT_TYPES: CONTENT_TYPES
};
