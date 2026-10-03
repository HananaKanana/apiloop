/**
 * 接口文档分享（第三轮第 4 节）。
 *
 * 给前端、测试或外部合作方看接口，以前只能导出文件发过去；这里生成一个链接，
 * 打开就是**只读**的接口文档，对方不用注册账号。
 *
 * 两个 router：
 *
 * - `createRouter(ctx)` —— 管理用（列表 / 新建 / 撤销），挂在 `requireLogin` **之后**，
 *   和别的项目接口一样按项目权限判（列表 viewer、新建 editor、撤销 editor）。
 * - `createPublicRouter(ctx)` —— 公开的文档数据，**不登录**，所以必须挂在
 *   `requireLogin` 之前（`lib/admin.js` 里和登录接口摆在一起）。
 *
 * **脱敏一律在服务端做完**（计划里点名的）：变量值、鉴权的值、脚本、Cookie、成员、
 * 历史一律不出现在返回里；请求头里敏感的名字值换成 `******`。绝不能「把原始数据发给
 * 前端再遮」—— 那等于把凭据送到了对方浏览器里。
 *
 * 分享的是**云端的数据**：网关（本机客户端）里这两个 router 也会被挂上，但网关把
 * `/projects/:pid/shares` 和 `/shares/...` 转给云端（见 `lib/gateway/account.js` 的
 * `cloudOnlyPath`），所以实际生效的永远是云端那一份。
 */

var express = require('express');

var respond = require('./respond');
var dto = require('./dto');
var guardModule = require('./guard');
var access = require('../access');
var tree = require('../tree');
var redact = require('../redact');
var mockHost = require('../mock-host');
var sharesRepo = require('../db/repos/shares');
var foldersRepo = require('../db/repos/folders');
var apisRepo = require('../db/repos/apis');
var examplesRepo = require('../db/repos/examples');
var projectsRepo = require('../db/repos/projects');
var usersRepo = require('../db/repos/users');

/**
 * 文档里被打码的值。
 *
 * 和历史那套 `***` 不一样（那是给人看「这里有东西被遮了」），这里的读者是外部合作方，
 * 统一六个星，看起来更像「这是个占位符，别去猜」。
 */
var MASK = '******';

/** 有效期只给这三档。7 / 30 天之外的值一律 400，别让调用方传个 0.5 天进来 */
var EXPIRES_CHOICES = [7, 30];

/** 没传 expiresInDays 时的有效期：**默认 30 天**（和生成链接的弹窗默认值一致）。
 *  永久必须显式传 null —— 「忘了传」不该等于「永久公开」。 */
var DEFAULT_EXPIRES_DAYS = 30;

/**
 * 头名里出现这些字样就打码（大小写不敏感）。
 *
 * 固定三个（Authorization / Cookie / Proxy-Authorization）由 `lib/redact.js` 那份清单
 * 提供，别在两处各写一遍；剩下的是**用户自己起的名字** —— `X-Api-Key`、`X-Auth-Token`
 * 这类没法穷举，只能按字样认。宁可多遮（遮错了只是文档里少一个值），不能漏。
 */
var SENSITIVE_WORDS = ['token', 'key', 'secret', 'auth', 'password', 'passwd', 'pwd', 'cookie', 'session'];

/** 这个请求头名是不是敏感的（值要打码） */
function isSensitiveHeaderName(name) {
    var lower = String(name === undefined || name === null ? '' : name).toLowerCase();
    if (!lower) return false;
    if (redact.SENSITIVE_HEADERS.indexOf(lower) > -1) return true;

    return SENSITIVE_WORDS.some(function (word) { return lower.indexOf(word) > -1; });
}

/**
 * **JSON 里的字段名**命中这些字样就打码（小写后包含即命中）。
 *
 * 和上面请求头那份 `SENSITIVE_WORDS` **故意不是同一份**：头名是用户自己起的，
 * 认不准就多遮（`X-Request-Key` 遮了没坏处）；而 JSON 的字段名是**业务字段**，
 * 那份清单里的 `key` / `auth` 会把 `author`、`keyword`、`authType` 这种正常字段
 * 一起遮掉 —— 文档里少一个字段，看文档的人是要骂人的。
 *
 * 所以这里只收「一看就是凭据」的完整词：用户自己的「用户登录」示例里
 * `jwtToken`、`mqttAuthKey` 都能命中（`jwttoken` 含 `token`、`mqttauthkey` 含 `authkey`）。
 */
