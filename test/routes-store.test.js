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
        var events = 0;
        store.on('change', function () { events++; });

        // fs.watch 从调用到真正生效有一小段时间，立刻写文件会漏掉事件（测试竞态）
        await new Promise(function (resolve) { setTimeout(resolve, 200); });
        fs.writeFileSync(store.filePath, JSON.stringify({ version: 1, routes: [{ id: 'x', path: '/api/from-disk' }] }));

        var deadline = Date.now() + 5000;
        function reloaded() {
            var list = store.getRoutes();
            return list.length === 1 && list[0].path === '/api/from-disk';
        }
        while (Date.now() < deadline && !reloaded()) {
            await new Promise(function (resolve) { setTimeout(resolve, 50); });
        }

        assert.ok(reloaded(), '外部写入后应重新加载，当前: ' + JSON.stringify(store.getRoutes()));
        assert.ok(events > 0, '外部修改应触发 change 事件');
    } finally {
        store.stopWatching();
    }
});

test('示例配置本身合法且能通过校验', function () {
    var sample = storeModule.createSampleRoutes();
    assert.strictEqual(sample.version, 1);
    assert.ok(sample.routes.length >= 3);
    assert.ok(Array.isArray(sample.groups), '示例配置应声明 groups');
    sample.routes.forEach(function (route) {
        var normalized = storeModule.normalizeRoute(route, { keepId: true });
        assert.strictEqual(normalized.id, route.id);
        assert.ok(normalized.path.charAt(0) === '/');
    });
});

/* ------------------------------------------------------------------ 分组管理 */

test('分组管理：新建 / 重命名 / 删除', function () {
    var ctx = tempStore();
    var store = ctx.store;
    store.load();
    assert.deepStrictEqual(store.getGroups(), []);

    store.addGroup('订单');
    store.addGroup('用户');
    assert.deepStrictEqual(store.getGroups().map(function (g) { return g.name; }), ['订单', '用户']);

    var route = store.create({ path: '/api/orders', group: '订单' });
    assert.strictEqual(store.getGroups()[0].count, 1, 'count 应反映分组下接口数');

    var renamed = store.renameGroup('订单', '交易');
    assert.strictEqual(renamed.moved, 1);
    assert.strictEqual(store.getRoute(route.id).group, '交易', '重命名应同步改掉接口上的分组');
    assert.deepStrictEqual(store.getGroups().map(function (g) { return g.name; }), ['交易', '用户']);

    var removed = store.removeGroup('用户');
    assert.strictEqual(removed.mode, 'move');
    assert.strictEqual(removed.affected, 0);
    assert.deepStrictEqual(store.getGroups().map(function (g) { return g.name; }), ['交易']);
});

test('路由上出现的分组会自动登记', function () {
    var ctx = tempStore();
    var store = ctx.store;
    store.load();
    store.create({ path: '/api/a', group: '顺手写的' });
    assert.deepStrictEqual(store.getGroups().map(function (g) { return g.name; }), ['顺手写的']);

    // 更新接口时换分组同样要登记
    var route = store.create({ path: '/api/b' });
    store.update(route.id, { path: '/api/b', group: '另一个' });
    assert.ok(store.getGroups().map(function (g) { return g.name; }).indexOf('另一个') > -1);
});

test('删除分组：move 把接口移到未分组，delete 连接口一起删', function () {
    var ctx = tempStore();
    var store = ctx.store;
    store.load();

    var a = store.create({ path: '/api/a', group: '临时' });
    var b = store.create({ path: '/api/b', group: '临时' });

    var moved = store.removeGroup('临时', 'move');
    assert.strictEqual(moved.affected, 2);
    assert.strictEqual(store.getRoutes().length, 2, 'move 不应删接口');
    assert.strictEqual(store.getRoute(a.id).group, '');
    assert.deepStrictEqual(store.getGroups(), [], '分组本身应消失');

    var c = store.create({ path: '/api/c', group: '待删' });
    var deleted = store.removeGroup('待删', 'delete');
    assert.strictEqual(deleted.mode, 'delete');
    assert.strictEqual(deleted.affected, 1);
    assert.strictEqual(store.getRoute(c.id), null, 'delete 应连接口一起删');
});

test('分组管理的非法输入', function () {
    var ctx = tempStore();
    var store = ctx.store;
    store.load();
    store.addGroup('用户');

    assert.throws(function () { store.addGroup('   '); }, /分组名不能为空/);
    assert.throws(function () { store.addGroup('用户'); }, /分组已存在/);
    assert.throws(function () { store.renameGroup('不存在', 'x'); }, /分组不存在/);
    assert.throws(function () { store.renameGroup('用户', '  '); }, /新分组名不能为空/);
    store.addGroup('其他');
    assert.throws(function () { store.renameGroup('用户', '其他'); }, /分组已存在/);
    assert.throws(function () { store.removeGroup('不存在'); }, /分组不存在/);
});

test('分组排序：完整重排 / 部分重排 / 非法名字', function () {
    var ctx = tempStore();
    var store = ctx.store;
    store.load();
    ['A', 'B', 'C'].forEach(function (name) { store.addGroup(name); });

    assert.deepStrictEqual(
        store.reorderGroups(['C', 'A', 'B']).map(function (g) { return g.name; }),
        ['C', 'A', 'B']
    );

    // 只提到一部分：没提到的按原顺序排在后面
    assert.deepStrictEqual(
        store.reorderGroups(['B']).map(function (g) { return g.name; }),
        ['B', 'C', 'A']
    );

    // 重复项忽略
    assert.deepStrictEqual(
        store.reorderGroups(['A', 'A', 'C']).map(function (g) { return g.name; }),
        ['A', 'C', 'B']
    );

    assert.throws(function () { store.reorderGroups(['不存在']); }, /分组不存在/);
    assert.throws(function () { store.reorderGroups('A'); }, /必须是数组/);

    // 顺序要落盘
    var doc = JSON.parse(fs.readFileSync(store.filePath, 'utf-8'));
    assert.deepStrictEqual(doc.groups, ['A', 'C', 'B']);
});

test('分组会写进 routes.json，老文件没有 groups 也能用', function () {
    var ctx = tempStore();
    var store = ctx.store;
    store.load();
    store.addGroup('空分组也应保存');
    var doc = JSON.parse(fs.readFileSync(store.filePath, 'utf-8'));
    assert.deepStrictEqual(doc.groups, ['空分组也应保存']);

    // 老格式：只有 routes，没有 groups
    var legacy = tempStore();
    fs.writeFileSync(legacy.store.filePath, JSON.stringify({
        version: 1,
        routes: [{ id: 'r1', path: '/api/a', group: '老分组' }, { id: 'r2', path: '/api/b', group: '老分组' }]
    }));
    legacy.store.load();
    assert.deepStrictEqual(legacy.store.getGroups(), [{ name: '老分组', count: 2 }]);

    // 只有路由数组的极简格式
    var bare = tempStore();
    fs.writeFileSync(bare.store.filePath, JSON.stringify([{ path: '/api/a', group: 'x' }]));
    bare.store.load();
    assert.deepStrictEqual(bare.store.getGroups(), [{ name: 'x', count: 1 }]);
});
