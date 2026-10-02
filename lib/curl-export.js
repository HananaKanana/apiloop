/**
 * 把一次请求转成 cURL 命令（「代码片段 → cURL」，用户 2026-10-01：要能一键复制 curl）。
 *
 * 用的是**发送时的同一套规则**，生成的命令和真正发出去的请求一致：
 *   - 变量按环境 → 目录 → 项目各层解析成实际值（`variables.resolveSpec`，和执行器同一个）；
 *   - 地址按 `url-utils.buildUrl` 拼（补协议、路径参数、query）；
 *   - 鉴权按 `executor.buildAuth` 加（「继承」已经在 prepare 里顺着目录链解析好了）；
 *   - JSON 请求体里的注释和发送前一样去掉。
 *
 * 不跑前置脚本（Postman 的代码片段也不跑）；Cookie 罐里的 cookie 不带上（那是本机的状态）。
 * 用户自己写了的请求头优先，鉴权和 Content-Type 都不覆盖它 —— 和执行器一致。
 */

var executor = require('./executor');
var variables = require('./variables');
var urlUtils = require('./url-utils');
var jsonComments = require('./json-comments');
var sendCore = require('./send-core');

var RAW_CONTENT_TYPES = {
    json: 'application/json',
    text: 'text/plain',
    xml: 'application/xml',
    html: 'text/html',
    javascript: 'application/javascript'
};

/** shell 单引号：里面的单引号写成 '\'' */
function quote(text) {
    return "'" + String(text).replace(/'/g, "'\\''") + "'";
}

function enabledRows(rows) {
    if (!Array.isArray(rows)) return [];
    return rows.filter(function (row) {
        return row && row.enabled !== false && row.key !== null && row.key !== undefined && String(row.key) !== '';
    });
}

function str(value) {
    return value === null || value === undefined ? '' : String(value);
}

/**
 * @param {object} prepared `lib/api/send.js` 的 prepare 产物（spec + 变量各层）
 * @returns {{curl: string, missing: string[]}} missing：没定义的变量名（命令里原样留着 {{x}}）
 */
function fromPrepared(prepared) {
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
    var dataLines = [];   // 每一项是一整段参数（已经带好引号）
    var hasBody = false;

    if (mode === 'raw') {
        var raw = typeof body.raw === 'string' ? body.raw : '';
        if (body.language === 'json') {
            var stripped = jsonComments.stripJsonComments(raw);
            // 去注释是保留行结构的：整行注释会剩下一行空白。命令是给人看的，把这种行去掉
            var before = raw.split('\n');
            var after = stripped.split('\n');
            raw = before.length === after.length
                ? after.filter(function (line, index) {
                    return !(line.trim() === '' && before[index].trim() !== '');
                }).join('\n')
                : stripped;
        }
        if (raw !== '') {
            hasBody = true;
            addIfAbsent('Content-Type', RAW_CONTENT_TYPES[body.language] || RAW_CONTENT_TYPES.text);
            dataLines.push('--data-raw ' + quote(raw));
        }
    } else if (mode === 'urlencoded') {
        enabledRows(body.form).forEach(function (row) {
            hasBody = true;
            dataLines.push('--data-urlencode ' + quote(String(row.key) + '=' + str(row.value)));
        });
    } else if (mode === 'formdata') {
        enabledRows(body.form).forEach(function (row) {
            hasBody = true;
            if (row.kind === 'file') {
                // curl 的 -F 'name=@路径' 会自己读文件；路径就是请求里填的那个（本机路径）
                dataLines.push('--form ' + quote(String(row.key) + '=@"' + str(row.src) + '"'));
            } else {
                dataLines.push('--form ' + quote(String(row.key) + '=' + str(row.value)));
            }
        });
    } else if (mode === 'binary') {
        var file = body.file || {};
        if (file.src) {
            hasBody = true;
            addIfAbsent('Content-Type', 'application/octet-stream');
            dataLines.push('--data-binary ' + quote('@' + str(file.src)));
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
        hasBody = true;
        addIfAbsent('Content-Type', 'application/json');
        dataLines.push('--data-raw ' + quote(JSON.stringify({ query: graphql.query || '', variables: graphqlVariables })));
    }

    /* -------- 拼命令 -------- */

    var parts = ['curl --location ' + quote(url)];

    // curl 默认 GET、带了 --data 默认 POST：只有和默认不一样时才写 --request，命令更干净
    var implied = hasBody ? 'POST' : 'GET';
    if (method !== implied) parts.splice(1, 0, '--request ' + method);

    headers.forEach(function (pair) {
        parts.push('--header ' + quote(pair[0] + ': ' + pair[1]));
    });
    dataLines.forEach(function (line) { parts.push(line); });

    return {
        curl: parts.join(' \\\n'),
        missing: resolved.missing || []
    };
}

module.exports = {
    fromPrepared: fromPrepared,
    quote: quote
};
