var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var express = require('express');
var bodyParser = require('body-parser');
var { once } = require('node:events');

var storeModule = require('../lib/routes-store');
var runtimeModule = require('../lib/mock-runtime');
var adminModule = require('../lib/admin');

var ctx = null;

test.before(async function () {
    var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-mock-http-'));
    var store = storeModule.createStore({ file: path.join(dir, 'routes.json') });
    store.load();
    store.startWatching();

    var app = express();
    app.use(bodyParser.json());
    app.use(bodyParser.urlencoded({ extended: true }));

    var admin = adminModule.createAdmin({ store: store, version: 'test' });
    app.use(admin.apiPath, admin.api);
    app.use(admin.mountPath, admin.static);
    app.use(runtimeModule.createRuntime(store).middleware);

    var server = app.listen(0);
    await once(server, 'listening');

    ctx = {
        store: store,
        server: server,
        dir: dir,
        base: 'http://127.0.0.1:' + server.address().port,
        api: function (method, url, body) {
            return fetch(ctx.base + '/__mock/api' + url, {
                method: method,
                headers: { 'Content-Type': 'application/json' },
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
    ctx.store.stopWatching();
    if (ctx.server) ctx.server.close();
});

test('管理台页面可访问', async function () {
    var res = await fetch(ctx.base + '/__mock/');
    assert.strictEqual(res.status, 200);
    var html = await res.text();
    assert.ok(html.indexOf('server-mock 管理台') > -1);
    assert.ok(html.indexOf('/__mock') > -1 || html.indexOf('app.js') > -1);
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

test('外部编辑 routes.json 触发热更新', async function () {
    var doc = JSON.parse(fs.readFileSync(ctx.store.filePath, 'utf-8'));
    doc.routes.push({
        id: 'r_from_disk', name: '磁盘接口', enabled: true, method: 'GET', path: '/api/from-disk',
        status: 200, delay: 0, cors: false, headers: [], query: [], body: [],
        responseType: 'json', response: '{"from":"disk"}'
    });
    fs.writeFileSync(ctx.store.filePath, JSON.stringify(doc, null, 2));

    var deadline = Date.now() + 5000;
    var ok = false;
    while (Date.now() < deadline) {
        var res = await fetch(ctx.base + '/api/from-disk');
        if (res.status === 200) {
            assert.strictEqual((await res.json()).from, 'disk');
            ok = true;
            break;
        }
        await new Promise(function (resolve) { setTimeout(resolve, 100); });
    }
    assert.ok(ok, '外部修改 routes.json 后应自动热更新');
});

test('删除接口后返回 404', async function () {
    var res = await ctx.api('DELETE', '/routes/' + ctx.pingId);
    assert.strictEqual(res.body.ok, true);
    assert.strictEqual((await fetch(ctx.base + '/api/ping')).status, 404);
    var again = await ctx.api('DELETE', '/routes/' + ctx.pingId);
    assert.strictEqual(again.status, 404);
});

test('校验失败返回 400 且带可读错误', async function () {
    var reserved = await ctx.api('POST', '/routes', { route: { path: '/__mock/hack' } });
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
