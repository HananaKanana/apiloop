/**
 * WebSocket 接口的 mock 回放（契约第 17 节）。
 *
 * `method` 为 `WS` 的接口存进目录树之后不会注册成 HTTP 路由，而是由这里从 HTTP 服务器的
 * **`upgrade` 事件**上接走：按 mockPath 找到接口与示例，回放 `onOpen` 和 `rules`。
 *
 * 三个要点：
 * - **匹配规则和 HTTP 共用同一套编译**：路径可能带 `:param`，自己写正则迟早和 Express
 *   对不上。这里把候选路由注册进一个一次性 Router，让 Express 自己去匹配（见 `buildMatcher`）。
 * - **每个项目最多 100 条连接**，超了用 1013 关掉 —— mock 服务端跑在本机，但一个连不上的
 *   客户端不停地重连也够把 fd 用光。
 * - **计时器一个都不能剩**：连接一关就清空，`closeAll()` 也要清干净。
 */

var wsModule = require('ws');
var express = require('express');

var engine = require('./mock-engine');
var mockLog = require('./mock-log');
var runtimeModule = require('./mock-runtime');

var MAX_CONNECTIONS_PER_PROJECT = 100;
var MAX_STEPS = 1000;
var MAX_DELAY = 60000;

var MATCH_TYPES = ['equals', 'contains', 'regex', 'any'];
var FALLBACKS = ['none', 'echo'];

/** 连接太多时用的关闭码：Try Again Later */
var TOO_MANY = 1013;

/** 服务关闭时用的关闭码：Going Away */
var GOING_AWAY = 1001;

function noop() {}

/* ------------------------------------------------------------------ 校验 */

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readSteps(value, at, problems) {
    if (value === undefined || value === null) return [];

    if (!Array.isArray(value)) {
        problems.push(at + '必须是数组');
        return [];
    }

    return value.map(function (step, index) {
        var where = at + '第 ' + (index + 1) + ' 条';

        if (!isPlainObject(step)) {
            problems.push(where + '必须是对象');
            return null;
        }
        if (typeof step.send !== 'string') {
            problems.push(where + '的 send 必须是字符串');
            return null;
        }

        var delay = step.delay === undefined || step.delay === null ? 0 : Number(step.delay);
        if (!isFinite(delay) || delay < 0 || delay > MAX_DELAY) {
            problems.push(where + '的 delay 必须在 0 到 ' + MAX_DELAY + ' 之间');
            return null;
        }

        return { delay: Math.max(0, Math.round(delay)), send: step.send };
    }).filter(Boolean);
}

/**
 * 解析并校验示例的 body。
 *
 * @param {string} body
 * @returns {{ok: true, spec: object}|{ok: false, reason: string}}
 */
