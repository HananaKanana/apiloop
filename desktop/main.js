/**
 * apiloop 桌面版外壳（D0 技术验证）。
 *
 * 两种运行方式：
 *   1. **正常启动**（`electron .`）：挑一个空闲端口 → 在本进程里跑
 *      `lib/command.js` 起服务 → 开窗口加载 `http://127.0.0.1:<port>/`。
 *   2. **自检**（`electron . --self-check`）：不开窗口、不起服务，把 D0 要验证的
 *      几项关键技术逐条跑一遍，结果以**一行 JSON** 打到 stdout，退出码 0/1。
 *
 * 自检为什么必须存在：Electron 自带的 Node 和系统 Node **不是一份东西**，
 * `node:sqlite` 要求 Node ≥ 22.13；而 QuickJS 的 wasm 打包后是在 `app.asar` 里，
 * 能不能读出来也只有**打包后的程序**说了算。这两件事在开发机上「看着没问题」
 * 不算数，所以自检必须在两种形态下都能跑同一份代码。
 *
 * 自检用到的自签名证书是 `scripts/fixtures/throwaway-*.pem`：只是给本地探针服务
 * 用的，没有任何安全价值（本来就该被客户端拒绝——这恰恰是要验的那件事）。
 */

'use strict';

var fs = require('fs');
var net = require('net');
var os = require('os');
var path = require('path');
var http = require('http');
var https = require('https');

var { app, BrowserWindow, dialog } = require('electron');

var SELF_CHECK = process.argv.indexOf('--self-check') > -1;

/**
 * 服务端代码在哪：**两种形态下都是 `__dirname/app`**。
 *
 * - 开发时 `__dirname` 是 `desktop/`，也就是 `node scripts/stage.js` 生成的 `desktop/app/`；
 * - 打包后 `__dirname` 是 `.../Resources/app.asar`，于是这里是 `app.asar/app/`。
 *   服务端代码确实在 asar 里面（`asar: true` 把它打进去了，磁盘上并没有
 *   `Resources/app/` 这个目录），Electron 的 fs 会照常读 asar；`asarUnpack` 出来的
 *   文件（QuickJS 的 wasm）Electron 会自动转到 `app.asar.unpacked`。
 *
 * 所以不要再按 `process.resourcesPath/app` 找 —— 那样打包后必然找不到。
 */
var APP_ROOT = path.join(__dirname, 'app');

var SERVER_ENTRY = path.join(APP_ROOT, 'lib', 'command.js');

/** 从应用目录里 require 服务端模块（而不是外层仓库的） */
function serverModule(rel) {
    return require(path.join(APP_ROOT, rel));
}

function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

/* ------------------------------------------------------------------ 端口 */

/**
 * 让系统分配一个空闲端口：监听 0，读出端口号，然后关掉。
 * 不能写死 8080 —— 用户本机很可能已经有别的服务占着。
 */
function freePort() {
    return new Promise(function (resolve, reject) {
        var probe = net.createServer();
        probe.unref();
        probe.on('error', reject);
        probe.listen(0, '127.0.0.1', function () {
            var port = probe.address().port;
            probe.close(function () { resolve(port); });
        });
    });
}

/* ------------------------------------------------------------------ 正常启动 */

function probeServer(port) {
    return new Promise(function (resolve) {
        var req = http.get({ host: '127.0.0.1', port: port, path: '/index.html', timeout: 1000 },
            function (res) {
                res.resume();
                resolve(res.statusCode === 200);
            });
        req.on('error', function () { resolve(false); });
        req.on('timeout', function () { req.destroy(); resolve(false); });
    });
}

/** 服务是 listen 之后才可用的，窗口不能抢在前面打开 —— 否则会先闪一个错误页 */
async function waitForServer(port) {
    for (var i = 0; i < 60; i++) {
        if (await probeServer(port)) return true;
        await sleep(100);
    }
    return false;
}

