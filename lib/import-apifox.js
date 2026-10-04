/**
 * Apifox 导出的「Apifox 格式」JSON（第九轮第 1 节）。
 *
 * **这份解析是「认得的转、认不出的列出来」的写法**，原因写在下面这段里，改动前先读：
 *
 * Apifox 的导出文件要登录账号才能拿到，本机没法造一份**真的**样本，所以这里的字段名来自
 * 两处：计划里点明的顶层结构（`apiCollection` / `environments` / `schemaCollection` /
 * `apiTestCaseCollection`），以及 Apifox 自己公开的数据模型（接口带 `parameters` /
 * `requestBody` / `responses`，响应示例在 `responseExamples` 里）。**没有一处是猜的**，
 * 但也没法保证每个字段都跟最新版的导出文件完全一致 —— 所以：
 *
 * - 每个字段都按**几个常见别名**去取（`name`/`title`、`items`/`children`、`schema`/`jsonSchema`……）；
 * - **取不到的一律进 `warnings`**，宁可少导一个接口，也不导一个字段对不上的接口
 *   ——「导进来了但是错的」比「没导进来」难发现得多（计划里就是这么要求的）；
 * - 对不上的操作（数据库操作、提取变量、断言对象……）**不硬转**，列进「没有导入」。
 *
 * 真机验过之后要补的地方：`parameters` 里 `in` 的取值、`responses` 是数组还是对象、
 * `responseExamples` 的元素形状。这三处一变，解析要跟着调（其它都是通用的）。
 *
 * 输出同样是 `lib/tree.js` 的 `writeTree` 认得的那棵树，落库走现有导入那一套。
 */

var importers = require('./importers');
var urlUtils = require('./url-utils');

var MANAGED_HEADERS = ['content-type', 'authorization', 'cookie'];

/** 前后置操作里认得的类型 → 我们的脚本阶段；别的类型都不硬转 */
var SCRIPT_PHASES = { script: 'prerequest', preRequestScript: 'prerequest', postResponseScript: 'test' };

function str(value) {
    return value === undefined || value === null ? '' : String(value);
}

function isObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function firstOf(source, keys) {
    if (!isObject(source)) return undefined;
    for (var i = 0; i < keys.length; i += 1) {
        if (source[keys[i]] !== undefined && source[keys[i]] !== null) return source[keys[i]];
    }
    return undefined;
}

function listOf(source, keys) {
    var value = firstOf(source, keys);
    if (Array.isArray(value)) return value;
    if (isObject(value)) return Object.keys(value).map(function (key) { return value[key]; });
    return [];
}

function parseJson(text) {
    try {
        return JSON.parse(text);
    } catch (err) {
        throw new Error('不是合法的 JSON：' + err.message);
    }
}

/** 顶层有 `apiCollection` 数组就是 Apifox 格式（Postman 的顶层是对象，不会撞） */
function detect(data) {
    if (!isObject(data)) return false;
    if (!Array.isArray(data.apiCollection)) return false;
    return true;
}

/* ---------------------------------------------------------------- 数据模型（schemaCollection） */

/**
 * 数据模型表：按名字和 id 都能查到。
 *
 * Apifox 的接口里用 `$ref` 引用数据模型，引用写法几种版本不太一样
 * （`#/schemaCollection/xxx`、`#/definitions/xxx`、直接写名字），这里都试一遍。
 */
function buildSchemas(data) {
    var byKey = {};
    var list = Array.isArray(data.schemaCollection) ? data.schemaCollection : [];

    list.forEach(function (item) {
        if (!isObject(item)) return;
        var name = str(firstOf(item, ['name', 'title']));
        var id = str(item.id);
        var schema = firstOf(item, ['schema', 'jsonSchema', 'content']);

        if (name && schema !== undefined) byKey[name] = schema;
        if (id && schema !== undefined) byKey[id] = schema;
    });

    return {
        byKey: byKey,
        count: list.length,
        /** `$ref` 里最后那一段的名字 / id */
        resolve: function (ref) {
            var text = str(ref);
            if (!text) return null;
            var tail = text.split('/').filter(Boolean).pop() || '';
            return byKey[tail] || byKey[text] || null;
        }
    };
}

