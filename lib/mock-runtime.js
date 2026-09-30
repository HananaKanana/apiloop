/**
 * 路由运行时：把 routes.json 里的配置编译成 Express 路由，并支持热更新。
 *
 * 保存配置后 store 会发 change 事件，这里重建一个 Router 并原子替换，
 * 不需要重启进程；未完成的请求仍走旧 Router，不会被打断。
 */

var express = require('express');
var engine = require('./mock-engine');

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
}

function renderRoute(route, req) {
    var result = engine.render(route.response, {
        query: req.query || {},
        body: req.body || {},
        params: req.params || {},
        headers: req.headers || {}
    });

    var text = result.text;
    if (route.responseType === 'json') {
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
function createHandler(route) {
    return function (req, res) {
        if (route.cors) applyCors(res);

        var send = function () {
            try {
                var rendered = renderRoute(route, req);
                res.status(route.status);
                res.set('Content-Type', CONTENT_TYPES[route.responseType] || CONTENT_TYPES.json);
                (route.headers || []).forEach(function (header) {
                    res.set(header.key, header.value);
                });
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
 * @returns {import('express').Router}
 */
function buildRouter(routes) {
    var router = express.Router();

    (routes || []).forEach(function (route) {
        if (!route.enabled) return;

        var handler = createHandler(route);
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

        // 开了跨域的路由顺带处理预检请求，否则浏览器 OPTIONS 会 404
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
    var current = buildRouter(store.getRoutes());

    function rebuild() {
        current = buildRouter(store.getRoutes());
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
    validateRoutePath: validateRoutePath,
    CONTENT_TYPES: CONTENT_TYPES
};