function parseSpec(body) {
    var text = typeof body === 'string' ? body : '';
    if (!text.trim()) return { ok: false, reason: 'WebSocket 示例的 body 不能为空' };

    var parsed;
    try {
        parsed = JSON.parse(text);
    } catch (err) {
        return { ok: false, reason: 'WebSocket 示例的 body 必须是合法的 JSON：' + err.message };
    }

    if (!isPlainObject(parsed)) {
        return { ok: false, reason: 'WebSocket 示例的 body 必须是一个 JSON 对象' };
    }

    var problems = [];
    var onOpen = readSteps(parsed.onOpen, 'onOpen 的', problems);

    var rules = [];
    if (parsed.rules !== undefined && parsed.rules !== null) {
        if (!Array.isArray(parsed.rules)) {
            problems.push('rules 必须是数组');
        } else {
            parsed.rules.forEach(function (rule, index) {
                var where = '第 ' + (index + 1) + ' 条规则';

                if (!isPlainObject(rule)) {
                    problems.push(where + '必须是对象');
                    return;
                }

                var match = isPlainObject(rule.match) ? rule.match : {};
                if (MATCH_TYPES.indexOf(match.type) === -1) {
                    problems.push(where + '的 match.type 只能是 ' + MATCH_TYPES.join(' / '));
                    return;
                }

                if (match.type === 'regex') {
                    try {
                        new RegExp(String(match.value === undefined ? '' : match.value));
                    } catch (err) {
                        problems.push(where + '的 match.value 不是合法的正则：' + err.message);
                        return;
                    }
                }

                var reply = readSteps(rule.reply, where + '的 reply ', problems);

                rules.push({
                    match: { type: match.type, value: match.value === undefined ? '' : String(match.value) },
                    reply: reply
                });
            });
        }
    }

    // 契约第 17 节（2026-09-30 明确）：步骤 = onOpen 的条数 + 各条规则 reply 的条数，规则本身不计
    var stepCount = onOpen.length + rules.reduce(function (sum, rule) { return sum + rule.reply.length; }, 0);
    if (stepCount > MAX_STEPS) {
        problems.push('步骤总数最多 ' + MAX_STEPS + ' 条（当前 ' + stepCount + ' 条），规则本身不计');
    }

    var fallback = parsed.fallback === undefined || parsed.fallback === null ? 'none' : String(parsed.fallback);
    if (FALLBACKS.indexOf(fallback) === -1) {
        problems.push('fallback 只能是 none 或 echo');
    }

    if (problems.length) return { ok: false, reason: 'WebSocket 示例不合法：' + problems[0] };

    return { ok: true, spec: { onOpen: onOpen, rules: rules, fallback: fallback } };
}

/** 写入时的校验：不合法返回中文原因，合法返回 null */
function validate(body) {
    var result = parseSpec(body);
    return result.ok ? null : result.reason;
}

/* ------------------------------------------------------------------ 匹配 */

function buildMatcher(routes) {
    var router = express.Router();

    (routes || []).forEach(function (route) {
        if (!route.enabled) return;
        if (String(route.method || '').toUpperCase() !== 'WS') return;

        try {
            router.all(route.path, function (req, res, next) {
                if (!req.__apiloopWsRoute) req.__apiloopWsRoute = route;
                next();
            });
        } catch (err) {
            // 路径不合法（括号不成对之类）：跳过这一条，别把整张表拖垮
        }
    });

    /**
     * 用 Express 自己匹配一次。
     *
     * 造一个最小的 req / res 喂给 Router —— 我们的 handler 除了记下命中的路由什么也不做，
     * 所以不需要真的响应对象。这样 `:param`、通配这些规则和 HTTP 那边**完全一致**。
     */
    return function (pathname) {
        var req = {
            url: pathname,
            originalUrl: pathname,
            baseUrl: '',
            method: 'GET',
            headers: {}
        };
        var res = { statusCode: 200, setHeader: noop, getHeader: noop, end: noop, write: noop, on: noop };

        router(req, res, noop);
        return req.__apiloopWsRoute || null;
    };
}

function splitQuery(url) {
    var text = String(url || '');
    var at = text.indexOf('?');
    return at === -1 ? text : text.slice(0, at);
}

function parseQuery(url) {
    var text = String(url || '');
    var at = text.indexOf('?');
    if (at === -1) return {};

    var out = {};
    text.slice(at + 1).split('&').forEach(function (pair) {
        if (!pair) return;
        var eq = pair.indexOf('=');
        var key = eq === -1 ? pair : pair.slice(0, eq);
        var value = eq === -1 ? '' : pair.slice(eq + 1);
        try {
            out[decodeURIComponent(key)] = decodeURIComponent(value.replace(/\+/g, ' '));
        } catch (err) {
            out[key] = value;
        }
    });
    return out;
}

function firstProtocol(header) {
    var text = String(header || '');
    if (!text) return '';
    return text.split(',')[0].trim();
}

