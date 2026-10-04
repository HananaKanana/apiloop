/**
 * YApi 导出的 JSON（第九轮第 1 节）。
 *
 * 格式以 **YApi 自己的源码**为准，不靠猜：
 * - 顶层是**分类数组** `[{ name, desc, list: [接口…] }]` —— 见
 *   `exts/yapi-plugin-export-data/controller.js` 的 `handleListClass` / `exportData`
 *   （分类里没有接口的会被丢掉；接口上的 `_id` / `uid` / `catid` / `project_id` 导出时被删掉）；
 * - 接口的字段来自 `server/models/interface.js` 的 schema：
 *   `title / path / method / status(done|undone) / desc / markdown / req_query /
 *    req_headers / req_params / req_body_type / req_body_is_json_schema / req_body_form /
 *    req_body_other / res_body_type / res_body / res_body_is_json_schema / tag`。
 *
 * 输出的是**和 Postman 导入一样的接口树**（`lib/tree.js` 的 `writeTree` 认得那个形状），
 * 落库走现有那一套，不另写。
 *
 * 认不出来的东西**宁可跳过并列出来**（进 `warnings`），也不要导入一个错的接口 ——
 * 「导进来了但是错的」比「没导进来」难发现得多。
 */

var importers = require('./importers');
var urlUtils = require('./url-utils');

/** apiloop 自己管这三个请求头（鉴权和 Cookie 在别处配、Content-Type 跟着请求体走） */
var MANAGED_HEADERS = ['content-type', 'authorization', 'cookie'];

function str(value) {
    return value === undefined || value === null ? '' : String(value);
}

function parseJson(text) {
    try {
        return JSON.parse(text);
    } catch (err) {
        throw new Error('不是合法的 JSON：' + err.message);
    }
}

/**
 * 是不是 YApi 的导出文件。
 *
 * 判据：顶层是数组，每个元素都有 `list` 数组，且至少有一个接口带着 YApi 的字段
 * （`path` / `req_query` / `req_body_type` 这些）—— 光看「有 list」不够，
 * 别的工具的导出里也可能有同名字段。
 */
function detect(data) {
    if (!Array.isArray(data) || !data.length) return false;

    var allCategories = data.every(function (item) {
        return item && typeof item === 'object' && Array.isArray(item.list);
    });
    if (!allCategories) return false;

    return data.some(function (category) {
        return category.list.some(function (item) {
            return item && typeof item === 'object' &&
                (item.req_body_type !== undefined || item.req_query !== undefined ||
                    item.res_body !== undefined || item.req_body_other !== undefined);
        });
    });
}

/** YApi 的路径参数两种写法都认：`{id}` 和 `:id`，统一成 Express 的 `:id` */
function normalizePath(value) {
    var path = str(value).trim();
    if (!path) return '';
    return path.replace(/\{([^}]+)\}/g, ':$1');
}

/** `required` 在 YApi 里是字符串 `'1'` / `'0'`，也见过布尔 */
function isRequired(value) {
    return value === '1' || value === 1 || value === true;
}

/** 普通参数行（查询 / 请求头 / 路径） */
function toRow(name, value, desc, required, type) {
    return {
        key: str(name),
        value: str(value),
        type: type || 'string',
        required: isRequired(required),
        desc: str(desc),
        enabled: true
    };
}

function queryRows(item) {
    return (item.req_query || []).filter(function (row) {
        return row && str(row.name);
    }).map(function (row) {
        // `example` 是示例值，`value` 是默认值；两个都有时示例更接近用户想看的
        return toRow(row.name, row.example !== undefined && row.example !== '' ? row.example : row.value,
            row.desc, row.required);
    });
}

function headerRows(item) {
    return (item.req_headers || []).filter(function (row) {
        return row && str(row.name) && MANAGED_HEADERS.indexOf(str(row.name).toLowerCase()) === -1;
    }).map(function (row) {
        return toRow(row.name, row.example !== undefined && row.example !== '' ? row.example : row.value,
            row.desc, row.required);
    });
}