function createWindow(port) {
    var win = new BrowserWindow({
        width: 1360,
        height: 900,
        minWidth: 1000,
        minHeight: 640,
        title: 'apiloop',
        backgroundColor: '#ffffff',
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    /*
     * 页面上有没保存的修改时，前端会在 beforeunload 里拦一下（浏览器会弹「确定离开吗」）。
     * Electron 不弹这个框，而是**悄悄取消关闭** —— 表现就是关窗口、⌘Q 都没反应，程序关不掉。
     * 这里接住 will-prevent-unload，自己弹一个系统对话框；选「仍然退出」就放行。
     */
    win.webContents.on('will-prevent-unload', function (event) {
        var choice = dialog.showMessageBoxSync(win, {
            type: 'warning',
            buttons: ['仍然退出', '取消'],
            defaultId: 1,
            cancelId: 1,
            title: 'apiloop',
            message: '有没保存的修改',
            detail: '有标签页里的修改还没保存，退出后这些修改会丢失。确定要退出吗？'
        });
        if (choice === 0) event.preventDefault();
    });

    win.loadURL('http://127.0.0.1:' + port + '/');
    return win;
}

async function startShell() {
    var dataDir = app.getPath('userData');
    fs.mkdirSync(dataDir, { recursive: true });

    // 静态目录给一个空目录：command.js 里 public / views / router.js 都是相对
    // process.cwd() 找的，cwd 留在原地（打包后是 /）会把整个磁盘当静态目录挂出去。
    var staticDir = path.join(dataDir, 'static');
    fs.mkdirSync(staticDir, { recursive: true });
    process.chdir(staticDir);

    // 上传的文件、Cookie 之类也跟着落到用户目录（默认是 ~/.apiloop）。
    // 必须在 require 服务端之前设 —— lib/app-info.js 是在模块加载时读它的。
    process.env.APILOOP_HOME = dataDir;

    // 初始管理员密码固定下来：双击安装包进来的用户看不到控制台，
    // 随机密码打印在 stdout 里等于没有，登录页会直接卡住。
    // 只在库里一个用户都没有的时候生效（bootstrapAdmin 的判断），
    // 之后改密码走界面。D1 桌面模式不需要登录本地服务，这段会删掉。
    if (!process.env.APILOOP_ADMIN_PASSWORD) {
        process.env.APILOOP_ADMIN_PASSWORD = 'apiloop';
    }

    var port = await freePort();

    console.log('[apiloop] 数据目录：' + dataDir);
    console.log('[apiloop] 本地服务：http://127.0.0.1:' + port);

    require(SERVER_ENTRY)({
        command: 'web',
        args: {
            port: port,
            host: '127.0.0.1',
            db: path.join(dataDir, 'apiloop.db')
        }
    });

    var ready = await waitForServer(port);
    if (!ready) console.error('[apiloop] 本地服务没有在 6 秒内起来，窗口可能打不开');

    createWindow(port);
}

/* ------------------------------------------------------------------ 自检 */

function spec(method, url) {
    return {
        method: method,
        url: url,
        params: { path: [], query: [], headers: [] },
        body: { mode: 'none' },
        auth: null
    };
}

function listen(server) {
    return new Promise(function (resolve, reject) {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', function () { resolve(server.address().port); });
    });
}

function close(server) {
    return new Promise(function (resolve) { server.close(function () { resolve(); }); });
}

async function checkRuntime() {
    return JSON.stringify({
        electron: process.versions.electron,
        node: process.versions.node,
        chrome: process.versions.chrome,
        v8: process.versions.v8
    });
}

/** 审阅重点 1：node:sqlite 在 Electron 主进程里能不能直接用（不加任何命令行参数） */
async function checkSqlite() {
    var sqlite = require('node:sqlite');
    var db = new sqlite.DatabaseSync(':memory:');

    db.exec('CREATE TABLE probe (id INTEGER PRIMARY KEY, name TEXT)');
    db.prepare('INSERT INTO probe (name) VALUES (?)').run('hello');
    var row = db.prepare('SELECT name FROM probe WHERE id = ?').get(1);
    db.close();

    if (!row || row.name !== 'hello') {
        throw new Error('读回来的不是 hello：' + JSON.stringify(row));
    }
    return 'DatabaseSync 可用：建表 / 写入 / 读回都通（无命令行参数）';
}

/** 审阅重点 2：QuickJS 的 wasm 能不能加载（打包后在 app.asar 里） */
async function checkQuickJs() {
    var sandbox = serverModule(path.join('lib', 'scripts', 'sandbox.js'));
    var prelude = serverModule(path.join('lib', 'scripts', 'prelude.js'));

    var wasmPath = null;
    try {
        wasmPath = require.resolve('@jitl/quickjs-wasmfile-release-asyncify/wasm', { paths: [APP_ROOT] });
    } catch (err) {
        wasmPath = '解析失败：' + err.message;
    }

    var result = await sandbox.execute({
        prelude: prelude.SOURCE,
        source: "pm.test('1+1', function () { if (1 + 1 !== 2) throw new Error('算错了'); });",
        input: {
            phase: 'prerequest',
            request: spec('GET', 'http://127.0.0.1/'),
            response: null,
            scopes: { project: {}, folders: [], environment: null, transient: {} },
            info: {}
        },
        api: {
            sendRequest: async function () { return '{}'; },
            log: function () { },
            now: function () { return Date.now(); }
        }
    });

    if (!result.ok) {
        throw new Error('沙箱执行失败：' + JSON.stringify(result.error));
    }
    var first = result.output && result.output.tests && result.output.tests[0];
    if (!first || first.passed !== true) {
        throw new Error('沙箱里 1+1 的断言没通过：' + JSON.stringify(result.output));
    }

    return 'wasm 加载成功并在沙箱里算出 1+1；wasm 路径：' + wasmPath;
}

/** 执行器：本地 HTTP */
async function checkExecutorHttp() {
    var executor = serverModule(path.join('lib', 'executor.js'));

    var server = http.createServer(function (req, res) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true,"via":"http"}');
    });
    var port = await listen(server);

    try {
        var result = await executor.execute(spec('GET', 'http://127.0.0.1:' + port + '/probe'), {
            timeoutMs: 5000,
            fileRoots: []
        });
        if (result.error) throw new Error('执行器返回错误：' + JSON.stringify(result.error));
        if (!result.response || result.response.status !== 200) {
            throw new Error('状态码不对：' + JSON.stringify(result.response && result.response.status));
        }
        return 'GET 本地 HTTP → ' + result.response.status + '，body=' + JSON.stringify(result.response.body);
    } finally {
        await close(server);
    }
}

