var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var express = require('express');
var bodyParser = require('body-parser');
var { once } = require('node:events');

var storeModule = require('../lib/routes-store');
var dbModule = require('../lib/db');
var projectsRepo = require('../lib/db/repos/projects');
var apisRepo = require('../lib/db/repos/apis');
var usersRepo = require('../lib/db/repos/users');
var auth = require('../lib/auth');
var examplesRepo = require('../lib/db/repos/examples');
var runtimeModule = require('../lib/mock-runtime');
var adminModule = require('../lib/admin');

var ctx = null;

test.before(async function () {
    var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apiloop-http-'));
    var handle = dbModule.open(path.join(dir, 'data.db'));
    var project = projectsRepo.create(handle, { name: '测试项目' });
    var store = storeModule.createStore({ handle: handle, projectId: project.id });
    store.load();
    store.startWatching();

    var app = express();

    // 管理台接口现在要登录，先建一个管理员
    usersRepo.create(handle, {
        username: 'tester',
        password_hash: auth.hashPassword('test-pass'),
        display_name: '测试员',
        role: 'admin'
    });
    // 和 command.js 启动时一样：没有 owner 的项目交给管理员（项目只有成员能看到）
    require('../lib/access').fillMissingOwners(handle, usersRepo.getByUsername(handle, 'tester').id);

    var admin = adminModule.createAdmin({ handle: handle, store: store, version: 'test' });
    app.use(admin.apiPath, admin.api);
    app.use(admin.rootStatic);
    app.get('/', function (req, res) { res.redirect(302, admin.defaultPage); });
    // 与 command.js 保持一致：body 解析排在管理台之后，只管 mock 接口
    app.use(bodyParser.json());
    app.use(bodyParser.urlencoded({ extended: true }));
    app.use(runtimeModule.createRuntime(store).middleware);

    var server = app.listen(0);
    await once(server, 'listening');

    var base = 'http://127.0.0.1:' + server.address().port;

    // 登录一次拿到 cookie，后面所有管理台请求都带上
    var loginResponse = await fetch(base + '/__admin/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'tester', password: 'test-pass' })
    });
    var cookie = String(loginResponse.headers.get('set-cookie') || '').split(';')[0];

    ctx = {
        store: store,
        handle: handle,
        project: project,
        server: server,
        dir: dir,
        base: base,
        cookie: cookie,
        api: function (method, url, body) {
            return fetch(ctx.base + '/__admin/api' + url, {
                method: method,
                headers: { 'Content-Type': 'application/json', 'Cookie': ctx.cookie },
                body: body === undefined ? undefined : JSON.stringify(body)
            }).then(function (res) {
                return res.json().then(function (json) { return { status: res.status, body: json }; });
            });
        },
        /**
         * 造一条能挂出去的 mock 数据。
         *
         * 旧版是一次 `POST /routes` 就完事，2.0 按契约第 3 节要走三步：
         * 建接口 → 建示例 → 打开 mock（没有示例时不允许打开）。
         */
        createRoute: async function (route) {
            var created = await ctx.api('POST', '/projects/' + ctx.project.id + '/apis', {
                api: {
                    name: route.name || '',
                    method: route.method || 'GET',
                    url: route.path || '',
                    mock: { delay: route.delay || 0, cors: route.cors === true }
                }
            });
            assert.strictEqual(created.status, 200, JSON.stringify(created.body));

            var apiId = created.body.api.id;
            var example = await ctx.api('POST', '/apis/' + apiId + '/examples', {
                example: {
                    name: '默认',
                    status: route.status === undefined ? 200 : route.status,
                    headers: route.headers || [],
                    body: route.response === undefined ? '' : route.response,
                    responseType: route.responseType || 'json'
                }
            });
            assert.strictEqual(example.status, 200, JSON.stringify(example.body));

            if (route.enabled !== false) {
                var enabled = await ctx.api('PUT', '/apis/' + apiId, { api: { mock: { enabled: true } } });
                assert.strictEqual(enabled.status, 200, JSON.stringify(enabled.body));
            }

            return { id: apiId, exampleId: example.body.example.id };
        }
    };
});

