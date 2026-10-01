/**
 * 本地网关（`apiloop gateway --cloud <地址>`，G0）。
 *
 * 为什么要有它：macOS 15 之后，没有苹果签名的程序访问不了同网段地址，系统也不弹授权框；
 * 而 **nodejs.org 的官方 Node 被 launchd 直接启动时**可以拿到授权（D0 实测）。所以页面
 * 从本机打开、由官方 Node 代发请求，是唯一不花钱的路。详见
 * `docs/design/2026-10-01-local-agent.md` 第 2、3 节。
 *
 * 一次请求的两条去向：
 *   - `/__admin/api/*`：**转发给云端**（第一期数据还在云端），会话 Cookie 逐个改写；
 *   - `/__admin/api/projects/:pid/send/stream`：**在本机执行**。它是「同网段请求」唯一
 *     的出口，所以必须排在转发之前 —— 顺序反了，这条也会被转到云端去发，白折腾。
 *
 * 安全（设计稿第 3.1 节）是这个模块最要紧的部分，见 `createGuard`。
 */

var http = require('http');
var https = require('https');
var fs = require('fs');
var path = require('path');
var StringDecoder = require('string_decoder').StringDecoder;
var express = require('express');

var appInfo = require('../app-info');
var executor = require('../executor');
var ndjson = require('../api/ndjson');
var dto = require('../api/dto');
var pkg = require('../../package.json');

/* ------------------------------------------------------------------ 常量 */

/** 端口从 47321 开始往上找，用到 47329 为止 */
var DEFAULT_PORT = 47321;
var MAX_PORT = 47329;

/** 判断云端在不在的超时（计划里定的 3 秒） */
var CLOUD_PROBE_TIMEOUT_MS = 3000;

/** 本机发送的超时：和云端 `/send` 的默认值、上下限保持一致 */
var SEND_TIMEOUT_MIN = 1;
var SEND_TIMEOUT_MAX = 300000;
var SEND_TIMEOUT_DEFAULT = 30000;

/** 真正发得出去的 HTTP 方法。和 `lib/api/send.js` 的同一份名单 */
var SEND_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];

/** 管理台接口前缀（和 lib/admin.js 的 API_PATH 是同一个字符串） */
var API_PREFIX = '/__admin/api';

/** 网关自己的接口前缀，转发时不能被它吃掉 */
var GATEWAY_PREFIX = '/__gateway';

/** 前端页面。和 lib/admin.js 的 WEB_DIR / DEFAULT_PAGE 保持一致 */
var WEB_DIR = path.join(__dirname, '..', 'web');
var DEFAULT_PAGE = '/index.html';

/** 自定义请求头。前端所有请求都会带上它，别的网站带不了（要带就得先过预检） */
var CUSTOM_HEADER = 'x-apiloop';

/** 配置文件与端口文件都放在数据目录里 */
var CONFIG_FILE = 'gateway.json';
var PORT_FILE = 'gateway.port';

/**
 * 逐跳头（RFC 7230 6.1）。转发时两头都要去掉 —— 它们是「这一段连接」的属性，
 * 照搬给下一段会让下一段按上一段的约定说话（最典型的是 transfer-encoding）。
 */
var HOP_BY_HOP = [
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer', 'transfer-encoding', 'upgrade'
];

/** 私有网段。第一次访问这些地址被系统拦下时，错误信息要换成授权提示 */
var PRIVATE_PATTERNS = [
    /^10\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^192\.168\./,
    /^169\.254\./
];

/** 设计稿第 3.3 节的那段提示，第一次访问局域网必然会看到它 */
var LOCAL_NETWORK_HINT = '请求失败：系统还没有允许 node 访问本地网络。' +
    '请在系统弹出的「本地网络」授权框中点「允许」，然后重新发送。' +
    '如果没看到弹框，到「系统设置 → 隐私与安全性 → 本地网络」里把 node 打开。';

/* ------------------------------------------------------------------ 配置 */