var SENSITIVE_KEY_WORDS = [
    'token', 'secret', 'password', 'passwd', 'pwd', 'session', 'cookie',
    'authorization', 'credential', 'apikey', 'api_key', 'accesskey',
    'access_key', 'authkey', 'privatekey', 'private_key'
];

/** 这个 JSON 字段名是不是敏感的（值要打码） */
function isSensitiveKeyName(name) {
    var lower = String(name === undefined || name === null ? '' : name).toLowerCase();
    if (!lower) return false;
    return SENSITIVE_KEY_WORDS.some(function (word) { return lower.indexOf(word) > -1; });
}

/**
 * 一段 JSON 文本的打码：**把键名命中敏感字样的那个值整段换成 `"******"`**，
 * 其余字符原样保留。解析不出来（带注释、带 `{{变量}}`、压根不是 JSON）就原样返回。
 *
 * 为什么是「扫一遍文本」而不是「`JSON.parse` → 递归遮 → `JSON.stringify` 回去」：
 * **`JSON.stringify` 会把数字转成双精度浮点**，19 位雪花 ID
 * `12345678901234567890` 会被悄悄改成 `12345678901234567000` ——
 * 文档里的 id 就变成错的了，而且看不出来（同一个坑 `web/src/utils/jsonFormat.js`
 * 的文件头里写着，那边为此专门自己做了词法输出）。这里只替换该替换的那几段，
 * 别的字符一个都不动，顺带也不会把用户压紧的 JSON 重新排版。
 */
function maskJsonText(text) {
    var source = String(text === undefined || text === null ? '' : text);
    if (!source.trim()) return source;

    // 先确认它是合法 JSON。合法 JSON 里不会有注释和单引号，所以下面那个扫描器
    // 遇到看不懂的结构一律放弃（返回 null），不会把坏数据改坏。
    try {
        JSON.parse(source);
    } catch (err) {
        return source;
    }

    var scanned = scanJsonValue(source, 0, 0);
    if (!scanned || scanned.end !== source.length) return source;

    return scanned.out;
}

/** 跳空白 */
function skipSpaces(text, index) {
    var i = index;
    while (i < text.length && /\s/.test(text.charAt(i))) i++;
    return i;
}

/** 读一个 JSON 字符串（index 指向开引号），返回 `{ end, value }`（value 含两边的引号） */
function readJsonString(text, index) {
    var i = index + 1;
    while (i < text.length) {
        var ch = text.charAt(i);
        if (ch === '\\') {
            i += 2;
            continue;
        }
        if (ch === '"') return { end: i + 1, value: text.slice(index, i + 1) };
        i++;
    }
    return null;
}

/**
 * 从 index 处扫一个值，返回 `{ start, end, out }`：`out` 是打码之后的那段文本
 * （没命中敏感键时和原文逐字相同），`start` / `end` 是它在原文里的起止位置
 * （`start` 已经跳过前面的空白，调用方靠它拼「冒号后到值之间的空白」）。
 * 看不懂的结构返回 null，由调用方原样返回整段原文。
 *
 * 空白一律照抄，所以排版不变；**数字只按原文搬，不经过 `JSON.parse`**，见 `maskJsonText`。
 */
function scanJsonValue(text, index, depth) {
    if (depth > 64) return null;   // 数据成环那种不存在的输入，别把栈爆了

    var i = skipSpaces(text, index);
    var ch = text.charAt(i);
    var result;

    if (ch === '"') {
        var str = readJsonString(text, i);
        if (!str) return null;
        result = { end: str.end, out: str.value };
    } else if (ch === '{') {
        result = scanJsonObject(text, i, depth);
    } else if (ch === '[') {
        result = scanJsonArray(text, i, depth);
    } else {
        // 数字 / true / false / null：读到分隔符为止
        var j = i;
        while (j < text.length && ',}] \t\r\n'.indexOf(text.charAt(j)) === -1) j++;
        if (j === i) return null;
        result = { end: j, out: text.slice(i, j) };
    }

    if (!result) return null;
    result.start = i;
    return result;
}

