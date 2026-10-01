/**
 * 本地网关（`apiloop gateway --cloud <地址>`，G0 / G1）。
 *
 * 为什么要有它：macOS 15 之后，没有苹果签名的程序访问不了同网段地址，系统也不弹授权框；
 * 而 **nodejs.org 的官方 Node 被 launchd 直接启动时**可以拿到授权（D0 实测）。所以页面
 * 从本机打开、由官方 Node 代发请求，是唯一不花钱的路。详见
 * `docs/design/2026-10-01-local-agent.md` 第 2、3 节。
 *
 * 请求的三种去向，**顺序本身就是设计**：
 *   1. `/__admin/api/*` → **转发给云端**（数据在云端）；
 *   2. `/__admin/api/projects/:pid/send/stream` → **在本机执行**（`gateway/send.js`）：
 *      同网段请求唯一的出口，必须排在转发之前 —— 顺序反了它也会被转到云端去发；
 *   3. `/__admin/api/projects/:pid/ws` 与 `/__admin/api/ws/:id/*` → **在本机跑**
 *      （`gateway/ws.js`）：WebSocket 会话连的是内网地址，同样不能转给云端。
 *
 * 安全（设计稿第 3.1 节）是这个模块最要紧的部分，见 `createGuard`。
 */

var http = require('http');
var https = require('https');
var fs = require('fs');
var os = require('os');
var path = require('path');
var express = require('express');

var appInfo = require('../app-info');
var auth = require('../auth');
var pkg = require('../../package.json');
var cloud = require('./cloud');
var space = require('./space');
var gatewaySend = require('./send');
var gatewayWs = require('./ws');

/* ------------------------------------------------------------------ 常量 */

/** 端口从 47321 开始往上找，用到 47329 为止 */
var DEFAULT_PORT = 47321;
var MAX_PORT = 47329;

/** 判断云端在不在的超时（计划里定的 3 秒） */
var CLOUD_PROBE_TIMEOUT_MS = 3000;

/** 管理台接口前缀（和 lib/admin.js 的 API_PATH 是同一个字符串） */
var API_PREFIX = '/__admin/api';

/**
 * 网关自己的接口前缀，转发时不能被它吃掉。
 *
 * **L1 起从 `/__gateway` 改成 `/__apiloop`**：这个前缀本来就是 apiloop 自己的命名空间
 * （前端产物也挂在 `/__apiloop/` 下，`lib/mock-runtime.js` 早就把它列进保留前缀了），
 * `/__gateway` 才是那个多出来的名字。前后端一起改，别只改一边。
 */
var GATEWAY_PREFIX = '/__apiloop';

/** 前端页面。和 lib/admin.js 的 WEB_DIR / DEFAULT_PAGE 保持一致 */
var WEB_DIR = path.join(__dirname, '..', 'web');
var DEFAULT_PAGE = '/index.html';

/** 自定义请求头。前端所有请求都会带上它，别的网站带不了（要带就得先过预检） */
var CUSTOM_HEADER = 'x-apiloop';

/** 配置文件与端口文件都放在数据目录里 */
var CONFIG_FILE = 'gateway.json';
var PORT_FILE = 'gateway.port';

/** 网关的运行模式：读写本机库（local），还是把数据接口转发给云端（cloud） */
var MODES = ['local', 'cloud'];

/* ------------------------------------------------------------------ 日志 */

/**
 * 日志超过这个大小就在**下次启动时**转存一份（只留一份旧的）。
 *
 * 只留一份、只在启动时转：网关是长期运行的后台服务，运行中做轮转要么打断写入、
 * 要么得自己实现按大小切分；而 5MB 已经够装下很久的正常日志，真出问题时
 * 我们关心的也基本都是最近这一段。
 */
var LOG_MAX_BYTES = 5 * 1024 * 1024;

/** 启动时日志的上限；`--log-file` 传的是路径，也可以传字面量 - 表示输出到终端 */
var LOG_TERMINAL = '-';

/** 已经装上的那一份（见 installGatewayLog 开头「只装一次」的说明） */
var ACTIVE_LOG = null;