/**
 * 把 schema 里的 `$ref` 就地展开成数据模型的内容。
 *
 * 不展开的话 `schemaToMock` 只能给出 `{}`（它认的是 OpenAPI 那种
 * `#/components/schemas/xxx`），示例会全空。
 */
function expandRefs(node, schemas, depth, seen) {
    var level = depth || 0;
    var guard = seen || [];

    if (level > 8 || !node || typeof node !== 'object') return node;

    if (typeof node.$ref === 'string') {
        if (guard.indexOf(node.$ref) > -1) return {};
        var target = schemas.resolve(node.$ref);
        if (!target) return {};
        return expandRefs(target, schemas, level + 1, guard.concat([node.$ref]));
    }

    if (Array.isArray(node)) {
        return node.map(function (item) { return expandRefs(item, schemas, level + 1, guard); });
    }

    var out = {};
    Object.keys(node).forEach(function (key) {
        out[key] = expandRefs(node[key], schemas, level + 1, guard);
    });
    return out;
}

/* ---------------------------------------------------------------- 参数与请求体 */

function toRow(name, value, desc, required, type) {
    return {
        key: str(name),
        value: str(value),
        type: str(type) || 'string',
        required: required === true || required === '1' || required === 1,
        desc: str(desc),
        enabled: true
    };
}

/** 参数的示例值：`example` / `examples` / `defaultValue` / `schema.example` 都试一遍 */
function paramExample(param) {
    var value = firstOf(param, ['example', 'defaultValue', 'default']);
    if (value !== undefined && value !== '') return value;

    var examples = firstOf(param, ['examples']);
    if (Array.isArray(examples) && examples.length) {
        var first = examples[0];
        return isObject(first) ? firstOf(first, ['value', 'data']) : first;
    }
    if (isObject(examples)) {
        var keys = Object.keys(examples);
        if (keys.length) {
            var item = examples[keys[0]];
            return isObject(item) ? firstOf(item, ['value', 'data']) : item;
        }
    }

    var schema = firstOf(param, ['schema']);
    if (isObject(schema)) {
        var fromSchema = firstOf(schema, ['example', 'default']);
        if (fromSchema !== undefined && fromSchema !== '') return fromSchema;
    }
    return '';
}

/** 参数在哪儿：`in` / `location` / `position` 都见过 */
function paramWhere(param) {
    var value = str(firstOf(param, ['in', 'location', 'position', 'paramType', 'type'])).toLowerCase();
    if (value.indexOf('path') > -1) return 'path';
    if (value.indexOf('header') > -1) return 'header';
    if (value.indexOf('cookie') > -1) return 'cookie';
    return 'query';
}

function collectParams(node, ctx) {
    var params = listOf(node, ['parameters', 'params']).filter(isObject);
    var rows = { query: [], path: [], header: [] };
    var cookies = 0;

    params.forEach(function (param) {
        var name = str(firstOf(param, ['name', 'key']));
        if (!name) return;

        var where = paramWhere(param);
        var row = toRow(name, paramExample(param), firstOf(param, ['description', 'desc']),
            firstOf(param, ['required']), firstOf(param, ['type']));

        if (where === 'path') rows.path.push(row);
        else if (where === 'header') {
            if (MANAGED_HEADERS.indexOf(name.toLowerCase()) === -1) rows.header.push(row);
        } else if (where === 'cookie') cookies += 1;
        else rows.query.push(row);
    });

    if (cookies) ctx.cookies += cookies;
    return rows;
}