test.after(function () {
    if (!ctx) return;
    ctx.store.close();
    if (ctx.handle) ctx.handle.close();
    if (ctx.server) ctx.server.close();
});

test('老地址 /__mock 不再挂管理台页面', async function () {
    var res = await fetch(ctx.base + '/__mock/');
    assert.strictEqual(res.status, 404, '老地址应该已经下线');
});

test('默认入口是 /index.html，根路径 302 过去', async function () {
    var page = await fetch(ctx.base + '/index.html');
    assert.strictEqual(page.status, 200);

    var html = await page.text();
    assert.ok(html.indexOf('管理台') > -1, '新版管理台的标题里应包含「管理台」');

    // 前端产物挂在 /__apiloop/ 下，从页面里把真实文件名抠出来，逐个确认能取到
    var assets = html.match(/\/__apiloop\/[^"']+/g) || [];
    assert.ok(assets.length >= 1, '页面里应引用 /__apiloop/ 下的资源');
    for (var asset of assets) {
        var assetResponse = await fetch(ctx.base + asset);
        assert.strictEqual(assetResponse.status, 200, asset + ' 应该能访问');
    }

    var root = await fetch(ctx.base + '/', { redirect: 'manual' });
    assert.strictEqual(root.status, 302);
    assert.strictEqual(root.headers.get('location'), adminModule.DEFAULT_PAGE);
});

test('默认页面优先于使用者自己的 index.html', async function () {
    // 根目录挂的 static 一旦有 index 选项就会把 / 变成 200 目录首页，跳转失效。
    // 这里直接断言 / 不会返回 HTML，确保 index:false 没被人改掉。
    var root = await fetch(ctx.base + '/', { redirect: 'manual' });
    assert.notStrictEqual(root.status, 200, '/ 不应该直接返回页面，而要跳转');
});

test('meta 返回占位符 / 字段类型 / 模板', async function () {
    var res = await ctx.api('GET', '/meta');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ok, true);
    assert.strictEqual(res.body.configPath, ctx.store.filePath);
    assert.ok(res.body.placeholders.length >= 30);
    assert.ok(res.body.fieldTypes.length >= 10);
    assert.ok(res.body.templates.length >= 5);
    assert.ok(res.body.methods.indexOf('PATCH') > -1);

    var item = res.body.placeholders[0];
    assert.ok(item.name && item.group && item.desc && item.example);
    var number = res.body.fieldTypes.filter(function (type) { return type.value === 'number'; })[0];
    assert.strictEqual(number.sample, '42', '入参示例值应是真实值而不是 Mock 表达式');
    assert.ok(number.placeholder.indexOf('{{@') === 0);
});

test('新建接口立刻生效，无需重启', async function () {
    var route = await ctx.createRoute({
        name: 'Ping', method: 'GET', path: '/api/ping',
        response: '{"pong":true,"n":"{{@int(1,5)}}"}'
    });
    var res = await fetch(ctx.base + '/api/ping');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('content-type').indexOf('application/json'), 0);
    var body = JSON.parse(await res.text());
    assert.strictEqual(body.pong, true);
    assert.strictEqual(typeof body.n, 'number');
    ctx.pingId = route.id;
    ctx.pingExampleId = route.exampleId;
});

