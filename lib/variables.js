/**
 * 变量替换：把请求里的 {{name}} 换成实际值。
 *
 * 注意和 mock 占位符 {{@xxx}} 区分 —— 那是造假数据用的模板语法，以 @ 开头，
 * 这里一律原样保留，绝不能当成变量去查表，否则接口里的模板会被替换空。
 *
 * 四条约定：
 * - 查不到的变量原样保留，名字记进 missing，由界面提示「这些变量还没定义」；
 * - 不递归展开：值里再出现 {{x}} 就保持原样，避免变量之间互相引用转不出来；
 * - 内置动态变量（{{$guid}} 这类）每遇到一次就重新生成一次；
 * - **变量名认中文**（`\p{L}`），所以数据驱动里 CSV 的中文列名（`账号`、`密码`）也能替换。
 *
 * 动态变量表 DYNAMIC 和前端 `web/src/utils/suggestions.js` 的 DYNAMIC_VARIABLES
 * **是两份、必须保持一致**（前端要用来做补全和「未定义」判断，拿不到这边的代码）。
 */

var crypto = require('crypto');
var mockEngine = require('./mock-engine');

/** {{ 与 }} 之间不允许再出现花括号，否则会跨占位符匹配 */
var PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;

/**
 * 变量名允许的字符：Unicode 字母、数字、下划线、点、短横、美元符。
 * `\p{L}` 是关键 —— 老版本只认 `\w`，中文列名 `{{账号}}` 会被当成「不是变量」原样留着。
 */
var NAME_PATTERN = /^[\p{L}\p{N}_.\-$]+$/u;

/**
 * 动态变量可以带参数：`{{$randomInt(1,100)}}`。
 * 只有动态变量允许括号，普通变量名里出现括号就不是变量（原样保留）。
 */
var CALL_PATTERN = /^([\p{L}\p{N}_.\-$]+)\s*\(([^()]*)\)$/u;

/* ------------------------------------------------------------------ 小工具 */

function isBlank(value) {
    return value === null || value === undefined;
}

function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
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

function randomInt(min, max) {
    var lo = Math.floor(min);
    var hi = Math.floor(max);
    if (hi < lo) { var swap = lo; lo = hi; hi = swap; }
    return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}

function pick(list) {
    return list[randomInt(0, list.length - 1)];
}

function pad(num, len) {
    var text = String(num);
    while (text.length < len) text = '0' + text;
    return text;
}

/** `1,100` → `['1', '100']`；没参数时是 null */
function parseArgs(raw) {
    if (raw === undefined || raw === null || String(raw).trim() === '') return [];
    return String(raw).split(',').map(function (item) { return item.trim(); });
}

function argNumber(args, index, fallback) {
    if (!args || args.length <= index) return fallback;
    var num = Number(args[index]);
    return isNaN(num) ? fallback : num;
}

/* ------------------------------------------------------------------ 中文随机数据 */

/** mock 引擎里现成的生成器（中文名、地址、公司、邮箱、IP……），能复用就复用 */
var MOCK_FN = {};
mockEngine.PLACEHOLDERS.forEach(function (item) {
    MOCK_FN[item.name.toLowerCase()] = item.fn;
});

function fromMock(name, args) {
    var fn = MOCK_FN[name];
    return fn ? String(fn(args || [], {})) : '';
}

/** 真实手机号段（前 3 位） */
var PHONE_PREFIXES = [
    '130', '131', '132', '133', '134', '135', '136', '137', '138', '139',
    '147', '149',
    '150', '151', '152', '153', '155', '156', '157', '158', '159',
    '166', '171', '172', '173', '175', '176', '177', '178',
    '180', '181', '182', '183', '184', '185', '186', '187', '188', '189',
    '191', '198', '199'
];

