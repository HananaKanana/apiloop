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
 * 历史里存的 `request` 是 `{ spec, environmentId }`。
 * 打码只动 spec，environmentId 原样带回去 —— 重放时要用它选环境。
 */
function redactHistoryRequest(request) {
    if (!request || typeof request !== 'object') return request;

    return Object.assign({}, request, { spec: redactRequestSpec(request.spec) });
}

module.exports = {
    redactRequestSpec: redactRequestSpec,
    redactHistoryRequest: redactHistoryRequest,
    redactHeaders: redactHeaders,
    redactAuth: redactAuth,
    SENSITIVE_HEADERS: SENSITIVE_HEADERS,
    REDACTED: REDACTED
};
