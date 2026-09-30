/**
 * 导入器：把 cURL 命令 / OpenAPI(Swagger) 定义转成管理台可直接用的路由配置。
 *
 * 导入出来的响应体会带 {{@...}} 占位符，例如 OpenAPI 里 integer 字段
 * 会变成 "{{@int(0,100)}}"，这样导入后立刻就有随机 mock 数据。
 */

var parseYaml = null;
try {
    parseYaml = require('js-yaml').load;
} catch (err) {
    parseYaml = null;
}

/* ------------------------------------------------------------------ 公共小工具 */

function indent(level) {
    return new Array(level + 1).join('  ');
}

function inferFieldType(value) {
    if (typeof value === 'number') {
        return Number.isInteger(value) ? 'number' : 'price';
    }
    if (typeof value === 'boolean') return 'boolean';
    if (Array.isArray(value)) return 'array';
    if (value && typeof value === 'object') return 'object';

    var text = String(value);
    if (/^1[3-9]\d{9}$/.test(text)) return 'phone';
    if (/^[\w.+-]+@[\w-]+\.[\w.]+$/.test(text)) return 'email';
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return 'date';
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(text)) return 'datetime';
    if (/^-?\d+$/.test(text)) return 'number';
    if (/^-?\d+\.\d+$/.test(text)) return 'price';
    if (/^https?:\/\//.test(text)) return 'url';
    return 'string';
}

function exampleText(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
}

function toField(key, value, extra) {
    return {
        key: key,
        type: inferFieldType(value),
        required: Boolean(extra && extra.required),
        desc: (extra && extra.desc) || '',
        example: exampleText(value)
    };
}

/** 由字段列表拼一个回显响应体，让导入后的接口直接可用 */
function echoResponse(fields) {
    if (!fields.length) {
        return '{\n  "code": 0,\n  "msg": "ok",\n  "data": {}\n}';
    }
    var lines = fields.map(function (field) {
        return '    ' + JSON.stringify(field.key) + ': "{{@body(' + field.key + ')}}"';
    });
    return '{\n  "code": 0,\n  "msg": "ok",\n  "data": {\n' + lines.join(',\n') + '\n  }\n}';
}

/* ------------------------------------------------------------------ cURL */

/**
 * 按 shell 引号规则切词，并处理行尾的 \ 与 ^ 续行。
 */
function tokenizeCurl(text) {
    var normalized = String(text).replace(/\\\r?\n/g, ' ').replace(/\^\r?\n/g, ' ');
    var tokens = [];
    var current = '';
    var quote = null;

    for (var i = 0; i < normalized.length; i++) {
        var ch = normalized[i];

        if (quote) {
            if (ch === quote) {
                quote = null;
                continue;
            }
            if (ch === '\\' && quote === '"') {
                current += normalized[i + 1] === undefined ? '' : normalized[i + 1];
                i++;
                continue;
            }
            current += ch;
            continue;
        }

        if (ch === '"' || ch === "'") {
            quote = ch;
            continue;
        }
        if (/\s/.test(ch)) {
            if (current) {
                tokens.push(current);
                current = '';
            }
            continue;
        }
        current += ch;
    }

    if (current) tokens.push(current);
    return tokens;
}

var DATA_FLAGS = ['-d', '--data', '--data-raw', '--data-binary', '--data-ascii', '--data-urlencode'];
var HEADER_FLAGS = ['-H', '--header'];
var METHOD_FLAGS = ['-X', '--request'];
var FORM_FLAGS = ['-F', '--form'];
var COOKIE_FLAGS = ['-b', '--cookie'];

function looksLikeUrl(token) {
    return /^https?:\/\//i.test(token) || /^[\w.-]+\.[a-z]{2,}(:\d+)?\//i.test(token);
}

/**
 * 把 cURL 命令解析成一条路由草稿
 * @param {string} text
 * @returns {object} route
 */
