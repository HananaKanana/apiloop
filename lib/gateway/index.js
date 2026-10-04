/**
 * 本地网关（`apiloop gateway`，G0 / G1 / L3）。
 *
 * 为什么要有它：macOS 15 之后，没有苹果签名的程序访问不了同网段地址，系统也不弹授权框；
 * 而 **nodejs.org 的官方 Node 被 launchd 直接启动时**可以拿到授权（D0 实测）。所以页面
 * 从本机打开、由官方 Node 代发请求，是唯一不花钱的路。
 *
 * **L3 起页面读写的就是本机库**（不再把数据接口转发给云端）：
 *
 *   1. 空间与打开即进入：当前空间的库 + 网关自己发的本机会话，页面打开就有身份；
 *   2. `/__admin/api/*` 全部交给当前空间的管理台 —— 数据、本机发送、WebSocket 调试
 *      都在这个进程里跑，页面的接口和直接打开云端时一模一样；
 *   3. 三条例外（`account.js`）：登录、退出，以及「只有云端有的功能」转给云端；
 *   4. `/__apiloop/*` 是网关自己的接口（状态、删本机数据）。
 *
 * 连云端的只剩：登录、只有云端有的功能、同步（Task 2 / 3）。
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
var account = require('./account');
var syncEngine = require('./sync/engine');
var syncPull = require('./sync/pull');
var syncPush = require('./sync/push');
var syncApply = require('./sync/apply');
var syncMerge = require('./sync/merge');
var syncRows = require('../sync/rows');
var update = require('./update');

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
    if (process.platform === 'darwin') {
        return path.join(os.homedir(), 'Library', 'Logs', appInfo.APP_NAME, 'gateway.log');
    }
    // Windows：网关由 apiloop.exe --gateway 在后台拉起，没有终端可看，只能写文件
    if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
        return path.join(process.env.LOCALAPPDATA, appInfo.APP_NAME, 'logs', 'gateway.log');
    }
    return null;
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
 * 形状是 `{ cloudUrl?, currentSpace }`：
 * - `cloudUrl` 只给开发用（正式装机用的是安装包里写死的那份，见 `cloud.readBundledCloudUrl`）；
 * - `currentSpace` 是「当前打开哪个空间」——`local` 是未绑定空间，其余是
 *   `<主机>~<端口>~<账号ID>`（见 `space.spaceKey`）。
 *
 * **L1 留下的 `mode` 读到了就忽略**：它表达的是「本机 / 转发云端」，和第二版的
 * 「当前是哪个空间」不是一回事，硬套会把 `mode: 'cloud'` 的老配置当成一个叫 cloud 的空间。
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
        currentSpace: typeof parsed.currentSpace === 'string' && parsed.currentSpace
            ? parsed.currentSpace
            : space.LOCAL_SPACE_KEY
    };
}

/**
 * 写回 `gateway.json`。
 *
 * **先读出来再合并**：调用方只说要改什么，另一个字段原样保留 ——
 * 否则「切空间」会把开发时手写的云端地址抹掉，「改地址」又可能把当前空间重置回 local。
 *
 * @param {object} patch `{ cloudUrl?, currentSpace? }`，没给的字段不动
 */
