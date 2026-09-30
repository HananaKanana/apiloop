var test = require('node:test');
var assert = require('node:assert');
var importers = require('../lib/importers');
var engine = require('../lib/mock-engine');

test('cURL：解析 method / path / query / JSON body', function () {
    var route = importers.curlToRoute(
        "curl 'http://localhost:8080/api/users?page=1&keyword=abc' -X POST " +
        "-H 'Content-Type: application/json' -d '{\"name\":\"张三\",\"age\":18,\"vip\":true}'"
    );
    assert.strictEqual(route.method, 'POST');
    assert.strictEqual(route.path, '/api/users');
    assert.deepStrictEqual(route.query.map(function (f) { return f.key; }), ['page', 'keyword']);
    assert.strictEqual(route.query[0].type, 'number');
    assert.deepStrictEqual(route.body.map(function (f) { return f.key; }), ['name', 'age', 'vip']);
    assert.strictEqual(route.body[1].type, 'number');
    assert.strictEqual(route.body[2].type, 'boolean');
});

test('cURL：没有 -X 时按有无 body 推断 GET/POST', function () {
    assert.strictEqual(importers.curlToRoute('curl http://x.com/a').method, 'GET');
    assert.strictEqual(importers.curlToRoute("curl http://x.com/a -d 'a=1'").method, 'POST');
});

test('cURL：数字路径段转成 :id', function () {
    var route = importers.curlToRoute('curl https://api.test.com/v1/orders/12345');
    assert.strictEqual(route.path, '/v1/orders/:id');
    assert.ok(route.desc.indexOf(':id') > -1, '应在备注里说明做了转换');
});

test('cURL：urlencoded body 与多行续行', function () {
    var route = importers.curlToRoute(
        'curl -X PUT https://x.com/api/user \\\n  -H \'Content-Type: application/x-www-form-urlencoded\' \\\n  -d \'a=1&b=hello\''
    );
    assert.strictEqual(route.method, 'PUT');
    assert.strictEqual(route.path, '/api/user');
    assert.deepStrictEqual(route.body.map(function (f) { return f.key + '=' + f.example; }), ['a=1', 'b=hello']);
});

test('cURL：-G 时 data 变成查询参数', function () {
    var route = importers.curlToRoute("curl -G https://x.com/api/list -d 'page=2'");
    assert.deepStrictEqual(route.query.map(function (f) { return f.key + '=' + f.example; }), ['page=2']);
    assert.strictEqual(route.body.length, 0);
});

test('cURL：缺 URL 时报错', function () {
    assert.throws(function () { importers.curlToRoute('curl -X GET'); }, /没有在 cURL 命令里找到 URL/);
});

test('cURL：导入结果能通过 store 校验并渲染出回显响应', function () {
    var store = require('../lib/routes-store');
    var route = store.normalizeRoute(importers.curlToRoute(
        "curl -X POST https://x.com/api/users -H 'Content-Type: application/json' -d '{\"name\":\"李四\"}'"
    ));
    var rendered = engine.render(route.response, { body: { name: '李四' } });
    assert.strictEqual(JSON.parse(rendered.text).data.name, '李四');
});

test('OpenAPI 3：解析路径、query 参数、tags、summary', function () {
    var spec = {
        openapi: '3.0.0',
        paths: {
            '/api/pets': {
                get: {
                    tags: ['pet'],
                    summary: '宠物列表',
                    parameters: [
                        { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 50 } }
                    ],
                    responses: {
                        '200': { content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Pet' } } } } }
                    }
                }
            }
        },
        components: {
            schemas: {
                Pet: {
                    type: 'object',
                    required: ['name'],
                    properties: {
                        id: { type: 'integer' },
                        name: { type: 'string' },
                        email: { type: 'string', format: 'email' },
                        status: { type: 'string', enum: ['available', 'sold'] },
                        tags: { type: 'array', items: { type: 'string' } }
                    }
                }
            }
        }
    };

    var routes = importers.openapiToRoutes(JSON.stringify(spec));
    assert.strictEqual(routes.length, 1);
    assert.strictEqual(routes[0].method, 'GET');
    assert.strictEqual(routes[0].path, '/api/pets');
    assert.strictEqual(routes[0].name, '宠物列表');
    assert.strictEqual(routes[0].group, 'pet');
    assert.strictEqual(routes[0].query[0].key, 'limit');
});

