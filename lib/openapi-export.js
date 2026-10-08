/**
 * 导出 OpenAPI 3.0.3（第四轮第 2 节）。
 *
 * **这个文件是纯的**：不读库、不碰请求，只把已经准备好的数据（项目 / 目录 / 接口 / 示例）
 * 转成一份 OpenAPI 文档。要库的那些在 `lib/api/postman.js` 的路由里读好再传进来 ——
 * 这样转换规则能单独测，也能在别处复用（比如以后「导出整个项目」以外的范围）。
 *
 * 三条贯穿全篇的约定：
 *
 *   - **变量原样保留**：`{{host}}` 这种写法是给导入方自己替换的，不解析、不展开；
 *     它出现在地址开头时就变成 servers 里的一条 `{ url: '{{host}}' }`。
 *   - **不导出任何凭据**：鉴权只出类型（`securitySchemes` + `security`），值一个都不带；
 *     请求体、示例、参数里的值都是用户自己写的东西（可能含 `{{变量}}`）。
 *   - **跳过的东西要说出来**：同一「方法 + 路径」有多个接口时只导第一个，
 *     其余的连同 WebSocket 接口一起记进 `skipped`，输出时放进注释 / `x-apiloop-skipped`。
 */

/** raw 请求体：language → content-type */
var CONTENT_TYPE_BY_LANGUAGE = {
    json: 'application/json',
    xml: 'application/xml',
    html: 'text/html',
    javascript: 'application/javascript',
    text: 'text/plain'
};

/** 示例：responseType → content-type（ws 不是 HTTP，压根不会走到这里） */
var CONTENT_TYPE_BY_RESPONSE = {
    json: 'application/json',
    html: 'text/html',
    text: 'text/plain',
    sse: 'text/event-stream'
};

/**
 * 这些请求头不进 parameters。
 *
 * Content-Type 由 requestBody 的 content 表达；Authorization / Cookie 是鉴权与 Cookie
 * 自动管理写进去的，用户手写的那份进文档只会和 securitySchemes 打架。
 */
var SKIP_HEADERS = ['content-type', 'authorization', 'cookie'];

var MAX_DEPTH = 64;
var OPENAPI_VERSION = '3.0.3';

/* ------------------------------------------------------------------ 小工具 */

function text(value) {
    return value === undefined || value === null ? '' : String(value);
}

function trimmed(value) {
    return text(value).trim();
}

/** 空串 / undefined / 空对象都不写进操作里，输出干净一点 */
function omitEmpty(object) {
    Object.keys(object).forEach(function (key) {
        var value = object[key];
        if (value === undefined || value === null || value === '') delete object[key];
        else if (Array.isArray(value) && !value.length) delete object[key];
        else if (typeof value === 'object' && !Array.isArray(value) && !Object.keys(value).length) {
            delete object[key];
        }
    });
    return object;
}

/**
 * 超出安全整数范围的整数（19 位雪花 ID）保留原文、变成字符串：直接 JSON.parse 会把
 * `12345678901234567890` 变成 `12345678901234567000`，导出的示例里 ID 就是错的。
 * 用的是 JSON.parse 第三个参数 `context.source`（Node 22 起有）；没有就照常给数字。
 */
function keepHugeIntegers(key, value, context) {
    if (typeof value === 'number' && !Number.isSafeInteger(value) &&
        context && typeof context.source === 'string' && /^-?\d+$/.test(context.source)) {
        return context.source;
    }
    return value;
}

function tryJson(source) {
    try {
        return { ok: true, value: JSON.parse(source, keepHugeIntegers) };
    } catch (err) {
        return { ok: false, value: null };
    }
}

/* ------------------------------------------------------------------ 路径与服务器 */

/**
 * 接口地址 → OpenAPI 的路径。
 *
 * 去掉开头的 `{{变量}}` / `http(s)://主机[:端口]`，去掉查询串和 `#` 后面；
 * 路径里的 `:id` 和 `{{id}}` 都变成 `{id}`。去完是空的就是 `/`。
 */