/**
 * 执行器：本地**自签名** HTTPS。
 *
 * 顺带把「证书校验归哪个选项管」钉死：跑两遍，一遍用默认选项（应该成功），
 * 一遍显式要求校验（`rejectUnauthorized: true`，应该失败）。
 */
async function checkExecutorHttps() {
    var executor = serverModule(path.join('lib', 'executor.js'));

    var fixtures = path.join(__dirname, 'scripts', 'fixtures');
    var server = https.createServer({
        key: fs.readFileSync(path.join(fixtures, 'throwaway-key.pem')),
        cert: fs.readFileSync(path.join(fixtures, 'throwaway-cert.pem'))
    }, function (req, res) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true,"via":"https-self-signed"}');
    });
    var port = await listen(server);

    try {
        var url = 'https://127.0.0.1:' + port + '/probe';

        var loose = await executor.execute(spec('GET', url), { timeoutMs: 5000, fileRoots: [] });
        if (loose.error) {
            throw new Error('默认选项下没拿到响应：' + JSON.stringify(loose.error));
        }
        if (!loose.response || loose.response.status !== 200) {
            throw new Error('默认选项下状态码不对：' + JSON.stringify(loose.response));
        }

        var strict = await executor.execute(spec('GET', url), {
            timeoutMs: 5000, fileRoots: [], rejectUnauthorized: true
        });
        if (strict.error === null || strict.error === undefined) {
            throw new Error('rejectUnauthorized:true 竟然也成功了，说明这个选项没在管证书校验');
        }

        return '默认拿到 ' + loose.response.status + '（执行器的 rejectUnauthorized 默认 false）；' +
            '显式 rejectUnauthorized:true 时如预期失败：' + strict.error.message;
    } finally {
        await close(server);
    }
}

