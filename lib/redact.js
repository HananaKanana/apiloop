/**
 * 历史的按查看者打码（契约第 12 节「历史中的原始请求也要打码」）。
 *
 * 为什么是「按查看者」而不是「写库时打码」：
 * - 历史里的 `request.spec` 是用户输入的**原始请求**，发起人点「重放」时需要完整内容
 *   —— 写库时就抹掉，等于把重放功能废掉；
 * - 但历史对项目里所有成员可见，别人（包括 admin）不该看到你手写的 token。
 *
 * 所以：**库里存的永远是原文，只在出接口前打码一份副本**。
 *
 * 注意这里是纯函数，不碰数据库也不碰请求对象 —— 判断「你是不是发起人」是路由的事。
 */

var REDACTED = '***';

/** 值一律打码的请求头。名字比大小写不敏感 */
var SENSITIVE_HEADERS = ['authorization', 'cookie', 'proxy-authorization'];

function isSensitive(name) {
    return SENSITIVE_HEADERS.indexOf(String(name).toLowerCase()) > -1;
}

/**
 * 请求头既可能是 DTO 的行数组 `[{ key, value, enabled }]`，
 * 也可能是执行器那套 `[[k, v]]`，两种都要认（历史里存的是前者，但别赌）。
 */
function redactHeaders(headers) {
    if (!Array.isArray(headers)) return headers;

    return headers.map(function (item) {
        if (Array.isArray(item)) {
            if (item.length < 2 || !isSensitive(item[0])) return item;
            return [item[0], REDACTED];
        }
        if (!item || typeof item !== 'object') return item;
        if (!isSensitive(item.key)) return item;

        return Object.assign({}, item, { value: REDACTED });
    });
}

/**
 * 鉴权里的敏感字段：bearer 的 token、basic 的 password、apikey 的 value。
 * 用户名保留 —— 排查「用的是哪个账号」时需要它，而它本身不是密钥。
 */
function redactAuth(auth) {
    if (!auth || typeof auth !== 'object') return auth;

    var copy = Object.assign({}, auth);

    if (copy.type === 'bearer' && copy.token !== undefined) copy.token = REDACTED;
    if (copy.type === 'basic' && copy.password !== undefined) copy.password = REDACTED;
    if (copy.type === 'apikey' && copy.value !== undefined) copy.value = REDACTED;

    return copy;
}

/**
 * 打码一份 RequestSpec 副本。
 *
 * 只处理契约点名的两处（请求头与鉴权）。**响应体不做处理**：那是服务端回显回来的
 * 内容，我们无从判断里面哪一段是凭据 —— 这个限制写在 README 里。
 */
function redactRequestSpec(spec) {
    if (!spec || typeof spec !== 'object') return spec;

    var copy = Object.assign({}, spec);

    if (spec.params && typeof spec.params === 'object') {
        var params = Object.assign({}, spec.params);
        if (params.headers !== undefined) params.headers = redactHeaders(params.headers);
        copy.params = params;
    }

    if (spec.auth !== undefined) copy.auth = redactAuth(spec.auth);

    return copy;
}

/**
 * 历史里的脚本结果打码（契约第 16 节）。
 *
 * 脚本最常干的两件事就是「把 token 打印出来」和「把 token 写进变量」，所以：
 * - `console` **整体清空** —— 它是一堆自由文本，挑不出哪一段是凭据，只能整体不留；
 * - `variables` 里 `set` 的**值**换成 `***`，key 保留 —— 别人还能看出脚本动过哪些变量，
 *   排查「为什么这个变量变了」时这一点有用。
 *
 * 测试结果、错误、警告、以及 `unset` 的 key 列表都不动：它们是排查问题用的，
 * 里面本来就不该有凭据。
 */
function redactScriptsResult(scripts) {
    if (!scripts || typeof scripts !== 'object') return scripts;

    var copy = Object.assign({}, scripts, { console: [] });

    if (scripts.variables && typeof scripts.variables === 'object') {
        var variables = Object.assign({}, scripts.variables);

        ['environment', 'project'].forEach(function (scope) {
            var change = scripts.variables[scope];
            if (!change || typeof change !== 'object' || !change.set) return;

            var masked = {};
            Object.keys(change.set).forEach(function (key) { masked[key] = REDACTED; });

            variables[scope] = Object.assign({}, change, { set: masked });
        });

        copy.variables = variables;
    }

    return copy;
}

/**
 * 历史里存的 `request` 是 `{ spec, environmentId }`。
 * 打码只动 spec，environmentId 原样带回去 —— 重放时要用它选环境。
 */
function redactHistoryRequest(request) {
    if (!request || typeof request !== 'object') return request;

    return Object.assign({}, request, { spec: redactRequestSpec(request.spec) });
}

/**
 * 保密变量的值在历史里的打码（第三轮第 3 节）。
 *
 * 历史里存的是**变量替换之后的请求**，保密值（password、私人 token）会明文出现在
 * URL / 请求头 / 请求体 / 甚至响应体里。写历史前把这些值整串换成 `******`。
 *
 * 和上面的 `***` 分开写是有意的：一个是「这个头不该被人看到」，一个是「这是你自己的
 * 保密变量的值，被特殊处理过」，长度都不一样，界面上也分辨得出来。
 */
var SECRET_MASK = '******';

/** 打码值得替换的最短长度 —— 太短的值满屏误伤（和 lib/secrets.js 同一口径） */
var MIN_SECRET_LENGTH = 4;

/**
 * 把一份结果里出现的保密值全部换成 `******`，返回新对象（不改入参）。
 *
 * 深度遍历，字符串命中就替换 —— 请求的每一处（url、headers、body）都要覆盖到，
 * 而这些地方在 `result` 里的层级不固定，逐个点名反而容易漏。
 *
 * @param {*} value
 * @param {string[]} [secrets] 保密值，长度不足 4 的忽略
 */
function maskSecrets(value, secrets) {
    var list = (secrets || []).filter(function (secret) {
        return typeof secret === 'string' && secret.length >= MIN_SECRET_LENGTH;
    });
    if (!list.length) return value;

    return maskNode(value, list);
}

function maskNode(value, list) {
    if (typeof value === 'string') {
        var text = value;
        for (var i = 0; i < list.length; i++) {
            if (text.indexOf(list[i]) === -1) continue;
            text = text.split(list[i]).join(SECRET_MASK);
        }
        return text;
    }
    if (Array.isArray(value)) {
        return value.map(function (item) { return maskNode(item, list); });
    }
    if (value && typeof value === 'object') {
        var out = {};
        Object.keys(value).forEach(function (key) { out[key] = maskNode(value[key], list); });
        return out;
    }
    return value;
}

module.exports = {
    redactRequestSpec: redactRequestSpec,
    redactHistoryRequest: redactHistoryRequest,
    redactScriptsResult: redactScriptsResult,
    redactHeaders: redactHeaders,
    redactAuth: redactAuth,
    maskSecrets: maskSecrets,
    SENSITIVE_HEADERS: SENSITIVE_HEADERS,
    REDACTED: REDACTED,
    SECRET_MASK: SECRET_MASK
};