function toPath(url) {
    var value = trimmed(url).split('#')[0].split('?')[0];

    // 开头可能连着好几段（`{{host}}` 之后又跟一个主机），循环剥
    var guard = 0;
    while (guard++ < 8) {
        var next = value.replace(/^\s*\{\{\s*[\w.\-]+\s*\}\}/, '');
        next = next.replace(/^\s*https?:\/\/[^\s/?#{}]*/i, '');
        if (next === value) break;
        value = next;
    }

    value = value.replace(/\{\{\s*([\w.\-]+)\s*\}\}/g, '{$1}');
    value = value.replace(/(^|\/):([\w-]+)/g, '$1{$2}');

    if (!value) return '/';
    return value.charAt(0) === '/' ? value : '/' + value;
}

/** 路径里的占位符，按出现顺序去重 */
function pathTokens(path) {
    var names = [];
    var pattern = /\{([^{}]+)\}/g;
    var matched = pattern.exec(path);

    while (matched) {
        var name = String(matched[1]).trim();
        if (name && names.indexOf(name) === -1) names.push(name);
        matched = pattern.exec(path);
    }
    return names;
}

/**
 * 地址里出现过的服务器：字面主机 `https://api.example.com` 原样收；
 * 开头是 `{{host}}` 这类变量的，收一条带说明的（同名只放一次）。
 */
function collectServers(url, addServer) {
    var value = text(url);

    var origin = /https?:\/\/[^\s/?#{}]+/gi;
    var matched = origin.exec(value);
    while (matched) {
        addServer(matched[0], null);
        matched = origin.exec(value);
    }

    var leading = /^\s*\{\{\s*([\w.\-]+)\s*\}\}/.exec(value);
    if (leading) addServer('{{' + leading[1] + '}}', '变量，导入方自己替换');
}

/* ------------------------------------------------------------------ schema 推断 */

/**
 * 按示例值推断一个简单 schema：对象 → properties，数组 → items（拿第一个元素），
 * 整数 integer、小数 number、布尔 boolean、null → nullable string。
 *
 * 只做一层层递归，不猜 format —— 猜错了比不猜更糟。
 */
function schemaOf(value) {
    if (value === null) return { type: 'string', nullable: true };

    if (Array.isArray(value)) {
        return { type: 'array', items: value.length ? schemaOf(value[0]) : { type: 'string' } };
    }

    if (typeof value === 'object') {
        var properties = {};
        Object.keys(value).forEach(function (key) { properties[key] = schemaOf(value[key]); });
        return { type: 'object', properties: properties };
    }

    if (typeof value === 'number') return Number.isInteger(value) ? { type: 'integer' } : { type: 'number' };
    if (typeof value === 'boolean') return { type: 'boolean' };
    return { type: 'string' };
}

/* ------------------------------------------------------------------ 鉴权 */

/**
 * 鉴权的类型 → securityScheme。**只出类型，不出值**。
 *
 * 返回值里带一个 `name`（components 里的键名）和 scheme 本身；`noauth` / 没配 / 不认识的
 * 类型都返回 null（那种接口不加 security）。
 */
function schemeFor(auth) {
    if (!auth || !auth.type) return null;

    if (auth.type === 'bearer') {
        return { name: 'bearerAuth', scheme: { type: 'http', scheme: 'bearer' } };
    }
    if (auth.type === 'basic') {
        return { name: 'basicAuth', scheme: { type: 'http', scheme: 'basic' } };
    }
    if (auth.type === 'apikey') {
        var where = auth.in === 'query' ? 'query' : 'header';
        return {
            name: where === 'query' ? 'apiKeyQueryAuth' : 'apiKeyHeaderAuth',
            scheme: {
                type: 'apiKey',
                in: where,
                // 头的名字不是凭据（值才是），给出去文档才有用
                name: trimmed(auth.key) || (where === 'query' ? 'api_key' : 'X-API-Key')
            }
        };
    }
    return null;
}

/* ------------------------------------------------------------------ 参数 / 请求体 / 响应 */

function enabledRows(rows) {
    if (!Array.isArray(rows)) return [];
    return rows.filter(function (row) { return row && row.enabled !== false && trimmed(row.key); });
}

function findRow(rows, key) {
    var found = enabledRows(rows).filter(function (row) { return trimmed(row.key) === key; })[0];
    return found || null;
}

/**
 * query / path / header 三类参数。类型一律 string（我们本来也没有类型系统），
 * path 的 required 固定 true（OpenAPI 要求），值就是表里的 example（变量原样）。
 *
 * **继承来的公共请求头也作为 header 参数导出**（第五轮第 1 节）：调用方把已经解析好的
 * 继承结果放在 `api.inheritedHeaders`（每行带 `shadowed` / `enabled`，见 lib/common-headers.js）。
 * 被接口自己的同名行盖掉的、以及停用的那些不进来 —— 它们不是实际会发的。
 */
function toParameters(api, tokens) {
    var params = api.params || {};
    var out = [];

    tokens.forEach(function (name) {
        var row = findRow(params.path, name);
        var param = { name: name, in: 'path', required: true, schema: { type: 'string' } };
        if (row && trimmed(row.desc)) param.description = trimmed(row.desc);
        if (row && trimmed(row.value)) param.example = text(row.value);
        out.push(param);
    });

    enabledRows(params.query).forEach(function (row) {
        var param = { name: trimmed(row.key), in: 'query', schema: { type: 'string' } };
        if (trimmed(row.desc)) param.description = trimmed(row.desc);
        if (trimmed(row.value)) param.example = text(row.value);
        out.push(param);
    });

    var seen = {};
    function pushHeaderRow(row, fromCommon) {
        var name = trimmed(row.key);
        var lower = name.toLowerCase();
        if (!name || seen[lower]) return;
        if (SKIP_HEADERS.indexOf(lower) !== -1) return;

        seen[lower] = true;
        var param = { name: name, in: 'header', schema: { type: 'string' } };
        if (trimmed(row.desc)) param.description = trimmed(row.desc);
        if (fromCommon) param.description = param.description || '公共请求头';
        if (trimmed(row.value)) param.example = text(row.value);
        out.push(param);
    }

    enabledRows(params.headers).forEach(function (row) { pushHeaderRow(row, false); });

    (api.inheritedHeaders || []).forEach(function (row) {
        if (row.shadowed || row.enabled === false) return;
        pushHeaderRow(row, true);
    });

    return out;
}

/** 一个 media object：schema 有、example 或 examples 二选一 */
function toRequestBody(body) {
    var input = body || {};
    var mode = trimmed(input.mode) || 'none';

    if (mode === 'raw') {
        var language = trimmed(input.language) || 'text';
        var type = CONTENT_TYPE_BY_LANGUAGE[language] || 'text/plain';
        var raw = text(input.raw);

        if (language === 'json') {
            var parsed = tryJson(raw);
            return {
                content: buildMedia('application/json', parsed.ok
                    ? { example: parsed.value, schema: schemaOf(parsed.value) }
                    : { example: raw, schema: { type: 'string' } })
            };
        }

        return { content: buildMedia(type, { example: raw, schema: { type: 'string' } }) };
    }

    if (mode === 'urlencoded' || mode === 'formdata') {
        var formType = mode === 'urlencoded'
            ? 'application/x-www-form-urlencoded'
            : 'multipart/form-data';
        var properties = {};

        enabledRows(input.form).forEach(function (row) {
            properties[trimmed(row.key)] = row.kind === 'file'
                ? { type: 'string', format: 'binary' }
                : { type: 'string' };
        });

        return { content: buildMedia(formType, { schema: { type: 'object', properties: properties } }) };
    }

    if (mode === 'binary') {
        return {
            content: {
                'application/octet-stream': { schema: { type: 'string', format: 'binary' } }
            }
        };
    }

    if (mode === 'graphql') {
        // 计划里没点名 graphql；按约定俗成的「POST + JSON 的 {query, variables}」导，
        // 总比把请求体整块丢掉强
        var graphql = input.graphql || {};
        var variables = tryJson(text(graphql.variables));
        var example = {
            query: text(graphql.query),
            variables: variables.ok ? variables.value : text(graphql.variables)
        };
        return { content: buildMedia('application/json', { example: example, schema: schemaOf(example) }) };
    }

    return null;
}

function buildMedia(type, parts) {
    var out = {};
    if (parts.schema) out.schema = parts.schema;
    if (parts.example !== undefined) out.example = parts.example;
    if (parts.examples) out.examples = parts.examples;
    return { [type]: out };
}

function mediaTypeOf(example) {
    return CONTENT_TYPE_BY_RESPONSE[trimmed(example && example.responseType) || 'json'] || 'application/json';
}

/** 示例的值：JSON 的解析出来（解析不了就原样当字符串） */
function exampleValue(example, type) {
    var body = text(example && example.body);
    if (type !== 'application/json') return body;

    var parsed = tryJson(body);
    return parsed.ok ? parsed.value : body;
}

/**
 * 按路径把响应字段说明拼成一棵 schema 树（第六轮第 2 节）。
 *
 * **只在示例不是合法 JSON 时兜底用**：从 OpenAPI 导入进来的示例是 mock 模板
 * （里面带 `{{@repeat(3)}}` 这种指令），`JSON.parse` 不认，按示例推出来的 schema
 * 只有一个 `{ type: 'string' }` —— 那样字段说明就没地方贴了。有说明的时候，
 * 按说明拼出来的结构比「什么结构都没有」有用得多。
 */
function schemaFromFields(fields) {
    var root = { type: 'object', properties: {} };
    var used = false;

    (fields || []).forEach(function (field) {
        var path = trimmed(field && field.path);
        if (!path) return;
        used = true;
        insertField(root, path.split('.'), field);
    });

    return used ? root : null;
}

function insertField(node, parts, field) {
    var head = String(parts[0]);
    var isElement = head.slice(-2) === '[]';
    var name = isElement ? head.slice(0, -2) : head;
    var rest = parts.slice(1);

    if (!name) return;
    if (!node.properties) node.properties = {};

    if (!node.properties[name]) {
        node.properties[name] = isElement
            ? { type: 'array', items: { type: 'object', properties: {} } }
            : { type: 'object', properties: {} };
    }

    var child = node.properties[name];

    if (isElement) {
        if (!child.items) child.items = { type: 'object', properties: {} };
        if (!child.items.properties) child.items.properties = {};

        // `list[]` 这一行：说明和类型贴在元素上
        if (!rest.length) {
            child.items.type = trimmed(field.type) || 'object';
            if (trimmed(field.desc)) child.items.description = trimmed(field.desc);
            return;
        }
        insertField(child.items, rest, field);
        return;
    }

    if (!rest.length) {
        child.type = trimmed(field.type) || 'string';
        if (trimmed(field.desc)) child.description = trimmed(field.desc);
        if (field.required === true) {
            if (!node.required) node.required = [];
            if (node.required.indexOf(name) === -1) node.required.push(name);
        }
        return;
    }

    if (!child.properties) child.properties = {};
    insertField(child, rest, field);
}

/**
 * 把响应字段说明按路径贴到 schema 的属性上（第六轮第 2 节）。
 *
 * 路径写法 `data.list[].id`，和前端那张表一致：**数组元素的路径带 `[]`**。
 * 说明贴到最贴近的那个节点上（数组元素贴 `items`），没有说明的字段不写 `description`
 * —— 空字符串也是噪音。
 */
function applyFieldDescriptions(schema, fields) {
    if (!schema || !Array.isArray(fields) || !fields.length) return schema;

    var byPath = {};
    fields.forEach(function (field) {
        if (field && trimmed(field.path)) byPath[trimmed(field.path)] = field;
    });
    if (!Object.keys(byPath).length) return schema;

    attach(schema, '', byPath);
    return schema;
}

/** 把某个属性标成「必有」（`required` 数组里没有就加上） */
function markRequired(node, key) {
    if (!node.required) node.required = [];
    if (node.required.indexOf(key) === -1) node.required.push(key);
}

function attach(node, prefix, byPath) {
    if (!node || typeof node !== 'object' || node.type !== 'object' || !node.properties) return;

    Object.keys(node.properties).forEach(function (key) {
        var path = prefix ? prefix + '.' + key : key;
        var child = node.properties[key];
        if (!child || typeof child !== 'object') return;

        if (child.type === 'array') {
            var elementPath = path + '[]';
            var elementField = byPath[elementPath];
            if (elementField) {
                if (trimmed(elementField.desc) && child.items) child.items.description = trimmed(elementField.desc);
                if (elementField.required === true) markRequired(node, key);
            }
            attach(child.items, elementPath, byPath);
            return;
        }

        var field = byPath[path];
        if (field) {
            if (trimmed(field.desc)) child.description = trimmed(field.desc);
            if (field.required === true) markRequired(node, key);
        }
        attach(child, path, byPath);
    });
}

/**
 * 响应：**每个示例一个状态码**；同一个状态码有多个示例时用 `examples` 命名列出。
 * 一个示例都没有就写 `200: { description: 'OK' }`。
 *
 * `fields` 是这个接口的响应字段说明（第六轮第 2 节），按路径贴到 schema 的属性上。
 */
function toResponses(examples, fields) {
    var list = Array.isArray(examples) ? examples : [];
    var groups = {};
    var order = [];

    list.forEach(function (example) {
        var status = Number(example && example.status);
        if (!Number.isInteger(status) || status < 100 || status > 599) status = 200;

        var key = String(status);
        if (!groups[key]) {
            groups[key] = [];
            order.push(key);
        }
        groups[key].push(example);
    });

    if (!order.length) return { 200: { description: 'OK' } };

    var responses = {};

    order.forEach(function (key) {
        var items = groups[key];
        var type = mediaTypeOf(items[0]);
        var first = exampleValue(items[0], type);
        var schema = schemaOf(first);
        // 示例不是合法 JSON（导入进来的 mock 模板就是）时，按字段说明兜底拼一棵树，
        // 不然说明没地方贴、导出的 schema 也只剩一个 `{ type: 'string' }`
        if (schema.type !== 'object') {
            var fromFields = schemaFromFields(fields);
            if (fromFields) schema = fromFields;
        }

        var media = { schema: applyFieldDescriptions(schema, fields) };

        if (items.length === 1) {
            media.example = first;
        } else {
            var named = {};
            items.forEach(function (example, index) {
                var name = trimmed(example && example.name) || ('示例 ' + (index + 1));
                if (Object.prototype.hasOwnProperty.call(named, name)) name = name + ' (' + (index + 1) + ')';
                named[name] = { value: exampleValue(example, type) };
            });
            media.examples = named;
        }

        responses[key] = {
            description: trimmed(items[0] && items[0].name) || (Number(key) === 200 ? 'OK' : '响应 ' + key),
            content: { [type]: media }
        };
    });

    return responses;
}

/* ------------------------------------------------------------------ 主流程 */

/**
 * @param {{title?: string, description?: string, folders?: Array, apis?: Array}} input
 *   `folders` 要给 `{ id, parentId, name }`（顺序＝目录树顺序）；
 *   `apis` 要给 `{ id, folderId, name, description, method, url, params, body, auth, examples }`，
 *   其中 `auth` 是**继承解析之后**的那个对象（见 lib/auth-type.js）、
 *   `inheritedHeaders` 是继承来的公共请求头（见 lib/common-headers.js 的 `resolve(...).inherited`）。
 * @returns {{doc: object, skipped: string[]}}
 */
function buildDocument(input) {
    var spec = input || {};
    var folders = spec.folders || [];
    var apis = spec.apis || [];

    var folderById = {};
    folders.forEach(function (folder) { folderById[folder.id] = folder; });

    /** 接口所在的**顶层**目录名（根目录的接口没有 tag） */
    function topFolderName(folderId) {
        var name = null;
        var current = folderId ? folderById[folderId] : null;
        var depth = 0;

        while (current && depth++ < MAX_DEPTH) {
            name = trimmed(current.name);
            current = current.parentId ? folderById[current.parentId] : null;
        }
        return name;
    }

    var paths = {};
    /** 参数名抹掉之后的路径 → 实际用的那个写法（见下面「只差参数名」那段） */
    var canonicalPaths = {};
    var usedTags = {};
    var skipped = [];
    var schemes = {};
    var servers = [];
    var serverSeen = {};

    function addServer(url, description) {
        if (!url || serverSeen[url]) return;
        serverSeen[url] = true;
        servers.push(description ? { url: url, description: description } : { url: url });
    }

    apis.forEach(function (api) {
        var method = trimmed(api.method).toUpperCase() || 'GET';

        if (method === 'WS') {
            skipped.push('WebSocket 接口「' + (trimmed(api.name) || '(未命名接口)') + '」：OpenAPI 里没有 WebSocket');
            return;
        }

        // Socket.IO（第九轮第 4 节）同理：它是在 WebSocket 之上的一层协议，
        // OpenAPI 里也没有对得上的写法，跳过并说明。
        if (method === 'SIO') {
            skipped.push('Socket.IO 接口「' + (trimmed(api.name) || '(未命名接口)') + '」：OpenAPI 里没有 Socket.IO');
            return;
        }

        // gRPC（第十一轮第 1 节）：OpenAPI 描述的是 HTTP 接口，gRPC 有自己的一套
        // （.proto / gRPC 反射），写不进 OpenAPI，跳过并说明。
        if (method === 'GRPC') {
            skipped.push('gRPC 接口「' + (trimmed(api.name) || '(未命名接口)') + '」：OpenAPI 里没有 gRPC');
            return;
        }

        // MQTT（第十三轮）：地址是 broker，收发的是主题和消息，OpenAPI 里没有这一套，
        // 跳过并说明。
        if (method === 'MQTT') {
            skipped.push('MQTT 接口「' + (trimmed(api.name) || '(未命名接口)') + '」：OpenAPI 里没有 MQTT');
            return;
        }

        // TCP / UDP（第十五轮）：地址是主机和端口，收发的是字节，OpenAPI 里没有这一套，
        // 跳过并说明。
        if (method === 'TCP' || method === 'UDP') {
            skipped.push(method + ' 接口「' + (trimmed(api.name) || '(未命名接口)') +
                '」：OpenAPI 里没有 ' + method);
            return;
        }

        var path = toPath(api.url);
        var verb = method.toLowerCase();

        // 只差参数名的路径（`/users/{id}` 和 `/users/{uid}`）在 OpenAPI 里算同一个，
        // 规范不允许并存（不管方法是不是一样，Swagger Editor 会报 Equivalent paths）：
        // 并到先出现的那个写法下面，方法也一样的话就是重了
        var canonical = path.replace(/\{[^}]*\}/g, '{}');
        if (!paths[path] && canonicalPaths[canonical]) path = canonicalPaths[canonical];
        canonicalPaths[canonical] = canonicalPaths[canonical] || path;

        paths[path] = paths[path] || {};
        if (paths[path][verb]) {
            skipped.push(method + ' ' + path + '（' + (trimmed(api.name) || '未命名接口') + '）：和前面一个接口重了');
            return;
        }

        collectServers(api.url, addServer);

        var tag = topFolderName(api.folderId);
        if (tag) usedTags[tag] = true;

        var scheme = schemeFor(api.auth);
        if (scheme && !schemes[scheme.name]) schemes[scheme.name] = scheme.scheme;

        var operation = omitEmpty({
            summary: trimmed(api.name),
            description: trimmed(api.description)
        });

        var parameters = toParameters(api, pathTokens(path));
        if (parameters.length) operation.parameters = parameters;

        var requestBody = toRequestBody(api.body);
        if (requestBody) operation.requestBody = requestBody;

        operation.responses = toResponses(api.examples, api.responseFields);
        if (tag) operation.tags = [tag];
        if (scheme) operation.security = [{ [scheme.name]: [] }];

        paths[path][verb] = operation;
    });

    var doc = {
        openapi: OPENAPI_VERSION,
        info: omitEmpty({
            title: trimmed(spec.title) || 'API',
            version: '1.0.0',
            description: trimmed(spec.description)
        })
    };

    if (servers.length) doc.servers = servers;

    // tags 按目录树顺序（folders 就是树序），只列真的用到的
    var tags = [];
    var seenTag = {};
    folders.forEach(function (folder) {
        if (folder.parentId) return;
        var name = trimmed(folder.name);
        if (!name || seenTag[name] || !usedTags[name]) return;
        seenTag[name] = true;
        tags.push({ name: name });
    });
    if (tags.length) doc.tags = tags;

    doc.paths = paths;

    if (Object.keys(schemes).length) doc.components = { securitySchemes: schemes };

    return { doc: doc, skipped: skipped };
}

/**
 * 文档 → 文本。`format` 是 `'json'` 或 `'yaml'`（默认 yaml）。
 *
 * 跳过的东西：YAML 写在开头的 `#` 注释里，JSON 放进 `info['x-apiloop-skipped']` ——
 * 静默少几个接口是最难查的那种问题。
 */
function toText(doc, format, skipped) {
    var lines = (skipped || []).slice();

    if (String(format).toLowerCase() === 'json') {
        var copy = JSON.parse(JSON.stringify(doc));
        if (lines.length) copy.info['x-apiloop-skipped'] = lines;
        return JSON.stringify(copy, null, 2) + '\n';
    }

    var dump;
    try {
        dump = require('js-yaml').dump;
    } catch (err) {
        throw new Error('当前环境没有 js-yaml，无法导出 YAML；可以改用 JSON 格式');
    }

    var head = '';
    if (lines.length) {
        head = '# 以下接口没有导出（同一「方法 + 路径」只导第一个；WebSocket / Socket.IO / gRPC 不在 OpenAPI 里）：\n' +
            lines.map(function (line) { return '#   ' + line; }).join('\n') + '\n';
    }

    return head + dump(doc, { noRefs: true });
}

module.exports = {
    buildDocument: buildDocument,
    toText: toText,
    toPath: toPath,
    pathTokens: pathTokens,
    schemaOf: schemaOf,
    CONTENT_TYPE_BY_LANGUAGE: CONTENT_TYPE_BY_LANGUAGE,
    CONTENT_TYPE_BY_RESPONSE: CONTENT_TYPE_BY_RESPONSE,
    SKIP_HEADERS: SKIP_HEADERS,
    OPENAPI_VERSION: OPENAPI_VERSION
};
