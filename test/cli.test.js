var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var net = require('net');
var { spawn, spawnSync } = require('node:child_process');

var dbModule = require('../lib/db');
var projectsRepo = require('../lib/db/repos/projects');
var apisRepo = require('../lib/db/repos/apis');

var CLI = path.join(__dirname, '..', 'bin', 'server');

/** 初始管理员密码走环境变量，免得每次跑测试都要去猜随机密码 */
var TEST_PASSWORD = 'test-pass';

/**
 * 所有启动 CLI 的地方都必须传 --db 指到临时目录 —— 默认库在 ~/.apiloop，
 * 测试绝不能碰到它。
 */
function runCli(args, cwd, env) {
    return spawnSync(process.execPath, [CLI].concat(args), {
        cwd: cwd || process.cwd(),
        encoding: 'utf-8',
        timeout: 20000,
        env: Object.assign({}, process.env, { APILOOP_ADMIN_PASSWORD: TEST_PASSWORD }, env || {})
    });
}

function tempDir() {
    // realpath 不能省：macOS 上 /var 是指向 /private/var 的软链，而子进程里的
    // process.cwd() 给的是真实路径。不解析的话按 source_dir 查项目永远查不到。
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'apiloop-cli-')));
}

/** 每个用例一个独立的库文件 */
function tempDb(dir) {
    return path.join(dir, 'data.db');
}

function getFreePort() {
    return new Promise(function (resolve, reject) {
        var server = net.createServer();
        server.on('error', reject);
        server.listen(0, function () {
            var port = server.address().port;
            server.close(function () { resolve(port); });
        });
    });
}

/** 管理台接口现在要登录，所以探活打的是静态页而不是 /meta */
async function waitForPage(base, timeoutMs) {
    var deadline = Date.now() + (timeoutMs || 15000);
    while (Date.now() < deadline) {
        try {
            var res = await fetch(base + '/index.html');
            if (res.ok) return;
        } catch (err) {
            // 还没起来，继续等
        }
        await new Promise(function (resolve) { setTimeout(resolve, 120); });
    }
    throw new Error('等待服务启动超时: ' + base);
}

async function login(base, username, password) {
    var res = await fetch(base + '/__admin/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username, password: password })
    });
    assert.strictEqual(res.status, 200, '登录应成功');
    return String(res.headers.get('set-cookie') || '').split(';')[0];
}