/** 身份证前 6 位的地区码（都是真实在用的行政区划代码） */
var REGION_CODES = [
    '110101', '110105', '110108', '110115',
    '120101', '120103', '120104',
    '130102', '130203', '130302',
    '210102', '210203', '210302',
    '310101', '310104', '310115',
    '320102', '320106', '320505',
    '330102', '330106', '330108',
    '340102', '340104', '350102', '350203', '360102', '360103',
    '370102', '370202', '370303',
    '410102', '410105', '410202',
    '420102', '420106', '420111',
    '430102', '430104', '430111',
    '440103', '440104', '440106', '440305', '440306',
    '450102', '450103', '500101', '500103', '500106',
    '510104', '510107', '510112',
    '520102', '520103', '530102', '530103',
    '610102', '610113', '620102', '620103', '630102', '630103'
];

/** 身份证校验位的加权因子和余数对照表（GB 11643） */
var ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
var ID_CHECK_CHARS = '10X98765432';

/** 银行卡号前 6 位（真实在用的发卡行 BIN，工行 / 农行 / 建行 / 中行 / 招行等） */
var BANK_PREFIXES = [
    '622202', '622203', '622208', '621226', '620521',
    '622848', '622845', '622846', '622849',
    '621700', '622700', '621661', '622280',
    '622588', '622575', '622576', '621286', '622609',
    '621483', '622155', '622156', '621758', '621792', '621691'
];

/** 统一社会信用代码的字符集（31 位，不含 I、O、S、V、Z）和加权因子（GB 32100） */
var USCC_CHARS = '0123456789ABCDEFGHJKLMNPQRTUWXY';
var USCC_WEIGHTS = [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28];

/** 邮箱：用 ASCII 的本地部分 —— 真实后端多半不收中文邮箱，拿它当测试数据会被打回 */
var EMAIL_LOCALS = [
    'user', 'test', 'admin', 'dev', 'qa', 'demo', 'guest', 'tester',
    'zhangsan', 'lisi', 'wangwu', 'zhaoliu', 'chenxi', 'liuyang', 'sunqi', 'zhouba'
];
var EMAIL_DOMAINS = ['example.com', 'test.com', 'demo.com', '163.com', '126.com', 'qq.com', 'outlook.com'];

/** 车牌：省份简称 + 发牌机关字母 + 5 位序号（序号里不含 I、O） */
var PLATE_PROVINCES = '京津冀晋蒙辽吉黑沪苏浙皖闽赣鲁豫鄂湘粤桂琼渝川贵云藏陕甘青宁新';
var PLATE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
var PLATE_CHARS = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ';

function randomEmail() {
    return pick(EMAIL_LOCALS) + randomInt(1, 9999) + '@' + pick(EMAIL_DOMAINS);
}

function daysInMonth(year, month) {
    return new Date(year, month, 0).getDate();
}

function randomPhone() {
    return pick(PHONE_PREFIXES) + pad(randomInt(0, 99999999), 8);
}

/** 生日（YYYYMMDD），年龄大概在 20~66 岁之间，日期本身合法（不会出 2 月 30 日） */
function randomBirthday() {
    var year = randomInt(1960, 2005);
    var month = randomInt(1, 12);
    var day = randomInt(1, daysInMonth(year, month));
    return String(year) + pad(month, 2) + pad(day, 2);
}

function randomIdCard() {
    var body = pick(REGION_CODES) + randomBirthday() + pad(randomInt(0, 999), 3);
    var sum = 0;
    for (var i = 0; i < 17; i++) sum += Number(body.charAt(i)) * ID_WEIGHTS[i];
    return body + ID_CHECK_CHARS.charAt(sum % 11);
}

/** Luhn 校验位：从右往左隔一位翻倍，和卡号本身拼起来能被 10 整除 */
function luhnCheckDigit(digits) {
    var sum = 0;
    var double = true;
    for (var i = digits.length - 1; i >= 0; i--) {
        var num = Number(digits.charAt(i));
        if (double) {
            num *= 2;
            if (num > 9) num -= 9;
        }
        sum += num;
        double = !double;
    }
    return (10 - (sum % 10)) % 10;
}

function randomBankCard() {
    var length = Math.random() < 0.5 ? 16 : 19;
    var digits = pick(BANK_PREFIXES);
    while (digits.length < length - 1) digits += String(randomInt(0, 9));
    return digits + String(luhnCheckDigit(digits));
}