/** 网关默认的日志文件。Mac 上写用户自己的家目录（多个用户互不影响），其它平台输出到终端 */
function defaultLogFile() {
    if (process.platform !== 'darwin') return null;
    return path.join(os.homedir(), 'Library', 'Logs', appInfo.APP_NAME, 'gateway.log');
}

/** 超过 LOG_MAX_BYTES 就把 gateway.log 挪成 gateway.log.1（覆盖上一份旧的） */
function rotateLog(file) {
    var size = 0;
    try {
        size = fs.statSync(file).size;
    } catch (err) {
        return;  // 还没有这个文件
    }
    if (size <= LOG_MAX_BYTES) return;

    try {
        fs.renameSync(file, file + '.1');
    } catch (err) {
        // 转存失败不该拦住启动：大不了继续往原来的文件后面追加
        try {
            fs.rmSync(file + '.1', { force: true });
            fs.renameSync(file, file + '.1');
        } catch (err2) {
            // 仍然失败就算了
        }
    }
}

/**
 * 决定网关的日志写到哪，并接管这个进程的输出。**只在网关模式下调用。**
 *
 * 为什么不让 launchd 的 `StandardOutPath` 代劳（G0 审阅 N4）：原来写死的是
 * `/tmp/apiloop-gateway.log` —— 多个用户登录同一台 Mac 时，第一个用户的 launchd 用
 * 自己的身份建了这个文件，第二个用户的 launchd 打不开它，网关**根本起不来**。
 * 改成写到每个用户自己的 `~/Library/Logs/apiloop/gateway.log` 就没有这个问题。
 *
 * `--log-file -` 或者非 Mac 平台照旧输出到终端（开发时直接在终端跑，行为不变）。
 *
 * 顺带装上 `uncaughtException`：写进日志再退出，让 launchd 把网关重新拉起来 ——
 * 后台服务崩溃后什么都不留下是最难查的。
 *
 * @param {string} [requested] `--log-file` 的值：路径、`-`、或 undefined（按平台默认）
 * @returns {{file: string|null, write: function(string), close: function(function)}}
 */