/** 请求体。`type` 是媒体类型（`application/json` 这些），也见过 `json` / `form` 这种简写 */
function bodyOf(node, schemas, ctx) {
    var body = firstOf(node, ['requestBody', 'body']);
    if (!isObject(body)) return { mode: 'none' };

    var media = str(firstOf(body, ['type', 'contentType', 'mediaType'])).toLowerCase();
    var form = listOf(body, ['parameters', 'form', 'fields']).filter(isObject);

    if (media.indexOf('form') > -1 || (!media && form.length)) {
        if (!form.length) return { mode: 'none' };

        var hasFile = form.some(function (row) {
            return str(firstOf(row, ['type', 'kind'])).toLowerCase().indexOf('file') > -1;
        });
        if (hasFile) ctx.fileForms += 1;

        return {
            mode: hasFile ? 'formdata' : 'urlencoded',
            form: form.map(function (row) {
                var kind = str(firstOf(row, ['type', 'kind'])).toLowerCase().indexOf('file') > -1 ? 'file' : 'text';
                return {
                    key: str(firstOf(row, ['name', 'key'])),
                    value: kind === 'file' ? '' : str(paramExample(row)),
                    type: 'string',
                    kind: kind,
                    src: null,
                    required: firstOf(row, ['required']) === true,
                    desc: str(firstOf(row, ['description', 'desc'])),
                    enabled: true
                };
            }).filter(function (row) { return row.key !== ''; })
        };
    }

    if (media.indexOf('xml') > -1 || media.indexOf('text') > -1 || media.indexOf('raw') > -1) {
        var text = firstOf(body, ['example', 'raw', 'content']);
        if (typeof text !== 'string') text = '';
        return text.trim()
            ? { mode: 'raw', raw: text, language: media.indexOf('xml') > -1 ? 'xml' : 'text' }
            : { mode: 'none' };
    }

    // 剩下的都按 JSON 处理（application/json 是绝大多数情况）
    var example = firstOf(body, ['example', 'examples']);
    if (typeof example === 'string' && example.trim()) {
        return { mode: 'raw', raw: example, language: 'json' };
    }
    if (isObject(example)) {
        return { mode: 'raw', raw: JSON.stringify(example, null, 2), language: 'json' };
    }
    if (Array.isArray(example) && example.length) {
        var firstExample = example[0];
        var value = isObject(firstExample) ? firstOf(firstExample, ['data', 'value', 'body']) : firstExample;
        if (typeof value === 'string' && value.trim()) return { mode: 'raw', raw: value, language: 'json' };
        if (isObject(value)) return { mode: 'raw', raw: JSON.stringify(value, null, 2), language: 'json' };
    }

    var schema = firstOf(body, ['jsonSchema', 'schema']);
    if (isObject(schema)) {
        var expanded = expandRefs(schema, schemas, 0, []);
        // 请求体用普通示例值，不用 Mock 模板（发送时没人替换 `{{@…}}`，见 importers.schemaToExample）
        return { mode: 'raw', raw: JSON.stringify(importers.schemaToExample(expanded, expanded), null, 2), language: 'json' };
    }

    return { mode: 'none' };
}

/* ---------------------------------------------------------------- 响应 */

/** 响应示例：`responseExamples` 可能是数组，也可能是「名字 → 内容」的对象 */
function examplesFromResponse(response, schemas) {
    var raw = firstOf(response, ['responseExamples', 'examples', 'example']);

    if (Array.isArray(raw)) {
        return raw.map(function (item) {
            if (!isObject(item)) {
                return { name: '示例', body: typeof item === 'string' ? item : JSON.stringify(item, null, 2) };
            }
            var body = firstOf(item, ['data', 'body', 'value', 'content', 'example']);
            return {
                name: str(firstOf(item, ['name', 'title'])) || '示例',
                code: Number(firstOf(item, ['code', 'status'])) || 0,
                body: typeof body === 'string' ? body : JSON.stringify(body === undefined ? {} : body, null, 2)
            };
        });
    }

    if (isObject(raw)) {
        return Object.keys(raw).map(function (key) {
            var body = raw[key];
            return {
                name: key || '示例',
                code: 0,
                body: typeof body === 'string' ? body : JSON.stringify(body, null, 2)
            };
        });
    }

    if (typeof raw === 'string' && raw.trim()) {
        return [{ name: '示例', code: 0, body: raw }];
    }

    // 没有示例就按 schema 生成一份，至少 Mock 能直接返回
    var schema = firstOf(response, ['schema', 'jsonSchema', 'content']);
    if (isObject(schema)) {
        var expanded = expandRefs(schema, schemas, 0, []);
        return [{
            name: '默认',
            code: 0,
            body: importers.schemaToMock(expanded, expanded, 0, 0, []),
            schema: expanded
        }];
    }

    return [];
}

function responseCode(response) {
    var code = Number(firstOf(response, ['code', 'status', 'httpCode']));
    return Number.isFinite(code) && code >= 100 && code <= 599 ? code : 0;
}

