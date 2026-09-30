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

function createHandler(route) {
    return function (req, res) {
        if (route.cors) applyCors(res);

        var send = function () {
            var rendered = renderRoute(route, req);
            res.status(route.status);
            res.set('Content-Type', CONTENT_TYPES[route.responseType] || CONTENT_TYPES.json);
            (route.headers || []).forEach(function (header) {
                res.set(header.key, header.value);
            });
            res.send(rendered.text);
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
 * @param {Array} routes
 * @returns {import('express').Router}
 */
function buildRouter(routes) {
    var router = express.Router();

    (routes || []).forEach(function (route) {
        if (!route.enabled) return;

        var handler = createHandler(route);
        var method = String(route.method || 'GET').toLowerCase();

        if (method === 'all') {
            router.all(route.path, handler);
        } else {
            router[method](route.path, handler);
        }

        // 开了跨域的路由顺带处理预检请求，否则浏览器 OPTIONS 会 404
        if (route.cors && method !== 'options' && method !== 'all') {
            router.options(route.path, function (req, res) {
                applyCors(res);
                res.status(204).end();
            });
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
    CONTENT_TYPES: CONTENT_TYPES
};