function installGatewayLog(requested) {
    // 只装一次。装第二次会把 stdout/stderr 再套一层，输出翻倍；而且后一层会把前一层
    // 已经 end 掉的流当成「原来的去向」继续写，直接抛 WRITE_AFTER_END。
    if (ACTIVE_LOG) return ACTIVE_LOG;

    /**
     * 只有「彻底没给这个参数」才用平台默认路径；其余给不明白的值一律理解为「输出到终端」。
     *
     * 为什么写得这么宽：**yargs 会把 `--log-file -` 解析成布尔 `true`**（单独的 `-` 被它
     * 当成「没有值」），而按老写法 `path.resolve(String(true))` 会在**当前目录**建一个
     * 名叫 `true` 的文件 —— 实测过：仓库根目录里凭空多出一个 `true`，里面是网关日志。
     * 声明成 string 也只是变成空串，照样不能当路径用。
     */
    var file;
    if (requested === undefined || requested === null) {
        file = defaultLogFile();
    } else if (typeof requested !== 'string' || requested === '' || requested === LOG_TERMINAL) {
        file = null;
    } else {
        file = path.resolve(requested);
    }

    /** 原来的去向。终端里跑时它就是终端；launchd 下没有 StandardOutPath，它是 /dev/null */
    var originalOut = process.stdout.write.bind(process.stdout);
    var originalErr = process.stderr.write.bind(process.stderr);
    var stream = null;
    var closed = false;

    if (file) {
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            rotateLog(file);
            // 先同步建出这个文件再挂流：createWriteStream 是异步建文件的，不这样做的话
            // 启动后的一小段时间里 `tail -f`、`ls` 都看不到它（转存之后尤其明显）
            fs.closeSync(fs.openSync(file, 'a'));
            stream = fs.createWriteStream(file, { flags: 'a' });
            // 磁盘满、权限变了之类的错误是**异步**报出来的，没接住就是一个未捕获异常
            stream.on('error', function (err) {
                originalErr('[apiloop] 写日志失败：' + err.message + '\n');
                stream = null;
            });
        } catch (err) {
            // 日志建不出来也不能让网关起不来：退回终端
            originalErr('无法写入日志文件 ' + file + '：' + err.message + '\n');
            stream = null;
            file = null;
        }
    }

    function write(text) {
        var chunk = typeof text === 'string' ? text : String(text);
        // close() 之后（比如崩溃退出前又有一行输出）不能再往流里写，但终端那一份照旧
        if (!closed && stream) {
            try {
                stream.write(chunk);
            } catch (err) {
                // 日志写不进去，但网关该继续跑
            }
        }
        // 同时往原来的去向写一份。终端里就是屏幕上（开发时行为不变），
        // launchd 下是 /dev/null，等于没有开销。
        if (originalOut.writable !== false) originalOut(chunk);
    }

    function close(then) {
        var done = false;
        function finish() {
            if (done) return;
            done = true;
            if (then) then();
        }
        closed = true;
        if (!stream) return finish();

        var ending = stream;
        stream = null;
        // 给「写完再退出」留一点时间，但绝不无限等（写不出去也要退出，否则 launchd 不会拉起）
        var timer = setTimeout(finish, 1000);
        if (timer.unref) timer.unref();
        ending.end(function () {
            clearTimeout(timer);
            finish();
        });
    }

    // 接管 stdout / stderr。签名保持和原来一致（chunk, encoding, callback）
    function hook() {
        return function (chunk, encoding, callback) {
            write(chunk);
            if (typeof encoding === 'function') encoding();
            else if (typeof callback === 'function') callback();
            return true;
        };
    }
    if (stream) {
        process.stdout.write = hook(originalOut);
        process.stderr.write = hook(originalErr);
    }

    process.on('uncaughtException', function (err) {
        write('[apiloop] 未捕获的异常：' +
            (err && err.stack ? err.stack : String(err)) + '\n');
        close(function () { process.exit(1); });
    });

    ACTIVE_LOG = {
        file: file,
        write: write,
        close: close
    };
    return ACTIVE_LOG;
}

/* ------------------------------------------------------------------ 配置 */

/**
 * 读数据目录里的 `gateway.json`。
 *
 * 形状是 `{ cloudUrl?, mode }`：
 * - `cloudUrl` 只给开发用（正式装机用的是安装包里写死的那份，见 `cloud.readBundledCloudUrl`）；
 * - `mode` 是「当前用哪个空间」——`local` 读写本机库，`cloud` 转发给云端。
 *   **没有这个字段的旧配置当成 `cloud`**：那正是它以前的行为。
 */
function readConfig(dataDir) {
    var parsed = null;
    try {
        parsed = JSON.parse(fs.readFileSync(path.join(dataDir, CONFIG_FILE), 'utf8'));
    } catch (err) {
        // 没有配置文件、或者内容坏了，都按「还没配置」处理：网关照样能起来，
        // 不该因为一个坏文件就启动失败
    }
    if (!parsed || typeof parsed !== 'object') parsed = {};

    return {
        cloudUrl: typeof parsed.cloudUrl === 'string'
            ? cloud.normalizeCloudUrl(parsed.cloudUrl)
            : '',
        mode: MODES.indexOf(parsed.mode) === -1 ? 'cloud' : parsed.mode
    };
}

/**
 * 写回 `gateway.json`。
 *
 * **先读出来再合并**：调用方只说要改什么，另一个字段原样保留 ——
 * 否则「切模式」会把开发时手写的云端地址抹掉，「改地址」又可能把模式重置成 cloud。
 *
 * @param {object} patch `{ cloudUrl?, mode? }`，没给的字段不动
 */