function scanJsonObject(text, index, depth) {
    var out = '{';
    var i = skipSpaces(text, index + 1);
    out += text.slice(index + 1, i);          // `{` 之后的空白
    if (text.charAt(i) === '}') return { end: i + 1, out: out + '}' };

    while (true) {
        i = skipSpaces(text, i);
        if (text.charAt(i) !== '"') return null;

        var key = readJsonString(text, i);
        if (!key) return null;
        out += key.value;

        var afterKey = skipSpaces(text, key.end);
        out += text.slice(key.end, afterKey);
        if (text.charAt(afterKey) !== ':') return null;
        out += ':';

        var afterColon = skipSpaces(text, afterKey + 1);
        var value = scanJsonValue(text, afterColon, depth + 1);
        if (!value) return null;

        var name;
        try {
            name = JSON.parse(key.value);      // 解开键名里的转义，才能判敏感字样
        } catch (err) {
            return null;
        }

        // 命中就把这个**值**换成占位符，没命中用 value.out（里面可能还有别的字段被遮过）。
        // 两种情况都只替换「值」那一段：冒号后面的空白照抄，排版一个字不变。
        out += text.slice(afterKey + 1, value.start) +
            (isSensitiveKeyName(name) ? '"' + MASK + '"' : value.out);

        var afterValue = skipSpaces(text, value.end);
        var ch = text.charAt(afterValue);
        if (ch === ',') {
            var afterComma = skipSpaces(text, afterValue + 1);
            out += text.slice(value.end, afterComma);   // 逗号 + 后面的空白
            i = afterComma;
            continue;
        }
        if (ch === '}') return { end: afterValue + 1, out: out + text.slice(value.end, afterValue) + '}' };
        return null;
    }
}

function scanJsonArray(text, index, depth) {
    var out = '[';
    var i = skipSpaces(text, index + 1);
    out += text.slice(index + 1, i);
    if (text.charAt(i) === ']') return { end: i + 1, out: out + ']' };

    while (true) {
        var value = scanJsonValue(text, i, depth + 1);
        if (!value) return null;
        out += text.slice(i, value.start) + value.out;

        var afterValue = skipSpaces(text, value.end);
        var ch = text.charAt(afterValue);
        if (ch === ',') {
            var afterComma = skipSpaces(text, afterValue + 1);
            out += text.slice(value.end, afterComma);
            i = afterComma;
            continue;
        }
        if (ch === ']') return { end: afterValue + 1, out: out + text.slice(value.end, afterValue) + ']' };
        return null;
    }
}

/** 解百分号编码；解不开就原样返回（宁可判不准，也不要让一个坏参数把整个文档接口打 500） */
function safeDecode(text) {
    try {
        return decodeURIComponent(String(text));
    } catch (err) {
        return String(text);
    }
}

/**
 * **地址里直接写着的查询串**打码：`?token=abc` → `?token=******`。
 *
 * 地址栏是手写的，用户常常直接把 token 写在里面（`{{host}}/x?token=xxx`），
 * 而这一串不经过参数表，`publicRows` 那一道管不到它。
 *
 * 规则用**请求头那一套**（`isSensitiveHeaderName`）—— 参数名同样是人随手起的，
 * 认不准就多遮。但**值里带 `{{变量}}` 的原样保留**：那是个变量引用、不是凭据本身，
 * 文档里让人看到 `?token={{token}}` 比看到六个星有用。
 *
 * 只动查询串，路径和 `#` 后面原样。
 */
function maskUrlQuery(url) {
    var text = String(url === undefined || url === null ? '' : url);

    var hashAt = text.indexOf('#');
    var head = hashAt === -1 ? text : text.slice(0, hashAt);
    var tail = hashAt === -1 ? '' : text.slice(hashAt);

    var questionAt = head.indexOf('?');
    if (questionAt === -1) return text;

    var base = head.slice(0, questionAt);
    var query = head.slice(questionAt + 1);
    if (!query) return text;

    var masked = query.split('&').map(function (pair) {
        var equalsAt = pair.indexOf('=');
        if (equalsAt === -1) return pair;      // 只有名字，没有值可遮

        var name = pair.slice(0, equalsAt);
        var value = pair.slice(equalsAt + 1);
        if (!isSensitiveHeaderName(safeDecode(name))) return pair;
        if (/\{\{[^}]*\}\}/.test(value)) return pair;

        return name + '=' + MASK;
    }).join('&');

    return base + '?' + masked + tail;
}

/** 启用的行（key 为空、enabled 为 false 的不进文档） */
function enabledRows(rows) {
    if (!Array.isArray(rows)) return [];
    return rows.filter(function (row) {
        return row && row.enabled !== false && row.key;
    });
}

/**
 * 参数 / 请求头的行 → 文档里的行：`{ key, value, desc }`。
 *
 * `type` / `required` / `enabled` 都不给 —— 文档读者不关心我们内部的字段类型，
 * 而「必填」这件事现在也没让人填过（一直是 false）。
 */
