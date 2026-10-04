/**
 * 代码片段：把一次请求渲染成各语言的调用代码。
 *
 * 支持 cURL、JavaScript（fetch / axios）、Python（requests）、Java（OkHttp）、
 * Go（net/http）、PHP（cURL）、C#（HttpClient）。
 *
 * 两条主线：
 *   1. `prepareRequest(prepared)` —— 把请求整理成一个**中间形状**。变量解析、地址拼接、
 *      鉴权、请求体这些「算」的活儿只在这里做一次，cURL 和别的语言共用同一份结果，
 *      所以「复制出去的代码」和「点发送打出去的请求」一定一致。
 *   2. 每种语言一个 `renderXxx(request)` —— 只负责把中间形状拼成代码，字符串转义
 *      按各语言的规则来（引号、反斜杠、换行、中文各不相同）。
 *
 * 中间形状：
 *   {
 *     method: 'POST',
 *     url: 'https://...',
 *     headers: [['Content-Type', 'application/json'], ...],
 *     body: { kind: 'none' }
 *         | { kind: 'raw', text, json: boolean, value? }     // json 为真时 value 是解析出来的值
 *         | { kind: 'urlencoded', fields: [[k, v], ...] }
 *         | { kind: 'form', fields: [{key, value} | {key, file, name}, ...] }
 *         | { kind: 'binary', file, name },
 *     missing: ['没定义的变量名', ...]
 *   }
 *
 * 和 cURL 那版一样：不跑前置脚本；Cookie 罐里的 cookie 不带上（那是本机的状态）；
 * 用户自己写了的请求头优先，鉴权和 Content-Type 都不覆盖它 —— 和执行器一致。
 */

var executor = require('./executor');
var variables = require('./variables');
var urlUtils = require('./url-utils');
var jsonComments = require('./json-comments');
var sendCore = require('./send-core');

/** 支持的语言（顺序就是界面上下拉的顺序） */
var LANGUAGES = ['curl', 'fetch', 'axios', 'python', 'java', 'go', 'php', 'csharp'];

var RAW_CONTENT_TYPES = {
    json: 'application/json',
    text: 'text/plain',
    xml: 'application/xml',
    html: 'text/html',
    javascript: 'application/javascript'
};

/* ------------------------------------------------------------------ 小工具 */

function str(value) {
    return value === null || value === undefined ? '' : String(value);
}

function enabledRows(rows) {
    if (!Array.isArray(rows)) return [];
    return rows.filter(function (row) {
        return row && row.enabled !== false && row.key !== null && row.key !== undefined && String(row.key) !== '';
    });
}

function basename(path) {
    var text = str(path);
    var at = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
    return at === -1 ? text : text.slice(at + 1);
}

function tryParseJson(text) {
    try {
        return { ok: true, value: JSON.parse(text) };
    } catch (err) {
        return { ok: false, value: undefined };
    }
}

/** 给多行文本每行加前缀（空行不加，免得行尾多出空白） */
function indent(text, prefix) {
    return String(text).split('\n').map(function (line) {
        return line === '' ? line : prefix + line;
    }).join('\n');
}

/* ------------------------------------------------------------------ 中间形状 */

/**
 * @param {object} prepared `lib/api/send.js` 的 prepare 产物（spec + 变量各层）
 * @returns {object} 中间形状（见文件头）
 */