function adminCall(base, cookie, method, url, body) {
    return fetch(base + '/__admin/api' + url, {
        method: method,
        headers: { 'Content-Type': 'application/json', 'Cookie': cookie },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
}

test('无参数时打印帮助并以 0 退出', function () {
    var result = runCli([]);
    assert.strictEqual(result.status, 0);
    assert.ok(result.stderr.indexOf('Usage') > -1, '帮助应该输出 usage');
    assert.ok(result.stderr.indexOf('web') > -1, '帮助里应列出 web 命令');
    assert.ok(result.stderr.indexOf('user') > -1, '帮助里应列出 user 命令');
});

test('--help 以 0 退出', function () {
    var result = runCli(['--help']);
    assert.strictEqual(result.status, 0);
});

test('web --help 列出 --db 与 --config 示例', function () {
    var result = runCli(['web', '--help']);
    assert.strictEqual(result.status, 0);
    assert.ok(result.stdout.indexOf('--config') > -1);
    assert.ok(result.stdout.indexOf('--db') > -1);
    assert.ok(result.stdout.indexOf('/index.html') > -1, '帮助里应给出默认入口');
});

test('非法命令以 1 退出并打印帮助', function () {
    var result = runCli(['bogus']);
    assert.strictEqual(result.status, 1);
    assert.ok(result.stderr.indexOf('Usage') > -1);
});

test('init：生成 router.js 并把示例接口灌进项目', function () {
    var dir = tempDir();
    var dbPath = tempDb(dir);

    var result = runCli(['init', '--db', dbPath], dir);
    assert.strictEqual(result.status, 0, result.stderr);

    assert.ok(fs.existsSync(path.join(dir, 'router.js')));
    assert.strictEqual(fs.existsSync(path.join(dir, 'index.html')), false,
        '不该再生成 index.html —— web 模式下它会被管理台盖住');
    assert.strictEqual(fs.existsSync(path.join(dir, 'routes.db')), false,
        '不该在 cwd 生成 routes.db —— 库是全局一份的');

    var handle = dbModule.open(dbPath);
    var project = projectsRepo.getBySourceDir(handle, dir);
    assert.ok(project, 'init 应建出绑定到当前目录的项目');
    assert.strictEqual(projectsRepo.list(handle).length, 1, '只应有一个项目');

    var routes = apisRepo.list(handle, project.id);
    assert.ok(routes.length >= 3, '项目里应有示例接口');
    // 注意 /api/users 上挂了 GET 和 POST 两条，所以必须连方法一起比
    assert.strictEqual(routes.filter(function (item) {
        return item.method === 'GET' && item.mockPath === '/api/users';
    }).length, 1, '应有 GET /api/users');
    handle.close();

    // 再跑一次不应覆盖已有接口
    var second = runCli(['init', '--db', dbPath], dir);
    assert.strictEqual(second.status, 0);
    var again = dbModule.open(dbPath);
    assert.strictEqual(apisRepo.list(again, project.id).length, routes.length, '重复 init 不应冲掉接口');
    again.close();
});

test('web：登录后管理台 API 与 mock 路由都可用', async function () {
    var dir = tempDir();
    var dbPath = tempDb(dir);
    assert.strictEqual(runCli(['init', '--db', dbPath], dir).status, 0);

    var port = await getFreePort();
    var child = spawn(process.execPath, [CLI, 'web', '--port', String(port), '--db', dbPath], {
        cwd: dir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: Object.assign({}, process.env, { APILOOP_ADMIN_PASSWORD: TEST_PASSWORD })
    });
    var output = '';
    child.stdout.on('data', function (chunk) { output += chunk; });
    child.stderr.on('data', function (chunk) { output += chunk; });

    var base = 'http://127.0.0.1:' + port;
    try {
        await waitForPage(base);

        // 默认入口是 /index.html，访问根路径自动跳过去
        var root = await fetch(base, { redirect: 'manual' });
        assert.strictEqual(root.status, 302);
        assert.strictEqual(root.headers.get('location'), '/index.html');

        var page = await fetch(base + '/index.html');
        assert.strictEqual(page.status, 200);
        assert.ok((await page.text()).indexOf('app.js') > -1);

        // 老地址 /__mock 已经下线
        assert.strictEqual((await fetch(base + '/__mock/')).status, 404, '老地址应该不再挂管理台');

        // 管理台接口要登录
        var anonymous = await fetch(base + '/__admin/api/meta');
        assert.strictEqual(anonymous.status, 401, '未登录应被挡在门外');

        var cookie = await login(base, 'admin', TEST_PASSWORD);

        var meta = await (await adminCall(base, cookie, 'GET', '/meta')).json();
        assert.strictEqual(meta.ok, true);
        assert.ok(meta.placeholders.length > 0);
        assert.strictEqual(meta.user.username, 'admin');
        assert.ok(meta.project && meta.project.name, 'meta 应带上当前项目');

        // init 灌的示例接口挂在根项目下
        var users = await fetch(base + '/api/users?page=2');
        assert.strictEqual(users.status, 200);
        var body = await users.json();
        assert.strictEqual(body.data.list.length, 3);
        assert.strictEqual(body.data.page, '2', 'query 回显应生效');

        assert.strictEqual((await (await fetch(base + '/api/users/99')).json()).data.id, '99', '路径参数');

        var groups = await (await adminCall(base, cookie, 'GET', '/groups')).json();
        var sample = groups.groups.filter(function (g) { return g.name === '用户'; })[0];
        assert.ok(sample, '应能读到 init 生成的示例分组');
        assert.strictEqual(sample.count, 3);

        // 新建接口立即生效
        var created = await adminCall(base, cookie, 'POST', '/routes', {
            route: { method: 'GET', path: '/api/added', response: '{"added":true}' }
        });
        assert.strictEqual((await created.json()).ok, true);
        assert.strictEqual((await fetch(base + '/api/added')).status, 200);

        assert.ok(output.indexOf('管理台已启动') > -1, '启动日志应包含管理台地址，实际输出：' + output);
    } finally {
        child.kill('SIGTERM');
    }
});

test('start：会自动导入旧的 routes.json 并供出接口', async function () {
    var dir = tempDir();
    var dbPath = tempDb(dir);
    fs.writeFileSync(path.join(dir, 'routes.json'), JSON.stringify({
        version: 1,
        routes: [{
            id: 'r1', name: '来自配置', enabled: true, method: 'GET', path: '/api/configured',
            status: 200, delay: 0, cors: false, headers: [], query: [], body: [],
            responseType: 'json', response: '{"source":"routes.json"}'
        }]
    }));

    var port = await getFreePort();
    var child = spawn(process.execPath, [CLI, 'start', '--port', String(port), '--db', dbPath], {
        cwd: dir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: Object.assign({}, process.env, { APILOOP_ADMIN_PASSWORD: TEST_PASSWORD })
    });

    var base = 'http://127.0.0.1:' + port;
    try {
        var deadline = Date.now() + 15000;
        var body = null;
        while (Date.now() < deadline) {
            try {
                var res = await fetch(base + '/api/configured');
                if (res.status === 200) {
                    body = await res.json();
                    break;
                }
            } catch (err) {
                // 继续等
            }
            await new Promise(function (resolve) { setTimeout(resolve, 120); });
        }
        assert.ok(body, '旧 routes.json 应被自动导入并生效');
        assert.strictEqual(body.source, 'routes.json');

        // 原文件保留不动
        assert.ok(fs.existsSync(path.join(dir, 'routes.json')), '原 routes.json 不该被删');

        // 导入来源记下来了，重启不会重复导入
        var handle = dbModule.open(dbPath);
        assert.strictEqual(projectsRepo.list(handle).length, 1, '不应重复导入产生第二个项目');
        handle.close();

        // start 模式不挂管理台
        var admin = await fetch(base + '/__admin/api/meta');
        assert.strictEqual(admin.status, 404);
    } finally {
        child.kill('SIGTERM');
    }
});

test('端口被占用时给出可读提示并退出', async function () {
    // 注意：macOS 允许 127.0.0.1:port 与 0.0.0.0:port 共存。服务默认监听
    // 127.0.0.1，所以占用方必须也绑在 127.0.0.1 上才占得住；绑通配地址的话
    // 两个 socket 各占一份，服务照样能起来，测不到占用分支。
    var blocker = net.createServer();
    var port = await new Promise(function (resolve) {
        blocker.listen(0, '127.0.0.1', function () { resolve(blocker.address().port); });
    });

    var dir = tempDir();
    try {
        var result = runCli(['start', '--port', String(port), '--db', tempDb(dir)], dir);
        assert.strictEqual(result.status, 1, '应当以退出码 1 结束，实际 stdout=' +
            result.stdout + ' stderr=' + result.stderr);
        assert.ok((result.stdout + result.stderr).indexOf(String(port)) > -1, '提示里应带上端口号');
    } finally {
        blocker.close();
    }
});
