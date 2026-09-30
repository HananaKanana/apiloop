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

test('落盘：整批写入后数据库里是接口 + 示例 + 目录', function () {
    var ctx = tempStore();
    var store = ctx.store;

    // replaceAll 是门面上还在用的那条写入路径（mock init 灌示例走它），
    // 顺带把 insertRoutes 的落库覆盖了：一条 route → apis + examples + folders
    store.replaceAll([{ path: '/api/a', group: 'G' }, { path: '/api/b' }]);

    var stored = apisRepo.list(ctx.handle, ctx.projectId);
    assert.deepStrictEqual(stored.map(function (item) { return item.mockPath; }), ['/api/a', '/api/b']);
    assert.deepStrictEqual(
        foldersRepo.list(ctx.handle, ctx.projectId).map(function (folder) { return folder.name; }),
        ['G'], '分组（= 顶层目录）也要落库'
    );
    // 每条 route 都要配一条示例，否则读出来 enabled 是 false、挂不到 mock 上
    stored.forEach(function (api) {
        assert.ok(api.mockExampleId, api.mockPath + ' 应指向一条示例');
    });
    assert.ok(store.getRoutes().every(function (route) { return route.enabled; }));

    var reloaded = storeModule.createStore({ handle: ctx.handle, projectId: ctx.projectId });
    assert.deepStrictEqual(reloaded.load().map(function (item) { return item.path; }), ['/api/a', '/api/b']);
});

test('load 对缺失的库和空库都返回空列表', function () {
    var ctx = tempStore();
    assert.deepStrictEqual(ctx.store.load(), [], '库文件还不存在时应为空');
    assert.deepStrictEqual(ctx.store.load(), [], '库已建好但还是空的时候仍应为空');
    assert.deepStrictEqual(foldersRepo.list(ctx.handle, ctx.projectId), []);
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
    assert.deepStrictEqual(
        foldersRepo.list(handle, first.project.id).map(function (folder) { return folder.name; }),
        ['分组甲']
    );
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
        foldersRepo.list(handle, result.project.id).map(function (folder) { return folder.name; }),
        ['空的分组', '有接口的'],
        '分组顺序与声明一致，空分组也保留'
    );
    handle.close();
});

test('文件监听：外部改库后触发 change 并重新加载', async function () {
    var ctx = tempStore();
    var store = ctx.store;
    store.load();
    // 造一条自己的数据（走 repo，门面上的写方法已经删掉了）
    ctx.handle.transaction(function () {
        apisRepo.insert(ctx.handle, ctx.projectId, {
            name: '自写', method: 'GET', url: '/api/self', mockPath: '/api/self'
        });
    }, { projectId: ctx.projectId });
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
        // stopWatching 现在是空操作（轮询归 handle 管），要停得直接停 handle
        ctx.handle.stopPolling();
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

/* ------------------------------------------------------------ 分组（= 顶层目录） */

test('insertRoutes：声明过的分组、以及接口上写的分组，都会落成顶层目录', function () {
    var ctx = tempStore();
    ctx.store.load();

    // 这条路径是 legacy 导入与批量导入共用的：groups 先按声明顺序建（空目录也要留下），
    // route 上的 group 没声明过就顺手补建
    ctx.handle.transaction(function () {
        storeModule.insertRoutes(ctx.handle, ctx.projectId, {
            groups: ['空的分组', '有接口的'],
            routes: [{ path: '/api/a', group: '有接口的' }, { path: '/api/b', group: '顺手写的' }]
        });
    }, { projectId: ctx.projectId });

    assert.deepStrictEqual(
        foldersRepo.list(ctx.handle, ctx.projectId).map(function (folder) { return folder.name; }),
        ['空的分组', '有接口的', '顺手写的'],
        '顺序与声明一致，空目录也保留'
    );
    assert.deepStrictEqual(
        foldersRepo.list(ctx.handle, ctx.projectId).filter(function (folder) { return !folder.parentId; }).length,
        3, '都建在顶层'
    );
});
