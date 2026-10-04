/**
 * 样例项目：点一下就建好一个「什么都配齐了」的项目，拿来试功能（2026-10-04 用户要的）。
 *
 * 所有接口都打到**这个项目自己的 Mock** 上，不需要任何真实后端：
 * 示例响应是带 `{{@…}}` 的模板（每次返回的数据不一样），Mock 期望负责「密码错了回 401」
 * 「token 不对回 401」这些分支。
 *
 * 环境用**真实的环境**而不是内置的 Mock 环境：内置那个不存库，提取到「环境」的 token
 * 存不下来，前置接口就会每次都重新登录。`host` 设成这个项目的 Mock 地址 ——
 * 它要用到项目 id，所以由前端把云端地址（`origin`）传上来，这里拼成 `origin/mock-<项目 id>`。
 *
 * 覆盖的功能：目录与接口、Mock 模板与期望、可视化断言与提取变量、前置接口（token 没值 / 401）、
 * 公共请求头、目录「不使用前置接口」、接口状态与负责人、响应字段说明、中文随机数据、
 * 两个环境（环境对比）、测试集（流程 + 中文列名的 CSV 数据驱动）、压测（一个慢一点的接口）。
 * WebSocket / Socket.IO / GraphQL / 数据库操作要真服务，样例里不放。
 */

var helpers = require('./db/repos/helpers');
var projectsRepo = require('./db/repos/projects');
var foldersRepo = require('./db/repos/folders');
var apisRepo = require('./db/repos/apis');
var examplesRepo = require('./db/repos/examples');
var expectationsRepo = require('./db/repos/expectations');
var environmentsRepo = require('./db/repos/environments');
var suitesRepo = require('./db/repos/suites');
var commonHeaders = require('./common-headers');
var mockHost = require('./mock-host');
var urlUtils = require('./url-utils');
var access = require('./access');

var PROJECT_DESCRIPTION = [
    '样例项目：所有接口都打到这个项目自己的 Mock 上，不需要真实后端。右上角环境选「样例环境」。',
    '',
    '可以这样试：',
    '1. 直接发「用户 / 当前用户」：token 是空的，会自动先调「认证 / 登录」（前置接口），控制台里能看到。',
    '2. 环境切到「样例环境（token 已过期）」再发：第一次 401，自动登录后重发。',
    '3. 「认证 / 登录」把密码改错再发：Mock 回 401，断言页签里的两条断言不通过。',
    '4. 「用户 / 新建用户」的请求体用了 {{$中文名}}、{{$手机号}}、{{$身份证}}，每次发都不一样。',
    '5. 左侧栏切到「测试集」：「下单流程」一键跑完五步；「批量建用户」按 CSV 每行跑一轮（列名是中文）。',
    '6. 「订单 / 慢接口」发送按钮旁的下拉里点「压测…」。',
    '7. 「公开接口」这个目录设了「不使用前置接口」，下面的接口不会自动登录。',
    '8. 环境下拉最下面「对比所有环境」，看两个环境哪里不一样。'
].join('\n');

function id(prefix) {
    return helpers.newId(prefix);
}

function row(key, value, desc, extra) {
    return Object.assign({ key: key, value: value, enabled: true, desc: desc || '' }, extra || {});
}

function jsonBody(value) {
    return { mode: 'raw', raw: JSON.stringify(value, null, 2), language: 'json' };
}

function assertion(source, path, op, value) {
    return { id: id('as'), enabled: true, source: source, path: path || '', op: op, value: value === undefined ? '' : String(value) };
}

function extract(path, name) {
    return { id: id('ex'), enabled: true, source: 'json', path: path, scope: 'environment', name: name };
}

/**
 * 建一个样例项目。
 *
 * @param {object} handle
 * @param {{id: string}|null} user 当前用户（成为项目 owner、接口负责人）
 * @param {string} origin 云端地址（Mock 地址的前半段），比如 `http://leonaz.top:8765`
 * @returns {{project: object, environmentId: string}} 新建的项目行，和「样例环境」的 id（界面上建好就选中它）
 */
