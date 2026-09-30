var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var net = require('net');
var { spawn, spawnSync } = require('node:child_process');

var CLI = path.join(__dirname, '..', 'bin', 'server');

function runCli(args, cwd) {
    return spawnSync(process.execPath, [CLI].concat(args), {
        cwd: cwd || process.cwd(),
        encoding: 'utf-8',
        timeout: 20000
    });
}

function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'server-mock-cli-'));
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

async function waitForServer(base, timeoutMs) {
    var deadline = Date.now() + (timeoutMs || 10000);
    while (Date.now() < deadline) {
        try {
            var res = await fetch(base + '/__admin/api/meta');
            if (res.ok) return await res.json();
        } catch (err) {
            // 还没起来，继续等
        }
        await new Promise(function (resolve) { setTimeout(resolve, 120); });
    }
    throw new Error('等待服务启动超时: ' + base);
}

test('无参数时打印帮助并以 0 退出', function () {
    var result = runCli([]);
    assert.strictEqual(result.status, 0);
    assert.ok(result.stderr.indexOf('Usage') > -1, '帮助应该输出 usage');
    assert.ok(result.stderr.indexOf('web') > -1, '帮助里应列出 web 命令');
});

test('--help 以 0 退出', function () {
    var result = runCli(['--help']);
    assert.strictEqual(result.status, 0);
});

test('web --help 列出 --config 示例', function () {
    var result = runCli(['web', '--help']);
    assert.strictEqual(result.status, 0);
    assert.ok(result.stdout.indexOf('--config') > -1);
    assert.ok(result.stdout.indexOf('/index.html') > -1, '帮助里应给出默认入口');
});

test('非法命令以 1 退出并打印帮助', function () {
    var result = runCli(['bogus']);
    assert.strictEqual(result.status, 1);
    assert.ok(result.stderr.indexOf('Usage') > -1);
});

test('init 生成 router.js / index.html / routes.json', function () {
    var dir = tempDir();
    var result = runCli(['init'], dir);
    assert.strictEqual(result.status, 0, result.stderr);

    assert.ok(fs.existsSync(path.join(dir, 'router.js')));
    assert.ok(fs.existsSync(path.join(dir, 'index.html')));

    var configPath = path.join(dir, 'routes.json');
    assert.ok(fs.existsSync(configPath), 'init 应生成 routes.json');
    var doc = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    assert.strictEqual(doc.version, 1);
    assert.ok(doc.routes.length >= 3);
    assert.ok(Array.isArray(doc.groups) && doc.groups.indexOf('用户') > -1, 'init 应声明示例分组');
    assert.strictEqual(fs.existsSync(path.join(dir, 'npm-debug.log')), false, '不应再拷贝 npm-debug.log');

    // 再跑一次不应覆盖已有配置
    var before = fs.readFileSync(configPath, 'utf-8');
    var second = runCli(['init'], dir);
    assert.strictEqual(second.status, 0);
    assert.strictEqual(fs.readFileSync(configPath, 'utf-8'), before);
});

test('web：启动管理台，API 与 mock 路由都可用', async function () {
    var dir = tempDir();
    assert.strictEqual(runCli(['init'], dir).status, 0);
    var port = await getFreePort();

    var child = spawn(process.execPath, [CLI, 'web', '--port', String(port)], {
        cwd: dir,
        stdio: ['ignore', 'pipe', 'pipe']
    });
    var output = '';
    child.stdout.on('data', function (chunk) { output += chunk; });
    child.stderr.on('data', function (chunk) { output += chunk; });

    var base = 'http://127.0.0.1:' + port;
    try {
        var meta = await waitForServer(base);
        assert.strictEqual(meta.ok, true);
        assert.ok(meta.placeholders.length > 0);

        // 老地址 /__mock 已经下线
        var legacy = await fetch(base + '/__mock/');
        assert.strictEqual(legacy.status, 404, '老地址应该不再挂管理台');

        // 默认入口是 /index.html，访问根路径自动跳过去
        var defaultPage = await fetch(base + '/index.html');
        assert.strictEqual(defaultPage.status, 200);
        assert.ok((await defaultPage.text()).indexOf('server-mock 管理台') > -1);

        var root = await fetch(base, { redirect: 'manual' });
        assert.strictEqual(root.status, 302);
        assert.strictEqual(root.headers.get('location'), '/index.html');

        // routes.json 里的示例接口
        var users = await fetch(base + '/api/users?page=2');
        assert.strictEqual(users.status, 200);
        var body = await users.json();
        assert.strictEqual(body.data.list.length, 3);
        assert.strictEqual(body.data.page, '2', 'query 回显应生效');

        // 分组接口可用，且示例分组里正好是那 3 个接口
        var groups = await (await fetch(base + '/__admin/api/groups')).json();
        var sample = groups.groups.filter(function (g) { return g.name === '用户'; })[0];
        assert.ok(sample, '应能读到 init 生成的示例分组');
        assert.strictEqual(sample.count, 3);

        // 路径参数
        var detail = await fetch(base + '/api/users/99');
        assert.strictEqual((await detail.json()).data.id, '99');

        // 新建接口立即生效
        var created = await fetch(base + '/__admin/api/routes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ route: { method: 'GET', path: '/api/added', response: '{"added":true}' } })
        });
        assert.strictEqual((await created.json()).ok, true);
        assert.strictEqual((await fetch(base + '/api/added')).status, 200);

        assert.ok(output.indexOf('管理台已启动') > -1, '启动日志应包含管理台地址，实际输出：' + output);
    } finally {
        child.kill('SIGTERM');
    }
});

test('start：也会加载 routes.json（不需要 web 也能用配置好的接口）', async function () {
    var dir = tempDir();
    fs.writeFileSync(path.join(dir, 'routes.json'), JSON.stringify({
        version: 1,
        routes: [{
            id: 'r1', name: '来自配置', enabled: true, method: 'GET', path: '/api/configured',
            status: 200, delay: 0, cors: false, headers: [], query: [], body: [],
            responseType: 'json', response: '{"source":"routes.json"}'
        }]
    }));

    var port = await getFreePort();
    var child = spawn(process.execPath, [CLI, 'start', '--port', String(port)], {
        cwd: dir,
        stdio: ['ignore', 'pipe', 'pipe']
    });

    var base = 'http://127.0.0.1:' + port;
    try {
        var deadline = Date.now() + 10000;
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
        assert.ok(body, 'start 也应加载 routes.json 里的接口');
        assert.strictEqual(body.source, 'routes.json');

        // start 模式不挂管理台
        var admin = await fetch(base + '/__admin/api/meta');
        assert.strictEqual(admin.status, 404);
    } finally {
        child.kill('SIGTERM');
    }
});

test('端口被占用时给出可读提示并退出', async function () {
    // 注意：macOS 允许 127.0.0.1:port 与 0.0.0.0:port 共存，
    // 所以占用端口必须绑通配地址，否则服务真能起来，测不到占用分支
    var blocker = net.createServer();
    var port = await new Promise(function (resolve) {
        blocker.listen(0, function () { resolve(blocker.address().port); });
    });

    var dir = tempDir();
    try {
        var result = runCli(['start', '--port', String(port)], dir);
        assert.strictEqual(result.status, 1, '应当以退出码 1 结束，实际 stdout=' +
            result.stdout + ' stderr=' + result.stderr);
        assert.ok(result.stdout.indexOf('已被占用') > -1,
            '应提示端口占用，实际输出：' + result.stdout + result.stderr);
    } finally {
        blocker.close();
    }
});