function writeConfig(dataDir, patch) {
    var file = path.join(dataDir, CONFIG_FILE);
    var current = readConfig(dataDir);
    var next = { cloudUrl: current.cloudUrl, currentSpace: current.currentSpace };

    if (patch && patch.cloudUrl !== undefined) {
        next.cloudUrl = cloud.normalizeCloudUrl(patch.cloudUrl);
    }
    if (patch && patch.currentSpace !== undefined && patch.currentSpace) {
        next.currentSpace = String(patch.currentSpace);
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
 * **第一期的「把数据接口原样转发给云端」在 L3 删掉了**（设计稿第 2 节）：页面读写的
 * 是本机库，网关不再转发任何数据接口。
 *
 * 现在连云端的只剩三处，都不走管道转发：
 *   - 登录、退出、只有云端有的功能 —— `account.js` 用 `cloud.requestJson` 缓冲 JSON；
 *   - 同步 —— `lib/gateway/sync/`。
 *
 * 那条链上有两个当时很要紧、以后重新写转发还会踩到的结论，留在这里：
 *   - 请求体只能用管道怼过去，**转发中间件前面不能挂全局 body 解析器**（请求流读完就接不上）；
 *   - 转发出去的 `Set-Cookie` 必须去掉 `Domain` 和 `Secure`（网关是 http），见 rewriteSetCookie。
 */
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

/**
 * 探云端活着没有：拿到任何 HTTP 响应（含 401）都算活着，连不上或超时才是不活着。
 *
 * 顺带读响应头里的 `X-Apiloop-Version`（云端每个管理台响应都带，401 也带）——
 * 前端拿它和本机版本比，不一致就提示「有新版本」。`/meta` 本身要登录，读不到正文。
 *
 * @returns {Promise<{reachable: boolean, version: string}>}
 */
function probeCloud(cloudUrl) {
    var DOWN = { reachable: false, version: '' };
    return new Promise(function (resolve) {
        if (!cloudUrl) return resolve(DOWN);

        var base = cloud.parseCloudUrl(cloudUrl);
        if (!base) return resolve(DOWN);

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
            finish({ reachable: true, version: String(probeRes.headers['x-apiloop-version'] || '') });
        });

        probeReq.on('timeout', function () {
            probeReq.destroy();
            finish(DOWN);
        });
        probeReq.on('error', function () { finish(DOWN); });
        probeReq.end();
    });
}

/** 探测结果的缓存时长 */
var CLOUD_PROBE_CACHE_MS = 10000;

/**
 * 带缓存的云端探测。
 *
 * 页面**每 3 秒**问一次 `/__apiloop/status`，如果每次都真去探一下，云端不可达时
 * 每个请求都要等到 `CLOUD_PROBE_TIMEOUT_MS` 才回 —— 页面会一直卡着，而且这些探测
 * 自己也会互相堆叠。探测结果本来就是「大概在不在」这种精度，缓存 10 秒完全够用。
 *
 * 同一时刻只允许一个在途探测：并发的调用共用它，不重复发。
 */