function publicRows(rows) {
    return enabledRows(rows).map(function (row) {
        return {
            key: dto.str(row.key),
            value: isSensitiveHeaderName(row.key) ? MASK : dto.str(row.value),
            desc: dto.str(row.desc)
        };
    });
}

/**
 * 请求体 → 文档里的请求体。
 *
 * **本地文件路径（`body.file.src`、formdata 里的 `src`）绝对不能出去** ——
 * 那是分享者电脑上的路径，对方既用不上，又暴露了人家的目录结构。
 * 所以 binary 只留一个 `mode`，formdata 的文件行只写「（文件）」。
 *
 * raw 且 `language` 是 json 时，把里面 `token` / `password` 这类字段遮掉
 * （见 `maskJsonText`）；不是 json 就原样给 —— 非 JSON 的正文没有「字段名」可言，
 * 硬猜会把正常内容遮花。
 */
/**
 * 请求体 / 示例响应体的打码。**不看 language / responseType**：标成 text 的内容照样可能是 JSON。
 *
 * 1. 先按合法 JSON 精确地遮（`maskJsonText`，不是 JSON 时原样返回）；
 * 2. 没变化时再按正则兜底：请求体里常见不带引号的 `{{变量}}`、注释，那不是合法 JSON，
 *    第 1 步会整段放过，`"password": "123456"` 就原样公开了。兜底只遮
 *    「敏感字段名后面紧跟的字符串值」，别的不动；没有敏感字段时什么都匹配不到。
 */