function createDemoProject(handle, user, origin) {
    var userId = user ? user.id : null;
    var base = String(origin || '').trim().replace(/\/+$/, '');

    return handle.transaction(function () {
        var project = projectsRepo.create(handle, {
            name: '样例项目',
            description: PROJECT_DESCRIPTION,
            created_by: userId
        });
        access.addOwner(handle, project.id, userId);

        var mockBase = base + mockHost.MOCK_PREFIX + project.id;

        /* ---------------- 目录 ---------------- */

        function folder(name, description, extra) {
            return foldersRepo.create(handle, project.id, {
                name: name,
                description: description || '',
                parentId: null,
                extra: extra || {},
                position: foldersRepo.nextPositionIn(handle, project.id, null)
            });
        }

        var authFolder = folder('认证', '登录接口。项目设置里把它设成了「前置接口」。');
        var userFolder = folder('用户', '要带 token 的接口。');
        var orderFolder = folder('订单', '下单、查询，以及一个给压测用的慢接口。');
        var publicFolder = folder('公开接口', '这个目录设了「不使用前置接口」：下面的接口不会自动登录。', {
            preflight: { apiId: null, whenMissing: '', retryOn401: false }
        });

        /* ---------------- 接口 ---------------- */

        /**
         * 建一个接口 + 示例（第一个示例当 Mock 返回）+ Mock 期望。
         * `expectations`：`[{ name, conditions, example }]`，`example` 是下标（指向 examples 里的第几个）。
         */
        function api(folderRow, spec) {
            var method = spec.method || 'GET';
            var row0 = apisRepo.insert(handle, project.id, {
                name: spec.name,
                description: spec.description || '',
                folderId: folderRow.id,
                method: method,
                url: '{{host}}' + spec.path,
                params: {
                    path: spec.pathParams || [],
                    query: spec.query || [],
                    headers: spec.headers || []
                },
                body: spec.body || { mode: 'none' },
                auth: null,
                scripts: spec.scripts || [],
                mockPath: urlUtils.deriveMockPath('{{host}}' + spec.path),
                mockDelay: spec.mockDelay || 0,
                mockEnabled: false,
                extra: Object.assign({
                    status: spec.status || 'done',
                    ownerId: userId,
                    assertions: spec.assertions || [],
                    extracts: spec.extracts || [],
                    responseFields: spec.responseFields || []
                }, spec.extra || {}),
                position: apisRepo.nextPositionIn(handle, project.id, folderRow.id)
            });

            var examples = (spec.examples || []).map(function (item) {
                return examplesRepo.insert(handle, row0.id, {
                    name: item.name,
                    status: item.status || 200,
                    headers: [],
                    body: typeof item.body === 'string' ? item.body : JSON.stringify(item.body, null, 2),
                    responseType: 'json',
                    // 带 {{@…}} 的是模板：每次返回现生成的数据
                    isTemplate: true,
                    source: 'manual'
                });
            });

            (spec.expectations || []).forEach(function (item) {
                expectationsRepo.insert(handle, row0.id, {
                    name: item.name,
                    enabled: true,
                    conditions: item.conditions,
                    exampleId: examples[item.example].id
                });
            });

            if (examples.length) {
                apisRepo.update(handle, row0.id, { mockEnabled: true, mockExampleId: examples[0].id });
            }
            return apisRepo.get(handle, row0.id);
        }

        var authHeader = [row('Authorization', 'Bearer {{token}}', '登录后拿到的 token（前置接口自动填）')];

        var login = api(authFolder, {
            name: '登录',
            method: 'POST',
            path: '/auth/login',
            description: '账号 demo，密码 123456。密码不对时 Mock 回 401。\n「断言」页签里配了两条断言，并把 data.token 提取到环境变量 token。',
            body: jsonBody({ username: 'demo', password: '123456' }),
            assertions: [
                assertion('status', '', 'eq', 200),
                assertion('json', 'code', 'eq', 0)
            ],
            extracts: [extract('data.token', 'token')],
            responseFields: [
                { path: 'code', type: 'number', desc: '0 表示成功', required: true },
                { path: 'data.token', type: 'string', desc: '登录令牌，放在 Authorization: Bearer 后面', required: true },
                { path: 'data.expiresIn', type: 'number', desc: '有效期（秒）', required: false }
            ],
            examples: [
                { name: '登录成功', body: { code: 0, data: { token: 'tk-{{@uuid}}', expiresIn: 7200 } } },
                { name: '密码错误', status: 401, body: { code: 401, message: '账号或密码错误' } }
            ],
            expectations: [
                { name: '密码不是 123456', conditions: [{ in: 'body', key: 'password', op: 'ne', value: '123456' }], example: 1 }
            ]
        });

        // 当前用户：没带 token、或者 token 是「expired」都回 401（给前置接口试两种触发条件）
        var unauthorized = { code: 401, message: 'token 无效或已过期' };
        var tokenGuard = [
            { name: '没带 token', conditions: [{ in: 'header', key: 'Authorization', op: 'notExists', value: '' }], example: 1 },
            { name: 'token 已过期', conditions: [{ in: 'header', key: 'Authorization', op: 'eq', value: 'Bearer expired' }], example: 1 },
            { name: 'token 是空的', conditions: [{ in: 'header', key: 'Authorization', op: 'eq', value: 'Bearer' }], example: 1 }
        ];

        api(userFolder, {
            name: '当前用户',
            path: '/users/me',
            description: '要带 token。环境里 token 是空的时候，发送前会自动先调「登录」。',
            headers: authHeader,
            assertions: [
                assertion('status', '', 'eq', 200),
                assertion('json', 'data.name', 'exists'),
                assertion('time', '', 'lt', 1000)
            ],
            responseFields: [
                { path: 'data.id', type: 'number', desc: '用户 id', required: true },
                { path: 'data.name', type: 'string', desc: '姓名', required: true },
                { path: 'data.phone', type: 'string', desc: '手机号', required: false },
                { path: 'data.roles[]', type: 'string', desc: '角色', required: false }
            ],
            examples: [
                { name: '成功', body: '{\n  "code": 0,\n  "data": {\n    "id": {{@int(1,9999)}},\n    "name": "{{@cname}}",\n    "phone": "{{@phone}}",\n    "roles": ["admin", "editor"]\n  }\n}' },
                { name: '未登录', status: 401, body: unauthorized }
            ],
            expectations: tokenGuard
        });

        var createUser = api(userFolder, {
            name: '新建用户',
            method: 'POST',
            path: '/users',
            status: 'developing',
            description: '请求体用了中文随机数据：每次发送姓名、手机号、身份证号都不一样（身份证校验位是对的）。\n新建出来的 id 提取到环境变量 userId，后面「用户详情」用它。',
            headers: authHeader,
            body: jsonBody({ name: '{{$中文名}}', phone: '{{$手机号}}', idCard: '{{$身份证}}', email: '{{$邮箱}}', birthday: '{{$日期}}' }),
            assertions: [assertion('json', 'code', 'eq', 0), assertion('json', 'data.name', 'notEmpty')],
            extracts: [extract('data.id', 'userId')],
            examples: [
                { name: '成功', body: '{\n  "code": 0,\n  "data": {\n    "id": {{@int(10000,99999)}},\n    "name": "{{@body(name)}}",\n    "phone": "{{@body(phone)}}"\n  }\n}' },
                { name: '未登录', status: 401, body: unauthorized }
            ],
            expectations: tokenGuard
        });

        var createUserFromData = api(userFolder, {
            name: '新建用户（用测试集数据）',
            method: 'POST',
            path: '/users/import',
            status: 'designing',
            description: '给测试集「批量建用户」用：请求体里的 {{姓名}}、{{手机号}} 来自测试集「数据」页签里 CSV 的中文列名。',
            headers: authHeader,
            body: jsonBody({ name: '{{姓名}}', phone: '{{手机号}}' }),
            assertions: [assertion('json', 'data.name', 'notEmpty')],
            examples: [
                { name: '成功', body: '{\n  "code": 0,\n  "data": {\n    "id": {{@int(10000,99999)}},\n    "name": "{{@body(name)}}",\n    "phone": "{{@body(phone)}}"\n  }\n}' },
                { name: '未登录', status: 401, body: unauthorized }
            ],
            expectations: tokenGuard
        });

        var userList = api(userFolder, {
            name: '用户列表',
            path: '/users',
            description: '分页查询。',
            headers: authHeader,
            query: [row('page', '1', '第几页'), row('size', '10', '每页几条'), row('keyword', '', '按姓名搜索', { enabled: false })],
            assertions: [assertion('json', 'data.list', 'type', 'array')],
            responseFields: [
                { path: 'data.total', type: 'number', desc: '总条数', required: true },
                { path: 'data.list[].id', type: 'number', desc: '用户 id', required: true },
                { path: 'data.list[].name', type: 'string', desc: '姓名', required: true }
            ],
            examples: [
                { name: '成功', body: '{\n  "code": 0,\n  "data": {\n    "total": 52,\n    "list": [\n      {{@repeat(5)}}{ "id": {{@int(1,9999)}}, "name": "{{@cname}}", "city": "{{@city}}" }{{/repeat}}\n    ]\n  }\n}' },
                { name: '未登录', status: 401, body: unauthorized }
            ],
            expectations: tokenGuard
        });

        var userDetail = api(userFolder, {
            name: '用户详情',
            path: '/users/:id',
            description: '路径参数 id 用的是「新建用户」提取出来的 {{userId}}。',
            headers: authHeader,
            pathParams: [row('id', '{{userId}}', '用户 id')],
            assertions: [assertion('status', '', 'eq', 200)],
            examples: [
                { name: '成功', body: '{\n  "code": 0,\n  "data": {\n    "id": "{{@params(id)}}",\n    "name": "{{@cname}}",\n    "company": "{{@company}}",\n    "address": "{{@address}}"\n  }\n}' },
                { name: '未登录', status: 401, body: unauthorized }
            ],
            expectations: tokenGuard
        });

        var createOrder = api(orderFolder, {
            name: '下单',
            method: 'POST',
            path: '/orders',
            description: '下单后把订单号提取到环境变量 orderNo。',
            headers: authHeader,
            body: jsonBody({ userId: '{{userId}}', items: [{ sku: 'SKU-001', count: 2 }], remark: '{{$中文名}} 的测试订单' }),
            assertions: [assertion('json', 'data.orderNo', 'regex', '^NO\\d+$')],
            extracts: [extract('data.orderNo', 'orderNo')],
            examples: [
                { name: '成功', body: '{\n  "code": 0,\n  "data": {\n    "orderNo": "NO{{@int(100000,999999)}}",\n    "amount": {{@price}},\n    "status": "待付款"\n  }\n}' },
                { name: '未登录', status: 401, body: unauthorized }
            ],
            expectations: tokenGuard
        });

        var orderDetail = api(orderFolder, {
            name: '订单详情',
            path: '/orders/:orderNo',
            headers: authHeader,
            pathParams: [row('orderNo', '{{orderNo}}', '订单号')],
            assertions: [assertion('json', 'data.status', 'exists')],
            examples: [
                { name: '成功', body: '{\n  "code": 0,\n  "data": {\n    "orderNo": "{{@params(orderNo)}}",\n    "status": "{{@pick(待付款,已付款,已发货)}}",\n    "createdAt": "{{@datetime}}"\n  }\n}' },
                { name: '未登录', status: 401, body: unauthorized }
            ],
            expectations: tokenGuard
        });

        api(orderFolder, {
            name: '慢接口（压测用）',
            path: '/orders/slow',
            description: 'Mock 固定延迟 200 毫秒，拿来试压测：发送按钮旁的下拉 →「压测…」。',
            mockDelay: 200,
            extra: { noPreflight: true },
            examples: [{ name: '成功', body: { code: 0, data: 'ok' } }]
        });

        api(publicFolder, {
            name: '健康检查',
            path: '/health',
            description: '所在目录设了「不使用前置接口」，发送时不会自动登录。',
            assertions: [assertion('json', 'status', 'eq', 'UP')],
            examples: [{ name: '成功', body: '{\n  "status": "UP",\n  "time": "{{@datetime}}"\n}' }]
        });

        /* ---------------- 项目设置：公共请求头、前置接口 ---------------- */

        var projectExtra = commonHeaders.withHeaders({}, [
            { key: 'X-Client', value: 'apiloop-demo', enabled: true, desc: '公共请求头：项目下所有接口发送时都带上' }
        ]);
        projectExtra.preflight = { apiId: login.id, whenMissing: 'token', retryOn401: true };
        projectsRepo.update(handle, project.id, { extra: projectExtra });

        /* ---------------- 环境 ---------------- */

        var mainEnv = environmentsRepo.create(handle, project.id, {
            name: '样例环境',
            variables: [
                row('host', mockBase, '这个项目的 Mock 地址'),
                row('token', '', '登录后自动填（前置接口）'),
                row('userId', '', '「新建用户」提取'),
                row('orderNo', '', '「下单」提取')
            ]
        });
        environmentsRepo.create(handle, project.id, {
            name: '样例环境（token 已过期）',
            variables: [
                row('host', mockBase, '这个项目的 Mock 地址'),
                row('token', 'expired', '故意放一个过期的 token：发送时第一次 401，自动登录后重发'),
                row('userId', '', '')
            ]
        });

        /* ---------------- 测试集 ---------------- */

        function step(apiRow, extra) {
            return Object.assign({
                id: id('st'), apiId: apiRow.id, enabled: true, onFail: 'continue', delayMs: 0, assertions: [], extracts: []
            }, extra || {});
        }

        suitesRepo.create(handle, project.id, {
            name: '下单流程',
            description: '新建用户 → 查用户 → 下单 → 查订单。第一步发现没有 token 会自动登录（前置接口），之后的步骤不再登录。',
            steps: [
                step(createUser, { onFail: 'skipIteration' }),
                step(userDetail),
                step(userList),
                step(createOrder, { onFail: 'skipIteration', assertions: [assertion('time', '', 'lt', 2000)] }),
                step(orderDetail)
            ],
            settings: { iterations: 1, delayMs: 0 }
        });

        suitesRepo.create(handle, project.id, {
            name: '批量建用户（数据驱动）',
            description: '「数据」页签里是一份 CSV（列名是中文），每一行跑一轮。',
            steps: [step(createUserFromData)],
            data: {
                format: 'csv',
                fileName: '用户.csv',
                text: '姓名,手机号\n张三,13800000001\n李四,13800000002\n王五,13800000003\n'
            },
            settings: { iterations: 1, delayMs: 0 }
        });

        return { project: projectsRepo.getById(handle, project.id), environmentId: mainEnv.id };
    }, { projectId: null });
}

module.exports = {
    createDemoProject: createDemoProject
};
