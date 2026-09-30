/**
 * Cookie 的解析、匹配与内存 jar（契约第 12 节）。
 *
 * 这是个**纯函数模块**：不碰数据库、不碰网络，`now` 一律由调用方传进来 ——
 * 「过期」这件事要能测，就不能藏在 Date.now() 里。
 *
 * 实现的是 RFC 6265 第 5.2–5.4 节的一个子集，够用且刻意保守：
 * Domain 属性比 RFC 更严一点（要求至少含一个点），因为**不内置公共后缀列表** ——
 * 那是个几百 KB 的数据文件，隔三差五还要更新。所以 `Domain=co.uk` 这种还是会放行，
 * 这是已知限制，README 里写明了。
 *
 * 安全边界全部落在 `parseSetCookie` 和 `matches` 这两个函数里：
 * 一个服务能不能把 cookie 种到别人的域名上，靠的就是「Domain 必须和请求主机对得上」。
 */

/**
 * Cookie 形状（与契约第 12 节一致）：
 *   { id, domain, path, name, value, expires, hostOnly, secure, httpOnly, sameSite, createdAt, updatedAt }
 * `expires` 是毫秒时间戳，null 表示会话 cookie。
 */

/** 同一个 cookie 的判定：domain + path + name（RFC 6265 §5.3） */
function keyOf(cookie) {
    return String(cookie.domain) + '\n' + String(cookie.path) + '\n' + String(cookie.name);
}

function toUrl(value) {
    try {
        return new URL(String(value));
    } catch (err) {
        return null;
    }
}

/** URL.hostname 对 IPv6 会带方括号，统一去掉，免得同一个地址有两种写法 */
function normalizeHost(host) {
    var value = String(host || '').toLowerCase();
    if (value.charAt(0) === '[' && value.charAt(value.length - 1) === ']') {
        return value.slice(1, -1);
    }
    return value;
}

/**
 * 是不是 IP 地址。
 *
 * 用来区分「域名后缀匹配」和「IP 必须完全相同」：`Domain=0.0.1` 不该匹配到
 * `127.0.0.1`，那看起来像后缀，实际上是另一个东西。
 */
function isIpHost(host) {
    if (!host) return false;
    if (host.indexOf(':') > -1) return true;   // IPv6
    return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
}

/**
 * RFC 6265 §5.1.3 的 domain-match。
 * 要求 host 等于 domain，或者 domain 是 host 的后缀且前面紧挨着一个点 ——
 * `notexample.com` 不能因为 `example.com` 是它的后缀就匹配上。
 */
function domainMatches(host, domain) {
    if (!host || !domain) return false;
    if (host === domain) return true;
    // IP 只能完全相同，不做后缀匹配
    if (isIpHost(host)) return false;

    return host.length > domain.length &&
        host.slice(-(domain.length + 1)) === '.' + domain;
}

/** RFC 6265 §5.1.4 的 default-path */
function defaultPath(uriPath) {
    var value = String(uriPath || '');
    if (!value || value.charAt(0) !== '/') return '/';

    // 只有一个 '/' 时（'/api' 这种），整段就是默认路径 '/'
    var lastSlash = value.lastIndexOf('/');
    if (lastSlash === 0) return '/';

    return value.slice(0, lastSlash);
}

/**
 * RFC 6265 §5.1.1 的 cookie-date。
 *
 * 这里只用 Date.parse —— 完整的解析规则要处理上百种历史写法，
 * 而真实浏览器和框架发出来的都是标准格式，解析不出来就当成会话 cookie。
 */
function parseCookieDate(text) {
    var time = Date.parse(String(text));
    return Number.isFinite(time) ? time : null;
}

/** 过期判定。`expires` 为空是会话 cookie，永不过期 */
function isExpired(cookie, now) {
    if (!cookie) return true;
    if (cookie.expires === null || cookie.expires === undefined) return false;
    return Number(cookie.expires) <= now;
}