test('OpenAPI 3：按 schema 生成带占位符的响应，且是合法 JSON', function () {
    var spec = {
        openapi: '3.0.0',
        paths: {
            '/api/pets/{petId}': {
                get: {
                    parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'integer' } }],
                    responses: {
                        '200': {
                            content: {
                                'application/json': {
                                    schema: {
                                        type: 'object',
                                        properties: {
                                            id: { type: 'integer', minimum: 10, maximum: 20 },
                                            email: { type: 'string', format: 'email' },
                                            createdAt: { type: 'string', format: 'date-time' },
                                            owner: { type: 'object', properties: { city: { type: 'string' } } },
                                            tags: { type: 'array', items: { type: 'string' } }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    };

    var routes = importers.openapiToRoutes(JSON.stringify(spec));
    // {petId} 必须转成 Express 的 :petId，否则路由永远匹配不上
    assert.strictEqual(routes[0].path, '/api/pets/:petId');

    var rendered = engine.render(routes[0].response, {});
    assert.deepStrictEqual(rendered.warnings, []);
    var data = JSON.parse(engine.repairJson(rendered.text));
    assert.ok(data.id >= 10 && data.id <= 20, 'integer 的 minimum/maximum 应该生效');
    assert.ok(data.tags.length >= 1, '数组应生成若干元素');
    assert.strictEqual(typeof data.owner.city, 'string');
    assert.ok(/@/.test(data.email));
});

test('OpenAPI：requestBody 的字段进入 body 且标注必填', function () {
    var spec = {
        openapi: '3.0.0',
        paths: {
            '/api/users': {
                post: {
                    requestBody: {
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    required: ['name'],
                                    properties: { name: { type: 'string' }, age: { type: 'integer' } }
                                }
                            }
                        }
                    },
                    responses: { '200': { content: { 'application/json': { schema: { type: 'object' } } } } }
                }
            }
        }
    };
    var routes = importers.openapiToRoutes(JSON.stringify(spec));
    var keys = routes[0].body.map(function (f) { return f.key; });
    assert.deepStrictEqual(keys, ['name', 'age']);
    assert.strictEqual(routes[0].body[0].required, true);
    assert.strictEqual(routes[0].body[1].required, false);
});

test('Swagger 2.0：body 参数与 responses.schema', function () {
    var spec = {
        swagger: '2.0',
        paths: {
            '/api/items': {
                post: {
                    parameters: [
                        { name: 'page', in: 'query', type: 'integer' },
                        { name: 'payload', in: 'body', schema: { type: 'object', properties: { title: { type: 'string' } } } }
                    ],
                    responses: { '200': { schema: { type: 'object', properties: { ok: { type: 'boolean' } } } } }
                }
            }
        }
    };
    var routes = importers.openapiToRoutes(JSON.stringify(spec));
    assert.strictEqual(routes[0].method, 'POST');
    assert.deepStrictEqual(routes[0].query.map(function (f) { return f.key; }), ['page']);
    var rendered = engine.render(routes[0].response, {});
    assert.strictEqual(typeof JSON.parse(engine.repairJson(rendered.text)).ok, 'boolean');
});

test('OpenAPI：支持 YAML 输入', function () {
    var yaml = [
        'openapi: 3.0.0',
        'paths:',
        '  /api/demo:',
        '    get:',
        '      summary: YAML 接口',
        '      responses:',
        "        '200':",
        '          content:',
        '            application/json:',
        '              schema:',
        '                type: object',
        '                properties:',
        '                  id: { type: integer }'
    ].join('\n');

    var routes = importers.openapiToRoutes(yaml);
    assert.strictEqual(routes.length, 1);
    assert.strictEqual(routes[0].name, 'YAML 接口');
    assert.ok(routes[0].response.indexOf('{{@int(') > -1);
});

test('OpenAPI：文档不含 paths 时报错', function () {
    assert.throws(function () { importers.openapiToRoutes('{"foo":1}'); }, /缺少 paths/);
    assert.throws(function () { importers.openapiToRoutes('   '); }, /内容为空/);
});