/** 路径参数：名字和说明带过去（值留空，用户自己填） */
function pathRows(item, path) {
    var declared = (item.req_params || []).filter(function (row) {
        return row && str(row.name);
    }).map(function (row) {
        return toRow(row.name, row.example, row.desc, true);
    });
    if (declared.length) return declared;

    // 没声明就按路径里的 `:xx` 补上，至少界面上能看到有哪几个
    var names = [];
    String(path || '').replace(/:([A-Za-z0-9_]+)/g, function (whole, name) {
        if (names.indexOf(name) === -1) names.push(name);
        return whole;
    });
    return names.map(function (name) { return toRow(name, '', '', true); });
}

/**
 * 请求体。
 *
 * `req_body_type` 有五种：`json` / `form` / `raw` / `text` / `file`。
 * `json` 且 `req_body_is_json_schema` 为真时 `req_body_other` 是 **JSON Schema 字符串**
 * （YApi 界面上就是让你写 schema 的），要生成一份示例；否则它是用户写的原文。
 */
function bodyOf(item, ctx) {
    var type = str(item.req_body_type).toLowerCase();
    var other = str(item.req_body_other);

    if (type === 'json') {
        if (item.req_body_is_json_schema && other.trim()) {
            var schema = safeParse(other);
            if (schema) {
                return { mode: 'raw', raw: importers.schemaToMock(schema, schema, 0, 0, []), language: 'json' };
            }
            ctx.warn('「' + ctx.name + '」的请求体 schema 解析不了，请求体没有导入');
            return { mode: 'none' };
        }
        return other.trim() ? { mode: 'raw', raw: other, language: 'json' } : { mode: 'none' };
    }

    if (type === 'form') {
        var rows = (item.req_body_form || []).filter(function (row) {
            return row && str(row.name);
        });
        if (!rows.length) return { mode: 'none' };

        var hasFile = rows.some(function (row) { return str(row.type) === 'file'; });
        if (hasFile) ctx.fileForms += 1;

        return {
            mode: hasFile ? 'formdata' : 'urlencoded',
            form: rows.map(function (row) {
                return {
                    key: str(row.name),
                    // 文件行只带名字（YApi 里没有本地文件路径，运行时用户自己选）
                    value: str(row.type) === 'file' ? '' : str(row.example !== undefined && row.example !== '' ? row.example : row.value),
                    type: 'string',
                    kind: str(row.type) === 'file' ? 'file' : 'text',
                    src: null,
                    required: isRequired(row.required),
                    desc: str(row.desc),
                    enabled: true
                };
            })
        };
    }

    if (type === 'raw' || type === 'text') {
        return other.trim() ? { mode: 'raw', raw: other, language: 'text' } : { mode: 'none' };
    }

    if (type === 'file') {
        ctx.warn('「' + ctx.name + '」的请求体是文件上传，没有导入（要自己选文件）');
        return { mode: 'none' };
    }

    return { mode: 'none' };
}

/** 响应 → 一条示例（YApi 只有一个 `res_body`，没有状态码，默认 200） */
function examplesOf(item, ctx) {
    var body = str(item.res_body);
    if (!body.trim()) return [];

    var type = str(item.res_body_type).toLowerCase() || 'json';
    var isSchema = item.res_body_is_json_schema === true;
    var text = body;
    var responseType = 'json';

    if (isSchema) {
        var schema = safeParse(body);
        if (!schema) {
            ctx.warn('「' + ctx.name + '」的响应 schema 解析不了，示例没有导入');
            return [];
        }
        text = importers.schemaToMock(schema, schema, 0, 0, []);
        responseType = 'json';
    } else if (type === 'xml') {
        responseType = 'xml';
    } else if (type !== 'json') {
        responseType = 'text';
    }

    return [{
        name: '默认',
        status: 200,
        headers: [],
        body: text,
        responseType: responseType,
        source: 'imported'
    }];
}