function writeConfig(dataDir, patch) {
    var file = path.join(dataDir, CONFIG_FILE);
    var current = readConfig(dataDir);
    var next = { cloudUrl: current.cloudUrl, mode: current.mode };

    if (patch && patch.cloudUrl !== undefined) {
        next.cloudUrl = cloud.normalizeCloudUrl(patch.cloudUrl);
    }
    if (patch && patch.mode !== undefined && MODES.indexOf(patch.mode) !== -1) {
        next.mode = patch.mode;
    }

    // 0600：里面可能带着内网地址，没必要让同机器上的其他用户读到
    fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', { mode: 384 });
    return file;
}

/* ------------------------------------------------------------------ 小工具 */

/** `pathname` 是不是 `prefix` 本身或者它的子路径（按路径段比，避免 /__admin/apiX 混进来） */
function isUnder(pathname, prefix) {
    var value = String(pathname || '');
    return value === prefix || value.indexOf(prefix + '/') === 0;
}

/* ------------------------------------------------------------------ 安全 */

/**
 * 安全闸门（设计稿第 3.1 节 + 审阅重点第 1 条）。**注册在所有路由之前**：
 * 静态资源、`/__apiloop/*`、转发、本机发送一律先过这里。
 *
 * 要挡的是「别的网站的页面借本机的网关读数据 / 发请求」。四道：
 *
 * 1. **Host 必须是 127.0.0.1:端口 或 localhost:端口。** 这是防 DNS 重绑定：攻击者的页面
 *    把 evil.com 解析到 127.0.0.1，浏览器就认为自己在和 evil.com 说话，`Origin` 和
 *    `Sec-Fetch-Site` 全都是「同源」，只有 Host 会露出真相。
 * 2. **`Sec-Fetch-Site: cross-site` 一律拒。** 现代浏览器都会带这个头，是首选判据；
 *    它缺失时不拦（老浏览器和 curl 都没有），交给第 1、4 条兜。
 * 3. **`Origin` 存在时必须是网关自己的地址。** 表单提交、跨域请求都会带。
 * 4. **`/__admin/api/*` 一律要求 `X-Apiloop: 1`；`/__apiloop/*` 的非 GET 请求也一样。**
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

/* ------------------------------------------------------------------ 转发 */

/**
 * 把其余的 `/__admin/api/*` 原样转发给云端。
 *
 * 请求体**用管道直接怼过去**（`req.pipe(proxyReq)`），不先缓冲 —— 上传大文件、导入
 * 几十 MB 的 HAR 都靠这一点；响应体同样边收边发（`proxyRes.pipe(res)`），
 * `/ws/:id/events` 那种长连接才不会被攒成一坨再吐出来（审阅重点第 3 条）。
 *
 * 也因此，这个中间件前面**不能挂全局的 body 解析器**：请求流一旦被读完就接不上了。
 * 所以网关只给「本机发送」「本机 WebSocket」「`/__apiloop/*`」几条路由单独挂解析器。
 *
 * @param {{getCloudUrl: function, log?: function, onResponse?: function}} options
 *   `onResponse(req, proxyRes)`：云端**回了响应**时调用（状态码已定、响应体还没读完）。
 *   登录成功要切模式就挂在这里 —— 不挂的话只能等响应体读完，那会拖慢登录这条长连接。
 */