/** 云端地址归一化：补协议、去结尾斜杠。空串原样返回（表示还没配置） */
function normalizeCloudUrl(value) {
    var text = String(value === undefined || value === null ? '' : value).trim();
    if (!text) return '';
    if (!/^https?:\/\//i.test(text)) text = 'http://' + text;
    return text.replace(/\/+$/, '');
}

function readConfig(dataDir) {
    try {
        var parsed = JSON.parse(fs.readFileSync(path.join(dataDir, CONFIG_FILE), 'utf8'));
        if (parsed && typeof parsed.cloudUrl === 'string') {
            return { cloudUrl: normalizeCloudUrl(parsed.cloudUrl) };
        }
    } catch (err) {
        // 没有配置文件、或者内容坏了，都按「还没配置」处理：网关照样能起来，
        // 用户在设置页里重填一次就好，不该因为一个坏文件就启动失败
    }
    return { cloudUrl: '' };
}

function writeConfig(dataDir, cloudUrl) {
    var file = path.join(dataDir, CONFIG_FILE);
    // 0600：里面可能带着内网地址，没必要让同机器上的其他用户读到
    fs.writeFileSync(file, JSON.stringify({ cloudUrl: cloudUrl }, null, 2) + '\n', { mode: 384 });
    return file;
}

/* ------------------------------------------------------------------ 小工具 */

/** `pathname` 是不是 `prefix` 本身或者它的子路径（按路径段比，避免 /__admin/apiX 混进来） */
function isUnder(pathname, prefix) {
    var value = String(pathname || '');
    return value === prefix || value.indexOf(prefix + '/') === 0;
}

/** 去掉端口后的主机名。IPv6 会带方括号，这里用不着，原样返回 */
function hostNameOf(hostHeader) {
    var text = String(hostHeader || '');
    var cut = text.lastIndexOf(':');
    if (cut > 0 && text.indexOf(']') < cut) return text.slice(0, cut);
    return text;
}

/** Host 头里写的端口。没写时按协议默认端口算 */
function hostPortOf(hostHeader, isSecure) {
    var text = String(hostHeader || '');
    var cut = text.lastIndexOf(':');
    if (cut > 0 && text.indexOf(']') < cut) return Number(text.slice(cut + 1));
    return isSecure ? 443 : 80;
}

function isPrivateHostUrl(urlText) {
    var parsed;
    try {
        parsed = new URL(urlText);
    } catch (err) {
        return false;
    }

    var host = parsed.hostname;
    for (var i = 0; i < PRIVATE_PATTERNS.length; i++) {
        if (PRIVATE_PATTERNS[i].test(host)) return true;
    }
    return false;
}

/** 和 `lib/api/send.js` 里同名的那个函数一样：从 `[[k, v]]` 里按头名取值 */
function headerValue(pairs, name) {
    if (!Array.isArray(pairs)) return '';

    var lower = String(name).toLowerCase();
    for (var i = 0; i < pairs.length; i++) {
        if (String(pairs[i][0]).toLowerCase() === lower) return pairs[i][1];
    }
    return '';
}

/**
 * 云端返回的 `Set-Cookie` → 网关自己的 `Set-Cookie`（审阅重点第 2 条）。
 *
 * 两个属性必须去掉：
 *   - `Domain`：它指向云端的主机名，浏览器看到「Domain 和当前站点不同源」会直接把整条
 *     丢掉。去掉之后 cookie 就归属 127.0.0.1，正是我们要的。
 *   - `Secure`：网关是 http 的，带 `Secure` 的 cookie 在 http 响应里一律不落盘。
 *     云端以后改成 https 时它才会出现，所以这一步是「云端是 https 才需要」——但去掉是
 *     无害的，干脆按「一律去掉」处理，省得再判一次协议。
 *
 * 其余属性（`HttpOnly` / `SameSite` / `Path` / `Max-Age`）原样保留。
 */
function rewriteSetCookie(value) {
    var parts = String(value).split(';');
    var kept = [parts[0]];

    for (var i = 1; i < parts.length; i++) {
        var attr = parts[i].trim();
        var name = attr.split('=')[0].trim().toLowerCase();
        if (name === 'domain') continue;
        if (name === 'secure') continue;
        if (attr) kept.push(attr);
    }
    return kept.join('; ');
}

/* ------------------------------------------------------------------ 安全 */

/**
 * 安全闸门（设计稿第 3.1 节 + 审阅重点第 1 条）。**注册在所有路由之前**：
 * 静态资源、设置页、转发、本机发送一律先过这里。
 *
 * 要挡的是「别的网站的页面借本机的网关读数据 / 发请求」。四道：
 *
 * 1. **Host 必须是 127.0.0.1:端口 或 localhost:端口。** 这是防 DNS 重绑定：攻击者的页面
 *    把 evil.com 解析到 127.0.0.1，浏览器就认为自己在和 evil.com 说话，`Origin` 和
 *    `Sec-Fetch-Site` 全都是「同源」，只有 Host 会露出真相。
 * 2. **`Sec-Fetch-Site: cross-site` 一律拒。** 现代浏览器都会带这个头，是首选判据；
 *    它缺失时不拦（老浏览器和 curl 都没有），交给第 1、4 条兜。
 * 3. **`Origin` 存在时必须是网关自己的地址。** 表单提交、跨域请求都会带。
 * 4. **`/__admin/api/*` 一律要求 `X-Apiloop: 1`；`/__gateway/*` 的非 GET 请求也一样。**
 *    设计稿 3.1 的原话是「所有 /__admin/api/* 接口都要求带这个头」——这里按字面执行，
 *    GET 也要带（审阅重点只点名了非 GET，是它的子集）。自定义请求头是这套防御的核心：
 *    别的网站想带就得先发预检，而预检（OPTIONS）被第 5 条一刀切掉。
 * 5. **OPTIONS 一律 403，并且全流程不设任何 `Access-Control-Allow-*` 头**。
 *
 * **前缀比较前必须把路径转小写（B1）。** Express 的路由默认不区分大小写，所以
 * `app.use('/__admin/api')` 会匹配 `/__ADMIN/API/...`；如果这里的大小写和路由不一致，
 * 大写前缀就能绕过这一条、直接打到转发和本机发送上去。两边必须对齐 ——
 * 这里统一转小写，同时整个 app 开了 `case sensitive routing`（见 createGateway），
 * 大小写不对的路径根本匹配不到任何路由。
 */
function createGuard(options) {
    var getPort = options.getPort;
    var log = options.log || function () {};

    return function guard(req, res, next) {
        function deny(reason) {
            log('拒绝 ' + req.method + ' ' + req.originalUrl + '：' + reason);
            // 返回体按计划写成 { error }，不设任何 Access-Control-* 头
            res.status(403).json({ error: reason });
        }

        // 5. 跨域预检：直接拒。走到这一支时响应里绝不会出现 Access-Control-Allow-*，
        //    浏览器拿不到许可，真正的跨域请求就发不出去 —— 这正是我们要的效果。
        if (req.method === 'OPTIONS') return deny('网关不接受跨域预检请求');

        var port = getPort();

        // 1. Host
        var host = req.headers.host;
        var allowedHosts = ['127.0.0.1:' + port, 'localhost:' + port];
        if (!host || allowedHosts.indexOf(String(host).toLowerCase()) === -1) {
            return deny('Host 不合法：只接受 127.0.0.1:' + port + ' 或 localhost:' + port);
        }

        // 2. Sec-Fetch-Site
        var site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
        if (site === 'cross-site') return deny('不允许跨站请求');

        // 3. Origin
        var origin = req.headers.origin;
        if (origin) {
            var allowedOrigins = ['http://127.0.0.1:' + port, 'http://localhost:' + port];
            if (allowedOrigins.indexOf(String(origin).toLowerCase()) === -1) {
                return deny('Origin 不合法：只接受网关自己的地址');
            }
        }

        // 4. X-Apiloop。
        //    路径统一转小写再比前缀（B1）：Express 的路由不区分大小写，大写前缀一样能
        //    打到转发和本机发送；这里的大小写一旦和路由不一致，这道防线就被绕过了。
        var lowerPath = String(req.path || '').toLowerCase();
        var needsHeader = isUnder(lowerPath, API_PREFIX) ||
            (isUnder(lowerPath, GATEWAY_PREFIX) && req.method !== 'GET' && req.method !== 'HEAD');
        if (needsHeader && req.headers[CUSTOM_HEADER] !== '1') {
            return deny('缺少请求头 X-Apiloop: 1');
        }

        return next();
    };
}

/* ------------------------------------------------------------------ 设置页 */

/**
 * 还没配置云端地址时给出的那一页：一个输入框加一个「保存」。
 *
 * 表单不能直接用 `<form>` 提交 —— POST 必须带上 `X-Apiloop: 1`，而 HTML 表单设不了
 * 请求头。所以页面上是 fetch，头由脚本加。
 */
function setupPageHtml() {
    return [
        '<!DOCTYPE html>',
        '<html lang="zh-CN">',
        '<head>',
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        '<title>apiloop 设置</title>',
        '<style>',
        'body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;',
        'font:14px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#f5f6f8;color:#1f2329}',
        '.card{width:420px;padding:32px;border-radius:12px;background:#fff;box-shadow:0 2px 16px rgba(0,0,0,.08)}',
        'h1{margin:0 0 4px;font-size:20px}',
        'p.hint{margin:0 0 20px;color:#646a73}',
        'label{display:block;margin-bottom:6px;font-weight:500}',
        'input{width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid #d0d3d6;border-radius:6px;font-size:14px}',
        'input:focus{outline:none;border-color:#3370ff}',
        'button{margin-top:16px;width:100%;padding:10px;border:0;border-radius:6px;background:#3370ff;',
        'color:#fff;font-size:14px;cursor:pointer}',
        'button:disabled{opacity:.6;cursor:default}',
        '.msg{margin:12px 0 0;font-size:13px;color:#d83931;min-height:20px}',
        '.msg.ok{color:#2ea121}',
        '</style>',
        '</head>',
        '<body>',
        '<div class="card">',
        '<h1>apiloop</h1>',
        '<p class="hint">填写云端地址，保存后就可以开始使用了。</p>',
        '<label for="cloud">云端地址</label>',
        '<input id="cloud" type="text" placeholder="http://localhost:8080" autocomplete="off" spellcheck="false">',
        '<button id="save">保存</button>',
        '<p class="msg" id="msg"></p>',
        '</div>',
        '<script>',
        '(function () {',
        '  var input = document.getElementById("cloud");',
        '  var button = document.getElementById("save");',
        '  var msg = document.getElementById("msg");',
        '  fetch("/__gateway/status", { credentials: "same-origin" })',
        '    .then(function (res) { return res.json(); })',
        '    .then(function (data) { if (data && data.cloudUrl) input.value = data.cloudUrl; })',
        '    .catch(function () {});',
        '  button.addEventListener("click", function () {',
        '    button.disabled = true;',
        '    msg.className = "msg";',
        '    msg.textContent = "保存中…";',
        '    fetch("/__gateway/setup", {',
        '      method: "POST",',
        '      credentials: "same-origin",',
        '      headers: { "Content-Type": "application/json", "X-Apiloop": "1" },',
        '      body: JSON.stringify({ cloudUrl: input.value })',
        '    }).then(function (res) {',
        '      return res.json().then(function (data) { return { status: res.status, data: data }; });',
        '    }).then(function (result) {',
        '      if (result.status !== 200 || !result.data || result.data.ok === false) {',
        '        throw new Error((result.data && result.data.error) || ("HTTP " + result.status));',
        '      }',
        '      msg.className = "msg ok";',
        '      msg.textContent = "已保存，正在打开…";',
        '      window.location.href = "/";',
        '    }).catch(function (err) {',
        '      button.disabled = false;',
        '      msg.textContent = "保存失败：" + (err && err.message ? err.message : "未知错误");',
        '    });',
        '  });',
        '}());',
        '</script>',
        '</body>',
        '</html>'
    ].join('\n');
}

/* ------------------------------------------------------------------ 转发 */

/**
 * 把 `/__admin/api/*` 原样转发给云端。
 *
 * 请求体**用管道直接怼过去**（`req.pipe(proxyReq)`），不先缓冲 —— 上传大文件、导入
 * 几十 MB 的 HAR 都靠这一点；响应体同样边收边发（`proxyRes.pipe(res)`），
 * `/ws/:id/events` 那种长连接才不会被攒成一坨再吐出来（审阅重点第 3 条）。
 *
 * 也因此，这个中间件前面**不能挂全局的 body 解析器**：请求流一旦被读完就接不上了。
 * 所以网关只给「本机发送」和「设置页」两条路由单独挂解析器。
 */
function createForwarder(options) {
    var getCloudUrl = options.getCloudUrl;
    var log = options.log || function () {};

    return function forward(req, res) {
        var cloudUrl = getCloudUrl();
        if (!cloudUrl) {
            res.status(503).json({ error: '网关还没有配置云端地址' });
            return;
        }

        var base;
        try {
            base = new URL(cloudUrl + req.originalUrl);
        } catch (err) {
            res.status(502).json({ error: '云端地址不合法：' + cloudUrl });
            return;
        }

        var secure = base.protocol === 'https:';
        var transport = secure ? https : http;

        var headers = {};
        Object.keys(req.headers).forEach(function (name) {
            var lower = name.toLowerCase();
            // host 要换成云端的；逐跳头不转发
            if (lower === 'host') return;
            if (HOP_BY_HOP.indexOf(lower) !== -1) return;
            headers[lower] = req.headers[name];
        });
        headers.host = base.host;

        var proxyReq = transport.request({
            protocol: base.protocol,
            hostname: base.hostname,
            port: base.port || (secure ? 443 : 80),
            method: req.method,
            path: base.pathname + base.search,
            headers: headers
        }, function (proxyRes) {
            var outHeaders = {};
            Object.keys(proxyRes.headers).forEach(function (name) {
                var lower = name.toLowerCase();
                if (lower === 'set-cookie') return;
                if (HOP_BY_HOP.indexOf(lower) !== -1) return;
                outHeaders[name] = proxyRes.headers[name];
            });

            var setCookies = proxyRes.headers['set-cookie'];
            if (Array.isArray(setCookies) && setCookies.length) {
                outHeaders['set-cookie'] = setCookies.map(rewriteSetCookie);
            }

            // 一个一个头设下去：`writeHead(code, headers)` 在数组值上会让 Node 做类型转换，
            // set-cookie 必须是数组形态才能一条条发出去
            res.status(proxyRes.statusCode);
            Object.keys(outHeaders).forEach(function (name) {
                res.setHeader(name, outHeaders[name]);
            });
            res.flushHeaders();

            proxyRes.pipe(res);
        });

        proxyReq.on('error', function (err) {
            log('转发失败 ' + req.method + ' ' + req.originalUrl + '：' + err.message);
            if (res.headersSent) {
                res.destroy();
                return;
            }
            res.status(502).json({
                error: '连不上云端（' + getCloudUrl() + '）：' + ((err && err.message) || '未知错误')
            });
        });

        // 浏览器断开时把在途的那一发也掐掉，否则云端会一直算下去
        res.on('close', function () {
            if (!res.writableEnded) proxyReq.destroy();
        });

        req.pipe(proxyReq);
    };
}

/** 探云端活着没有：拿到任何 HTTP 响应（含 401）都算活着，连不上或超时才是不活着 */
function probeCloud(cloudUrl) {
    return new Promise(function (resolve) {
        if (!cloudUrl) return resolve(false);

        var base;
        try {
            base = new URL(cloudUrl + API_PREFIX + '/meta');
        } catch (err) {
            return resolve(false);
        }

        var secure = base.protocol === 'https:';
        var transport = secure ? https : http;
        var done = false;

        function finish(value) {
            if (done) return;
            done = true;
            resolve(value);
        }

        var probeReq = transport.request({
            protocol: base.protocol,
            hostname: base.hostname,
            port: base.port || (secure ? 443 : 80),
            method: 'GET',
            path: base.pathname,
            headers: { host: base.host, accept: 'application/json' },
            timeout: CLOUD_PROBE_TIMEOUT_MS
        }, function (probeRes) {
            probeRes.resume();
            finish(true);
        });

        probeReq.on('timeout', function () {
            probeReq.destroy();
            finish(false);
        });
        probeReq.on('error', function () { finish(false); });
        probeReq.end();
    });
}

/* ------------------------------------------------------------------ 本机发送 */

/**
 * 在本机把页面给的请求按原样发出去（G0 的定位）。
 *
 * **原样**是这一版刻意划的边界：不解析 `{{变量}}`、不跑脚本、不带 Cookie、不写历史、
 * 不读本地文件。完整的那一套（`send/prepare` + `send/record`）在 G1。这样 G0 要验的
 * 「官方 Node 能不能拿到本地网络授权」不会被别的东西干扰。
 *
 * 头、块、尾三个事件和云端 `/send/stream` **完全一致**（`lib/api/ndjson.js`），
 * 所以前端一行都不用改。
 */
function createLocalSend(options) {
    var log = options.log || function () {};

    return function localSend(req, res, body) {
        var input = dto.plainObject((body || {}).request);
        if (!input) {
            res.status(400).json({ error: '缺少 request' });
            return;
        }

        var method = dto.str(input.method || 'GET').toUpperCase();
        if (SEND_METHODS.indexOf(method) === -1) {
            res.status(400).json({ error: '不支持的请求方法：' + input.method });
            return;
        }

        var spec = {
            method: method,
            url: dto.str(input.url),
            params: dto.toParams(input.params),
            body: dto.toBody(input.body),
            auth: dto.toAuth(input.auth)
        };

        var rawOptions = dto.plainObject((body || {}).options) || {};
        var timeoutMs = rawOptions.timeoutMs === undefined
            ? SEND_TIMEOUT_DEFAULT
            : Number(rawOptions.timeoutMs);
        if (!Number.isFinite(timeoutMs)) timeoutMs = SEND_TIMEOUT_DEFAULT;
        timeoutMs = Math.min(SEND_TIMEOUT_MAX, Math.max(SEND_TIMEOUT_MIN, timeoutMs));

        var controller = new AbortController();
        res.on('close', function () {
            // 浏览器走了就别再等结果，否则内网那个连接会一直吊着
            if (!res.writableEnded) controller.abort();
        });

        var decoder = new StringDecoder('utf8');
        var textResponse = false;
        var controls = null;
        var waitingForDrain = false;

        /**
         * 写一段就往响应里塞一段；塞不进去就把上游按停（背压）。
         * 和云端那份一样只按一次 —— 重复 pause / resume 会让 drain 的配对错位。
         */
        function writeChunk(payload) {
            if (ndjson.write(res, payload)) return;
            if (waitingForDrain || !controls) return;

            waitingForDrain = true;
            controls.pause();
            res.once('drain', function () {
                waitingForDrain = false;
                controls.resume();
            });
        }

        var execOptions = {
            timeoutMs: timeoutMs,
            followRedirects: rawOptions.followRedirects !== false,
            // 内网自签名证书是常态，和云端 /send 一样默认不校验
            rejectUnauthorized: false,
            signal: controller.signal,
            // 刻意不给 fileRoots：执行器允许读本地文件当请求体，放开就等于让页面把
            // 本机任意文件发到任意地址去。G0 不支持文件，G1 由云端把文件内容送过来
            fileRoots: [],
            stream: true
        };

        execOptions.onHead = function (head, headControls) {
            controls = headControls;
            textResponse = executor.isTextContentType(
                headerValue(head.response.headers, 'content-type'));

            ndjson.write(res, {
                type: 'head',
                response: head.response,
                redirects: head.redirects
            });
        };

        execOptions.onChunk = function (buffer) {
            if (textResponse) {
                writeChunk({ type: 'chunk', text: decoder.write(buffer) });
                return;
            }
            writeChunk({ type: 'chunk', base64: Buffer.from(buffer).toString('base64') });
        };

        ndjson.start(res);

        return executor.execute(spec, execOptions).then(function (result) {
            result.gatewayRawSend = true;

            /**
             * 第一次访问局域网必然失败：授权框还没被点掉，内核直接回 EHOSTUNREACH。
             * 只看「连不上」用户是没法自救的，所以这里把错误信息换成明确的指引。
             *
             * 判断方式有两层：目标是私有网段，且原始错误是 EHOSTUNREACH。
             * 执行器把错误码归一化成了 `CONNECT`（`mapErrorCode`），原始码只留在消息里，
             * 所以这里匹配消息 —— 不改执行器是这一版的边界（它的行为要一个字不变）。
             */
            if (result.error && /EHOSTUNREACH/.test(String(result.error.message || '')) &&
                isPrivateHostUrl(spec.url)) {
                result.error.message = LOCAL_NETWORK_HINT;
                result.error.localNetworkHint = true;
            }

            if (textResponse) {
                var tail = decoder.end();
                if (tail) ndjson.write(res, { type: 'chunk', text: tail });
            }

            // 事件流已经开始了，出什么错都只能靠 end 事件告诉前端
            ndjson.write(res, { type: 'end', result: result, historyId: null });
            if (!res.writableEnded) res.end();
        }).catch(function (err) {
            log('本机发送失败：' + ((err && err.message) || err));
            if (!res.headersSent) {
                res.status(500).json({ error: '服务端出错：' + ((err && err.message) || '未知错误') });
                return;
            }
            if (!res.writableEnded) res.end();
        });
    };
}

/* ------------------------------------------------------------------ 组装 */

/** 候选端口：从 start 往上试到 47329。start 不在默认区间里时就只试它一个 */
function portCandidates(start) {
    var list = [start];
    if (start >= DEFAULT_PORT && start < MAX_PORT) {
        for (var port = start + 1; port <= MAX_PORT; port++) list.push(port);
    }
    return list;
}

/** 监听一个端口；被占用时 reject 成 { code: 'EADDRINUSE' }，其他错误原样抛 */
function listenOn(server, port) {
    return new Promise(function (resolve, reject) {
        function onError(err) {
            server.removeListener('listening', onListening);
            reject(err);
        }
        function onListening() {
            server.removeListener('error', onError);
            resolve(server.address().port);
        }

        server.once('error', onError);
        server.once('listening', onListening);
        // 只监听回环地址：局域网里别的机器碰不到它，这是第 3.1 节的第一条
        server.listen(port, '127.0.0.1');
    });
}

/**
 * 起一个本地网关。
 *
 * @param {{cloudUrl?: string, port?: number, dataDir?: string, log?: function}} options
 * @returns {Promise<{server: object, port: number, dataDir: string, cloudUrl: string, close: function}>}
 */
function createGateway(options) {
    var opts = options || {};
    var dataDir = opts.dataDir ? path.resolve(opts.dataDir) : appInfo.DATA_DIR;
    var log = typeof opts.log === 'function' ? opts.log : function () {};

    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

    // 云端地址：启动参数优先，并且写回配置文件（下次不带参数也是它）
    var cloudUrl = '';
    if (opts.cloudUrl !== undefined && opts.cloudUrl !== null && String(opts.cloudUrl) !== '') {
        cloudUrl = normalizeCloudUrl(opts.cloudUrl);
        if (!cloudUrl) {
            return Promise.reject(new Error('云端地址不合法：' + opts.cloudUrl));
        }
        writeConfig(dataDir, cloudUrl);
    } else {
        cloudUrl = readConfig(dataDir).cloudUrl;
    }

    /** 实际监听的端口。绑定成功之前是 0，安全闸门在此之前不放行任何请求 */
    var actualPort = 0;
    var closed = false;

    var app = express();
    app.disable('x-powered-by');

    /**
     * **路由区分大小写（B1）。**
     *
     * Express 默认不区分，`/__ADMIN/API/...` 一样能命中 `/__admin/api` 的转发和本机发送。
     * 安全闸门里已经把路径转小写再比前缀了，这一条是第二道：大小写不对的路径根本匹配不到
     * 任何路由，直接落到静态资源那儿返回 404，既不会被转发，也不会在本机发请求。
     *
     * 副作用：静态资源也变区分大小写了。前端请求的都是构建产物里的原样路径，
     * 不受影响；而 `/INDEX.HTML` 这类写法以前能被 APFS 的大小写不敏感兜住，现在会 404 ——
     * 这正是我们要的。
     */
    app.set('case sensitive routing', true);

    // 1) 安全闸门。必须是第一个 —— 静态资源、设置页、转发、本机发送全都要先过它
    app.use(createGuard({
        getPort: function () { return actualPort; },
        log: log
    }));

    // 2) 状态
    app.get(GATEWAY_PREFIX + '/status', function (req, res) {
        probeCloud(cloudUrl).then(function (reachable) {
            res.json({
                version: pkg.version,
                cloudUrl: cloudUrl,
                cloudReachable: reachable
            });
        });
    });

    // 3) 设置页：保存云端地址
    app.post(GATEWAY_PREFIX + '/setup', express.json({ limit: '64kb' }), function (req, res) {
        var next = normalizeCloudUrl((req.body || {}).cloudUrl);
        if (!next) {
            res.status(400).json({ error: '请填写云端地址' });
            return;
        }
        try {
            new URL(next);
        } catch (err) {
            res.status(400).json({ error: '云端地址不合法：' + next });
            return;
        }

        try {
            writeConfig(dataDir, next);
        } catch (err) {
            res.status(500).json({ error: '写入配置失败：' + err.message });
            return;
        }

        cloudUrl = next;
        log('云端地址已更新为 ' + cloudUrl);
        res.json({ ok: true, cloudUrl: cloudUrl });
    });

    /**
     * 还没配置云端地址时，页面请求给出设置页。
     *
     * 只接管 `/` 和 `/index.html` 这两个「打开页面」的入口：静态资源照常发出去，
     * 设置页自己的样式和脚本都是内联的，不依赖它们。
     */
    app.use(function (req, res, next) {
        if (cloudUrl) return next();
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();

        var pathname = req.path;
        if (pathname !== '/' && pathname !== DEFAULT_PAGE) return next();

        res.status(200).type('html').send(setupPageHtml());
    });

    // 4) 本机发送。**必须排在转发之前**：同一条路径，前面这条先命中。
    //    请求体上限和云端一样是 4MB（云端那套也挂在 4MB 的解析器下面）
    var localSend = createLocalSend({ log: log });
    app.post(API_PREFIX + '/projects/:pid/send/stream',
        express.json({ limit: '4mb' }),
        function (req, res) {
            return localSend(req, res, req.body);
        });

    // 5) 其余管理台接口一律转发云端。
    //    用 app.use 挂在 /__admin/api 上：所有方法、所有子路径都进来；
    //    这里**不做请求体解析**，请见 createForwarder 的说明。
    app.use(API_PREFIX, createForwarder({
        getCloudUrl: function () { return cloudUrl; },
        log: log
    }));

    // 6) 页面：和云端同一份 lib/web
    app.use(express.static(WEB_DIR, { index: false }));
    app.get('/', function (req, res) {
        res.redirect(302, DEFAULT_PAGE);
    });

    // 不碰 server.timeout / requestTimeout：Node 的 socket 空闲超时本来就是 0（关的），
    // 转发出去的 NDJSON 长连接可以一直挂着；而请求体要先收全这件事仍然有默认上限兜着。
    var server = http.createServer(app);

    var candidates = portCandidates(Number(opts.port) > 0 ? Number(opts.port) : DEFAULT_PORT);

    function tryListen(index) {
        if (index >= candidates.length) {
            return Promise.reject(new Error(
                '端口 ' + candidates[0] + '–' + candidates[candidates.length - 1] + ' 都被占用了'));
        }

        return listenOn(server, candidates[index]).catch(function (err) {
            if (err && err.code === 'EADDRINUSE') {
                log('端口 ' + candidates[index] + ' 已被占用，换下一个');
                return tryListen(index + 1);
            }
            throw err;
        });
    }

    return tryListen(0).then(function (port) {
        actualPort = port;

        // 端口文件给启动器读：它只负责用默认浏览器打开正确的地址
        fs.writeFileSync(path.join(dataDir, PORT_FILE), String(port) + '\n');

        return {
            server: server,
            port: port,
            dataDir: dataDir,
            cloudUrl: cloudUrl,
            close: function close() {
                if (closed) return;
                closed = true;
                // 长连接（NDJSON、转发出去的 SSE）不会自己断，要主动收掉，
                // 否则 close() 会一直等到它们超时
                if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
                server.close();
            }
        };
    });
}

module.exports = {
    createGateway: createGateway,
    DEFAULT_PORT: DEFAULT_PORT,
    MAX_PORT: MAX_PORT,
    API_PREFIX: API_PREFIX,
    GATEWAY_PREFIX: GATEWAY_PREFIX,
    DEFAULT_PAGE: DEFAULT_PAGE,
    // 下面几个只给自测脚本用
    normalizeCloudUrl: normalizeCloudUrl,
    rewriteSetCookie: rewriteSetCookie,
    isPrivateHostUrl: isPrivateHostUrl,
    setupPageHtml: setupPageHtml
};