/** 响应字段说明（第六轮第 2 节）：从 `res_body` 的 schema 里读 description */
function responseFieldsOf(item) {
    if (item.res_body_is_json_schema !== true) return [];

    var schema = safeParse(str(item.res_body));
    if (!schema) return [];

    return importers.responseFieldsFromSchema(schema, schema);
}

function safeParse(text) {
    try {
        return JSON.parse(text);
    } catch (err) {
        return null;
    }
}

/**
 * 解析一份 YApi 导出文件。
 *
 * @param {string|object} input 文件内容（字符串）或已经 parse 过的对象
 * @returns {{kind: 'collection', format: 'yapi', collection: object, stats: object, warnings: string[]}}
 */
function parse(input) {
    var data = typeof input === 'string' ? parseJson(input) : input;
    if (!detect(data)) {
        throw new Error('这不是 YApi 导出的 JSON：顶层应该是一个分类数组（每项有 name 和 list）');
    }

    var warnings = [];
    var stats = { folders: 0, apis: 0, examples: 0, scripts: 0 };
    var counters = { fileForms: 0 };

    function warn(text) {
        if (warnings.indexOf(text) === -1) warnings.push(text);
    }

    var children = [];

    data.forEach(function (category) {
        var apis = (category.list || []).map(function (item) {
            if (!item || typeof item !== 'object') return null;

            var name = str(item.title) || str(item.path) || '未命名接口';
            var path = normalizePath(item.path);
            var method = str(item.method || 'GET').toUpperCase();

            if (!path) {
                warn('「' + name + '」没有 path，跳过了');
                return null;
            }

            var ctx = {
                name: name,
                warn: warn,
                fileForms: 0
            };

            var examples = examplesOf(item, ctx);
            counters.fileForms += ctx.fileForms;
            stats.apis += 1;
            stats.examples += examples.length;

            return {
                type: 'api',
                name: name,
                // YApi 的 `desc` 是界面上那段说明，`markdown` 是它的 md 版本；两个都有时用 desc
                description: str(item.desc) || str(item.markdown) || '',
                method: method,
                url: path,
                params: {
                    path: pathRows(item, path),
                    query: queryRows(item),
                    headers: headerRows(item)
                },
                body: bodyOf(item, ctx),
                auth: null,
                // YApi 的接口没有脚本（脚本在它的测试集合里，不在这份导出里）
                scripts: [],
                mockPath: urlUtils.deriveMockPath(path),
                examples: examples,
                // 接口状态（第四轮第 1 节）：YApi 只有 done / undone
                status: str(item.status) === 'done' ? 'done' : 'developing',
                responseFields: responseFieldsOf(item),
                extra: {}
            };
        }).filter(Boolean);

        if (!apis.length) return;

        stats.folders += 1;
        children.push({
            type: 'folder',
            name: str(category.name) || '未命名分类',
            description: str(category.desc),
            children: apis
        });
    });

    if (!stats.apis) throw new Error('这份 YApi 文件里没有解析到任何接口');

    if (counters.fileForms) {
        warnings.push('有 ' + counters.fileForms + ' 个接口的请求体是文件上传，表单里的文件行没有值（运行时自己选文件）');
    }

    // 用不了的东西说清楚，别让用户以为全导进来了
    var mockScripts = data.reduce(function (sum, category) {
        return sum + (category.list || []).filter(function (item) {
            return item && item.res_body && str(item.res_body).indexOf('{{') > -1 && item.res_body_is_json_schema !== true;
        }).length;
    }, 0);
    if (mockScripts) {
        warnings.push('有 ' + mockScripts + ' 个接口的响应里带着 YApi 自己的 Mock 模板语法（`{{...}}`），' +
            '没有转成 apiloop 的占位符，原样存进了示例');
    }

    return {
        kind: 'collection',
        format: 'yapi',
        collection: {
            name: 'YApi 导入',
            description: '从 YApi 导出的 JSON 导入（' + stats.folders + ' 个分类、' + stats.apis + ' 个接口）',
            children: children
        },
        stats: stats,
        warnings: warnings
    };
}

module.exports = {
    detect: detect,
    parse: parse,
    normalizePath: normalizePath
};
