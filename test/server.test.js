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
var foldersRepo = require('../lib/db/repos/folders');
var examplesRepo = require('../lib/db/repos/examples');
var runtimeModule = require('../lib/mock-runtime');
var adminModule = require('../lib/admin');

var ctx = null;

test.before(async function () {
    var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-mock-http-'));
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
        createRoute: async function (route) {
            var res = await ctx.api('POST', '/routes', { route: route });
            assert.strictEqual(res.body.ok, true, JSON.stringify(res.body));
            return res.body.route;
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
});

test('状态码 / 自定义头 / CORS / 延时 / OPTIONS 预检', async function () {
    var start = Date.now();
    await ctx.api('PUT', '/routes/' + ctx.pingId, {
        route: {
            name: 'Ping', method: 'GET', path: '/api/ping',
            status: 201, delay: 120, cors: true,
            headers: [{ key: 'X-Custom', value: 'hi' }],
            response: '{"pong":true}'
        }
    });
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
    await ctx.api('PUT', '/routes/' + ctx.pingId, {
        route: { name: 'Ping', method: 'GET', path: '/api/ping', enabled: false, response: '{}' }
    });
    var res = await fetch(ctx.base + '/api/ping');
    assert.strictEqual(res.status, 404);

    await ctx.api('PUT', '/routes/' + ctx.pingId, {
        route: { name: 'Ping', method: 'GET', path: '/api/ping', enabled: true, response: '{"pong":true}', status: 200, delay: 0 }
    });
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

    var added = await ctx.api('POST', '/import/routes', {
        routes: curl.body.routes.concat(openapi.body.routes)
    });
    assert.strictEqual(added.body.routes.length, 2);

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

test('导出 JSON', async function () {
    var res = await ctx.api('GET', '/export');
    assert.strictEqual(res.body.filename, 'routes.json');
    var doc = JSON.parse(res.body.json);
    assert.strictEqual(doc.version, 1);
    assert.ok(doc.routes.length > 0);
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
    var res = await ctx.api('DELETE', '/routes/' + ctx.pingId);
    assert.strictEqual(res.body.ok, true);
    assert.strictEqual((await fetch(ctx.base + '/api/ping')).status, 404);
    var again = await ctx.api('DELETE', '/routes/' + ctx.pingId);
    assert.strictEqual(again.status, 404);
});

test('校验失败返回 400 且带可读错误', async function () {
    var reserved = await ctx.api('POST', '/routes', { route: { path: '/__admin/hack' } });
    assert.strictEqual(reserved.status, 400);
    assert.ok(reserved.body.error.indexOf('管理台') > -1);

    var method = await ctx.api('POST', '/routes', { route: { path: '/a', method: 'FETCH' } });
    assert.strictEqual(method.status, 400);

    var empty = await ctx.api('POST', '/routes', { route: { path: '' } });
    assert.strictEqual(empty.status, 400);
});

test('未知管理台接口返回 JSON 404', async function () {
    var res = await ctx.api('GET', '/not-exist');
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.body.ok, false);
});

/* ------------------------------------------------------------------ 分组管理 */

test('GET /routes 会带上分组列表', async function () {
    var res = await ctx.api('GET', '/routes');
    assert.strictEqual(res.body.ok, true);
    assert.ok(Array.isArray(res.body.groups), 'routes 响应应包含 groups');
    res.body.groups.forEach(function (group) {
        assert.strictEqual(typeof group.name, 'string');
        assert.strictEqual(typeof group.count, 'number');
    });
});

test('分组的 HTTP 接口：新建 / 列表 / 重命名 / 删除', async function () {
    // 新建（中文分组名要能正确编码解析）
    var created = await ctx.api('POST', '/groups', { name: '订单管理' });
    assert.strictEqual(created.status, 200);
    assert.strictEqual(created.body.group.name, '订单管理');
    assert.strictEqual(created.body.group.count, 0, '空分组也要能建');
    assert.ok(Array.isArray(created.body.routes), '分组写接口应回带最新 routes，省掉二次请求');

    // 空分组应该出现在列表里
    var list = await ctx.api('GET', '/groups');
    assert.ok(list.body.groups.map(function (g) { return g.name; }).indexOf('订单管理') > -1);

    // 重名报错
    var dup = await ctx.api('POST', '/groups', { name: '订单管理' });
    assert.strictEqual(dup.status, 400);
    assert.ok(dup.body.error.indexOf('已存在') > -1);

    var empty = await ctx.api('POST', '/groups', { name: '   ' });
    assert.strictEqual(empty.status, 400);

    // 往这个分组里放两个接口
    await ctx.createRoute({ name: 'G1', method: 'GET', path: '/api/g1', group: '订单管理', response: '{}' });
    await ctx.createRoute({ name: 'G2', method: 'GET', path: '/api/g2', group: '订单管理', response: '{}' });

    var withRoutes = await ctx.api('GET', '/groups');
    var found = withRoutes.body.groups.filter(function (g) { return g.name === '订单管理'; })[0];
    assert.strictEqual(found.count, 2);

    // 重命名，接口上的分组要跟着改（响应里直接就是新的，不用再 GET 一次）
    var renamed = await ctx.api('PUT', '/groups/' + encodeURIComponent('订单管理'), { name: '交易管理' });
    assert.strictEqual(renamed.status, 200);
    assert.strictEqual(renamed.body.moved, 2);
    var renamedInResponse = renamed.body.routes.filter(function (r) { return r.path === '/api/g1' || r.path === '/api/g2'; });
    assert.strictEqual(renamedInResponse.length, 2);
    renamedInResponse.forEach(function (route) {
        assert.strictEqual(route.group, '交易管理');
    });

    var afterRename = await ctx.api('GET', '/routes');
    var renamedRoutes = afterRename.body.routes.filter(function (r) { return r.path === '/api/g1' || r.path === '/api/g2'; });
    assert.strictEqual(renamedRoutes.length, 2);
    renamedRoutes.forEach(function (route) {
        assert.strictEqual(route.group, '交易管理');
    });

    // 重命名到已存在的分组要报错
    await ctx.api('POST', '/groups', { name: '另一个组' });
    var conflict = await ctx.api('PUT', '/groups/' + encodeURIComponent('交易管理'), { name: '另一个组' });
    assert.strictEqual(conflict.status, 400);

    // 删除分组（默认 move）：接口保留并落到未分组
    var removed = await ctx.api('DELETE', '/groups/' + encodeURIComponent('交易管理'));
    assert.strictEqual(removed.status, 200);
    assert.strictEqual(removed.body.removed.mode, 'move');
    assert.strictEqual(removed.body.removed.affected, 2);
    var afterRemove = await ctx.api('GET', '/routes');
    var kept = afterRemove.body.routes.filter(function (r) { return r.path === '/api/g1' || r.path === '/api/g2'; });
    assert.strictEqual(kept.length, 2, 'move 模式不应删接口');
    kept.forEach(function (route) { assert.strictEqual(route.group, ''); });

    // 删除分组（delete）：连接口一起删
    await ctx.createRoute({ name: 'G3', method: 'GET', path: '/api/g3', group: '另一个组', response: '{}' });
    var hard = await ctx.api('DELETE', '/groups/' + encodeURIComponent('另一个组') + '?routes=delete');
    assert.strictEqual(hard.body.removed.mode, 'delete');
    assert.strictEqual(hard.body.removed.affected, 1);
    var finalRoutes = await ctx.api('GET', '/routes');
    assert.strictEqual(finalRoutes.body.routes.filter(function (r) { return r.path === '/api/g3'; }).length, 0);
    assert.strictEqual((await fetch(ctx.base + '/api/g3')).status, 404, '被删的接口应立刻失效');

    // 删除不存在的分组
    var missing = await ctx.api('DELETE', '/groups/' + encodeURIComponent('查无此组'));
    assert.strictEqual(missing.status, 400);
    assert.ok(missing.body.error.indexOf('不存在') > -1);
});

test('分组排序接口', async function () {
    await ctx.api('POST', '/groups', { name: '排序甲' });
    await ctx.api('POST', '/groups', { name: '排序乙' });
    await ctx.api('POST', '/groups', { name: '排序丙' });

    var before = await ctx.api('GET', '/groups');
    var names = before.body.groups.map(function (g) { return g.name; });
    assert.ok(names.indexOf('排序甲') < names.indexOf('排序乙'));

    var reordered = await ctx.api('POST', '/groups/reorder', {
        names: ['排序丙', '排序乙', '排序甲']
    });
    assert.strictEqual(reordered.status, 200);
    var after = reordered.body.groups.map(function (g) { return g.name; });
    assert.ok(after.indexOf('排序丙') < after.indexOf('排序乙'));
    assert.ok(after.indexOf('排序乙') < after.indexOf('排序甲'));

    // 顺序要真的落盘
    var stored = foldersRepo.list(ctx.handle, ctx.store.projectId).map(function (folder) { return folder.name; });
    assert.ok(stored.indexOf('排序丙') < stored.indexOf('排序甲'), '分组顺序应写进数据库');

    // 非法输入
    var bad = await ctx.api('POST', '/groups/reorder', { names: ['查无此组'] });
    assert.strictEqual(bad.status, 400);
    assert.ok(bad.body.error.indexOf('不存在') > -1);
    var notArray = await ctx.api('POST', '/groups/reorder', { names: '排序甲' });
    assert.strictEqual(notArray.status, 400);
});

test('导出内容包含分组', async function () {
    var res = await ctx.api('GET', '/export');
    var doc = JSON.parse(res.body.json);
    assert.ok(Array.isArray(doc.groups));
    assert.ok(Array.isArray(doc.routes));
});