function curlToRoute(text) {
    var tokens = tokenizeCurl(text);
    if (!tokens.length) throw new Error('内容为空，请粘贴一条 cURL 命令');

    var url = '';
    var method = '';
    var headerList = [];
    var dataParts = [];
    var formParts = [];
    var useQuery = false;

    for (var i = 0; i < tokens.length; i++) {
        var token = tokens[i];
        var lower = token.toLowerCase();

        if (METHOD_FLAGS.indexOf(token) > -1) {
            method = String(tokens[++i] || '').toUpperCase();
            continue;
        }
        if (HEADER_FLAGS.indexOf(token) > -1) {
            headerList.push(String(tokens[++i] || ''));
            continue;
        }
        if (DATA_FLAGS.indexOf(token) > -1) {
            dataParts.push(String(tokens[++i] || ''));
            continue;
        }
        if (FORM_FLAGS.indexOf(token) > -1) {
            formParts.push(String(tokens[++i] || ''));
            continue;
        }
        if (COOKIE_FLAGS.indexOf(token) > -1) {
            headerList.push('Cookie: ' + String(tokens[++i] || ''));
            continue;
        }
        if (token === '-G' || token === '--get') {
            useQuery = true;
            continue;
        }
        if (token === '--url') {
            url = String(tokens[++i] || '');
            continue;
        }
        if (lower === 'curl' || /[\\/]curl$/.test(token)) {
            continue;
        }
        if (token.charAt(0) === '-') {
            continue;
        }
        if (!url) {
            url = token;
        }
    }

    if (!url) throw new Error('没有在 cURL 命令里找到 URL');
    if (!/^https?:\/\//i.test(url)) url = 'http://' + url;

    var parsed;
    try {
        parsed = new URL(url);
    } catch (err) {
        throw new Error('URL 解析失败: ' + url);
    }

    // -G 时 data 要当成查询参数
    if (useQuery && dataParts.length) {
        dataParts.join('&').split('&').forEach(function (pair) {
            if (!pair) return;
            var index = pair.indexOf('=');
            var key = index === -1 ? pair : pair.slice(0, index);
            var value = index === -1 ? '' : decodeURIComponent(pair.slice(index + 1));
            if (key) parsed.searchParams.set(decodeURIComponent(key), value);
        });
        dataParts = [];
    }

    var query = [];
    parsed.searchParams.forEach(function (value, key) {
        query.push(toField(key, value));
    });

    var rawBody = dataParts.join('&');
    var body = [];
    var contentType = '';

    headerList.forEach(function (header) {
        if (/^content-type\s*:/i.test(header)) contentType = header.split(':').slice(1).join(':').trim();
    });

    if (rawBody) {
        var json = null;
        try {
            json = JSON.parse(rawBody);
        } catch (err) {
            json = null;
        }

        if (json && typeof json === 'object' && !Array.isArray(json)) {
            Object.keys(json).forEach(function (key) {
                body.push(toField(key, json[key]));
            });
        } else if (!json && /application\/x-www-form-urlencoded/i.test(contentType)) {
            rawBody.split('&').forEach(function (pair) {
                if (!pair) return;
                var index = pair.indexOf('=');
                var key = decodeURIComponent(index === -1 ? pair : pair.slice(0, index));
                var value = index === -1 ? '' : decodeURIComponent(pair.slice(index + 1));
                if (key) body.push(toField(key, value));
            });
        } else {
            body.push({ key: 'raw', type: 'text', required: false, desc: '原始请求体', example: rawBody });
        }
    }

    formParts.forEach(function (item) {
        var index = item.indexOf('=');
        var key = index === -1 ? item : item.slice(0, index);
        var value = index === -1 ? '' : item.slice(index + 1);
        if (key) body.push(toField(key, value.replace(/^@/, '')));
    });

    // 数字结尾的路径段当成资源 ID，转成路径参数更好用
    var note = '';
    var pathname = parsed.pathname;
    var converted = pathname.replace(/\/\d+(?=\/|$)/g, function () {
        note = '（导入时把数字路径段转成了 :id，可自行调整）';
        return '/:id';
    });

    if (!method) method = (rawBody || formParts.length) ? 'POST' : 'GET';

    return {
        name: '',
        group: '导入',
        desc: '由 cURL 导入' + note,
        enabled: true,
        method: method,
        path: converted || '/',
        status: 200,
        delay: 0,
        cors: false,
        headers: [],
        query: query,
        body: body,
        responseType: 'json',
        response: echoResponse(body)
    };
}

/* ------------------------------------------------------------------ OpenAPI */

function resolveRef(ref, root) {
    if (!ref || ref.indexOf('#/') !== 0) return null;
    var parts = ref.slice(2).split('/');
    var current = root;
    for (var i = 0; i < parts.length; i++) {
        if (current === null || typeof current !== 'object') return null;
        current = current[parts[i].replace(/~1/g, '/').replace(/~0/g, '~')];
    }
    return current || null;
}

function deref(schema, root) {
    if (!schema || typeof schema !== 'object') return schema || {};
    if (schema.$ref) {
        var resolved = resolveRef(schema.$ref, root);
        if (resolved) return resolved;
    }
    return schema;
}

/**
 * 把 JSON Schema 转成带 {{@...}} 占位符的 JSON 文本
 */
function schemaToMock(schema, root, depth, level, seen) {
    var node = deref(schema, root);
    depth = depth || 0;
    level = level || 0;
    seen = seen || [];

    if (!node || typeof node !== 'object' || depth > 5) return 'null';
    if (node.example !== undefined) return JSON.stringify(node.example);
    if (node.default !== undefined) return JSON.stringify(node.default);
    if (Array.isArray(node.enum) && node.enum.length) {
        return '"{{@pick(' + node.enum.join(',') + ')}}"';
    }

    var type = node.type;
    if (!type) {
        if (node.properties) type = 'object';
        else if (node.items) type = 'array';
        else if (node.allOf && node.allOf.length) type = 'object';
        else type = 'string';
    }

    if (type === 'object' || node.allOf) {
        var properties = node.properties || {};
        if (node.allOf) {
            node.allOf.forEach(function (part) {
                var resolved = deref(part, root);
                if (resolved && resolved.properties) {
                    Object.keys(resolved.properties).forEach(function (key) {
                        if (!properties[key]) properties[key] = resolved.properties[key];
                    });
                }
            });
        }
        var keys = Object.keys(properties);
        if (!keys.length) return '{}';
        var lines = keys.map(function (key) {
            var child = schemaToMock(properties[key], root, depth + 1, level + 1, seen);
            return indent(level + 1) + JSON.stringify(key) + ': ' + child;
        });
        return '{\n' + lines.join(',\n') + '\n' + indent(level) + '}';
    }

    if (type === 'array') {
        var itemMock = schemaToMock(node.items || {}, root, depth + 1, level + 1, seen);
        return '[\n' + indent(level + 1) + '{{@repeat(3)}}' + itemMock + '\n' +
            indent(level + 1) + '{{/repeat}}\n' + indent(level) + ']';
    }

    if (type === 'integer') {
        var min = node.minimum === undefined ? 1 : node.minimum;
        var max = node.maximum === undefined ? Math.max(min + 99, 100) : node.maximum;
        return '"{{@int(' + min + ',' + max + ')}}"';
    }
    if (type === 'number') {
        var nMin = node.minimum === undefined ? 0 : node.minimum;
        var nMax = node.maximum === undefined ? 100 : node.maximum;
        return '"{{@float(' + nMin + ',' + nMax + ',2)}}"';
    }
    if (type === 'boolean') return '"{{@bool}}"';

    switch (node.format) {
        case 'date': return '"{{@date}}"';
        case 'date-time': return '"{{@datetime}}"';
        case 'email': return '"{{@email}}"';
        case 'uuid': return '"{{@uuid}}"';
        case 'uri': case 'url': return '"{{@url}}"';
        case 'phone': return '"{{@phone}}"';
        default: break;
    }

    if (/name$/i.test(node.title || '') || /姓名|名字/.test(node.description || '')) {
        return '"{{@cname}}"';
    }
    if (/phone|mobile|手机/i.test(node.description || '')) return '"{{@phone}}"';
    if (/email|邮箱/i.test(node.description || '')) return '"{{@email}}"';
    if (/city|城市/i.test(node.description || '')) return '"{{@city}}"';
    if (/time|时间/i.test(node.description || '')) return '"{{@datetime}}"';
    if (/image|avatar|图片|头像/i.test(node.description || '')) return '"{{@image(200x200)}}"';

    return '"{{@word}}"';
}

function pickResponseSchema(operation, root) {
    var responses = operation.responses || {};
    var keys = Object.keys(responses);
    var preferred = keys.filter(function (key) { return /^2\d\d$/.test(key); });
    var target = preferred.length ? preferred[0] : (keys.indexOf('default') > -1 ? 'default' : keys[0]);
    if (!target) return null;

    var response = deref(responses[target], root);

    // OpenAPI 3
    if (response.content) {
        var jsonType = Object.keys(response.content).filter(function (key) {
            return /json/i.test(key);
        })[0] || Object.keys(response.content)[0];
        if (jsonType && response.content[jsonType]) {
            return response.content[jsonType].schema || null;
        }
        return null;
    }

    // Swagger 2
    return response.schema || null;
}

function collectParameters(operation, pathItem, root) {
    var all = [];
    (pathItem.parameters || []).concat(operation.parameters || []).forEach(function (param) {
        all.push(deref(param, root));
    });

    var query = [];
    var pathParams = [];

    all.forEach(function (param) {
        if (!param || !param.name) return;
        var schema = param.schema || param;
        var type = schema.type || 'string';
        var example = param.example !== undefined ? param.example
            : (schema.example !== undefined ? schema.example
                : (schema.default !== undefined ? schema.default : defaultValueForType(type)));

        var field = {
            key: param.name,
            type: inferFieldType(example),
            required: Boolean(param.required),
            desc: param.description || '',
            example: exampleText(example)
        };

        if (param.in === 'query') query.push(field);
        else if (param.in === 'path') pathParams.push(field);
    });

    return { query: query, pathParams: pathParams };
}

function defaultValueForType(type) {
    switch (type) {
        case 'integer': case 'number': return 1;
        case 'boolean': return true;
        case 'array': return [];
        case 'object': return {};
        default: return '';
    }
}

function bodyFieldsFromSchema(schema, root) {
    var node = deref(schema, root);
    if (!node || !node.properties) return [];
    return Object.keys(node.properties).map(function (key) {
        var property = deref(node.properties[key], root);
        var example = property.example !== undefined ? property.example
            : (property.default !== undefined ? property.default : defaultValueForType(property.type));
        return {
            key: key,
            type: inferFieldType(example),
            required: (node.required || []).indexOf(key) > -1,
            desc: property.description || '',
            example: exampleText(example)
        };
    });
}

/**
 * 解析 OpenAPI 3 / Swagger 2 定义（JSON 或 YAML），产出路由草稿数组
 * @param {string} text
 * @returns {Array} routes
 */
function openapiToRoutes(text) {
    var raw = String(text || '').trim();
    if (!raw) throw new Error('内容为空，请粘贴 OpenAPI/Swagger 定义');

    var document = null;
    try {
        document = JSON.parse(raw);
    } catch (jsonError) {
        if (!parseYaml) {
            throw new Error('解析失败：看起来不是 JSON，且当前环境没有 js-yaml，无法解析 YAML。' +
                '原始错误：' + jsonError.message);
        }
        try {
            document = parseYaml(raw);
        } catch (yamlError) {
            throw new Error('既不是合法 JSON 也不是合法 YAML：' + yamlError.message);
        }
    }

    if (!document || typeof document !== 'object' || !document.paths) {
        throw new Error('不是有效的 OpenAPI/Swagger 文档：缺少 paths 字段');
    }

    var routes = [];
    var methodNames = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options'];

    Object.keys(document.paths).forEach(function (routePath) {
        var pathItem = deref(document.paths[routePath], document) || {};
        // OpenAPI 的路径模板是 /pets/{petId}，Express 需要 /pets/:petId
        var expressPath = String(routePath).replace(/\{([^}]+)\}/g, ':$1');
        methodNames.forEach(function (method) {
            var operation = pathItem[method];
            if (!operation) return;

            operation = deref(operation, document) || operation;
            var collected = collectParameters(operation, pathItem, document);

            var bodyFields = [];
            if (operation.requestBody) {
                var requestBody = deref(operation.requestBody, document);
                var content = requestBody.content || {};
                var jsonKey = Object.keys(content).filter(function (key) { return /json/i.test(key); })[0];
                if (jsonKey) bodyFields = bodyFieldsFromSchema(content[jsonKey].schema, document);
            }

            // 路径参数不进 body，管理台会根据 path 里的 :xx 自动识别
            var responseSchema = pickResponseSchema(operation, document);
            var response = responseSchema
                ? schemaToMock(responseSchema, document, 0, 0, [])
                : echoResponse(bodyFields);

            routes.push({
                name: operation.summary || operation.operationId || '',
                group: (operation.tags && operation.tags[0]) || '导入',
                desc: operation.description || '',
                enabled: true,
                method: method.toUpperCase(),
                path: expressPath,
                status: 200,
                delay: 0,
                cors: false,
                headers: [],
                query: collected.query,
                body: bodyFields,
                responseType: 'json',
                response: response
            });
        });
    });

    if (!routes.length) throw new Error('文档里没有解析到任何接口（paths 为空？）');
    return routes;
}

module.exports = {
    curlToRoute: curlToRoute,
    openapiToRoutes: openapiToRoutes,
    tokenizeCurl: tokenizeCurl,
    schemaToMock: schemaToMock
};