/**
 * 解析一条 `Set-Cookie`。
 *
 * @param {string} header
 * @param {string} requestUrl 这条响应是从哪个地址回来的 —— 安全边界全看它
 * @param {number} now
 * @returns {object|null} 不合法、或者被安全规则拒绝时返回 null（不抛异常）
 */
function parseSetCookie(header, requestUrl, now) {
    var url = toUrl(requestUrl);
    if (!url) return null;

    var text = String(header === undefined || header === null ? '' : header);
    if (!text.trim()) return null;

    var parts = text.split(';');

    // ---- name=value ----
    var first = parts.shift();
    var eq = first.indexOf('=');
    if (eq === -1) return null;

    var name = first.slice(0, eq).trim();
    var value = first.slice(eq + 1).trim();
    if (!name) return null;
    // 名字里出现分隔符就不是合法的 cookie 名（§4.1.1）
    if (/[\s;,=]/.test(name)) return null;
    // 带引号的值按 §5.2 去掉成对的引号（`a="b"` 存成 `b`）
    if (value.length >= 2 && value.charAt(0) === '"' && value.charAt(value.length - 1) === '"') {
        value = value.slice(1, -1);
    }

    // ---- 属性 ----
    var attrs = {};
    parts.forEach(function (part) {
        var index = part.indexOf('=');
        var key = (index === -1 ? part : part.slice(0, index)).trim().toLowerCase();
        var raw = index === -1 ? '' : part.slice(index + 1).trim();
        // 同名属性以最后一个为准（RFC 就是这么规定的）
        if (key) attrs[key] = raw;
    });

    var host = normalizeHost(url.hostname);

    // ---- Domain ----
    var domain = null;
    if (attrs.domain !== undefined) {
        var candidate = attrs.domain.replace(/^\./, '').toLowerCase();
        if (!candidate) return null;

        if (isIpHost(host)) {
            // 请求主机是 IP 时只认完全相同 —— IP 没有「子域」这回事，
            // 后缀匹配会让 Domain=0.0.1 匹配上 127.0.0.1。
            // 这一支也顺带放行 IPv6（`::1` 里没有点，过不了下面那条规则）。
            if (candidate !== host) return null;
        } else {
            // 只有一段的域（com、localhost）一律拒绝 —— 没有公共后缀列表时，
            // 这是我们唯一能拦住「往整片 TLD 种 cookie」的手段
            if (candidate.indexOf('.') === -1) return null;

            // 必须和请求主机对得上，否则就是 evil.com 想给 bank.com 种 cookie
            if (!domainMatches(host, candidate)) return null;
        }

        domain = candidate;
    }

    // ---- Path ----
    var path = null;
    if (attrs.path !== undefined && attrs.path.charAt(0) === '/') {
        path = attrs.path;
    } else {
        path = defaultPath(url.pathname);
    }

    // ---- 过期时间：Max-Age 优先于 Expires ----
    var expires = null;
    if (attrs['max-age'] !== undefined) {
        // 不是整数的 Max-Age 直接忽略，退回 Expires（§5.2.2）
        if (/^-?\d+$/.test(attrs['max-age'])) {
            var maxAge = Number(attrs['max-age']);
            // 小于等于 0 表示立即过期：记成「此刻」就够了，isExpired 用 <=
            expires = maxAge <= 0 ? now : now + maxAge * 1000;
        }
    }
    if (expires === null && attrs.expires !== undefined) {
        expires = parseCookieDate(attrs.expires);
    }

    var sameSite = null;
    if (typeof attrs.samesite === 'string') {
        var candidateSite = attrs.samesite.toLowerCase();
        if (candidateSite === 'strict' || candidateSite === 'lax' || candidateSite === 'none') {
            sameSite = candidateSite;
        }
    }

    return {
        id: null,
        domain: domain === null ? host : domain,
        path: path,
        name: name,
        value: value,
        expires: expires,
        // 没写 Domain 的是 host-only：只发给完全相同的主机名，子域名也不行
        hostOnly: domain === null,
        secure: attrs.secure !== undefined,
        httpOnly: attrs.httponly !== undefined,
        sameSite: sameSite,
        createdAt: now,
        updatedAt: now
    };
}

