/**
 * 变量替换：把请求里的 {{name}} 换成实际值。
 *
 * 注意和 mock 占位符 {{@xxx}} 区分 —— 那是造假数据用的模板语法，以 @ 开头，
 * 这里一律原样保留，绝不能当成变量去查表，否则接口里的模板会被替换空。
 *
 * 三条约定：
 * - 查不到的变量原样保留，名字记进 missing，由界面提示「这些变量还没定义」；
 * - 不递归展开：值里再出现 {{x}} 就保持原样，避免变量之间互相引用转不出来；
 * - 内置动态变量（{{$guid}} 这类）每遇到一次就重新生成一次。
 */

var crypto = require('crypto');

/** {{ 与 }} 之间不允许再出现花括号，否则会跨占位符匹配 */
var PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;

/** 变量名允许的字符：字母数字下划线、点、短横、美元符 */
var NAME_PATTERN = /^[\w.\-$]+$/;

/** 内置动态变量。键统一小写，查表时把名字也转小写，{{$GUID}} 也能用 */
var DYNAMIC = {
    '$guid': function () {
        return crypto.randomUUID();
    },
    '$timestamp': function () {
        return String(Math.floor(Date.now() / 1000));
    },
    '$isotimestamp': function () {
        return new Date().toISOString();
    },
    '$randomint': function () {
        return String(Math.floor(Math.random() * 1001));
    }
};

function isBlank(value) {
    return value === null || value === undefined;
}

/** 复制一份普通对象（浅拷贝），替换后的新对象不该和入参共用引用 */
function clone(row) {
    var next = {};
    Object.keys(row || {}).forEach(function (key) {
        next[key] = row[key];
    });
    return next;
}

function pushMissing(target, names) {
    (names || []).forEach(function (name) {
        if (target.indexOf(name) === -1) target.push(name);
    });
}

/**
 * 替换一段文本里的变量。
 *
 * @param {string} text
 * @param {Object<string,string>} [vars]
 * @returns {{text: string, missing: string[]}}
 */
function resolve(text, vars) {
    if (typeof text !== 'string' || text.indexOf('{{') === -1) {
        return { text: text, missing: [] };
    }

    var values = vars || {};
    var missing = [];

    var result = text.replace(PLACEHOLDER, function (whole, rawName) {
        var name = String(rawName).trim();

        // 空名、@ 开头的 mock 占位符、名字里有非法字符：都不是变量，原样留着
        if (!name || name.charAt(0) === '@' || !NAME_PATTERN.test(name)) return whole;

        var dynamic = DYNAMIC[name.toLowerCase()];
        if (dynamic) return dynamic();

        if (Object.prototype.hasOwnProperty.call(values, name)) {
            return isBlank(values[name]) ? '' : String(values[name]);
        }

        if (missing.indexOf(name) === -1) missing.push(name);
        return whole;
    });

    return { text: result, missing: missing };
}

/**
 * 替换单个字符串字段，把缺失变量并进 missing。
 * 非字符串原样返回，undefined / null 归一成空串（便于后面拼 header 和请求体）。
 */
function resolveField(value, vars, missing) {
    if (typeof value !== 'string') return isBlank(value) ? '' : value;

    var resolved = resolve(value, vars);
    pushMissing(missing, resolved.missing);
    return resolved.text;
}

/** 键值行数组：只替换 key / value，其余字段（type / required / desc / enabled / kind / src）原样带过 */
function resolveRows(rows, vars, missing) {
    if (!Array.isArray(rows)) return [];

    return rows.map(function (row) {
        var next = clone(row);
        ['key', 'value'].forEach(function (field) {
            if (typeof next[field] !== 'string') return;
            var resolved = resolve(next[field], vars);
            next[field] = resolved.text;
            pushMissing(missing, resolved.missing);
        });
        return next;
    });
}

/** auth 的各个字段也要能写变量，比如 {{token}}、{{apiKey}} */
function resolveAuth(auth, vars, missing) {
    if (!auth) return null;

    if (auth.type === 'bearer') {
        return { type: 'bearer', token: resolveField(auth.token, vars, missing) };
    }
    if (auth.type === 'basic') {
        return {
            type: 'basic',
            username: resolveField(auth.username, vars, missing),
            password: resolveField(auth.password, vars, missing)
        };
    }
    if (auth.type === 'apikey') {
        return {
            type: 'apikey',
            key: resolveField(auth.key, vars, missing),
            value: resolveField(auth.value, vars, missing),
            in: auth.in === 'query' ? 'query' : 'header'
        };
    }

    // noauth / inherit / 不支持的鉴权类型：不认识内部字段，整块原样带过
    return clone(auth);
}

/**
 * 对整个请求定义做替换，返回一份新对象，不修改入参。
 *
 * @param {object} spec RequestSpec
 * @param {Object<string,string>} [vars]
 * @returns {{spec: object, missing: string[]}}
 */
function resolveSpec(spec, vars) {
    var source = spec || {};
    var missing = [];

    var url = resolveField(source.url, vars, missing);

    var params = source.params || {};
    var nextParams = {
        path: resolveRows(params.path, vars, missing),
        query: resolveRows(params.query, vars, missing),
        headers: resolveRows(params.headers, vars, missing)
    };

    var body = source.body || { mode: 'none' };
    var nextBody = clone(body);
    if (typeof body.raw === 'string') {
        var raw = resolve(body.raw, vars);
        nextBody.raw = raw.text;
        pushMissing(missing, raw.missing);
    }
    if (Array.isArray(body.form)) {
        nextBody.form = resolveRows(body.form, vars, missing);
    }
    if (body.graphql) {
        var query = resolveField(body.graphql.query, vars, missing);
        var graphqlVariables = resolveField(body.graphql.variables, vars, missing);
        nextBody.graphql = { query: query, variables: graphqlVariables };
    }

    return {
        spec: {
            method: source.method,
            url: url,
            params: nextParams,
            body: nextBody,
            auth: resolveAuth(source.auth, vars, missing)
        },
        missing: missing
    };
}

/**
 * 把「键值行」压成变量表。
 *
 * 调用方按「项目变量行 → 环境变量行」的顺序拼一个数组传进来，
 * 后出现的覆盖先出现的，就实现了 spec 第 3 节的优先级。
 * enabled === false 的行忽略；没写 enabled 的行按启用处理。
 *
 * @param {Array<{key: string, value: string, enabled?: boolean}>} rows
 * @returns {Object<string,string>}
 */
function fromRows(rows) {
    var values = {};
    if (!Array.isArray(rows)) return values;

    rows.forEach(function (row) {
        if (!row || row.enabled === false) return;

        var key = isBlank(row.key) ? '' : String(row.key);
        if (!key) return;

        values[key] = isBlank(row.value) ? '' : String(row.value);
    });

    return values;
}

module.exports = {
    resolve: resolve,
    resolveSpec: resolveSpec,
    fromRows: fromRows
};
