/**
 * 代理设置（契约第 12 节）。
 *
 * 存在 `meta` 表的 `proxy` 键里，全局一份（不是按项目）—— 代理是「这台机器怎么
 * 出去」的事，同一个进程连出去的路只有一条。
 *
 * 库里还没有这个键时，默认值从环境变量 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`
 * 读（大小写两种写法都认），**但绝不写库**：写进去就等于把用户的环境变量固化下来，
 * 他之后再改环境变量就永远不生效了。
 *
 * 密码只在两处出现：库里存原文，出接口时一律 `mask()` 成 `***`。
 */

var DEFAULT_PORTS = { 'http:': 80, 'https:': 443 };

/**
 * 校验不过时抛的错。
 *
 * 这里刻意不 require `lib/api/respond`：那是接口层的东西，业务模块反过来依赖它
 * 会把分层搞乱。`respond.wrap` / `send.js` 认的就是 `status` 这个字段，
 * 所以形状对得上就够了。
 */
function badRequest(message) {
    var err = new Error(message);
    err.status = 400;
    err.exposed = true;
    return err;
}

function envValue(name) {
    var upper = process.env[name.toUpperCase()];
    if (upper !== undefined && upper !== null && String(upper) !== '') return String(upper);

    var lower = process.env[name.toLowerCase()];
    if (lower !== undefined && lower !== null && String(lower) !== '') return String(lower);

    return '';
}

/** 库里那一行；没有、或者存坏了都返回 null（退化成环境变量） */
function readStored(handle) {
    var row = handle.db.prepare('SELECT value FROM meta WHERE key = ?').get('proxy');
    if (!row) return null;

    try {
        var parsed = JSON.parse(row.value);
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (err) {
        return null;
    }
}

function writeStored(handle, setting) {
    handle.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
        .run('proxy', JSON.stringify(setting));
}

function normalize(raw) {
    var source = raw || {};

    return {
        enabled: source.enabled !== false,
        http: source.http === undefined || source.http === null ? '' : String(source.http),
        https: source.https === undefined || source.https === null ? '' : String(source.https),
        noProxy: source.noProxy === undefined || source.noProxy === null ? '' : String(source.noProxy)
    };
}

/**
 * 当前生效的设置。库里有就用库里的，没有就从环境变量现算（不写库）。
 */
function get(handle) {
    var stored = readStored(handle);
    if (stored) return normalize(stored);

    var http = envValue('HTTP_PROXY');
    var https = envValue('HTTPS_PROXY');
    var noProxy = envValue('NO_PROXY');

    return {
        // 契约：只要读到任何一个，enabled 就为 true
        enabled: !!(http || https || noProxy),
        http: http,
        https: https,
        noProxy: noProxy
    };
}

/** 把地址里的密码换成 `***`（用户名保留：「用的哪个账号」排查时需要） */
function maskAddress(value) {
    var text = String(value === undefined || value === null ? '' : value);
    return text.replace(/^(\w+:\/\/)([^@/]*):([^@/]*)@/, function (match, scheme, user) {
        return scheme + user + ':***@';
    });
}

function mask(setting) {
    var value = normalize(setting);
    return {
        enabled: value.enabled,
        http: maskAddress(value.http),
        https: maskAddress(value.https),
        noProxy: value.noProxy
    };
}

/**
 * 存的是不是「保持原密码」的占位。`http://user:***@host:8080` 这种。
 * 不能先 `new URL` 再比 `password === '***'`：那要看 URL 会不会把 `*` 百分号编码，
 * 直接比字符串最稳。
 */
function keepsPassword(address) {
    return /:\*\*\*@/.test(String(address || ''));
}

function parseAddress(address) {
    try {
        return new URL(String(address));
    } catch (err) {
        return null;
    }
}

/**
 * 把提交上来的地址里那个 `***` 还原成库里真正的密码。
 * 原来就没有密码时，把占位去掉 —— 否则会真的存一个 `***` 当密码。
 */
function restorePassword(incoming, previous) {
    if (!keepsPassword(incoming)) return incoming;

    var old = parseAddress(previous);
    var password = old && old.password ? decodeURIComponent(old.password) : '';
    if (!password) return String(incoming).replace(/:\*\*\*@/, '@');

    return String(incoming).replace(/:\*\*\*@/, ':' + encodeURIComponent(password) + '@');
}

/**
 * 更新设置。`patch` 里没给的字段保持原值。
 *
 * 地址只接受 `http://` 形式：`socks://` / `https://` 的代理我们不会用（https 目标是
 * 走 CONNECT 隧道的），存下来只会让请求莫名其妙地失败，不如在保存时就报 400。
 */
function set(handle, patch) {
    var current = get(handle);
    var input = patch || {};

    var next = {
        enabled: input.enabled === undefined ? current.enabled : input.enabled !== false,
        http: input.http === undefined ? current.http : String(input.http).trim(),
        https: input.https === undefined ? current.https : String(input.https).trim(),
        noProxy: input.noProxy === undefined ? current.noProxy : String(input.noProxy).trim()
    };

    ['http', 'https'].forEach(function (key) {
        if (!next[key]) {
            next[key] = '';
            return;
        }

        next[key] = restorePassword(next[key], current[key]);

        if (!/^http:\/\//i.test(next[key])) {
            throw badRequest('代理地址只支持 http:// 形式（https 目标会走 CONNECT 隧道）');
        }

        var parsed = parseAddress(next[key]);
        if (!parsed || !parsed.hostname) {
            throw badRequest('代理地址不合法：' + maskAddress(next[key]));
        }
        if (DEFAULT_PORTS[parsed.protocol] === undefined) {
            throw badRequest('代理地址只支持 http:// 形式');
        }
    });

    writeStored(handle, next);
    return next;
}

/**
 * 这次请求该用哪个代理。设置没启用、或者目标地址拿不到时返回 null（直连）。
 *
 * 目标是 https 就优先用 `https` 那一栏，为空时退回 `http` 那栏（大多数人两个填一样的）；
 * 反之亦然。`noProxy` 的判断不在这里做 —— 执行器按每一跳的真实主机名判，
 * 重定向之后换主机了也照样对。
 *
 * @param {object} setting
 * @param {string} url 目标地址（变量已经替换过的）
 * @returns {{url: string, noProxy: string}|null}
 */
function forTarget(setting, url) {
    var value = normalize(setting);
    if (!value.enabled) return null;

    var parsed = parseAddress(url);
    if (!parsed) return null;

    var proxyUrl = parsed.protocol === 'https:'
        ? (value.https || value.http)
        : (value.http || value.https);

    if (!proxyUrl) return null;

    return { url: proxyUrl, noProxy: value.noProxy };
}

module.exports = {
    get: get,
    set: set,
    mask: mask,
    forTarget: forTarget,
    maskAddress: maskAddress
};