/**
 * RFC 6265 §5.1.4 的 path-match。
 * `/api` 不能匹配 `/apix`，但能匹配 `/api/users`。
 */
function pathMatches(requestPath, cookiePath) {
    var target = String(requestPath || '/');
    var base = String(cookiePath || '/');

    if (target === base) return true;
    if (target.indexOf(base) !== 0) return false;

    // 前缀的下一个字符必须是 '/'，或者 cookiePath 本身以 '/' 结尾
    if (base.charAt(base.length - 1) === '/') return true;
    return target.charAt(base.length) === '/';
}

/**
 * 这个 cookie 该不该发给这个地址。
 *
 * @param {object} cookie
 * @param {string} url
 * @param {number} now
 * @returns {boolean}
 */
function matches(cookie, url, now) {
    var parsed = toUrl(url);
    if (!parsed || !cookie) return false;

    if (isExpired(cookie, now)) return false;

    // Secure 的 cookie 不能走 http —— 明文通道上发出去就等于泄露
    if (cookie.secure && parsed.protocol !== 'https:') return false;

    var host = normalizeHost(parsed.hostname);
    if (cookie.hostOnly) {
        if (host !== String(cookie.domain).toLowerCase()) return false;
    } else if (!domainMatches(host, String(cookie.domain).toLowerCase())) {
        return false;
    }

    return pathMatches(parsed.pathname || '/', cookie.path);
}

/**
 * 拼出 `Cookie` 请求头的值。
 *
 * 顺序按 §5.4：path 长的在前（更具体的优先），长度相同的按创建时间早的在前。
 *
 * @param {Array} cookies
 * @param {string} url
 * @param {number} now
 * @returns {string} 没有匹配的 cookie 时返回空串
 */
function cookieHeader(cookies, url, now) {
    var picked = (cookies || []).filter(function (cookie) {
        return matches(cookie, url, now);
    });

    picked.sort(function (a, b) {
        var lengthDiff = String(b.path).length - String(a.path).length;
        if (lengthDiff !== 0) return lengthDiff;
        return Number(a.createdAt || 0) - Number(b.createdAt || 0);
    });

    return picked.map(function (cookie) {
        return cookie.name + '=' + cookie.value;
    }).join('; ');
}

/**
 * 给历史记录用的 `Set-Cookie` 打码（契约第 12 节）：
 * **保留 cookie 名和各项属性，只把值换成 `***`** —— `sid=***; Path=/; HttpOnly`。
 *
 * 为什么不整条抹掉：看历史的人需要知道「这一跳种了哪个 cookie、是不是 HttpOnly」，
 * 这些不是秘密；值才是。
 *
 * 只替换第一个 `=` 和第一个 `;` 之间的内容。值本身可能含 `=`（base64 常见），
 * 那部分一起打掉。
 */
function maskSetCookie(value) {
    var text = String(value === undefined || value === null ? '' : value);

    var eq = text.indexOf('=');
    if (eq === -1) return text;

    var end = text.indexOf(';', eq);
    var tail = end === -1 ? '' : text.slice(end);
    return text.slice(0, eq + 1) + '***' + tail;
}

/* ------------------------------------------------------------------ 内存 jar */

function cloneCookie(cookie) {
    return {
        id: cookie.id === undefined ? null : cookie.id,
        domain: String(cookie.domain || ''),
        path: String(cookie.path || '/'),
        name: String(cookie.name || ''),
        value: cookie.value === undefined || cookie.value === null ? '' : String(cookie.value),
        expires: cookie.expires === undefined ? null : cookie.expires,
        hostOnly: cookie.hostOnly === true,
        secure: cookie.secure === true,
        httpOnly: cookie.httpOnly === true,
        sameSite: cookie.sameSite || null,
        createdAt: cookie.createdAt,
        updatedAt: cookie.updatedAt
    };
}