function randomCreditCode() {
    // 9 = 工商登记，1 = 企业，后面接行政区划码
    var body = '91' + pick(REGION_CODES);
    while (body.length < 17) body += USCC_CHARS.charAt(randomInt(0, USCC_CHARS.length - 1));

    var sum = 0;
    for (var i = 0; i < 17; i++) sum += USCC_CHARS.indexOf(body.charAt(i)) * USCC_WEIGHTS[i];
    return body + USCC_CHARS.charAt((31 - (sum % 31)) % 31);
}

function randomPlate() {
    var out = PLATE_PROVINCES.charAt(randomInt(0, PLATE_PROVINCES.length - 1));
    out += PLATE_LETTERS.charAt(randomInt(0, PLATE_LETTERS.length - 1));
    for (var i = 0; i < 5; i++) out += PLATE_CHARS.charAt(randomInt(0, PLATE_CHARS.length - 1));
    return out;
}

/** 近一年内（含今天）的日期，days 是往回推的天数 */
function recentDay(offset) {
    return fromMock('dateoffset', [String(-offset)]);
}

/* ------------------------------------------------------------------ 动态变量表 */

/**
 * 内置动态变量。键统一小写，查表时把名字也转小写，`{{$GUID}}` 也能用；
 * 中文写法（`{{$手机号}}`）转小写不变，所以两种写法共用一个生成器。
 *
 * 函数收到的是**参数数组**（`{{$randomInt(1,100)}}` → `['1','100']`），没参数时是 null。
 */
var DYNAMIC = {
    /* 标识 / 时间 */
    '$guid': function () { return crypto.randomUUID(); },
    '$timestamp': function () { return String(Math.floor(Date.now() / 1000)); },
    '$timestampms': function () { return String(Date.now()); },
    '$isotimestamp': function () { return new Date().toISOString(); },
    '$randomint': function (args) {
        if (args && args.length >= 2) {
            return String(randomInt(argNumber(args, 0, 0), argNumber(args, 1, 1000)));
        }
        return String(randomInt(0, 1000));
    },
    '$整数': function (args) { return DYNAMIC.$randomint(args); },

    /* 中文常见测试数据 */
    '$randomphone': function () { return randomPhone(); },
    '$手机号': function () { return randomPhone(); },
    '$randomidcard': function () { return randomIdCard(); },
    '$身份证': function () { return randomIdCard(); },
    '$randomchinesename': function () { return fromMock('cname'); },
    '$中文名': function () { return fromMock('cname'); },
    '$randomemail': function () { return randomEmail(); },
    '$邮箱': function () { return randomEmail(); },
    '$randomdate': function () { return recentDay(randomInt(0, 364)); },
    '$日期': function () { return recentDay(randomInt(0, 364)); },
    '$randomdatetime': function () { return fromMock('datetimeoffset', [String(-randomInt(0, 364))]); },
    '$时间': function () { return fromMock('datetimeoffset', [String(-randomInt(0, 364))]); },
    '$randomaddress': function () { return fromMock('address'); },
    '$地址': function () { return fromMock('address'); },
    '$randomcompany': function () { return fromMock('company'); },
    '$公司': function () { return fromMock('company'); },
    '$randombankcard': function () { return randomBankCard(); },
    '$银行卡': function () { return randomBankCard(); },
    '$randomcreditcode': function () { return randomCreditCode(); },
    '$信用代码': function () { return randomCreditCode(); },
    '$randomplate': function () { return randomPlate(); },
    '$车牌': function () { return randomPlate(); },
    '$randomip': function () { return fromMock('ip'); }
};

/* ------------------------------------------------------------------ 替换 */

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

        // 空名、@ 开头的 mock 占位符：都不是变量，原样留着
        if (!name || name.charAt(0) === '@') return whole;

        var args = null;
        var call = CALL_PATTERN.exec(name);
        if (call) {
            name = call[1];
            args = parseArgs(call[2]);
        }

        var dynamic = DYNAMIC[name.toLowerCase()];
        if (dynamic) return String(dynamic(args));

        // 带括号但不是动态变量：普通变量名里不允许括号，原样留着
        if (args !== null) return whole;

        if (!NAME_PATTERN.test(name)) return whole;

        if (hasOwn(values, name)) {
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