var LOOSE_STRING_PAIR = /("((?:[^"\\]|\\.)*)"\s*:\s*)"(?:[^"\\]|\\.)*"/g;

function maskBodyText(text) {
    var source = String(text === undefined || text === null ? '' : text);
    var masked = maskJsonText(source);
    if (masked !== source) return masked;

    return source.replace(LOOSE_STRING_PAIR, function (whole, head, key) {
        return isSensitiveKeyName(key) ? head + '"' + MASK + '"' : whole;
    });
}

function publicBody(body) {
    var input = body || {};
    var mode = dto.str(input.mode) || 'none';

    if (mode === 'raw') {
        var language = dto.str(input.language) || 'text';
        var raw = dto.str(input.raw);

        return {
            mode: 'raw',
            raw: maskBodyText(raw),
            language: language
        };
    }

    if (mode === 'urlencoded' || mode === 'formdata') {
        return {
            mode: mode,
            form: enabledRows(input.form).map(function (row) {
                var isFile = row.kind === 'file';
                return {
                    key: dto.str(row.key),
                    value: isFile ? '（文件）' : dto.str(row.value),
                    desc: dto.str(row.desc),
                    kind: isFile ? 'file' : 'text'
                };
            })
        };
    }

    if (mode === 'graphql') {
        var graphql = input.graphql || {};
        return {
            mode: 'graphql',
            graphql: { query: dto.str(graphql.query), variables: dto.str(graphql.variables) }
        };
    }

    if (mode === 'binary') return { mode: 'binary' };

    return { mode: 'none' };
}

/**
 * 示例：只要名字、状态码、响应体和响应类型（契约里点名的那几个）。
 *
 * 响应体是**真实回显**，里面常常直接带凭据 —— 用户自己的「用户登录」示例就是
 * （`jwtToken`、`mqttAuthKey` 都在里面）。所以 `responseType` 是 json 时同样要过一遍
 * `maskJsonText`；别的类型（html / text / sse / ws 场景）没有字段名可认，原样给。
 */
function publicExample(example) {
    var responseType = dto.str(example.responseType) || 'json';
    var body = dto.str(example.body);

    return {
        name: dto.str(example.name),
        status: example.status,
        body: maskBodyText(body),
        responseType: responseType
    };
}

/**
 * 这个接口实际用的鉴权**类型**（值一律不给）。
 *
 * 要顺着目录链往上找，和发送时同一套规则（`lib/api/send.js` 的 `inheritAuth`）——
 * 接口自己写着「继承父级」时，文档里显示「无鉴权」就是骗人。找到 `noauth` 也算找到，
 * 它正是「不加鉴权」的意思。
 */
function authTypeOf(handle, project, api) {
    var own = api.auth;
    if (own && own.type && own.type !== 'inherit') return own.type;

    // 从接口所在目录往上：越靠前越近，第一个配过的就是它
    var current = api.folderId ? foldersRepo.get(handle, api.folderId) : null;
    var guardCount = 0;
    while (current && guardCount++ < 64) {
        var auth = current.auth;
        if (auth && auth.type && auth.type !== 'inherit') return auth.type;
        current = current.parentId ? foldersRepo.get(handle, current.parentId) : null;
    }

    var projectAuth = project.auth;
    if (projectAuth && projectAuth.type && projectAuth.type !== 'inherit') return projectAuth.type;
    return null;
}

/**
 * 分享范围：`folderId` 为空是**整个项目**，否则是那个目录**连同它的子目录**。
 *
 * 目录已经不存在时返回 null（正常情况那条 share 会被外键 CASCADE 掉，
 * 这里是兜底 —— 返回「已失效」比返回一份空文档好）。
 */
function scopeOf(handle, projectId, folderId) {
    if (!folderId) {
        return {
            folders: foldersRepo.list(handle, projectId),
            apis: apisRepo.list(handle, projectId)
        };
    }

    var folder = foldersRepo.get(handle, folderId);
    if (!folder || folder.projectId !== projectId) return null;

    var folders = [folder].concat(tree.descendants(handle, projectId, folderId));
    var ids = folders.map(function (item) { return item.id; });

    return {
        folders: folders,
        apis: apisRepo.list(handle, projectId).filter(function (api) {
            return ids.indexOf(api.folderId) > -1;
        })
    };
}

/** 管理列表 / 新建返回的那一条 */
function sharePayload(handle, share) {
    var folder = share.folderId ? foldersRepo.get(handle, share.folderId) : null;
    var creator = share.createdBy ? usersRepo.getById(handle, share.createdBy) : null;

    return {
        id: share.id,
        folderId: share.folderId,
        folderName: folder ? folder.name : null,
        title: share.title,
        createdBy: share.createdBy
            ? { id: share.createdBy, displayName: (creator && creator.displayName) || '' }
            : null,
        createdAt: share.createdAt,
        expiresAt: share.expiresAt
    };
}

/** 链接过期了吗（`expiresAt` 为空 = 永久） */
function isExpired(share, now) {
    if (!share.expiresAt) return false;
    return Number(share.expiresAt) <= (now || Date.now());
}

/**
 * 公开文档的完整数据。**这里返回的每一个字段都是可以直接给外人看的**。
 *
 * 不返回：变量值（项目 / 目录 / 环境都不给）、鉴权的值、脚本、Cookie、成员、历史、
 * 示例的响应头（回显里可能带 Set-Cookie）、任何本地文件路径。
 */
function publicDoc(handle, ctx, share) {
    var project = projectsRepo.getById(handle, share.projectId);
    if (!project) return null;

    var scope = scopeOf(handle, share.projectId, share.folderId);
    if (!scope) return null;

    // 根项目的 mock 挂在根路径（见 lib/mock-host.js），其余是 /mock-<项目ID>
    var isRoot = Boolean(ctx && ctx.rootProjectId && ctx.rootProjectId === project.id);

    return {
        share: {
            title: share.title,
            createdAt: share.createdAt,
            expiresAt: share.expiresAt
        },
        project: { id: project.id, name: project.name },
        // 页面拿它拼出自己的 mock 地址（服务端不知道对外的域名和端口映射，
        // 由页面用 window.location.origin 拼才对）
        mockPath: isRoot ? '' : mockHost.MOCK_PREFIX + project.id,
        folders: scope.folders.map(function (folder) {
            return {
                id: folder.id,
                parentId: folder.parentId,
                name: folder.name,
                description: dto.str(folder.description),
                position: folder.position
            };
        }),
        apis: scope.apis.map(function (api) {
            return {
                id: api.id,
                folderId: api.folderId,
                name: api.name,
                method: api.method,
                // 地址里直接写着的查询串也要过一遍（`?token=xxx` 不经过参数表）
                url: maskUrlQuery(api.url),
                description: dto.str(api.description),
                position: api.position,
                params: {
                    path: publicRows((api.params || {}).path),
                    query: publicRows((api.params || {}).query)
                },
                headers: publicRows((api.params || {}).headers),
                body: publicBody(api.body),
                authType: authTypeOf(handle, project, api),
                examples: examplesRepo.listByApi(handle, api.id).map(publicExample)
            };
        })
    };
}

/**
 * `expiresInDays` → 时间戳。
 *
 * 三种输入：`7` / `30` 是那两档，`null` 是永久，**不给就是默认 30 天**。
 * 别的值一律 400 —— 悄悄按某个值处理的话，调用方以为设了 3 天、实际给了 30 天。
 */
function expiresAtFrom(value) {
    if (value === null) return null;

    var days = value === undefined || value === '' ? DEFAULT_EXPIRES_DAYS : Number(value);
    if (EXPIRES_CHOICES.indexOf(days) === -1) {
        throw respond.apiError(400, '有效期只能是 7 天、30 天或永久');
    }
    return Date.now() + days * 24 * 60 * 60 * 1000;
}

function createRouter(ctx) {
    var handle = ctx.handle;
    var router = express.Router();

    var g = guardModule.createGuard(ctx);
    var guard = g.guard;
    var byPid = g.byPid;

    /** 目录 id 必须属于这个项目，否则会分享到别人的目录上去 */
    function resolveFolderId(projectId, value) {
        if (value === undefined || value === null || value === '') return null;

        var folderId = dto.str(value);
        var folder = foldersRepo.get(handle, folderId);
        if (!folder || folder.projectId !== projectId) {
            throw respond.apiError(400, '目录不存在或不属于这个项目');
        }
        return folderId;
    }

    /** 这个项目已生成的链接（viewer 就能看：文档本来就是给项目成员看的） */
    router.get('/projects/:pid/shares', guard('viewer', byPid), respond.wrap(function (req, res) {
        respond.ok(res, {
            shares: sharesRepo.list(handle, req.project.id).map(function (share) {
                return sharePayload(handle, share);
            })
        });
    }));

    router.post('/projects/:pid/shares', guard('editor', byPid), respond.wrap(function (req, res) {
        var project = req.project;
        var body = req.body || {};
        var folderId = resolveFolderId(project.id, body.folderId);
        var expiresAt = expiresAtFrom(body.expiresInDays);
        var folder = folderId ? foldersRepo.get(handle, folderId) : null;

        var share = sharesRepo.insert(handle, project.id, {
            folderId: folderId,
            // 列表里显示用的标题：目录名或项目名（之后再改名不影响，这里只是当时的标签）
            title: (folder && folder.name) || project.name,
            createdBy: req.user ? req.user.id : null,
            expiresAt: expiresAt
        });

        respond.ok(res, { share: sharePayload(handle, share) });
    }));

    /**
     * 撤销。**不用 `byParam('share')`**：那需要往 `lib/access.js` 的 KINDS 里加一种资源，
     * 而那个文件这一轮由 session1 在改（保密变量）—— 手工判一遍更省事，也更清楚：
     * 不是成员时和「不存在」返回**一模一样**的 404，不能让人拿 id 试出「这个项目有这条分享」。
     */
    router.delete('/shares/:id', respond.wrap(function (req, res) {
        var share = sharesRepo.get(handle, String(req.params.id));
        if (!share) throw respond.apiError(404, '分享链接不存在');

        var role = access.roleOf(handle, req.user, share.projectId);
        if (!role) throw respond.apiError(404, '分享链接不存在');
        if (!access.atLeast(role, 'editor')) throw respond.apiError(403, '需要 editor 权限');

        sharesRepo.remove(handle, share.id);
        respond.ok(res, {});
    }));

    return router;
}

/**
 * 公开的文档接口（`GET /public/shares/:id`）。
 *
 * **不登录**，所以调用方必须把它挂在 `requireLogin` 之前；这里也不能读 `req.user`
 * 或任何登录态。过期、撤销、目录被删、项目没了 —— 一律同一句 404
 * 「这个链接已失效」：区分开就等于告诉外面的人「这个 id 曾经存在过」。
 */
function createPublicRouter(ctx) {
    var handle = ctx.handle;
    var router = express.Router();

    router.get('/public/shares/:id', respond.wrap(function (req, res) {
        var share = sharesRepo.get(handle, String(req.params.id));
        if (!share || isExpired(share)) throw respond.apiError(404, '这个链接已失效');

        var doc = publicDoc(handle, ctx, share);
        if (!doc) throw respond.apiError(404, '这个链接已失效');

        respond.ok(res, { doc: doc });
    }));

    return router;
}

module.exports = {
    createRouter: createRouter,
    createPublicRouter: createPublicRouter,
    isSensitiveHeaderName: isSensitiveHeaderName,
    isSensitiveKeyName: isSensitiveKeyName,
    maskJsonText: maskJsonText,
    maskUrlQuery: maskUrlQuery,
    MASK: MASK,
    EXPIRES_CHOICES: EXPIRES_CHOICES,
    DEFAULT_EXPIRES_DAYS: DEFAULT_EXPIRES_DAYS
};