test('状态码 / 自定义头 / CORS / 延时 / OPTIONS 预检', async function () {
    var start = Date.now();
    // 延时和跨域挂在接口上，状态码和响应头属于「示例」—— 契约第 3 节就是这么分的
    var patchedApi = await ctx.api('PUT', '/apis/' + ctx.pingId, {
        api: { name: 'Ping', mock: { delay: 120, cors: true } }
    });
    assert.strictEqual(patchedApi.status, 200, JSON.stringify(patchedApi.body));

    var patchedExample = await ctx.api('PUT', '/examples/' + ctx.pingExampleId, {
        example: { status: 201, headers: [{ key: 'X-Custom', value: 'hi' }], body: '{"pong":true}' }
    });
    assert.strictEqual(patchedExample.status, 200, JSON.stringify(patchedExample.body));

    var res = await fetch(ctx.base + '/api/ping');
    var elapsed = Date.now() - start;

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.headers.get('x-custom'), 'hi');
    assert.strictEqual(res.headers.get('access-control-allow-origin'), '*');
    assert.ok(elapsed >= 100, '延时 120ms 应该生效，实际 ' + elapsed + 'ms');
    assert.ok(elapsed < 3000, '延时不应过长，实际 ' + elapsed + 'ms');

    var preflight = await fetch(ctx.base + '/api/ping', { method: 'OPTIONS' });
    assert.strictEqual(preflight.status, 204);
    assert.strictEqual(preflight.headers.get('access-control-allow-methods'), '*');
});

test('停用接口后返回 404', async function () {
    var off = await ctx.api('PUT', '/apis/' + ctx.pingId, { api: { mock: { enabled: false } } });
    assert.strictEqual(off.status, 200, JSON.stringify(off.body));
    assert.strictEqual((await fetch(ctx.base + '/api/ping')).status, 404);

    // 复原成 200（上面那条用例把示例改成了 201）
    await ctx.api('PUT', '/examples/' + ctx.pingExampleId, { example: { status: 200 } });
    await ctx.api('PUT', '/apis/' + ctx.pingId, { api: { mock: { enabled: true, delay: 0 } } });
    assert.strictEqual((await fetch(ctx.base + '/api/ping')).status, 200);
});

test('路径参数与请求回显', async function () {
    await ctx.createRoute({
        name: '详情', method: 'GET', path: '/api/users/:id',
        response: '{"id":"{{@params(id)}}","q":"{{@query(k)}}"}'
    });
    var body = await (await fetch(ctx.base + '/api/users/42?k=v')).json();
    assert.strictEqual(body.id, '42');
    assert.strictEqual(body.q, 'v');
});

test('POST body 回显 + repeat 列表 + JSON 修复', async function () {
    await ctx.createRoute({
        name: '建单', method: 'POST', path: '/api/orders',
        response: '{"name":"{{@body(name)}}","list":[{{@repeat(3)}}{"id":"{{@id}}"}{{/repeat}}]}'
    });
    var res = await fetch(ctx.base + '/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '张三' })
    });
    var body = await res.json();
    assert.strictEqual(body.name, '张三');
    assert.strictEqual(body.list.length, 3);
    assert.strictEqual(typeof body.list[0].id, 'number');
});

test('文本与 HTML 响应类型', async function () {
    await ctx.createRoute({
        name: '纯文本', method: 'GET', path: '/api/text',
        responseType: 'text', response: 'hello {{@query(who)}}'
    });
    var res = await fetch(ctx.base + '/api/text?who=world');
    assert.strictEqual(res.headers.get('content-type').indexOf('text/plain'), 0);
    assert.strictEqual(await res.text(), 'hello world');

    await ctx.createRoute({
        name: '页面', method: 'GET', path: '/api/page',
        responseType: 'html', response: '<h1>{{@cname}}</h1>'
    });
    var htmlRes = await fetch(ctx.base + '/api/page');
    assert.strictEqual(htmlRes.headers.get('content-type').indexOf('text/html'), 0);
    assert.ok(/^<h1>.+<\/h1>$/.test(await htmlRes.text()));
});

test('预览：渲染结果、未知占位符警告、非法 JSON 报错', async function () {
    var good = await ctx.api('POST', '/preview', {
        route: { responseType: 'json', response: '{"a":"{{@cname}}","b":"{{@int(1,3)}}"}' }
    });
    assert.strictEqual(good.body.jsonValid, true);
    assert.deepStrictEqual(good.body.warnings, []);

    var withWarning = await ctx.api('POST', '/preview', {
        route: { responseType: 'json', response: '{"a":"{{@nmae}}"}' }
    });
    assert.deepStrictEqual(withWarning.body.warnings, ['nmae']);

    var bad = await ctx.api('POST', '/preview', {
        route: { responseType: 'json', response: '{"a":1,,}' }
    });
    assert.strictEqual(bad.body.jsonValid, false);
    assert.ok(bad.body.jsonError);

    var draft = await ctx.api('POST', '/preview', { route: { path: '', responseType: 'json', response: '{}' } });
    assert.strictEqual(draft.status, 200, '草稿不合法也要能预览');
});