/** 前置脚本：跑真实的脚本链，确认沙箱在 Electron 里能用 */
async function checkScript() {
    var runner = serverModule(path.join('lib', 'scripts', 'runner.js'));

    // environment 给一个空对象 = 「选中了环境」，这样 pm.environment.set 会被记进
    // 导出结果里；给 null 的话按契约它会落到「本次请求的临时变量」，导出里看不到。
    var chain = await runner.runChain('prerequest', [
        { source: 'probe', exec: "pm.environment.set('a', '1');" }
    ], {
        request: spec('GET', 'http://127.0.0.1/'),
        scopes: { project: {}, folders: [], environment: {}, transient: {} },
        sendRequest: async function () { return '{}'; }
    });

    if (chain.state.errors.length) {
        throw new Error('脚本报错：' + JSON.stringify(chain.state.errors));
    }
    var value = chain.state.variables.environment.set.a;
    if (value !== '1') {
        throw new Error("pm.environment.set('a','1') 没生效：" + JSON.stringify(chain.state.variables));
    }
    return "pm.environment.set('a','1') 生效，导出 " +
        JSON.stringify(chain.state.variables.environment.set);
}

var CHECKS = [
    { name: 'runtime', run: checkRuntime },
    { name: 'node:sqlite', run: checkSqlite },
    { name: 'quickjs-wasm', run: checkQuickJs },
    { name: 'executor-http-local', run: checkExecutorHttp },
    { name: 'executor-https-self-signed', run: checkExecutorHttps },
    { name: 'prerequest-script', run: checkScript }
];

async function runSelfCheck() {
    var items = [];

    for (var i = 0; i < CHECKS.length; i++) {
        var item = CHECKS[i];
        var entry = { name: item.name, ok: false, detail: null };
        try {
            entry.detail = await item.run();
            entry.ok = true;
        } catch (err) {
            entry.detail = (err && err.message) || String(err);
        }
        items.push(entry);
    }

    var payload = {
        ok: items.every(function (entry) { return entry.ok; }),
        packaged: app.isPackaged,
        platform: process.platform + '-' + process.arch,
        appRoot: APP_ROOT,
        versions: {
            electron: process.versions.electron,
            node: process.versions.node,
            chrome: process.versions.chrome
        },
        items: items
    };

    // 一行 JSON：调用方直接 grep / 交给 jq
    console.log(JSON.stringify(payload));
    return payload.ok ? 0 : 1;
}

/* ------------------------------------------------------------------ 入口 */

app.whenReady().then(async function () {
    if (SELF_CHECK) {
        var code = await runSelfCheck();
        app.exit(code);
        return;
    }

    if (!fs.existsSync(SERVER_ENTRY)) {
        console.error('[apiloop] 找不到服务端代码：' + SERVER_ENTRY +
            '\n  开发模式下先跑 `node scripts/stage.js` 生成 desktop/app/');
        app.exit(1);
        return;
    }

    try {
        await startShell();
    } catch (err) {
        console.error('[apiloop] 启动失败：' + ((err && err.stack) || err));
        app.exit(1);
    }
});

app.on('window-all-closed', function () {
    app.quit();
});