/** 值指纹：只比对「会变的字段」，用来判断一个 cookie 到底有没有被改过 */
function fingerprint(cookie) {
    return JSON.stringify([
        cookie.value, cookie.expires, cookie.secure, cookie.httpOnly,
        cookie.sameSite, cookie.hostOnly
    ]);
}

/**
 * 一次请求期间用的内存 jar。
 *
 * 执行器只认 `cookieHeaderFor(url)` 和 `storeFrom(url, setCookieHeaders)` 两个方法，
 * 它不需要知道底下是数据库还是内存 —— 所以这个模块可以保持纯粹，`/send` 那边
 * 负责把库里的 cookie 装进来、把 `changes()` 写回去。
 *
 * **同时是「每一跳」的 jar**：重定向时 A 站种的 cookie 会被带到 B 站去（只要域对得上），
 * 这正是「登录后跳转」能跑通的原因。
 *
 * @param {Array} initial 已有的 cookie
 * @param {Function} clock () => 毫秒时间戳
 */
function createMemoryJar(initial, clock) {
    var current = typeof clock === 'function' ? clock : Date.now;

    var jar = new Map();
    var initialByKey = {};

    (initial || []).forEach(function (cookie) {
        if (!cookie || !cookie.name) return;

        var copy = cloneCookie(cookie);
        if (copy.createdAt === undefined || copy.createdAt === null) copy.createdAt = current();

        jar.set(keyOf(copy), copy);
        initialByKey[keyOf(copy)] = copy;
    });

    function cookieHeaderFor(url) {
        var all = [];
        jar.forEach(function (cookie) { all.push(cookie); });
        return cookieHeader(all, url, current());
    }

    /**
     * 收下这一跳响应里的 Set-Cookie。
     *
     * **必须在跟随重定向之前调用**：登录接口是 302 + Set-Cookie，
     * 等跳完了再写就晚了 —— 下一跳的请求头里不会有这个 cookie。
     */
    function storeFrom(url, setCookieHeaders) {
        var list = Array.isArray(setCookieHeaders)
            ? setCookieHeaders
            : (setCookieHeaders ? [setCookieHeaders] : []);

        list.forEach(function (header) {
            var cookie = parseSetCookie(header, url, current());
            if (!cookie) return;

            var k = keyOf(cookie);

            // 已经过期（含 Max-Age<=0）＝ 删除同名 cookie
            if (isExpired(cookie, current())) {
                jar.delete(k);
                return;
            }

            var existing = jar.get(k);
            if (existing) {
                // 覆盖时保留原来的 createdAt —— 发送顺序要按它排
                cookie.id = existing.id === undefined ? null : existing.id;
                cookie.createdAt = existing.createdAt;
            }
            jar.set(k, cookie);
        });
    }

    /**
     * 相比最初的那份，哪些要写、哪些要删。
     * 值没变的不会出现在 upserts 里，省掉一堆无意义的写库。
     */
    function changes() {
        var upserts = [];
        var deletes = [];

        jar.forEach(function (cookie, k) {
            var before = initialByKey[k];
            if (!before || fingerprint(before) !== fingerprint(cookie)) {
                upserts.push(cloneCookie(cookie));
            }
        });

        Object.keys(initialByKey).forEach(function (k) {
            if (!jar.has(k)) deletes.push(cloneCookie(initialByKey[k]));
        });

        return { upserts: upserts, deletes: deletes };
    }

    return {
        cookieHeaderFor: cookieHeaderFor,
        storeFrom: storeFrom,
        changes: changes
    };
}

module.exports = {
    parseSetCookie: parseSetCookie,
    matches: matches,
    cookieHeader: cookieHeader,
    isExpired: isExpired,
    createMemoryJar: createMemoryJar,
    maskSetCookie: maskSetCookie,
    // 下面几个是给别处复用的小工具，也便于自测时直接断言
    keyOf: keyOf,
    domainMatches: domainMatches,
    pathMatches: pathMatches
};