/** 收集所有响应 → 示例列表（第一个 2xx 会成为 Mock 的返回） */
function collectResponses(node, schemas, ctx) {
    var responses = listOf(node, ['responses', 'response']).filter(isObject);
    var examples = [];

    responses.forEach(function (response) {
        var code = responseCode(response);
        var items = examplesFromResponse(response, schemas);

        items.forEach(function (item) {
            examples.push({
                name: items.length > 1 ? str(item.name) : (str(response.name) || item.name || '默认'),
                status: code || item.code || 200,
                headers: [],
                body: item.body,
                responseType: /^\s*[<{[]/.test(item.body) ? 'json' : 'text',
                source: 'imported'
            });
        });
    });

    // 2xx 排前面（第一个就是 Mock 的返回）
    examples.sort(function (a, b) {
        var a2 = a.status >= 200 && a.status < 300 ? 0 : 1;
        var b2 = b.status >= 200 && b.status < 300 ? 0 : 1;
        return a2 - b2;
    });

    if (!examples.length && responses.length) ctx.noExample += 1;
    return examples;
}

function responseFieldsOf(node, schemas) {
    var responses = listOf(node, ['responses', 'response']).filter(isObject);
    var picked = responses.filter(function (response) {
        var code = responseCode(response);
        return code >= 200 && code < 300;
    })[0] || responses[0];

    if (!picked) return [];

    var schema = firstOf(picked, ['schema', 'jsonSchema']);
    if (!isObject(schema)) return [];

    var expanded = expandRefs(schema, schemas, 0, []);
    return importers.responseFieldsFromSchema(expanded, expanded);
}

/* ---------------------------------------------------------------- 前后置操作 */

/**
 * 前后置操作 → 脚本。
 *
 * Apifox 的脚本 API 和我们的 `pm.*` 基本一致（`pm.test` / `pm.response.json()` /
 * `pm.environment.set`……），所以**只有自定义脚本能直接搬**。别的类型：
 * - 断言 / 提取变量：Apifox 那边是结构化的对象，形状和我们的可视化断言对不上，
 *   **不硬转**，只报「没有导入」（硬转出来一条永远通过的断言更糟）；
 * - 数据库操作、等待、自定义请求：同样列出来。
 */
function collectProcessors(node, ctx) {
    var scripts = [];

    [['preProcessors', 'prerequest'], ['postProcessors', 'test']].forEach(function (pair) {
        listOf(node, [pair[0]]).forEach(function (processor) {
            if (!isObject(processor)) return;

            var type = str(firstOf(processor, ['type', 'processorType', 'kind']));
            var exec = firstOf(processor, ['script', 'content', 'code', 'exec']);

            /*
             * 阶段看**它在哪个数组里**，不看类型名：Apifox 里前置和后置的自定义脚本
             * `type` 都叫 `script`，只有少数版本会写成 `preRequestScript` /
             * `postResponseScript`。按类型名决定的话，后置脚本会被塞进「请求前」——
             * 自测里就是这么抓出来的（`pm.test` 跑到请求前，断言永远不生效）。
             */
            var listen = pair[1];
            if (type === 'preRequestScript') listen = 'prerequest';
            else if (type === 'postResponseScript') listen = 'test';

            if (type === 'script' || SCRIPT_PHASES[type] || (typeof exec === 'string' && exec.trim())) {
                if (typeof exec === 'string' && exec.trim()) {
                    scripts.push({ listen: listen, exec: exec });
                    ctx.scripts += 1;
                }
                return;
            }

            // 认不出的操作：按类型归一类，最后统一说一句
            var label = type || '未知操作';
            if (ctx.skipped[label] === undefined) ctx.skipped[label] = 0;
            ctx.skipped[label] += 1;
        });
    });

    return scripts;
}

/* ---------------------------------------------------------------- 环境 */

/**
 * 环境 → 环境。
 *
 * `baseUrl` 变成变量 `host`（地址里那一截会换成 `{{host}}`，见 `applyBaseUrl`）；
 * 其余的变量原样带过来（Apifox 的变量有 `name` / `value`，没有 `key`）。
 */
function collectEnvironments(data, stats) {
    var list = Array.isArray(data.environments) ? data.environments : [];
    var environments = [];

    list.forEach(function (item) {
        if (!isObject(item)) return;

        var name = str(firstOf(item, ['name', 'title']));
        if (!name) return;

        var baseUrl = str(firstOf(item, ['baseUrl', 'baseURL', 'host']));
        var rows = [];

        if (baseUrl) {
            rows.push({ key: 'host', value: baseUrl.replace(/\/+$/, ''), type: 'string', required: false, desc: '服务地址', enabled: true });
        }

        listOf(item, ['variables', 'variable']).forEach(function (variable) {
            if (!isObject(variable)) return;
            var key = str(firstOf(variable, ['name', 'key']));
            if (!key) return;
            // baseUrl 已经变成 host 了，别重复
            if (key === 'host' && baseUrl) return;

            rows.push({
                key: key,
                value: str(firstOf(variable, ['value', 'defaultValue'])),
                type: 'string',
                required: false,
                desc: str(firstOf(variable, ['description', 'desc'])),
                enabled: firstOf(variable, ['enabled']) !== false
            });
        });

        environments.push({ name: name, variables: rows, baseUrl: baseUrl.replace(/\/+$/, '') });
    });

    stats.environments = environments.length;
    return environments;
}

/**
 * 地址要不要带 `{{host}}`。
 *
 * Apifox 里接口的 `path` 通常只是 `/api/order`，域名在环境的 `baseUrl` 上 —— 所以：
 * - 地址以某个环境的 baseUrl 开头 → 把那一段换成 `{{host}}`（换环境就换域名）；
 * - 地址是**相对**的（`/xxx`）且至少有一个环境给了 baseUrl → 前面补 `{{host}}`；
 * - 地址自己带了别的域名 → **原样留着**（那多半是有意写死的第三方地址）。
 *
 * 一个 baseUrl 都没有时**不加** `{{host}}`：那样地址里会多出一个没处定义的变量。
 */
function applyBaseUrl(url, baseUrls) {
    var text = str(url);
    var bases = (baseUrls || []).filter(Boolean).sort(function (a, b) { return b.length - a.length; });
    if (!text) return text;

    var hit = bases.filter(function (base) { return text.indexOf(base) === 0; })[0];
    if (hit) return '{{host}}' + text.slice(hit.length);

    if (!bases.length) return text;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(text)) return text;
    if (text.charAt(0) !== '/') return text;

    return '{{host}}' + text;
}

/* ---------------------------------------------------------------- 主流程 */

function isApiNode(node) {
    return Boolean(firstOf(node, ['method'])) || Boolean(firstOf(node, ['path', 'url', 'endpoint']));
}

function isFolderNode(node) {
    return Array.isArray(firstOf(node, ['items', 'children', 'apis', 'apiCollection']));
}

/**
 * 解析一份 Apifox 导出文件。
 *
 * @param {string|object} input
 * @returns {{kind: 'collection', format: 'apifox', collection: object, stats: object,
 *   warnings: string[], environments: Array}}
 */
function parse(input) {
    var data = typeof input === 'string' ? parseJson(input) : input;
    if (!detect(data)) {
        throw new Error('这不是 Apifox 导出的 JSON：顶层应该有 apiCollection 数组');
    }

    var schemas = buildSchemas(data);
    var warnings = [];
    var stats = { folders: 0, apis: 0, examples: 0, scripts: 0, environments: 0 };
    var counters = { fileForms: 0, cookies: 0, noExample: 0, skipped: {}, unknownNodes: 0 };

    function warn(text) {
        if (warnings.indexOf(text) === -1) warnings.push(text);
    }

    var environments = collectEnvironments(data, stats);
    var baseUrls = environments.map(function (env) { return env.baseUrl; }).filter(Boolean);

    var skipped = {};

    function toApi(node, folderPath) {
        var name = str(firstOf(node, ['name', 'title'])) || str(firstOf(node, ['path', 'url'])) || '未命名接口';
        var path = str(firstOf(node, ['path', 'url', 'endpoint']));
        var method = str(firstOf(node, ['method'])).toUpperCase();

        if (!path) {
            counters.unknownNodes += 1;
            warn('「' + name + '」没有地址，跳过了');
            return null;
        }
        if (!method) {
            counters.unknownNodes += 1;
            warn('「' + name + '」没有请求方法，跳过了');
            return null;
        }

        var ctx = {
            scripts: 0,
            fileForms: 0,
            cookies: 0,
            noExample: 0,
            skipped: skipped
        };

        var params = collectParams(node, ctx);
        var examples = collectResponses(node, schemas, ctx);
        var scripts = collectProcessors(node, ctx);

        counters.fileForms += ctx.fileForms;
        counters.cookies += ctx.cookies;
        counters.noExample += ctx.noExample;
        stats.apis += 1;
        stats.examples += examples.length;
        stats.scripts += ctx.scripts;

        var status = str(firstOf(node, ['status'])).toLowerCase();
        var mapped = 'developing';
        if (status === 'designing') mapped = 'designing';
        else if (status === 'released' || status === 'done' || status === 'published') mapped = 'done';
        else if (status === 'deprecated' || status === 'obsolete') mapped = 'deprecated';

        return {
            type: 'api',
            name: name,
            description: str(firstOf(node, ['description', 'desc'])),
            method: method,
            url: applyBaseUrl(path, baseUrls),
            params: {
                path: params.path,
                query: params.query,
                headers: params.header
            },
            body: bodyOf(node, schemas, ctx),
            auth: null,
            scripts: scripts,
            mockPath: urlUtils.deriveMockPath(path),
            examples: examples,
            status: mapped,
            responseFields: responseFieldsOf(node, schemas),
            extra: {}
        };
    }

    function walk(nodes, path) {
        var children = [];

        (nodes || []).forEach(function (node) {
            if (!isObject(node)) return;

            if (isFolderNode(node)) {
                stats.folders += 1;
                var folderName = str(firstOf(node, ['name', 'title'])) || '未命名目录';
                var nextPath = path.concat([folderName]);
                var sub = walk(firstOf(node, ['items', 'children', 'apis', 'apiCollection']), nextPath);

                children.push({
                    type: 'folder',
                    name: folderName,
                    description: str(firstOf(node, ['description', 'desc'])),
                    children: sub
                });
                return;
            }

            if (isApiNode(node)) {
                var api = toApi(node, path);
                if (api) children.push(api);
                return;
            }

            counters.unknownNodes += 1;
            warn('有不认识的内容（既不是目录也不是接口），跳过了');
        });

        return children;
    }

    var children = walk(data.apiCollection, []);

    if (!stats.apis) throw new Error('这份 Apifox 文件里没有解析到任何接口');

    /* ---- 没有导入的东西，一条条说清楚 ---- */

    Object.keys(skipped).forEach(function (type) {
        warn('有 ' + skipped[type] + ' 处「' + type + '」操作没有导入（和我们的断言 / 提取对不上）');
    });

    var testCases = (Array.isArray(data.apiTestCaseCollection) ? data.apiTestCaseCollection.length : 0);
    var scenarios = (Array.isArray(data.apiTestScenarioCollection) ? data.apiTestScenarioCollection.length : 0);
    if (testCases || scenarios) {
        warn('测试用例（' + testCases + ' 个）和测试场景（' + scenarios + ' 个）这一轮不导入');
    }
    if (schemas.count) {
        warn('数据模型（' + schemas.count + ' 个）已经按引用展开到接口里了，没有单独建成模型');
    }
    if (counters.cookies) {
        warn('有 ' + counters.cookies + ' 个 cookie 参数没有导入（Cookie 在 Cookie 管理器里配）');
    }
    if (counters.fileForms) {
        warn('有 ' + counters.fileForms + ' 个接口的请求体是文件上传，文件行没有值（运行时自己选文件）');
    }
    if (counters.noExample) {
        warn('有 ' + counters.noExample + ' 个接口的响应里既没有示例也没有 schema，没有生成示例响应');
    }

    return {
        kind: 'collection',
        format: 'apifox',
        collection: {
            name: str(firstOf(data.info, ['name'])) || 'Apifox 导入',
            description: str(firstOf(data.info, ['description'])) ||
                ('从 Apifox 导出导入（' + stats.folders + ' 个目录、' + stats.apis + ' 个接口）'),
            children: children
        },
        environments: environments.map(function (env) {
            return { name: env.name, variables: env.variables };
        }),
        stats: stats,
        warnings: warnings
    };
}

module.exports = {
    detect: detect,
    parse: parse,
    expandRefs: expandRefs
};