function prepareRequest(prepared) {
    var vars = sendCore.mergeScopes(prepared.scopes);
    var resolved = variables.resolveSpec(prepared.spec, vars);
    var spec = resolved.spec;

    var method = String(spec.method || 'GET').toUpperCase();
    var url = urlUtils.buildUrl(spec);

    var headers = [];
    function findHeader(name) {
        var lower = String(name).toLowerCase();
        return headers.some(function (pair) { return pair[0].toLowerCase() === lower; });
    }
    function addIfAbsent(name, value) {
        if (!findHeader(name)) headers.push([name, value]);
    }

    enabledRows((spec.params || {}).headers).forEach(function (row) {
        headers.push([String(row.key), str(row.value)]);
    });

    var auth = executor.buildAuth(spec.auth);
    auth.headers.forEach(function (pair) { addIfAbsent(pair[0], pair[1]); });
    auth.query.forEach(function (pair) {
        url += (url.indexOf('?') === -1 ? '?' : '&') +
            urlUtils.encodeQueryPart(pair[0]) + '=' + urlUtils.encodeQueryPart(pair[1]);
    });

    /* -------- 请求体 -------- */

    var body = spec.body || {};
    var mode = body.mode || 'none';
    var out = { kind: 'none' };

    if (mode === 'raw') {
        var raw = typeof body.raw === 'string' ? body.raw : '';
        if (body.language === 'json') {
            var stripped = jsonComments.stripJsonComments(raw);
            // 去注释是保留行结构的：整行注释会剩下一行空白。代码是给人看的，把这种行去掉
            var before = raw.split('\n');
            var after = stripped.split('\n');
            raw = before.length === after.length
                ? after.filter(function (line, index) {
                    return !(line.trim() === '' && before[index].trim() !== '');
                }).join('\n')
                : stripped;
        }
        if (raw !== '') {
            addIfAbsent('Content-Type', RAW_CONTENT_TYPES[body.language] || RAW_CONTENT_TYPES.text);
            out = { kind: 'raw', text: raw, json: false };
            if (body.language === 'json') {
                var parsed = tryParseJson(raw);
                if (parsed.ok) {
                    out.json = true;
                    out.value = parsed.value;
                }
            }
        }
    } else if (mode === 'urlencoded') {
        var encoded = enabledRows(body.form);
        if (encoded.length) {
            // curl 用 --data 时会自己补这个头，别的语言的库补的值可能带 charset，
            // 这里统一写成一份，八种语言发出去的头才完全一样
            addIfAbsent('Content-Type', 'application/x-www-form-urlencoded');
            out = {
                kind: 'urlencoded',
                fields: encoded.map(function (row) { return [String(row.key), str(row.value)]; })
            };
        }
    } else if (mode === 'formdata') {
        var formRows = enabledRows(body.form);
        if (formRows.length) {
            out = {
                kind: 'form',
                fields: formRows.map(function (row) {
                    if (row.kind === 'file') {
                        return { key: String(row.key), file: str(row.src), name: basename(str(row.src)) };
                    }
                    return { key: String(row.key), value: str(row.value) };
                })
            };
        }
    } else if (mode === 'binary') {
        var file = body.file || {};
        if (file.src) {
            addIfAbsent('Content-Type', 'application/octet-stream');
            out = { kind: 'binary', file: str(file.src), name: basename(str(file.src)) };
        }
    } else if (mode === 'graphql') {
        var graphql = body.graphql || {};
        var graphqlVariables = {};
        if (graphql.variables) {
            try {
                graphqlVariables = JSON.parse(graphql.variables);
            } catch (err) {
                graphqlVariables = {};
            }
        }
        addIfAbsent('Content-Type', 'application/json');
        var graphqlValue = { query: graphql.query || '', variables: graphqlVariables };
        out = { kind: 'raw', text: JSON.stringify(graphqlValue), json: true, value: graphqlValue };
    }

    return {
        method: method,
        url: url,
        headers: headers,
        body: out,
        missing: resolved.missing || []
    };
}

/* ------------------------------------------------------------------ cURL */

