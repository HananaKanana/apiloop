var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var storeModule = require('../lib/routes-store');
var dbModule = require('../lib/db');
var projectsRepo = require('../lib/db/repos/projects');
var apisRepo = require('../lib/db/repos/apis');
var foldersRepo = require('../lib/db/repos/folders');
var legacyImport = require('../lib/legacy-import');

/**
 * store 现在是「单个项目的门面」，所以要先开库、建一个项目，再拿它建 store。
 */
function tempStore() {
    var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-mock-store-'));
    var handle = dbModule.open(path.join(dir, 'data.db'));
    var project = projectsRepo.create(handle, { name: '测试项目' });
    return {
        handle: handle,
        projectId: project.id,
        store: storeModule.createStore({ handle: handle, projectId: project.id }),
        dir: dir
    };
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
    assert.throws(function () { storeModule.normalizeRoute({ path: '/__admin/api/routes' }); }, /管理台占用的前缀/);
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

test('落盘：写进数据库并可被重新读取', function () {
    var ctx = tempStore();
    var store = ctx.store;
    store.create({ path: '/api/a', group: 'G' });
    store.create({ path: '/api/b' });

    // 一条 route 现在落在 apis（接口定义）和 folders（分组）里，直接查表核对
    var stored = apisRepo.list(ctx.handle, ctx.projectId);
    assert.deepStrictEqual(stored.map(function (item) { return item.mockPath; }), ['/api/a', '/api/b']);
    assert.deepStrictEqual(
        foldersRepo.list(ctx.handle, ctx.projectId).map(function (folder) { return folder.name; }),
        ['G'], '分组也要落库'
    );

    var reloaded = storeModule.createStore({ handle: ctx.handle, projectId: ctx.projectId });
    assert.deepStrictEqual(reloaded.load().map(function (item) { return item.path; }), ['/api/a', '/api/b']);
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

test('load 对缺失的库和空库都返回空列表', function () {
    var ctx = tempStore();
    assert.deepStrictEqual(ctx.store.load(), [], '库文件还不存在时应为空');
    assert.deepStrictEqual(ctx.store.load(), [], '库已建好但还是空的时候仍应为空');
    assert.deepStrictEqual(ctx.store.getGroups(), []);
});

test('迁移：旧 routes.db 旁边的目录名会成为项目名', function () {
    var ctx = tempStore();
    fs.writeFileSync(path.join(ctx.dir, 'routes.db'), '这不是个数据库');
    var result = legacyImport.importLegacyDir(ctx.handle, ctx.dir);
    assert.strictEqual(result.project, null, '读不出来就不该建空项目');
    assert.strictEqual(result.warnings.length, 1);
    assert.ok(/不是 SQLite 数据库/.test(result.warnings[0]), result.warnings[0]);
});

test('迁移：旧 routes.json 坏掉时只记警告，不影响启动', function () {
    var ctx = tempStore();
    fs.writeFileSync(path.join(ctx.dir, 'routes.json'), '{ 这不是合法 JSON');
    var result = legacyImport.importLegacyDir(ctx.handle, ctx.dir);
    assert.strictEqual(result.project, null);
    assert.strictEqual(result.warnings.length, 1);
    assert.ok(/不是合法 JSON/.test(result.warnings[0]), result.warnings[0]);
});

test('迁移：旧 routes.json 支持直接是数组的极简写法', function () {
    var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-mock-legacy-'));
    var handle = dbModule.open(path.join(dir, 'data.db'));
    fs.writeFileSync(path.join(dir, 'routes.json'), JSON.stringify([{ path: '/api/a' }]));

    var result = legacyImport.importLegacyDir(handle, dir);
    assert.ok(result.project, '应建出项目');
    assert.strictEqual(result.importedFrom, path.join(dir, 'routes.json'));
    assert.strictEqual(result.project.name, path.basename(dir), '项目名取目录名');

    var store = storeModule.createStore({ handle: handle, projectId: result.project.id });
    assert.deepStrictEqual(store.load().map(function (r) { return r.path; }), ['/api/a']);
    assert.ok(fs.existsSync(path.join(dir, 'routes.json')), '原文件保留不动');
    handle.close();
});

test('迁移：目录里同时有 routes.db 和 routes.json 时只认 routes.db', function () {
    var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-mock-legacy-'));
    var handle = dbModule.open(path.join(dir, 'data.db'));

    // 造一个 P0 格式的库：它自己的表结构由 legacy 模块负责
    var legacyDb = require('../lib/legacy/routes-db');
    var p0 = legacyDb.openDatabase(path.join(dir, 'routes.db'));
    p0.exec("CREATE TABLE IF NOT EXISTS groups (name TEXT PRIMARY KEY, position INTEGER NOT NULL)");
    p0.exec("CREATE TABLE IF NOT EXISTS routes (id TEXT PRIMARY KEY, name TEXT, grp TEXT, descr TEXT, " +
        "enabled INTEGER, method TEXT, path TEXT, status INTEGER, delay INTEGER, cors INTEGER, " +
        "headers TEXT, query TEXT, body TEXT, response_type TEXT, response TEXT, position INTEGER)");
    p0.prepare("INSERT INTO routes (id,name,grp,descr,enabled,method,path,status,delay,cors,headers,query,body,response_type,response,position) " +
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run('r1', '来自库', '', '', 1, 'GET', '/api/from-db', 200, 0, 0, '[]', '[]', '[]', 'json', '{}', 0);
    legacyDb.close(p0);

    fs.writeFileSync(path.join(dir, 'routes.json'), JSON.stringify([{ path: '/api/from-json' }]));

    var result = legacyImport.importLegacyDir(handle, dir);
    assert.strictEqual(result.importedFrom, path.join(dir, 'routes.db'), '应优先 routes.db');

    var store = storeModule.createStore({ handle: handle, projectId: result.project.id });
    assert.deepStrictEqual(store.load().map(function (r) { return r.path; }), ['/api/from-db']);
    handle.close();
});

test('迁移：同一个目录不会重复导入', function () {
    var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-mock-legacy-'));
    var handle = dbModule.open(path.join(dir, 'data.db'));
    fs.writeFileSync(path.join(dir, 'routes.json'), JSON.stringify([{ path: '/api/a', group: '分组甲' }]));

    var first = legacyImport.importLegacyDir(handle, dir);
    assert.ok(first.project && first.importedFrom, '第一次应真的导入');

    var second = legacyImport.importLegacyDir(handle, dir);
    assert.strictEqual(second.project.id, first.project.id, '第二次应返回同一个项目');
    assert.strictEqual(second.importedFrom, null, '第二次不应再报导入');

    assert.strictEqual(
        projectsRepo.list(handle).length, 1, '不应产生第二个项目'
    );
    var store = storeModule.createStore({ handle: handle, projectId: first.project.id });
    assert.strictEqual(store.load().length, 1, '接口也不应被导入两次');
    assert.deepStrictEqual(store.getGroups().map(function (g) { return g.name; }), ['分组甲']);
    handle.close();
});

test('迁移：声明的空分组也会按原顺序建出来', function () {
    var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-mock-legacy-'));
    var handle = dbModule.open(path.join(dir, 'data.db'));
    fs.writeFileSync(path.join(dir, 'routes.json'), JSON.stringify({
        version: 1,
        groups: ['空的分组', '有接口的'],
        routes: [{ path: '/api/a', group: '有接口的' }]
    }));

    var result = legacyImport.importLegacyDir(handle, dir);
    var store = storeModule.createStore({ handle: handle, projectId: result.project.id });
    store.load();
    assert.deepStrictEqual(
        store.getGroups().map(function (g) { return g.name; }),
        ['空的分组', '有接口的'],
        '分组顺序与声明一致，空分组也保留'
    );
    handle.close();
});

test('文件监听：外部改库后触发 change 并重新加载', async function () {
    var ctx = tempStore();
    var store = ctx.store;
    store.load();
    store.create({ path: '/api/self' });
    store.startWatching();
    try {
        var events = 0;
        store.on('change', function () { events++; });

        // fs.watch 从调用到真正生效有一小段时间，立刻写会漏掉事件（测试竞态）
        await new Promise(function (resolve) { setTimeout(resolve, 200); });

        // 模拟「另一个进程改了库」：另开一个 handle 往同一个库文件里写
        var other = dbModule.open(ctx.handle.file);
        apisRepo.insert(other, ctx.projectId, {
            name: '外部写入', method: 'GET', url: '/api/from-db', mockPath: '/api/from-db'
        });
        other.close();

        var deadline = Date.now() + 5000;
        function reloaded() {
            return store.getRoutes().some(function (r) { return r.path === '/api/from-db'; });
        }
        while (Date.now() < deadline && !reloaded()) {
            await new Promise(function (resolve) { setTimeout(resolve, 50); });
        }

        assert.ok(reloaded(), '外部改库后应重新加载，当前: ' + JSON.stringify(store.getRoutes()));
        assert.ok(events > 0, '外部改动应触发 change 事件');
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

    // 顺序要落盘：换一个 store 实例读回来
    var reopened = storeModule.createStore({ handle: ctx.handle, projectId: ctx.projectId });
    reopened.load();
    assert.deepStrictEqual(reopened.getGroups().map(function (g) { return g.name; }), ['A', 'C', 'B']);
});

test('分组会落进数据库，接口上写的新分组名会自动登记', function () {
    var ctx = tempStore();
    var store = ctx.store;
    store.load();
    store.addGroup('空分组也应保存');

    var reopened = storeModule.createStore({ handle: ctx.handle, projectId: ctx.projectId });
    reopened.load();
    assert.deepStrictEqual(reopened.getGroups().map(function (g) { return g.name; }), ['空分组也应保存']);
    assert.strictEqual(reopened.getGroups()[0].count, 0, '空分组的接口数是 0');

    // 接口上写了新分组名会自动登记（旧 routes.json 的 groups 推导见 Task 4 的 legacy-import）
    store.create({ path: '/api/a', group: '顺手写的' });
    assert.ok(
        store.getGroups().map(function (g) { return g.name; }).indexOf('顺手写的') > -1,
        '接口上写的新分组名应自动登记'
    );
});