test('导入 cURL 与 OpenAPI 并落库', async function () {
    var curl = await ctx.api('POST', '/import/curl', {
        text: "curl 'https://api.example.com/v1/goods/9?from=web' -X POST -H 'Content-Type: application/json' -d '{\"sku\":\"A-1\"}'"
    });
    assert.strictEqual(curl.body.routes.length, 1);
    assert.strictEqual(curl.body.routes[0].path, '/v1/goods/:id');

    var spec = {
        openapi: '3.0.0',
        paths: {
            '/api/spec/{id}': {
                get: {
                    summary: '规格详情',
                    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
                    responses: { '200': { content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' } } } } } } }
                }
            }
        }
    };
    var openapi = await ctx.api('POST', '/import/openapi', { text: JSON.stringify(spec) });
    assert.strictEqual(openapi.body.routes.length, 1);
    assert.strictEqual(openapi.body.routes[0].path, '/api/spec/:id');

    var added = await ctx.api('POST', '/projects/' + ctx.project.id + '/import/routes', {
        routes: curl.body.routes.concat(openapi.body.routes)
    });
    assert.strictEqual(added.body.apis.length, 2);

    var hit = await fetch(ctx.base + '/v1/goods/9?from=web', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"sku":"A-1"}'
    });
    assert.strictEqual(hit.status, 200);
    assert.strictEqual((await hit.json()).data.sku, 'A-1');

    var specHit = await fetch(ctx.base + '/api/spec/7');
    assert.strictEqual((await specHit.json()).ok !== undefined, true);

    var badCurl = await ctx.api('POST', '/import/curl', { text: 'curl -X GET' });
    assert.strictEqual(badCurl.status, 400);
    assert.ok(badCurl.body.error);
});

test('外部改数据库触发热更新', async function () {
    // 模拟外部改库：另开一个 handle 把接口写进同一个库文件。
    // 注意要连示例一起写 —— 按门面的规则 enabled = mockEnabled && 有示例，
    // 光有接口没有示例的话这条路由不会被挂出去。
    var other = dbModule.open(ctx.handle.file);
    var external = apisRepo.insert(other, ctx.store.projectId, {
        name: '外部接口', method: 'GET', url: '/api/from-db', mockPath: '/api/from-db'
    });
    var externalExample = examplesRepo.insert(other, external.id, {
        name: '默认', status: 200, body: '{"from":"db"}', responseType: 'json'
    });
    apisRepo.update(other, external.id, { mockExampleId: externalExample.id });
    other.close();

    var deadline = Date.now() + 5000;
    var ok = false;
    while (Date.now() < deadline) {
        var res = await fetch(ctx.base + '/api/from-db');
        if (res.status === 200) {
            assert.strictEqual((await res.json()).from, 'db');
            ok = true;
            break;
        }
        await new Promise(function (resolve) { setTimeout(resolve, 100); });
    }
    assert.ok(ok, '外部改库后应自动热更新');
});

test('删除接口后返回 404', async function () {
    var res = await ctx.api('DELETE', '/apis/' + ctx.pingId);
    assert.strictEqual(res.body.ok, true);
    assert.strictEqual((await fetch(ctx.base + '/api/ping')).status, 404);
    var again = await ctx.api('DELETE', '/apis/' + ctx.pingId);
    assert.strictEqual(again.status, 404);
});