function createCloudProbe(cloudUrl) {
    var lastAt = 0;
    var lastValue = { reachable: false, version: '' };
    var inflight = null;

    return function probe() {
        if (Date.now() - lastAt < CLOUD_PROBE_CACHE_MS) return Promise.resolve(lastValue);
        if (inflight) return inflight;

        inflight = probeCloud(cloudUrl).then(function (result) {
            lastAt = Date.now();
            lastValue = result;
            inflight = null;
            return result;
        }, function () {
            lastAt = Date.now();
            lastValue = { reachable: false, version: '' };
            inflight = null;
            return lastValue;
        });

        return inflight;
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
 * @returns {Promise<{server: object, port: number, dataDir: string, cloudUrl: string,
 *   cloudSource: string, manager: object, close: function}>}
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
     *   2. 安装包里的 `cloud.json` —— 正式装机时用的就是它，打包时由 `APILOOP_CLOUD_URL` 写死；
     *   3. `<数据目录>/gateway.json` 里的 `cloudUrl` —— 只在没有安装包地址时用（从源码跑网关）。
     *
     * **安装包的地址必须排在 gateway.json 前面**（2026-10-01 用户遇到）：早期版本有「首次填
     * 云端地址」，在 gateway.json 里留下过 localhost:8080；装了连正式环境的新包之后，那份旧值
     * 还压着新地址，数据一直往一个早就不在的测试环境同步，另一台电脑当然同步不下来。
     *
     * **`--cloud` 不写回配置文件**（L1 之前的版本会写）。写回的话，开发时随手指一次
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
    } else {
        var bundled = cloud.readBundledCloudUrl();
        if (bundled) {
            cloudUrl = bundled;
            cloudSource = 'cloud.json';
        } else if (config.cloudUrl) {
            cloudUrl = config.cloudUrl;
            cloudSource = CONFIG_FILE;
        }
    }

    /**
     * 空间管理器（`space.js`）：**它就是「页面读写的到底是哪个库」的唯一答案**。
     *
     * 构造时就打开当前空间；打不开的话 `current()` 返回 null，下面的中间件一律回 503 ——
     * 宁可页面上一句明确的错误，也不要拿一个空库装作正常（那会让人以为数据丢了）。
     */
    var manager = space.createSpaceManager({
        dataDir: dataDir,
        getCloudUrl: function () { return cloudUrl; },
        currentSpace: config.currentSpace,
        // 换空间写回 gateway.json，下次启动还是它。写失败只打日志：
        // 空间在内存里已经切过来了，不该因为写不了配置文件让这次请求失败
        onSpaceChange: function (key) {
            try {
                writeConfig(dataDir, { currentSpace: key });
            } catch (err) {
                log('写 gateway.json 失败：' + ((err && err.message) || err));
            }
        },
        log: log
    });

    if (!manager.current()) {
        log('当前空间打不开，页面会收到 503');
    }

    var accountRoutes = account.createAccountRoutes({
        manager: manager,
        getCloudUrl: function () { return cloudUrl; },
        log: log
    });

    /**
     * 同步引擎（Task 2）。只在已登录时干活：登录那一刻、启动时、每 30 秒，
     * 连不上云端时改成每 10 秒试。
     *
     * 挂在 `manager.onChange` 上而不是登录那条路径里：登录、退出、切换空间都会走到它，
     * 同步引擎不必知道登录是怎么发生的。**退出登录时这一勾什么都不会做**（状态不是
     * `signedIn`），本机的修改照样记在 `changes` 里，下次登录推上去。
     */
    var sync = syncEngine.createSyncEngine({
        manager: manager,
        getCloudUrl: function () { return cloudUrl; },
        log: log
    });
    manager.onChange(function () { sync.kick('空间变化'); });
    // 别处要能催一轮同步（第八轮第 1 节：测试集刚建好、还没推上云时要先同步一次）
    manager.setSyncNow(function () { sync.kick('测试集运行记录'); });
    sync.kick('启动');

    /** 实际监听的端口。绑定成功之前是 0，安全闸门在此之前不放行任何请求 */
    var actualPort = 0;
    var closed = false;

    /** 云端连通性探测（带 10 秒缓存，页面每 3 秒问一次状态） */
    var probeCloudCached = createCloudProbe(cloudUrl);

    /** 一键更新：下载云端那个版本的安装包，交给系统安装（update.js） */
    var updater = update.createUpdater({
        getCloudUrl: function () { return cloudUrl; },
        log: log
    });

    var app = express();
    app.disable('x-powered-by');

    /**
     * **路由区分大小写（B1）。**
     *
     * Express 默认不区分，`/__ADMIN/API/...` 一样能命中 `/__admin/api` 下面的路由。
     * 安全闸门里已经把路径转小写再比前缀了，这一条是第二道：大小写不对的路径根本匹配不到
     * 任何路由，直接落到静态资源那儿返回 404。
     *
     * 副作用：静态资源也变区分大小写了。前端请求的都是构建产物里的原样路径，
     * 不受影响；而 `/INDEX.HTML` 这类写法以前能被 APFS 的大小写不敏感兜住，现在会 404 ——
     * 这正是我们要的。
     */
    app.set('case sensitive routing', true);

    // 1) 安全闸门。必须是第一个 —— 静态资源、`/__apiloop/*`、管理台接口全都要先过它
    app.use(createGuard({
        getPort: function () { return actualPort; },
        log: log
    }));

    /**
     * 2) 状态。前端顶栏就靠它（设计稿第 7 节）。
     *
     * `space.state` 是三种空间状态；`sync` 是同步引擎的状态（待同步、冲突、上次同步时间）。
     * `mode` 是**给 L4 之前的旧前端留的兼容值**（`unbound` 当 `local`，其余当 `cloud`），
     * 前端改完就删。
     */
    app.get(GATEWAY_PREFIX + '/status', function (req, res) {
        var current = manager.current();
        probeCloudCached().then(function (probe) {
            res.json({
                version: pkg.version,
                cloudUrl: cloudUrl,
                cloudReachable: probe.reachable,
                // 云端的版本（连不上、或者云端还是没带版本头的老版本时为空）
                cloudVersion: probe.version,
                // 一键更新的进度（立即更新 → 下载中 → 已打开安装程序）
                update: updater.status(),
                mode: manager.state() === space.UNBOUND ? 'local' : 'cloud',
                space: {
                    state: manager.state(),
                    user: current ? publicUser(current.user) : null
                },
                sync: sync.status()
            });
        });
    });

    // 3) 删掉本机数据（设计稿 4.4 的「退出并删除本机数据」）
    app.post(GATEWAY_PREFIX + '/space/delete',
        express.json({ limit: '16kb' }),
        accountRoutes.deleteSpace);

    /**
     * 3a) 一键更新：下载**云端现在的版本**的安装包并打开安装程序。
     *
     * 版本不让前端传：只认网关自己探到的云端版本，而且必须比本机新 ——
     * 免得一个旧的云端把大家「更新」回老版本。
     */
    app.post(GATEWAY_PREFIX + '/update/start', function (req, res) {
        probeCloudCached().then(function (probe) {
            if (!probe.reachable || !probe.version) {
                return res.status(409).json({ ok: false, error: '连不上云端，稍后再试' });
            }
            if (!update.isNewer(probe.version, pkg.version)) {
                return res.status(409).json({ ok: false, error: '已经是最新版本（' + pkg.version + '）' });
            }
            var outcome = updater.start(probe.version);
            if (!outcome.ok) return res.status(400).json({ ok: false, error: outcome.error });
            return res.json({ ok: true, update: updater.status() });
        });
    });

    /* 3b) 同步的待同步清单与冲突（设计稿第 7 节，界面用） */

    /** 顶栏「N 项待同步」和目录树上的小点：本机还没推上去的行 */
    app.get(GATEWAY_PREFIX + '/sync/pending', function (req, res) {
        var current = manager.current();
        if (!current) return res.status(503).json({ error: '本机数据打不开，请重试或重新安装' });

        var items = [];
        syncApply.pendingKeys(current.handle).forEach(function (key) {
            var index = key.indexOf(':');
            items.push({ entity: key.slice(0, index), id: key.slice(index + 1) });
        });
        res.json({ items: items });
    });

    /** 冲突列表：左边「我的」右边「云端的」，只列不一致的那几列 */
    app.get(GATEWAY_PREFIX + '/sync/conflicts', function (req, res) {
        var current = manager.current();
        if (!current) return res.status(503).json({ error: '本机数据打不开，请重试或重新安装' });

        var items = syncMerge.listConflicts(current.handle).map(function (item) {
            var row = syncRows.get(current.handle, item.entity, item.entityId) || item.remote || {};
            return {
                entity: item.entity,
                id: item.entityId,
                name: row.name || (syncRows.label(item.entity) + ' ' + item.entityId),
                fields: item.fields
            };
        });
        res.json({ items: items });
    });

    /**
     * 处理一条冲突：`mine` 用我的、`theirs` 用云端的、`copy` 另存为副本（只对接口）。
     * 处理完立刻催一轮同步 —— 选「用我的」要把结果推上去。
     */
    app.post(GATEWAY_PREFIX + '/sync/conflicts/resolve',
        express.json({ limit: '1mb' }),
        function (req, res) {
            var current = manager.current();
            if (!current) return res.status(503).json({ error: '本机数据打不开，请重试或重新安装' });

            var body = req.body || {};
            var entity = String(body.entity || '');
            var id = String(body.id || '');
            var choice = String(body.choice || '');

            if (!syncRows.has(entity) || !id) {
                return res.status(400).json({ ok: false, error: '缺少 entity / id' });
            }
            if (['mine', 'theirs', 'copy'].indexOf(choice) === -1) {
                return res.status(400).json({ ok: false, error: 'choice 只能是 mine / theirs / copy' });
            }

            var outcome = syncPush.resolve(current.handle, entity, id, choice);
            if (!outcome.ok) return res.status(400).json({ ok: false, error: outcome.error });

            sync.kick('处理冲突');
            return res.json({ ok: true, copyId: outcome.copyId || null });
        });

    /**
     * 4) 登录、退出、只有云端有的功能（`account.js`）。
     *
     * 挂在 `/__admin/api` 上，但**只截那几条路径**，其余原样交给下面的空间管理台。
     * 顺序要紧：这一层在管理台之前，否则本机库会先给登录请求回一个 404。
     */
    var smallJson = express.json({ limit: '1mb' });
    app.use(API_PREFIX, function (req, res, next) {
        var pathname = String(req.originalUrl || '').split('?')[0];

        if (req.method === 'POST' && pathname === API_PREFIX + '/auth/login') {
            return smallJson(req, res, function () { accountRoutes.login(req, res); });
        }
        if (req.method === 'POST' && pathname === API_PREFIX + '/auth/register') {
            return smallJson(req, res, function () { accountRoutes.register(req, res); });
        }
        if (req.method === 'POST' && pathname === API_PREFIX + '/auth/logout') {
            return accountRoutes.logout(req, res);
        }
        if (!accountRoutes.cloudOnlyPath(req)) return next();
        return smallJson(req, res, function () { accountRoutes.forwardCloudOnly(req, res); });
    });

    /**
     * 5) 打开即进入 + 其余 `/__admin/api/*` 全部交给当前空间的本机管理台。
     *
     * 「打开即进入」（设计稿 3.2）：浏览器没有会话时，网关直接发一个**当前空间身份**的
     * 会话，并把这次请求的 Cookie 头换成新发的那个 —— 页面打开就有身份，不经过登录页。
     * 这件事走的是 `auth.createSession`，库里那个用户没有密码，所以这是本机身份唯一的入口。
     */
    app.use(API_PREFIX, function (req, res, next) {
        var current = manager.current();
        if (!current) {
            return res.status(503).json({ error: '本机数据打不开，请重试或重新安装' });
        }

        return auth.createSessionMiddleware(current.handle)(req, res, function (err) {
            if (err) return next(err);

            if (!req.user) {
                var token = auth.createSession(current.handle, current.user.id, res);
                req.headers.cookie = appInfo.SESSION_COOKIE + '=' + token;
            }
            return current.admin.api(req, res, next);
        });
    });

    // 6) 页面：和云端同一份 lib/web
    app.use(express.static(WEB_DIR, { index: false }));
    app.get('/', function (req, res) {
        res.redirect(302, DEFAULT_PAGE);
    });

    // 不碰 server.timeout / requestTimeout：Node 的 socket 空闲超时本来就是 0（关的），
    // NDJSON 长连接可以一直挂着；而请求体要先收全这件事仍然有默认上限兜着。
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
            /** 空间管理器：自测脚本用它看当前空间、登录退出 */
            manager: manager,
            /** 同步引擎：自测脚本用 `kick` 手动催一轮、看 `status()` */
            sync: sync,
            close: function close() {
                if (closed) return;
                closed = true;
                // 先停同步引擎的定时器，再关库 —— 反过来会有一次「库已经关了还在跑」的竞态
                sync.close();
                updater.close();
                // 先关库再关服务：库关掉之后还在跑的请求会拿到 503，比静默出错好
                manager.close();
                // 长连接（NDJSON）不会自己断，要主动收掉，否则 close() 会一直等到它们超时
                if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
                server.close();
            }
        };
    });
}

/** 给页面的用户信息：只露它用得上的四个字段，绝不带 `password_hash`（本来也没有） */
function publicUser(user) {
    if (!user) return null;
    return {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        role: user.role
    };
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
    // 网关自己已经不用它了（L3 起没有管道转发），留着是因为自测脚本还在拿它验 Set-Cookie 的处理
    rewriteSetCookie: rewriteSetCookie,
    readConfig: readConfig,
    writeConfig: writeConfig,
    // 空间：`spaceKey` 是目录名规则，自测脚本要按它找目录
    spaceKey: space.spaceKey,
    userIdFromKey: space.userIdFromKey
};
