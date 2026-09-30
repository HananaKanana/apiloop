var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var storeModule = require('../lib/routes-store');

function tempStore() {
    var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-mock-store-'));
    return { store: storeModule.createStore({ file: path.join(dir, 'routes.json') }), dir: dir };
}

test('normalizeRoute 补默认值', function () {
    var route = storeModule.normalizeRoute({ path: 'api/x' });
    assert.strictEqual(route.path, '/api/x', '缺前导斜杠要补上');
    assert.strictEqual(route.method, 'GET');
    assert.strictEqual(route.status, 200);
    assert.strictEqual(route.enabled, true);
    assert.strictEqual(route.responseType, 'json');
    assert.ok(route.id, '应生成 id');
    assert.deepStrictEqual(route.headers, []);
});

test('normalizeRoute 拒绝非法输入', function () {
    assert.throws(function () { storeModule.normalizeRoute({ path: '/a', method: 'FETCH' }); }, /不支持的请求方法/);
    assert.throws(function () { storeModule.normalizeRoute({ path: '   ' }); }, /路径不能为空/);
    assert.throws(function () { storeModule.normalizeRoute({ path: '/__mock/api/routes' }); }, /管理台占用的前缀/);
});

test('normalizeRoute 约束数值范围', function () {
    assert.strictEqual(storeModule.normalizeRoute({ path: '/a', status: 999 }).status, 599);
    assert.strictEqual(storeModule.normalizeRoute({ path: '/a', status: 50 }).status, 100);
    assert.strictEqual(storeModule.normalizeRoute({ path: '/a', delay: -5 }).delay, 0);
    assert.strictEqual(storeModule.normalizeRoute({ path: '/a', delay: 'abc' }).delay, 0);
});

test('normalizeRoute 过滤空字段行并纠正未知类型', function () {
    var route = storeModule.normalizeRoute({
        path: '/a',
        headers: [{ key: 'X-A', value: '1' }, { key: '', value: 'drop' }],
        query: [{ key: 'page', type: '不存在的类型' }, { key: '' }]
    });
    assert.strictEqual(route.headers.length, 1);
    assert.strictEqual(route.query.length, 1);
    assert.strictEqual(route.query[0].type, 'string');
});

test('CRUD：新建 / 查询 / 更新 / 复制 / 删除', function () {
    var ctx = tempStore();
    var store = ctx.store;
    assert.deepStrictEqual(store.load(), []);

    var created = store.create({ path: '/api/a', name: 'A' });
    assert.strictEqual(store.getRoutes().length, 1);
    assert.strictEqual(store.getRoute(created.id).name, 'A');

    var updated = store.update(created.id, { path: '/api/a', name: 'A2', status: 201 });
    assert.strictEqual(updated.name, 'A2');
    assert.strictEqual(updated.id, created.id, '更新不应改变 id');
    assert.strictEqual(store.getRoutes().length, 1, '更新不应新增');

    var copy = store.duplicate(created.id);
    assert.notStrictEqual(copy.id, created.id);
    assert.strictEqual(copy.name, 'A2 副本');

    assert.strictEqual(store.remove(created.id), true);
    assert.strictEqual(store.remove(created.id), false, '重复删除返回 false');
    assert.strictEqual(store.getRoutes().length, 1);

    assert.strictEqual(store.update('not-exist', { path: '/x' }), null);
    assert.strictEqual(store.duplicate('not-exist'), null);
});

test('落盘：文件格式、原子替换、可被重新读取', function () {
    var ctx = tempStore();
    var store = ctx.store;
    store.create({ path: '/api/a' });
    store.create({ path: '/api/b' });

    var text = fs.readFileSync(store.filePath, 'utf-8');
    var doc = JSON.parse(text);
    assert.strictEqual(doc.version, 1);
    assert.strictEqual(doc.routes.length, 2);
    assert.ok(text.endsWith('\n'), '文件应以换行结尾');
    assert.strictEqual(fs.existsSync(store.filePath + '.tmp'), false, '临时文件应已被 rename');

    var reloaded = storeModule.createStore({ file: store.filePath });
    assert.strictEqual(reloaded.load().length, 2);
});

test('change 事件在增删改后触发', function () {
    var ctx = tempStore();
    var store = ctx.store;
    var events = 0;
    store.on('change', function () { events++; });

    var route = store.create({ path: '/api/a' });
    store.update(route.id, { path: '/api/a', name: 'x' });
    store.remove(route.id);
    assert.strictEqual(events, 3);

    store.addMany([{ path: '/api/b' }, { path: '/api/c' }]);
    assert.strictEqual(events, 4, '批量导入只触发一次变更');
    assert.strictEqual(store.getRoutes().length, 2);
});

test('load 对空文件与缺失文件都返回空列表', function () {
    var ctx = tempStore();
    assert.deepStrictEqual(ctx.store.load(), []);

    fs.writeFileSync(ctx.store.filePath, '   \n');
    assert.deepStrictEqual(ctx.store.load(), []);
});

test('load 对坏 JSON 抛出可读错误', function () {
    var ctx = tempStore();
    fs.writeFileSync(ctx.store.filePath, '{ this is not json');
    assert.throws(function () { ctx.store.load(); }, /不是合法的 JSON/);
});

test('load 支持直接是数组的写法', function () {
    var ctx = tempStore();
    fs.writeFileSync(ctx.store.filePath, JSON.stringify([{ path: '/api/a' }]));
    assert.strictEqual(ctx.store.load().length, 1);
});

test('文件监听：外部修改后触发 change 并重新加载', async function () {
    var ctx = tempStore();
    var store = ctx.store;
    store.load();
    store.startWatching();
    try {
        var changed = new Promise(function (resolve) { store.on('change', resolve); });
        fs.writeFileSync(store.filePath, JSON.stringify({ version: 1, routes: [{ id: 'x', path: '/api/from-disk' }] }));
        await Promise.race([
            changed,
            new Promise(function (resolve, reject) {
                setTimeout(function () { reject(new Error('等待 change 事件超时')); }, 5000).unref();
            })
        ]);
        assert.strictEqual(store.getRoutes().length, 1);
        assert.strictEqual(store.getRoutes()[0].path, '/api/from-disk');
    } finally {
        store.stopWatching();
    }
});

test('示例配置本身合法且能通过校验', function () {
    var sample = storeModule.createSampleRoutes();
    assert.strictEqual(sample.version, 1);
    assert.ok(sample.routes.length >= 3);
    sample.routes.forEach(function (route) {
        var normalized = storeModule.normalizeRoute(route, { keepId: true });
        assert.strictEqual(normalized.id, route.id);
        assert.ok(normalized.path.charAt(0) === '/');
    });
});