/** shell 单引号：里面的单引号写成 '\'' */
function quote(text) {
    return "'" + String(text).replace(/'/g, "'\\''") + "'";
}

function renderCurl(request) {
    var headers = request.headers;
    var body = request.body;
    var dataLines = [];
    var hasBody = false;

    if (body.kind === 'raw') {
        hasBody = true;
        dataLines.push('--data-raw ' + quote(body.text));
    } else if (body.kind === 'urlencoded') {
        body.fields.forEach(function (pair) {
            hasBody = true;
            dataLines.push('--data-urlencode ' + quote(pair[0] + '=' + pair[1]));
        });
    } else if (body.kind === 'form') {
        body.fields.forEach(function (field) {
            hasBody = true;
            if (field.file !== undefined) {
                // curl 的 -F 'name=@路径' 会自己读文件；路径就是请求里填的那个（本机路径）
                dataLines.push('--form ' + quote(field.key + '=@"' + field.file + '"'));
            } else {
                dataLines.push('--form ' + quote(field.key + '=' + field.value));
            }
        });
    } else if (body.kind === 'binary') {
        hasBody = true;
        dataLines.push('--data-binary ' + quote('@' + body.file));
    }

    var parts = ['curl --location ' + quote(request.url)];

    // curl 默认 GET、带了 --data 默认 POST：只有和默认不一样时才写 --request，命令更干净
    var implied = hasBody ? 'POST' : 'GET';
    if (request.method !== implied) parts.splice(1, 0, '--request ' + request.method);

    headers.forEach(function (pair) {
        parts.push('--header ' + quote(pair[0] + ': ' + pair[1]));
    });
    dataLines.forEach(function (line) { parts.push(line); });

    return parts.join(' \\\n');
}

/* ------------------------------------------------------------------ JavaScript 公共 */

/** JS 字符串字面量：JSON.stringify 的双引号形式正好是合法的 JS 字符串（中文不转义） */
function jsString(value) {
    return JSON.stringify(String(value));
}

/** 缩进好的 JS 对象字面量；pairs 是 [键, 值] */
function jsHeaderObject(pairs, base) {
    if (!pairs.length) return '{}';
    var entries = pairs.map(function (pair) {
        return base + '  ' + jsString(pair[0]) + ': ' + jsString(pair[1]);
    });
    return '{\n' + entries.join(',\n') + '\n' + base + '}';
}

/** 一个请求体要不要在 JS 里再 JSON.stringify 一次（只有 JSON 文本需要） */
function jsNeedsStringify(body) {
    return body.kind === 'raw' && body.json;
}

/**
 * JS 的请求体：返回 { pre: [准备语句], expr: '传给请求体的表达式' | null }
 */
function jsBody(body) {
    var pre = [];
    var expr = null;

    if (body.kind === 'raw') {
        if (body.json && body.value !== undefined) {
            pre.push('const payload = ' + JSON.stringify(body.value, null, 2) + ';');
        } else {
            pre.push('const payload = ' + jsString(body.text) + ';');
        }
        expr = 'payload';
    } else if (body.kind === 'urlencoded') {
        var entries = body.fields.map(function (pair) {
            return '  ' + jsString(pair[0]) + ': ' + jsString(pair[1]);
        });
        pre.push('const payload = new URLSearchParams({\n' + entries.join(',\n') + '\n});');
        expr = 'payload';
    } else if (body.kind === 'form') {
        pre.push('const payload = new FormData();');
        body.fields.forEach(function (field) {
            if (field.file !== undefined) {
                pre.push('payload.append(' + jsString(field.key) +
                    ', new Blob([fs.readFileSync(' + jsString(field.file) + ')]), ' + jsString(field.name) + ');');
            } else {
                pre.push('payload.append(' + jsString(field.key) + ', ' + jsString(field.value) + ');');
            }
        });
        expr = 'payload';
    } else if (body.kind === 'binary') {
        pre.push('const payload = fs.readFileSync(' + jsString(body.file) + ');');
        expr = 'payload';
    }

    return { pre: pre, expr: expr };
}

function jsNeedsFs(request) {
    return request.body.kind === 'form' || request.body.kind === 'binary';
}

function renderFetch(request) {
    var body = jsBody(request.body);
    var head = [];

    if (jsNeedsFs(request)) head.push('const fs = require("node:fs");');
    if (body.pre.length) {
        if (head.length) head.push('');
        head.push(body.pre.join('\n'));
    }

    var options = ['    method: ' + jsString(request.method)];
    if (request.headers.length) options.push('    headers: ' + jsHeaderObject(request.headers, '    '));
    if (body.expr) {
        options.push('    body: ' + (jsNeedsStringify(request.body) ? 'JSON.stringify(' + body.expr + ')' : body.expr));
    }

    var call = [
        '(async () => {',
        '  const response = await fetch(' + jsString(request.url) + ', {',
        options.join(',\n'),
        '  });',
        '',
        '  console.log(response.status);',
        '  console.log(await response.text());',
        '})();'
    ];

    return head.length ? head.join('\n') + '\n\n' + call.join('\n') : call.join('\n');
}

function renderAxios(request) {
    var body = jsBody(request.body);
    var head = ['const axios = require("axios");'];

    if (jsNeedsFs(request)) head.push('const fs = require("node:fs");');
    if (body.pre.length) {
        head.push('');
        head.push(body.pre.join('\n'));
    }

    var options = ['    method: ' + jsString(request.method), '    url: ' + jsString(request.url)];
    if (request.headers.length) options.push('    headers: ' + jsHeaderObject(request.headers, '    '));
    if (body.expr) {
        options.push('    data: ' + (jsNeedsStringify(request.body) ? 'JSON.stringify(' + body.expr + ')' : body.expr));
    }

    var call = [
        '(async () => {',
        '  const response = await axios.request({',
        options.join(',\n'),
        '  });',
        '',
        '  console.log(response.status);',
        '  console.log(response.data);',
        '})();'
    ];

    return head.join('\n') + '\n\n' + call.join('\n');
}

/* ------------------------------------------------------------------ Python */

/** Python 字面量：JSON 除了 true/false/null，其它写法在 Python 里都合法 */
function pyLiteral(value, base) {
    var pad = base || '';

    if (value === null) return 'None';
    if (value === true) return 'True';
    if (value === false) return 'False';
    if (typeof value === 'number') return String(value);
    if (typeof value === 'string') return JSON.stringify(value);

    if (Array.isArray(value)) {
        if (!value.length) return '[]';
        var items = value.map(function (item) { return pad + '    ' + pyLiteral(item, pad + '    '); });
        return '[\n' + items.join(',\n') + '\n' + pad + ']';
    }

    var keys = Object.keys(value);
    if (!keys.length) return '{}';
    var entries = keys.map(function (key) {
        return pad + '    ' + JSON.stringify(key) + ': ' + pyLiteral(value[key], pad + '    ');
    });
    return '{\n' + entries.join(',\n') + '\n' + pad + '}';
}

var PY_FUNCS = {
    GET: 'get',
    POST: 'post',
    PUT: 'put',
    DELETE: 'delete',
    PATCH: 'patch',
    HEAD: 'head',
    OPTIONS: 'options'
};

function renderPython(request) {
    var body = request.body;
    var lines = ['import requests', ''];
    lines.push('url = ' + JSON.stringify(request.url));

    var callArgs = ['url'];

    if (request.headers.length) {
        var headerLines = request.headers.map(function (pair) {
            return '    ' + JSON.stringify(pair[0]) + ': ' + JSON.stringify(pair[1]);
        });
        lines.push('headers = {\n' + headerLines.join(',\n') + '\n}');
        callArgs.push('headers=headers');
    }

    var closeFiles = [];

    if (body.kind === 'raw') {
        if (body.json && body.value !== undefined) {
            lines.push('payload = ' + pyLiteral(body.value, ''));
            callArgs.push('json=payload');
        } else {
            lines.push('payload = ' + JSON.stringify(body.text));
            callArgs.push('data=payload');
        }
    } else if (body.kind === 'urlencoded') {
        var fields = body.fields.map(function (pair) {
            return '    ' + JSON.stringify(pair[0]) + ': ' + JSON.stringify(pair[1]);
        });
        lines.push('payload = {\n' + fields.join(',\n') + '\n}');
        callArgs.push('data=payload');
    } else if (body.kind === 'form') {
        var plain = body.fields.filter(function (field) { return field.file === undefined; });
        var files = body.fields.filter(function (field) { return field.file !== undefined; });

        if (plain.length) {
            var plainLines = plain.map(function (field) {
                return '    ' + JSON.stringify(field.key) + ': ' + JSON.stringify(field.value);
            });
            lines.push('payload = {\n' + plainLines.join(',\n') + '\n}');
            callArgs.push('data=payload');
        }
        if (files.length) {
            var fileLines = files.map(function (field) {
                // 关的时候要用 files[...] 取回来，不能拿字段名当变量名（中文键当不了变量名）
                closeFiles.push('files[' + JSON.stringify(field.key) + ']');
                return '    ' + JSON.stringify(field.key) + ': open(' + JSON.stringify(field.file) + ', "rb")';
            });
            lines.push('files = {\n' + fileLines.join(',\n') + '\n}');
            callArgs.push('files=files');
        }
    } else if (body.kind === 'binary') {
        lines.push('payload = open(' + JSON.stringify(body.file) + ', "rb")');
        closeFiles.push('payload');
        callArgs.push('data=payload');
    }

    callArgs.push('timeout=30');

    var fn = PY_FUNCS[request.method];
    var call = fn
        ? 'requests.' + fn + '(' + callArgs.join(', ') + ')'
        : 'requests.request(' + JSON.stringify(request.method) + ', ' + callArgs.join(', ') + ')';

    lines.push('');
    lines.push('response = ' + call);
    lines.push('print(response.status_code)');
    lines.push('print(response.text)');

    if (closeFiles.length) {
        lines.push('');
        closeFiles.forEach(function (name) { lines.push(name + '.close()'); });
    }

    return lines.join('\n');
}

/* ------------------------------------------------------------------ Java */

/** Java 字符串：非 ASCII 一律写成 \uXXXX，源文件用什么编码都不会乱 */
function javaString(value) {
    var text = String(value);
    var out = '';

    for (var i = 0; i < text.length; i++) {
        var ch = text.charAt(i);
        var code = text.charCodeAt(i);

        if (ch === '\\') out += '\\\\';
        else if (ch === '"') out += '\\"';
        else if (code === 10) out += '\\n';
        else if (code === 13) out += '\\r';
        else if (code === 9) out += '\\t';
        else if (code < 0x20 || code > 0x7e) out += '\\u' + ('0000' + code.toString(16)).slice(-4);
        else out += ch;
    }

    return '"' + out + '"';
}

function renderJava(request) {
    var body = request.body;
    var lines = [];
    var imports = ['java.io.IOException', 'okhttp3.*'];

    if (body.kind === 'form' || body.kind === 'binary') imports.splice(1, 0, 'java.io.File');

    lines.push(imports.map(function (name) { return 'import ' + name + ';'; }).join('\n'));
    lines.push('');
    lines.push('public class Main {');
    lines.push('    public static void main(String[] args) throws IOException {');
    lines.push('        OkHttpClient client = new OkHttpClient();');
    // body 在 if 里赋值、在 if 外面用，所以先声明成 null（Java 的块作用域不允许跨块）
    if (body.kind !== 'none') {
        lines.push('');
        lines.push('        RequestBody body = null;');
        lines.push('');
    }

    if (body.kind === 'raw') {
        var mediaType = contentTypeOf(request) || 'application/json';
        lines.push('        MediaType mediaType = MediaType.parse(' + javaString(mediaType) + ');');
        lines.push('        body = RequestBody.create(' + javaString(body.text) + ', mediaType);');
    } else if (body.kind === 'urlencoded') {
        lines.push('        body = new FormBody.Builder()');
        body.fields.forEach(function (pair) {
            lines.push('                .add(' + javaString(pair[0]) + ', ' + javaString(pair[1]) + ')');
        });
        lines.push('                .build();');
    } else if (body.kind === 'form') {
        lines.push('        body = new MultipartBody.Builder()');
        lines.push('                .setType(MultipartBody.FORM)');
        body.fields.forEach(function (field) {
            if (field.file !== undefined) {
                lines.push('                .addFormDataPart(' + javaString(field.key) + ', ' + javaString(field.name) +
                    ', RequestBody.create(new File(' + javaString(field.file) +
                    '), MediaType.parse("application/octet-stream")))');
            } else {
                lines.push('                .addFormDataPart(' + javaString(field.key) + ', ' + javaString(field.value) + ')');
            }
        });
        lines.push('                .build();');
    } else if (body.kind === 'binary') {
        lines.push('        body = RequestBody.create(new File(' + javaString(body.file) +
            '), MediaType.parse("application/octet-stream"));');
    }

    lines.push('');
    lines.push('        Request request = new Request.Builder()');
    lines.push('                .url(' + javaString(request.url) + ')');
    lines.push('                .method(' + javaString(request.method) + ', ' + (body.kind === 'none' ? 'null' : 'body') + ')');
    request.headers.forEach(function (pair) {
        lines.push('                .addHeader(' + javaString(pair[0]) + ', ' + javaString(pair[1]) + ')');
    });
    lines.push('                .build();');
    lines.push('');
    lines.push('        try (Response response = client.newCall(request).execute()) {');
    lines.push('            System.out.println(response.code());');
    lines.push('            System.out.println(response.body() != null ? response.body().string() : "");');
    lines.push('        }');
    lines.push('    }');
    lines.push('}');

    return lines.join('\n');
}

/* ------------------------------------------------------------------ Go */

/** Go 字符串：内容里没有反引号和回车就用反引号原文（JSON 最好看），否则双引号转义 */
function goString(value) {
    var text = String(value);
    if (text.indexOf('`') === -1 && text.indexOf('\r') === -1) return '`' + text + '`';

    var out = '';
    for (var i = 0; i < text.length; i++) {
        var ch = text.charAt(i);
        var code = text.charCodeAt(i);

        if (ch === '\\') out += '\\\\';
        else if (ch === '"') out += '\\"';
        else if (code === 10) out += '\\n';
        else if (code === 13) out += '\\r';
        else if (code === 9) out += '\\t';
        else if (code < 0x20) out += '\\u' + ('0000' + code.toString(16)).slice(-4);
        else out += ch;
    }
    return '"' + out + '"';
}

function renderGo(request) {
    var body = request.body;
    // Go 不允许导入用不到的包，所以按请求体形态一个个加
    var imports = ['fmt', 'io', 'net/http'];
    var pre = [];
    var bodyExpr = null;

    if (body.kind === 'raw') {
        imports.push('strings');
        pre.push('payload := strings.NewReader(' + goString(body.text) + ')');
        bodyExpr = 'payload';
    } else if (body.kind === 'urlencoded') {
        imports.push('strings', 'net/url');
        var values = body.fields.map(function (pair) {
            return '\t' + JSON.stringify(pair[0]) + ': {' + JSON.stringify(pair[1]) + '},';
        });
        // url.Values.Encode() 和发送时用的编码规则一致（空格编成 +，键排序）
        pre.push('payload := strings.NewReader(url.Values{\n' + values.join('\n') + '\n}.Encode())');
        bodyExpr = 'payload';
    } else if (body.kind === 'form') {
        imports.push('bytes', 'mime/multipart');
        pre.push('var buffer bytes.Buffer');
        pre.push('writer := multipart.NewWriter(&buffer)');
        body.fields.forEach(function (field) {
            if (field.file !== undefined) {
                imports.push('os');
                pre.push('file, err := os.Open(' + goString(field.file) + ')');
                pre.push('if err != nil {');
                pre.push('    panic(err)');
                pre.push('}');
                pre.push('part, err := writer.CreateFormFile(' + goString(field.key) + ', ' + goString(field.name) + ')');
                pre.push('if err != nil {');
                pre.push('    panic(err)');
                pre.push('}');
                pre.push('if _, err := io.Copy(part, file); err != nil {');
                pre.push('    panic(err)');
                pre.push('}');
                pre.push('file.Close()');
            } else {
                pre.push('if err := writer.WriteField(' + goString(field.key) + ', ' + goString(field.value) + '); err != nil {');
                pre.push('    panic(err)');
                pre.push('}');
            }
        });
        pre.push('writer.Close()');
        bodyExpr = '&buffer';
    } else if (body.kind === 'binary') {
        imports.push('os');
        pre.push('file, err := os.Open(' + goString(body.file) + ')');
        pre.push('if err != nil {');
        pre.push('    panic(err)');
        pre.push('}');
        pre.push('defer file.Close()');
        bodyExpr = 'file';
    }

    var headers = request.headers.slice();

    var lines = [];
    lines.push('package main');
    lines.push('');
    lines.push('import (');
    imports.sort().forEach(function (name) { lines.push('\t' + JSON.stringify(name)); });
    lines.push(')');
    lines.push('');
    lines.push('func main() {');

    pre.forEach(function (line) { lines.push(indent(line, '\t')); });

    if (pre.length) lines.push('');
    lines.push('\treq, err := http.NewRequest(' + JSON.stringify(request.method) + ', ' + goString(request.url) +
        ', ' + (bodyExpr === null ? 'nil' : bodyExpr) + ')');
    lines.push('\tif err != nil {');
    lines.push('\t\tpanic(err)');
    lines.push('\t}');
    headers.forEach(function (pair) {
        lines.push('\treq.Header.Add(' + goString(pair[0]) + ', ' + goString(pair[1]) + ')');
    });
    if (body.kind === 'form') {
        lines.push('\treq.Header.Set("Content-Type", writer.FormDataContentType())');
    }
    lines.push('');
    lines.push('\tres, err := http.DefaultClient.Do(req)');
    lines.push('\tif err != nil {');
    lines.push('\t\tpanic(err)');
    lines.push('\t}');
    lines.push('\tdefer res.Body.Close()');
    lines.push('');
    lines.push('\tbody, err := io.ReadAll(res.Body)');
    lines.push('\tif err != nil {');
    lines.push('\t\tpanic(err)');
    lines.push('\t}');
    lines.push('');
    lines.push('\tfmt.Println(res.StatusCode)');
    lines.push('\tfmt.Println(string(body))');
    lines.push('}');

    return lines.join('\n');
}

/* ------------------------------------------------------------------ PHP */

/** PHP 单引号字符串：只认 \\ 和 \'，其它字符原样（换行就是真换行） */
function phpString(value) {
    return "'" + String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}

function renderPhp(request) {
    var body = request.body;
    var lines = ['<?php', '', '$curl = curl_init();', ''];

    lines.push('curl_setopt_array($curl, [');
    lines.push('    CURLOPT_URL => ' + phpString(request.url) + ',');
    lines.push('    CURLOPT_RETURNTRANSFER => true,');
    lines.push('    CURLOPT_CUSTOMREQUEST => ' + phpString(request.method) + ',');

    var headers = request.headers.slice();

    if (body.kind === 'raw') {
        lines.push('    CURLOPT_POSTFIELDS => ' + phpString(body.text) + ',');
    } else if (body.kind === 'urlencoded') {
        lines.push('    CURLOPT_POSTFIELDS => http_build_query([');
        body.fields.forEach(function (pair) {
            lines.push('        ' + phpString(pair[0]) + ' => ' + phpString(pair[1]) + ',');
        });
        lines.push('    ]),');
    } else if (body.kind === 'form') {
        lines.push('    CURLOPT_POSTFIELDS => [');
        body.fields.forEach(function (field) {
            if (field.file !== undefined) {
                lines.push('        ' + phpString(field.key) + ' => new CURLFile(' + phpString(field.file) + '),');
            } else {
                lines.push('        ' + phpString(field.key) + ' => ' + phpString(field.value) + ',');
            }
        });
        lines.push('    ],');
    } else if (body.kind === 'binary') {
        lines.push('    CURLOPT_POSTFIELDS => file_get_contents(' + phpString(body.file) + '),');
    }

    if (headers.length) {
        lines.push('    CURLOPT_HTTPHEADER => [');
        headers.forEach(function (pair) {
            lines.push('        ' + phpString(pair[0] + ': ' + pair[1]) + ',');
        });
        lines.push('    ],');
    }

    lines.push(']);');
    lines.push('');
    lines.push('$response = curl_exec($curl);');
    lines.push('');
    lines.push('if (curl_errno($curl)) {');
    lines.push('    echo curl_error($curl);');
    lines.push('} else {');
    lines.push('    echo $response;');
    lines.push('}');
    lines.push('');
    lines.push('curl_close($curl);');

    return lines.join('\n');
}

/* ------------------------------------------------------------------ C# */

/** C# 字符串：非 ASCII 写成 \uXXXX，源文件编码不影响结果 */
function csString(value) {
    return javaString(value);
}

function renderCsharp(request) {
    var body = request.body;
    var imports = ['System', 'System.Net.Http', 'System.Text', 'System.Threading.Tasks'];
    var lines = [];
    var contentLines = [];
    var needsFile = body.kind === 'binary' || (body.kind === 'form' && body.fields.some(function (field) {
        return field.file !== undefined;
    }));

    if (needsFile) imports.push('System.IO');
    if (body.kind === 'urlencoded' || body.kind === 'form') imports.push('System.Collections.Generic');

    var ctHeader = request.headers.filter(function (pair) {
        return pair[0].toLowerCase() === 'content-type';
    })[0];
    if (ctHeader && body.kind !== 'form') imports.push('System.Net.Http.Headers');

    lines.push(imports.map(function (name) { return 'using ' + name + ';'; }).join('\n'));
    lines.push('');
    lines.push('class Program');
    lines.push('{');
    lines.push('    static async Task Main()');
    lines.push('    {');
    lines.push('        using var client = new HttpClient();');
    lines.push('');
    lines.push('        using var request = new HttpRequestMessage(' + csMethodExpr(request.method) + ', ' +
        csString(request.url) + ');');

    if (body.kind === 'raw') {
        contentLines.push('        request.Content = new StringContent(' + csString(body.text) + ', Encoding.UTF8' +
            csMediaArg(request) + ');');
    } else if (body.kind === 'urlencoded') {
        contentLines.push('        request.Content = new FormUrlEncodedContent(new Dictionary<string, string>');
        contentLines.push('        {');
        body.fields.forEach(function (pair) {
            contentLines.push('            { ' + csString(pair[0]) + ', ' + csString(pair[1]) + ' },');
        });
        contentLines.push('        });');
    } else if (body.kind === 'form') {
        contentLines.push('        var content = new MultipartFormDataContent();');
        body.fields.forEach(function (field) {
            if (field.file !== undefined) {
                contentLines.push('        content.Add(new ByteArrayContent(File.ReadAllBytes(' + csString(field.file) +
                    ')), ' + csString(field.key) + ', ' + csString(field.name) + ');');
            } else {
                contentLines.push('        content.Add(new StringContent(' + csString(field.value) + ', Encoding.UTF8), ' +
                    csString(field.key) + ');');
            }
        });
        contentLines.push('        request.Content = content;');
    } else if (body.kind === 'binary') {
        contentLines.push('        request.Content = new ByteArrayContent(File.ReadAllBytes(' + csString(body.file) + '));');
    }

    contentLines.forEach(function (line) { lines.push(line); });

    /*
     * Content-Type 不能加到 request.Headers 上（.NET 把它归在 Content 那边），
     * 所以显式设到 Content 上 —— 不设的话 ByteArrayContent 之类根本没有这个头，
     * 发出去就和「发送」不一样了。multipart 不设：boundary 是运行期生成的，设了反而会坏。
     */
    if (ctHeader && body.kind !== 'form') {
        lines.push('        request.Content.Headers.ContentType = MediaTypeHeaderValue.Parse(' + csString(ctHeader[1]) + ');');
    }

    request.headers.forEach(function (pair) {
        if (pair[0].toLowerCase() === 'content-type') return;   // 由 Content 自己带
        lines.push('        request.Headers.TryAddWithoutValidation(' + csString(pair[0]) + ', ' + csString(pair[1]) + ');');
    });

    lines.push('');
    lines.push('        using var response = await client.SendAsync(request);');
    lines.push('        Console.WriteLine((int)response.StatusCode);');
    lines.push('        Console.WriteLine(await response.Content.ReadAsStringAsync());');
    lines.push('    }');
    lines.push('}');

    return lines.join('\n');
}

var CS_METHODS = ['Get', 'Post', 'Put', 'Delete', 'Patch', 'Head', 'Options', 'Trace'];

function csMethodExpr(method) {
    var name = String(method || 'GET').toUpperCase();
    var known = CS_METHODS.filter(function (item) { return item.toUpperCase() === name; })[0];
    // HttpMethod 只有固定几个静态属性，其它方法走构造函数
    return known ? 'HttpMethod.' + known : 'new HttpMethod(' + csString(name) + ')';
}

/** StringContent 的媒体类型参数：用请求头里的 Content-Type，没有就不传 */
function csMediaArg(request) {
    var found = request.headers.filter(function (pair) {
        return pair[0].toLowerCase() === 'content-type';
    })[0];
    return found ? ', ' + csString(String(found[1]).split(';')[0].trim()) : '';
}

/** 请求头里的 Content-Type（给 Java 用） */
function contentTypeOf(request) {
    var found = request.headers.filter(function (pair) {
        return pair[0].toLowerCase() === 'content-type';
    })[0];
    return found ? String(found[1]).split(';')[0].trim() : '';
}

/* ------------------------------------------------------------------ 出口 */

function renderLanguage(request, language) {
    switch (String(language || '').toLowerCase()) {
        case 'fetch': return renderFetch(request);
        case 'axios': return renderAxios(request);
        case 'python': return renderPython(request);
        case 'java': return renderJava(request);
        case 'go': return renderGo(request);
        case 'php': return renderPhp(request);
        case 'csharp': return renderCsharp(request);
        default: return renderCurl(request);
    }
}

/**
 * @param {object} prepared `lib/api/send.js` 的 prepare 产物
 * @returns {{curl: string, code: Object<string,string>, missing: string[]}}
 *   `curl` 是 cURL 那一种（`/send/curl` 的老客户端只认它），`code` 是「语言 → 代码」的表。
 *   一次把八种都渲染出来（就是拼字符串，很快），前端切语言不用再打一次接口。
 */
function fromPrepared(prepared) {
    var request = prepareRequest(prepared);

    var code = {};
    LANGUAGES.forEach(function (id) { code[id] = renderLanguage(request, id); });

    return { curl: code.curl, code: code, missing: request.missing };
}

module.exports = {
    LANGUAGES: LANGUAGES,
    prepareRequest: prepareRequest,
    renderLanguage: renderLanguage,
    renderCurl: renderCurl,
    quote: quote,
    fromPrepared: fromPrepared
};
