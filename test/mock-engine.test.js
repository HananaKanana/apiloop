var test = require('node:test');
var assert = require('node:assert');
var engine = require('../lib/mock-engine');

function parse(text) {
    return JSON.parse(engine.repairJson(text));
}

test('字符串占位符渲染成随机中文姓名', function () {
    var out = engine.render('{"name":"{{@cname}}"}', {});
    assert.deepStrictEqual(out.warnings, []);
    var parsed = JSON.parse(out.text);
    assert.strictEqual(typeof parsed.name, 'string');
    assert.ok(parsed.name.length >= 2, '姓名至少两个字');
});

test('独占字符串的数值占位符会去掉引号', function () {
    var out = engine.render('{"age":"{{@int(18,60)}}","ok":"{{@bool}}"}', {});
    var parsed = JSON.parse(out.text);
    assert.strictEqual(typeof parsed.age, 'number');
    assert.ok(parsed.age >= 18 && parsed.age <= 60);
    assert.strictEqual(typeof parsed.ok, 'boolean');
});

test('嵌入在文字里的占位符保持字符串', function () {
    var out = engine.render('{"msg":"你好 {{@cname}} 先生"}', {});
    var parsed = JSON.parse(out.text);
    assert.ok(/^你好 .+ 先生$/.test(parsed.msg));
});

test('未知占位符原样保留并产生警告', function () {
    var out = engine.render('{"a":"{{@nmae}}"}', {});
    assert.deepStrictEqual(out.warnings, ['nmae']);
    assert.strictEqual(JSON.parse(out.text).a, '{{@nmae}}');
});

test('中文占位符名也能识别成未知并警告', function () {
    var out = engine.render('{"a":"{{@姓名}}"}', {});
    assert.deepStrictEqual(out.warnings, ['姓名']);
});

test('repeat 固定份数', function () {
    var out = engine.render('[{{@repeat(3)}}"x"{{/repeat}}]', {});
    assert.deepStrictEqual(parse(out.text), ['x', 'x', 'x']);
});

test('repeat 范围份数', function () {
    var out = engine.render('[{{@repeat(2-4)}}"x"{{/repeat}}]', {});
    var parsed = parse(out.text);
    assert.ok(parsed.length >= 2 && parsed.length <= 4, '份数应在 2~4 之间，实际 ' + parsed.length);
});

test('repeat 支持嵌套', function () {
    var out = engine.render('[{{@repeat(2)}}[{{@repeat(2)}}"a"{{/repeat}}]{{/repeat}}]', {});
    assert.deepStrictEqual(parse(out.text), [['a', 'a'], ['a', 'a']]);
});

test('repeat 不配对时保留原文并警告', function () {
    var out = engine.render('[{{@repeat(2)}}"x"]', {});
    assert.ok(out.warnings.some(function (item) { return item.indexOf('repeat') > -1; }));
});

test('repeat 里的对象数组缺逗号能被修复', function () {
    var out = engine.render('{"list":[{{@repeat(3)}}{"id":"{{@id}}"}{{/repeat}}]}', {});
    var parsed = parse(out.text);
    assert.strictEqual(parsed.list.length, 3);
    assert.strictEqual(typeof parsed.list[0].id, 'number');
});

test('输入回显：query / body / params / header，支持嵌套', function () {
    var out = engine.render(
        '{"q":"{{@query(page)}}","b":"{{@body(user.name)}}","p":"{{@params(id)}}","h":"{{@header(x-token)}}","缺失":"{{@query(none)}}"}',
        {
            query: { page: '3' },
            body: { user: { name: '老王' } },
            params: { id: '42' },
            headers: { 'x-token': 'abc' }
        }
    );
    var parsed = JSON.parse(out.text);
    assert.strictEqual(parsed.q, '3');
    assert.strictEqual(parsed.b, '老王');
    assert.strictEqual(parsed.p, '42');
    assert.strictEqual(parsed.h, 'abc');
    assert.strictEqual(parsed['缺失'], '');
});

test('repairJson：补逗号 / 去尾逗号 / 不动字符串内容', function () {
    assert.strictEqual(engine.repairJson('[{"a":1}{"b":2}]'), '[{"a":1},{"b":2}]');
    assert.strictEqual(engine.repairJson('[1,2,]'), '[1,2]');
    assert.strictEqual(engine.repairJson('{"a":1,}'), '{"a":1}');
    assert.strictEqual(engine.repairJson('{"a":"}{,\\"}"}'), '{"a":"}{,\\"}"}');
    assert.strictEqual(engine.repairJson('[1 2 3]'), '[1, 2, 3]');
    assert.strictEqual(engine.repairJson('["a" "b"]'), '["a", "b"]');
});

test('repairJson 不会破坏科学计数法与字面量', function () {
    assert.strictEqual(engine.repairJson('[1e5,2e-3]'), '[1e5,2e-3]');
    assert.strictEqual(engine.repairJson('[true false null]'), '[true, false, null]');
    assert.strictEqual(engine.repairJson('{"a":1e10}'), '{"a":1e10}');
});

test('id 占位符自增', function () {
    var first = JSON.parse(engine.render('{"id":"{{@id(1000)}}"}', {}).text).id;
    var second = JSON.parse(engine.render('{"id":"{{@id(1000)}}"}', {}).text).id;
    assert.strictEqual(second, first + 1);
});

test('pick 只返回候选值之一', function () {
    var out = engine.render('{"s":"{{@pick(待付款,已付款)}}"}', {});
    assert.ok(['待付款', '已付款'].indexOf(JSON.parse(out.text).s) > -1);
});

test('字段类型同时提供真实样例值与 Mock 表达式', function () {
    engine.FIELD_TYPES.forEach(function (type) {
        assert.ok(type.value, 'type.value 必填');
        assert.ok(type.label, type.value + ' 需要 label');
        assert.strictEqual(typeof type.sample, 'string', type.value + ' 需要真实样例值 sample');
        assert.strictEqual(typeof type.placeholder, 'string', type.value + ' 需要 placeholder');
    });
    var number = engine.FIELD_TYPES.filter(function (type) { return type.value === 'number'; })[0];
    assert.strictEqual(number.sample, '42');
});

test('每个占位符都带有可插入的写法与分组', function () {
    assert.ok(engine.PLACEHOLDERS.length >= 30);
    engine.PLACEHOLDERS.forEach(function (item) {
        assert.ok(item.insert.indexOf('{{@') === 0, item.name + ' 的 insert 应形如 {{@name}}');
        assert.ok(item.group && item.desc, item.name + ' 需要 group 与 desc');
    });
});

test('响应模板本身能渲染成合法 JSON', function () {
    engine.TEMPLATES.forEach(function (template) {
        var out = engine.render(template.response, {});
        assert.deepStrictEqual(out.warnings, [], template.name + ' 不应有未知占位符');
        JSON.parse(engine.repairJson(out.text));
    });
});