test('校验失败返回 400 且带可读错误', async function () {
    // mock 路径必须是 Express 能编译的（括号不成对就不行）。这条挡在写入层，
    // 因为坏路径进了热更新会在定时器回调里把进程带走。
    var badPath = await ctx.api('POST', '/projects/' + ctx.project.id + '/apis', {
        api: { url: '/api/ok', mock: { path: '/api/:id(' } }
    });
    assert.strictEqual(badPath.status, 400);
    assert.ok(badPath.body.error.indexOf('mock 路径不合法') > -1, badPath.body.error);

    var method = await ctx.api('POST', '/projects/' + ctx.project.id + '/apis', {
        api: { url: '/a', method: 'FETCH' }
    });
    assert.strictEqual(method.status, 400);

    // 示例的状态码越界会让 mock 运行时的 res.status() 抛错，同样挡在入口。
    // （上面那条用例已经把 Ping 删掉了，这里现建一个接口来试）
    var holder = await ctx.api('POST', '/projects/' + ctx.project.id + '/apis', {
        api: { url: '/api/holder' }
    });
    assert.strictEqual(holder.status, 200, JSON.stringify(holder.body));

    var badStatus = await ctx.api('POST', '/apis/' + holder.body.api.id + '/examples', {
        example: { status: 999 }
    });
    assert.strictEqual(badStatus.status, 400);
    assert.ok(badStatus.body.error.indexOf('100~599') > -1, badStatus.body.error);
});

test('未知管理台接口返回 JSON 404', async function () {
    var res = await ctx.api('GET', '/not-exist');
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.body.ok, false);
});

/* ------------------------------------------------ 目录：契约第 3 节的树接口 */

test('目录接口：新建 / 重名报错 / 移动接口进去', async function () {
    var created = await ctx.api('POST', '/projects/' + ctx.project.id + '/folders', { name: '订单管理' });
    assert.strictEqual(created.status, 200);
    assert.strictEqual(created.body.folder.name, '订单管理');

    var dup = await ctx.api('POST', '/projects/' + ctx.project.id + '/folders', { name: '订单管理' });
    assert.strictEqual(dup.status, 400);
    assert.ok(dup.body.error.indexOf('已存在') > -1, dup.body.error);

    var empty = await ctx.api('POST', '/projects/' + ctx.project.id + '/folders', { name: '   ' });
    assert.strictEqual(empty.status, 400);

    var g1 = await ctx.createRoute({ name: 'G1', method: 'GET', path: '/api/g1', response: '{}' });
    var g2 = await ctx.createRoute({ name: 'G2', method: 'GET', path: '/api/g2', response: '{}' });

    // 目录树里能看到这两个接口
    var tree = await ctx.api('GET', '/projects/' + ctx.project.id + '/tree');
    assert.strictEqual(tree.status, 200);
    assert.ok(tree.body.folders.some(function (f) { return f.id === created.body.folder.id; }));

    // 把接口移进目录
    var moved = await ctx.api('POST', '/projects/' + ctx.project.id + '/move', {
        kind: 'api', id: g1.id, parentId: created.body.folder.id, index: 0
    });
    assert.strictEqual(moved.status, 200, JSON.stringify(moved.body));
    assert.strictEqual(moved.body.apis.filter(function (a) { return a.id === g1.id; })[0].folderId,
        created.body.folder.id);

    // 删目录（默认 move）：接口保留、落到父级
    var removed = await ctx.api('DELETE', '/folders/' + created.body.folder.id);
    assert.strictEqual(removed.status, 200);
    var after = await ctx.api('GET', '/apis/' + g1.id);
    assert.strictEqual(after.body.api.folderId, null, 'move 模式不应删接口');

    // 删目录（delete）：连接口一起删
    var second = await ctx.api('POST', '/projects/' + ctx.project.id + '/folders', { name: '待删目录' });
    await ctx.api('POST', '/projects/' + ctx.project.id + '/move', {
        kind: 'api', id: g2.id, parentId: second.body.folder.id, index: 0
    });
    var hard = await ctx.api('DELETE', '/folders/' + second.body.folder.id + '?apis=delete');
    assert.strictEqual(hard.status, 200);
    assert.strictEqual((await ctx.api('GET', '/apis/' + g2.id)).status, 404, '接口应一起被删');
    assert.strictEqual((await fetch(ctx.base + '/api/g2')).status, 404, '被删的接口应立刻失效');
});