/** 用裸 socket 回一个 HTTP 错误再断开：upgrade 阶段还没有响应对象可用 */
function refuse(socket, status, message) {
    var body = message || '';

    try {
        socket.write(
            'HTTP/1.1 ' + status + ' ' + (status === 404 ? 'Not Found' : 'Error') + '\r\n' +
            'Connection: close\r\n' +
            'Content-Type: text/plain; charset=utf-8\r\n' +
            'Content-Length: ' + Buffer.byteLength(body, 'utf8') + '\r\n' +
            '\r\n' + body
        );
    } catch (err) {
        // socket 已经断了
    }

    socket.destroy();
}

/**
 * @param {object} options
 * @param {object} options.handle lib/db 的 handle
 * @param {object} options.mockHost `createMockHost()` 的返回值，用来按地址找项目
 * @param {string|null} [options.rootProjectId]
 * @returns {{handleUpgrade: Function, closeAll: Function, count: Function}}
 */
function createMockWs(options) {
    var handle = options.handle;
    var mockHost = options.mockHost;

    var wss = new wsModule.WebSocketServer({
        noServer: true,
        // 契约第 17 节：子协议取客户端提供的第一个
        handleProtocols: function (protocols) {
            if (!protocols || typeof protocols.values !== 'function') return false;
            var first = protocols.values().next();
            return first.done ? false : first.value;
        }
    });

    /** projectId → 当前连接数 */
    var counts = new Map();
    /** 所有活着的连接，closeAll 用 */
    var live = new Set();
    /** projectId → { routes, match }，路由数组的引用变了就重建 */
    var matchers = new Map();

    function matcherFor(projectId) {
        var store = require('./project-stores').get(handle, projectId);
        var routes = store.getRoutes();
        var cached = matchers.get(projectId);

        if (cached && cached.routes === routes) return cached.match;

        var match = buildMatcher(routes);
        matchers.set(projectId, { routes: routes, match: match });
        return match;
    }

    function record(projectId, req, route) {
        try {
            mockLog.record(projectId, {
                method: 'WS',
                url: req.url || '',
                query: parseQuery(req.url),
                headers: req.headers || {},
                bodyPreview: '',
                matched: { apiId: route.id, apiName: route.name, via: 'default' },
                status: 101,
                durationMs: 0,
                responsePreview: ''
            });
        } catch (err) {
            console.warn('[apiloop] 记录 WebSocket 调用日志失败，已跳过：' + ((err && err.message) || err));
        }
    }

    /* ------------------------------------------------------------ 回放 */

    function playSequence(conn, steps, timers) {
        var render = conn.__render;
        var index = 0;

        function next() {
            if (conn.__closed) return;
            if (index >= steps.length) return;

            var step = steps[index];
            index += 1;

            var timer = setTimeout(function () {
                timers.delete(timer);
                if (conn.__closed) return;

                try {
                    // send 在发送的那一刻才渲染模板
                    conn.send(render(step.send));
                } catch (err) {
                    // 连接已经断了
                    return;
                }

                next();
            }, step.delay);

            timers.add(timer);
            if (timer.unref) timer.unref();
        }

        next();
    }

    function matches(rule, text, isBinary) {
        var match = rule.match || {};

        // 二进制消息只按 any 规则和 echo 处理（契约第 17 节）
        if (isBinary) return match.type === 'any';
        if (match.type === 'any') return true;
        if (match.type === 'equals') return text === match.value;
        if (match.type === 'contains') return text.indexOf(match.value) > -1;
        if (match.type === 'regex') {
            try {
                return new RegExp(match.value).test(text);
            } catch (err) {
                return false;
            }
        }
        return false;
    }

    function attach(conn, route, projectId, protocol, req) {
        var parsed = parseSpec(route.response);
        var timers = new Set();

        conn.__closed = false;
        conn.__render = function (text) {
            return engine.render(text, {
                query: parseQuery(req.url),
                body: {},
                params: {},
                headers: req.headers || {}
            }).text;
        };

        function cleanup() {
            if (conn.__closed) return;
            conn.__closed = true;

            timers.forEach(function (timer) { clearTimeout(timer); });
            timers.clear();

            live.delete(conn);
            var left = (counts.get(projectId) || 1) - 1;
            if (left > 0) counts.set(projectId, left);
            else counts.delete(projectId);
        }

        conn.on('close', cleanup);
        conn.on('error', cleanup);

        if (!parsed.ok) {
            // 库里已有的坏数据：给一条说明再关掉，别静默断连
            console.warn('[apiloop] 接口「' + (route.name || route.path) + '」的 WebSocket 示例不合法：' + parsed.reason);
            try {
                conn.send('mock 的 WebSocket 示例不合法：' + parsed.reason);
            } catch (err) { /* 已经断了 */ }
            conn.close(GOING_AWAY, '示例不合法');
            return;
        }

        conn.on('message', function (data, isBinary) {
            if (conn.__closed) return;

            var text = isBinary ? '' : data.toString('utf8');
            var rule = parsed.spec.rules.filter(function (item) {
                return matches(item, text, isBinary);
            })[0];

            if (rule) {
                playSequence(conn, rule.reply, timers);
                return;
            }

            if (parsed.spec.fallback === 'echo') {
                try {
                    if (isBinary) conn.send(data);
                    else conn.send(data.toString('utf8'));
                } catch (err) {
                    // 连接已经断了
                }
            }
        });

        playSequence(conn, parsed.spec.onOpen, timers);
    }

    /* ------------------------------------------------------------ 入口 */

    function handleUpgrade(req, socket, head) {
        try {
            var url = String(req.url || '');

            // 管理台自己的前缀直接断开（契约第 17 节）—— 那些 upgrade 不该由 mock 处理
            if (runtimeModule.reservedPrefixOf(url)) {
                socket.destroy();
                return;
            }

            var resolved = mockHost.resolve(url);
            if (!resolved) {
                refuse(socket, 404, '没有匹配的 WebSocket 接口');
                return;
            }

            var route = matcherFor(resolved.projectId)(resolved.pathname);
            if (!route || String(route.responseType) !== 'ws') {
                refuse(socket, 404, '没有匹配的 WebSocket 接口');
                return;
            }

            if ((counts.get(resolved.projectId) || 0) >= MAX_CONNECTIONS_PER_PROJECT) {
                refuse(socket, 503, '这个项目的 mock 连接数已达上限（' + MAX_CONNECTIONS_PER_PROJECT + '）');
                return;
            }

            var protocol = firstProtocol(req.headers['sec-websocket-protocol']);

            wss.handleUpgrade(req, socket, head, function (conn) {
                counts.set(resolved.projectId, (counts.get(resolved.projectId) || 0) + 1);
                live.add(conn);

                // 契约第 17 节：握手成功时记一条，method 为 WS，status 为 101
                record(resolved.projectId, req, route);

                attach(conn, route, resolved.projectId, protocol, req);
            });
        } catch (err) {
            console.error('[apiloop] WebSocket mock 处理 upgrade 失败：' + ((err && err.message) || err));
            try { socket.destroy(); } catch (destroyError) { /* 已经断了 */ }
        }
    }

    /** 服务关闭时调用：把还开着的 mock 连接全部关掉，计时器一并清理 */
    function closeAll() {
        Array.from(live).forEach(function (conn) {
            try {
                conn.close(GOING_AWAY, '服务关闭');
            } catch (err) {
                // 已经断了
            }
            try {
                conn.terminate();
            } catch (err) {
                // 已经断了
            }
        });

        live.clear();
        counts.clear();
        matchers.clear();
    }

    return {
        handleUpgrade: handleUpgrade,
        closeAll: closeAll,
        /** 供测试查看当前的连接数 */
        count: function (projectId) {
            return projectId ? (counts.get(projectId) || 0) : live.size;
        }
    };
}

module.exports = {
    createMockWs: createMockWs,
    parseSpec: parseSpec,
    validate: validate,
    MAX_CONNECTIONS_PER_PROJECT: MAX_CONNECTIONS_PER_PROJECT,
    MAX_STEPS: MAX_STEPS,
    MAX_DELAY: MAX_DELAY
};