function createForwarder(options) {
    var getCloudUrl = options.getCloudUrl;
    var log = options.log || function () {};
    var onResponse = typeof options.onResponse === 'function' ? options.onResponse : null;

    return function forward(req, res) {
        var cloudUrl = getCloudUrl();
        if (!cloudUrl) {
            // 三个来源都没有（`--cloud` / gateway.json / 安装包里的 cloud.json）。
            // 正式装的包不该走到这里 —— 打包时不给地址就打不出来。
            res.status(503).json({ error: '这个安装包没有配置云端地址' });
            return;
        }

        var base = cloud.parseCloudUrl(cloudUrl);
        if (!base) {
            res.status(502).json({ error: '云端地址不合法：' + cloudUrl });
            return;
        }

        var secure = base.protocol === 'https:';
        var transport = secure ? https : http;

        // 哪些头能过去由 cloud.headersForCloud 一家定，别处不要再写一遍
        var headers = cloud.headersForCloud(req.headers);
        headers.host = base.host;

        var proxyReq = transport.request({
            protocol: base.protocol,
            hostname: base.hostname,
            port: base.port || (secure ? 443 : 80),
            method: req.method,
            path: req.originalUrl,
            headers: headers
        }, function (proxyRes) {
            // 状态码已经定了：登录成功要切模式的，就在这里切（响应体还没开始读）
            if (onResponse) {
                try {
                    onResponse(req, proxyRes);
                } catch (err) {
                    // 钩子出错不能把转发这条链带崩
                    log('转发响应钩子出错：' + ((err && err.message) || err));
                }
            }

            var outHeaders = {};
            Object.keys(proxyRes.headers).forEach(function (name) {
                var lower = name.toLowerCase();
                if (lower === 'set-cookie') return;
                if (cloud.HOP_BY_HOP.indexOf(lower) !== -1) return;
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
            res.status(502).json({ error: cloud.cloudDownMessage(getCloudUrl(), err) });
        });

        // 浏览器断开时把在途的那一发也掐掉，否则云端会一直算下去
        res.on('close', function () {
            if (!res.writableEnded) proxyReq.destroy();
        });

        req.pipe(proxyReq);
    };
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

/** 探云端活着没有：拿到任何 HTTP 响应（含 401）都算活着，连不上或超时才是不活着 */
function probeCloud(cloudUrl) {
    return new Promise(function (resolve) {
        if (!cloudUrl) return resolve(false);

        var base = cloud.parseCloudUrl(cloudUrl);
        if (!base) return resolve(false);

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
            path: API_PREFIX + '/meta',
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
 * @returns {Promise<{server: object, port: number, dataDir: string, cloudUrl: string,
 *   cloudSource: string, mode: string, close: function}>}
 */
function createGateway(options) {
    var opts = options || {};
    var dataDir = opts.dataDir ? path.resolve(opts.dataDir) : appInfo.DATA_DIR;
    var log = typeof opts.log === 'function' ? opts.log : function () {};

    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

    var config = readConfig(dataDir);

    /**
     * 云端地址的三个来源，**从上到下第一个有值的生效**：
     *
     *   1. `--cloud` 启动参数 —— 开发用；
     *   2. `<数据目录>/gateway.json` 里的 `cloudUrl` —— 也是开发用；
     *   3. 安装包里的 `cloud.json` —— 正式装机时用的就是它，打包时由 `APILOOP_CLOUD_URL` 写死。
     *
     * **`--cloud` 不再写回配置文件**（L1 之前的版本会写）。写回的话，开发时随手指一次
     * 测试环境，之后忘了带参数也会连到测试环境上去，看起来像「云端数据丢了」。
     */
    var cloudUrl = '';
    var cloudSource = '';
    if (opts.cloudUrl !== undefined && opts.cloudUrl !== null && String(opts.cloudUrl) !== '') {
        cloudUrl = cloud.normalizeCloudUrl(opts.cloudUrl);
        if (!cloudUrl) {
            return Promise.reject(new Error('云端地址不合法：' + opts.cloudUrl));
        }
        cloudSource = '--cloud';
    } else if (config.cloudUrl) {
        cloudUrl = config.cloudUrl;
        cloudSource = CONFIG_FILE;
    } else {
        var bundled = cloud.readBundledCloudUrl();
        if (bundled) {
            cloudUrl = bundled;
            cloudSource = 'cloud.json';
        }
    }

    /** 当前模式：`local` 读写本机库，`cloud` 转发给云端。下面会被 /local/enter 和登录改掉 */
    var mode = config.mode;

    /**
     * 本机空间（`local` 模式下页面读写的就是它）。**懒打开**：云端模式下不该白白建一个库；
     * 启动时模式已经是 `local` 的话在下面立刻打开。
     */
    var localSpace = null;

    /**
     * 切模式，并把结果写回 `gateway.json`（下次启动还是这个模式）。
     *
     * 写失败只打日志：模式已经在内存里生效了，不该因为写不了配置文件就让这次请求失败。
     */
    function setMode(next) {
        if (MODES.indexOf(next) === -1 || next === mode) return;
        mode = next;
        try {
            writeConfig(dataDir, { mode: mode });
        } catch (err) {
            log('写 gateway.json 失败：' + ((err && err.message) || err));
        }
        log('模式切换为 ' + mode);
    }

    /** 打开本机空间；失败时返回 null 并记日志（调用方决定怎么报错） */
    function openLocalSpace() {
        if (localSpace) return localSpace;
        try {
            localSpace = space.openLocalSpace(dataDir);
            return localSpace;
        } catch (err) {
            log('打开本机空间失败：' + ((err && err.stack) || err));
            return null;
        }
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

    // 1) 安全闸门。必须是第一个 —— 静态资源、`/__apiloop/*`、转发、本机发送全都要先过它
    app.use(createGuard({
        getPort: function () { return actualPort; },
        log: log
    }));

    // 2) 状态。前端的 `gateway.status` 就靠它：`mode` 决定顶栏显示「仅本机」还是云端那套
    app.get(GATEWAY_PREFIX + '/status', function (req, res) {
        probeCloud(cloudUrl).then(function (reachable) {
            res.json({
                version: pkg.version,
                cloudUrl: cloudUrl,
                cloudReachable: reachable,
                mode: mode
            });
        });
    });

    // 3) ~~设置页~~（L1 已删）
    //
    // 以前没配云端地址时，页面会看到一张「填地址 + 保存」的表单。L1 起云端地址**打包时
    // 写死**（安装包里的 `cloud.json`），用户界面上不再有任何填写或修改它的地方 ——
    // 换地址就是发一个新版本的安装包。所以设置页、`POST …/setup`、以及「没配地址时
    // 接管 `/`」那段中间件一起去掉了。
    //
    // 三个来源都取不到地址时（`--cloud` / `gateway.json` / 安装包里的 `cloud.json`），
    // 转发这条链会返回 503 并说明原因，见 createForwarder。

    /**
     * 3b) 进入本机空间（前端登录页上那个「跳过登录，先在本机用」）。
     *
     * 发的是**网关自己**的会话：库里那个本机用户没有密码，这一条是它唯一的入口。
     * 全程不碰网络，所以断网、没配云端地址都能用。
     */
    app.post(GATEWAY_PREFIX + '/local/enter', function (req, res) {
        var opened = openLocalSpace();
        if (!opened) {
            res.status(500).json({ error: '本机数据打不开，请重试或重新安装' });
            return;
        }

        auth.createSession(opened.handle, opened.user.id, res);
        setMode('local');
        res.json({ ok: true, user: opened.user });
    });

    /**
     * 4) 本机模式：`/__admin/api/*` 全部交给本机空间的管理台（设计稿第 2、3.2 节）。
     *
     * **唯一的例外是 `POST /auth/login`** —— 它必须转发给云端：「登录」这件事只可能是
     * 登云端账号（本机用户没有密码），登录成功了才切到云端模式。
     *
     * 顺序要紧：这一段排在网关自己的「本机发送」「本机 WebSocket」和转发**之前**，
     * 所以本机模式下那几个请求由本机管理台处理（和云端自己发送时是同一条链，
     * 在同一个进程里），不会漏到云端去。
     */
    app.use(API_PREFIX, function (req, res, next) {
        if (mode !== 'local') return next();

        // 本机库打不开时**不能放它往下走**：下面就是转发，那等于把本机模式下的请求
        // 漏到云端去（审阅重点第 1 条）。宁可明确报错。
        if (!localSpace) {
            res.status(503).json({ error: '本机数据打不开，请重试或重新安装' });
            return;
        }

        // 登录云端账号那一条：交给下面的转发器
        var pathname = String(req.originalUrl || '').split('?')[0];
        if (req.method === 'POST' && pathname === API_PREFIX + '/auth/login') return next();

        return localSpace.admin.api(req, res, next);
    });

    // 5) 本机发送（云端模式）。**必须排在转发之前**：同一条路径，前面这条先命中。
    //    请求体上限和云端一样是 4MB（云端那套也挂在 4MB 的解析器下面）。
    //    本机模式下走不到这里 —— 上面那段已经把请求交给本机管理台了。
    var localSend = gatewaySend.createLocalSend({
        getCloudUrl: function () { return cloudUrl; },
        dataDir: dataDir,
        log: log
    });
    app.post(API_PREFIX + '/projects/:pid/send/stream',
        express.json({ limit: '4mb' }),
        function (req, res) {
            return localSend(req, res, req.body);
        });

    // 4b) 本机 WebSocket 调试会话。同样排在转发之前 —— 它连的是内网地址。
    var wsRoutes = gatewayWs.createWsRoutes({
        getCloudUrl: function () { return cloudUrl; },
        log: log,
        sessionOptions: opts.wsSessionOptions
    });

    app.post(API_PREFIX + '/projects/:pid/ws',
        express.json({ limit: '1mb' }),
        function (req, res) { return wsRoutes.create(req, res, req.body); });

    // `/ws/:id/*` 不挂解析器也读不到体，所以 send 那条单独挂一个小的
    app.post(API_PREFIX + '/ws/:id/send',
        express.json({ limit: '64mb' }),
        function (req, res) { return wsRoutes.send(req, res, req.body); });

    app.get(API_PREFIX + '/ws/:id/events', function (req, res) {
        return wsRoutes.events(req, res);
    });

    app.delete(API_PREFIX + '/ws/:id', function (req, res) {
        return wsRoutes.destroy(req, res);
    });

    // 6) 其余管理台接口一律转发云端。
    //    用 app.use 挂在 /__admin/api 上：所有方法、所有子路径都进来；
    //    这里**不做请求体解析**，请见 createForwarder 的说明。
    app.use(API_PREFIX, createForwarder({
        getCloudUrl: function () { return cloudUrl; },
        log: log,
        /**
         * 登录云端账号成功 → 切到云端模式（设计稿 4.3）。
         *
         * 判据是**云端真的回了 2xx**，不是「我们发出去了」——密码错了、账号被锁了都不该切。
         * 切换写进 `gateway.json`，下次启动还是云端模式。
         */
        onResponse: function (req, proxyRes) {
            var pathname = String(req.originalUrl || '').split('?')[0];
            var isLogin = req.method === 'POST' && pathname === API_PREFIX + '/auth/login';
            if (isLogin && proxyRes.statusCode >= 200 && proxyRes.statusCode < 300) {
                setMode('cloud');
            }
        }
    }));

    // 7) 页面：和云端同一份 lib/web
    app.use(express.static(WEB_DIR, { index: false }));
    app.get('/', function (req, res) {
        res.redirect(302, DEFAULT_PAGE);
    });

    /**
     * 启动时模式就是 `local` 的（上次点了「跳过登录」，或者上一次启动就在本机模式里），
     * 现在就把本机空间打开 —— 否则页面第一屏的 `/meta`、`/projects` 会 503，
     * 得等用户再点一次「跳过登录」。
     */
    if (mode === 'local') openLocalSpace();

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
            /** 地址是从哪来的：`--cloud` / `gateway.json` / `cloud.json` / ''（都没有） */
            cloudSource: cloudSource,
            mode: mode,
            close: function close() {
                if (closed) return;
                closed = true;
                // 本机建的 WebSocket 会话要先收掉，否则它们会一直连着内网
                wsRoutes.closeAll();
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
    // 日志去向（N4）。由 command.js 在起网关之前调用，这样连启动失败也留得下痕迹
    installGatewayLog: installGatewayLog,
    defaultLogFile: defaultLogFile,
    // 下面几个只给自测脚本用
    normalizeCloudUrl: cloud.normalizeCloudUrl,
    rewriteSetCookie: rewriteSetCookie,
    readConfig: readConfig,
    writeConfig: writeConfig,
    // 从 gateway/send.js 转出去：G0 时它们挂在这个文件上，自测脚本还在用
    hostFromError: gatewaySend.hostFromError,
    isPrivateAddress: gatewaySend.isPrivateAddress
};
