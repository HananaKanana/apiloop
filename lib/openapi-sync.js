/**
 * 从 OpenAPI 同步更新的**纯逻辑**（第四轮第 3 节）：认接口、算差异、算更新之后长什么样。
 *
 * 不碰数据库、不发请求 —— 落库那一段在 `lib/api/openapi.js`。
 * 这样拆的收益是「检查更新」和「同步所选」用的是同一份计算：两边各算一次迟早会不一致，
 * 用户在列表里看到的和真正改掉的就不是一回事了。
 *
 * 三件事：
 *   1. `computeDiff` —— 拿解析出来的 route 列表 + 项目里现有的接口，算出
 *      「新增 / 有改动 / 文档里已删除」三组；
 *   2. `planUpdate` —— 一条接口要改成什么样（patch）+ 改了哪些字段（给界面显示）；
 *   3. `openapiRecordFor` —— 从文档来的接口要记的那份记号（`extra.openapi`）。
 */

/* ------------------------------------------------------------------ 认接口 */

/**
 * 地址里的占位符统一成 `{名字}`：`:id` / `{{id}}` / `{id}` 都是一种东西。
 *
 * **名字要保留**：`/users/:id` 和 `/pets/:petId` 不是一个接口，路径参数名也是接口的一部分。
 * `:name` 只认前面紧跟 `/` 的（否则 `http://host:8080` 里的端口会被当成参数）。
 */
function normalizePlaceholders(text) {
    return String(text === undefined || text === null ? '' : text)
        .replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, '{$1}')
        .replace(/\/(:([A-Za-z_][A-Za-z0-9_]*))/g, '/{$2}');
}

/**
 * 接口地址 → 用来比对的路径：去掉开头的变量 / 协议主机、去掉查询串和 `#`，
 * 占位符统一写法，去掉结尾多余的 `/`。
 *
 * 老导入（这个功能上线之前）的接口没有 `extra.openapi` 记号，只能靠它认出来 ——
 * 所以这里要宽容：`{{host}}/pets/{{petId}}`、`/pets/:petId`、`/pets/{petId}` 都是同一个。
 */
function comparablePath(url) {
    var text = String(url === undefined || url === null ? '' : url).trim();

    var hashAt = text.indexOf('#');
    if (hashAt > -1) text = text.slice(0, hashAt);
    var queryAt = text.indexOf('?');
    if (queryAt > -1) text = text.slice(0, queryAt);

    // 开头的变量或协议主机（可能连着好几个：`{{baseUrl}}{{version}}/x`）
    while (true) {
        var next = text.replace(/^\{\{[^}]*\}\}/, '').replace(/^https?:\/\/[^/]*/i, '');
        if (next === text) break;
        text = next;
    }

    text = normalizePlaceholders(text);

    if (!text) return '/';
    if (text.charAt(0) !== '/') text = '/' + text;
    if (text.length > 1 && text.slice(-1) === '/') text = text.slice(0, -1);
    return text;
}

/** 接口上那份「从文档哪一条来的」记号（没有就是 null） */
function docRecordOf(api) {
    var extra = (api && api.extra) || {};
    return extra.openapi && typeof extra.openapi === 'object' ? extra.openapi : null;
}

/**
 * 这个接口**像不像**从文档来的。用来决定「文档里没了」要不要把它列出来。
 *
 * 有记号的一定是；没有记号的老接口看地址：文档导进来的 url 就是裸路径
 * （`/pets/:petId`），而手写的接口不写 `{{host}}` / 协议主机根本发不出去 ——
 * 所以「裸路径」就当它也是文档来的。**宁可多列（默认不勾），不要漏掉真的删掉的。**
 */
function looksDocSourced(api) {
    if (docRecordOf(api)) return true;

    var url = String((api && api.url) || '').trim();
    if (!url || url.charAt(0) !== '/') return false;
    return true;
}

/**
 * 按「operationId → openapiKey → 方法 + 规范化路径」三级认接口（计划里定的顺序）。
 *
 * 三级要**分开做**：先拿 operationId 配一遍、再拿 key 配一遍、最后才按路径 ——
 * 混在一起的话，一个没有 operationId 的 route 可能被按路径配到一个「本来能用 key
 * 精确配上」的接口上，后面那些就全错位了。
 *
 * @returns {{ pairs: Array<{route, api}>, usedRoutes: object, usedApis: object }}
 */
function matchRoutes(routes, apis) {
    var usedRoutes = {};
    var usedApis = {};
    var pairs = [];

    var stages = [
        {
            routeKey: function (route) { return route.operationId ? 'op:' + route.operationId : ''; },
            apiKey: function (api) {
                var record = docRecordOf(api);
                return record && record.operationId ? 'op:' + record.operationId : '';
            }
        },
        {
            routeKey: function (route) { return route.openapiKey ? 'key:' + route.openapiKey : ''; },
            apiKey: function (api) {
                var record = docRecordOf(api);
                return record && record.key ? 'key:' + record.key : '';
            }
        },
        {
            /**
             * 最后这一级是**兜底**的：按「方法 + 规范化路径」认。老导入的接口没有记号，
             * 只能靠它；而且它要能配上**已经被前两级配过的 route** ——
             * 同一个文档接口在项目里导了两份时，一份靠 key 配上，另一份只能靠路径，
             * 那个 route 已经用掉了，跳过它就等于把第二份当成「文档里已删除」。
             */
            fuzzy: true,
            routeKey: function (route) {
                return 'path:' + String(route.method || '').toUpperCase() + ' ' + comparablePath(route.path);
            },
            apiKey: function (api) {
                return 'path:' + String(api.method || '').toUpperCase() + ' ' + comparablePath(api.url);
            }
        }
    ];

    stages.forEach(function (stage) {
        var byKey = {};
        apis.forEach(function (api) {
            if (usedApis[api.id]) return;
            var key = stage.apiKey(api);
            if (!key) return;
            if (!byKey[key]) byKey[key] = [];
            byKey[key].push(api);
        });

        routes.forEach(function (route, index) {
            // 精确的两级：这个 route 已经配过了就不再配，免得把本该配给别的 route 的接口抢走
            if (stage.fuzzy !== true && usedRoutes[index]) return;

            var key = stage.routeKey(route);
            if (!key) return;

            var list = byKey[key];
            if (!list || !list.length) return;

            /**
             * **一个 route 可以配上多条接口**：同一个文档接口在项目里被导了两份
             * （换了个目录再导一次），或者用户自己复制过 —— 它们都该跟着文档更新。
             * 只配第一条的话，剩下的会被列进「文档里已删除」，那是错的（默认不勾也会吓人）。
             */
            usedRoutes[index] = true;
            list.forEach(function (api) {
                usedApis[api.id] = true;
                pairs.push({ route: route, api: api });
            });
            byKey[key] = [];
        });
    });

    return { pairs: pairs, usedRoutes: usedRoutes, usedApis: usedApis };
}

/* ------------------------------------------------------------------ 地址合并 */

/** 地址拆成 `{ prefix, segments }`：prefix 是开头的变量 / 协议主机，segments 是路径段 */
function splitUrl(url) {
    var text = String(url === undefined || url === null ? '' : url);
    var at = 0;

    while (at < text.length) {
        var variable = /^\{\{[^}]*\}\}/.exec(text.slice(at));
        if (variable) {
            at += variable[0].length;
            continue;
        }
        var host = /^https?:\/\/[^/]*/i.exec(text.slice(at));
        if (host) {
            at += host[0].length;
            continue;
        }
        break;
    }

    return {
        prefix: text.slice(0, at),
        segments: text.slice(at).split('/').filter(function (part) { return part !== ''; })
    };
}

/**
 * 把文档里的路径合并进现有地址：**用户写的前缀留着，只换路径**。
 *
 * 例：现在是 `{{host}}/api/pets/123?detail=1`、文档说 `/pets/{petId}` →
 * 结果 `{{host}}/api/pets/:petId?detail=1`（`/api` 是用户加的前缀，保留；
 * 查询串也留着 —— 那是用户写的，文档的参数走参数表）。
 *
 * 找前缀的办法：**文档路径的第一段**在现有地址里出现的位置。
 * 第一段本身是占位符（`{version}`）、或者压根找不到时，就只保留开头的变量 / 主机，
 * 整段路径按文档来 —— 宁可多换一段，也不要留下一个拼接错乱的地址。
 */
function mergeUrl(currentUrl, docPath) {
    var current = String(currentUrl === undefined || currentUrl === null ? '' : currentUrl);
    var next = String(docPath === undefined || docPath === null ? '' : docPath).trim();

    if (!next) return current;
    if (!current) return next;

    var hashAt = current.indexOf('#');
    var tail = hashAt === -1 ? '' : current.slice(hashAt);
    var head = hashAt === -1 ? current : current.slice(0, hashAt);

    var queryAt = head.indexOf('?');
    var query = queryAt === -1 ? '' : head.slice(queryAt);
    var base = queryAt === -1 ? head : head.slice(0, queryAt);

    var docSegments = splitUrl(next).segments;
    var first = docSegments[0];
    if (!first || first.charAt(0) === '{') return splitUrl(base).prefix + next + query + tail;

    var currentParts = splitUrl(base);
    var keep = [];
    for (var i = 0; i < currentParts.segments.length; i++) {
        if (currentParts.segments[i] === first) break;
        keep.push(currentParts.segments[i]);
    }

    var merged = keep.concat(docSegments);
    return currentParts.prefix + '/' + merged.join('/') + query + tail;
}

/* ------------------------------------------------------------------ 行合并 */

/** 行数组 → 名字数组 */
function namesOf(rows) {
    return (rows || []).map(function (row) {
        return String((row && row.key) || '');
    }).filter(function (name) { return name !== ''; });
}

function sameRow(a, b) {
    return String(a.key) === String(b.key) &&
        String(a.value === undefined || a.value === null ? '' : a.value) ===
            String(b.value === undefined || b.value === null ? '' : b.value) &&
        String(a.desc || '') === String(b.desc || '') &&
        Boolean(a.required) === Boolean(b.required) &&
        String(a.type || 'string') === String(b.type || 'string') &&
        (a.enabled !== false) === (b.enabled !== false);
}

/** 行 → 展开看前后对比时显示的文本 */
function formatRows(rows) {
    return (rows || []).map(function (row) {
        var value = String(row.value === undefined || row.value === null ? '' : row.value);
        return value ? row.key + '=' + value : String(row.key);
    }).join('\n');
}

/**
 * 按名字合并一组行（query / 路径 / 请求头 / 表单字段共用）。
 *
 * 规则（计划里点名的）：
 * - 文档里新加的 → 加上，值用文档给的示例值；
 * - **上次同步时文档里有、这次没了**的 → 删掉（靠 `lastDocNames` 认，不是靠「文档里没有」）；
 * - 用户自己加的（文档里从来没有过）→ **留着**，比如手写的 `X-User-Info`；
 * - 两边都有的 → **保留用户的值**，更新说明 / 类型 / 必填。
 *
 * @param {{current: Array, incoming: Array, lastDocNames: Array}} options
 * @returns {{rows: Array, added: Array<string>, removed: Array<string>, touched: boolean}}
 */
function mergeRows(options) {
    var current = options.current || [];
    var incoming = options.incoming || [];
    var lastNames = {};
    (options.lastDocNames || []).forEach(function (name) { lastNames[String(name)] = true; });

    var incomingByName = {};
    incoming.forEach(function (row) { incomingByName[String(row.key)] = row; });

    var out = [];
    var added = [];
    var removed = [];
    var touched = false;

    current.forEach(function (row) {
        var name = String(row.key);
        var doc = incomingByName[name];

        if (doc) {
            var next = {
                key: name,
                value: row.value,
                type: doc.type || row.type || 'string',
                required: doc.required === true,
                desc: doc.desc ? doc.desc : (row.desc || ''),
                enabled: row.enabled !== false
            };
            if (!sameRow(next, row)) touched = true;
            out.push(next);
            return;
        }

        // 文档里没有这一行：只有「上次同步时文档给过」才跟着删
        if (lastNames[name]) {
            removed.push(name);
            touched = true;
            return;
        }
        out.push(row);
    });

    incoming.forEach(function (doc) {
        var name = String(doc.key);
        var exists = out.some(function (row) { return String(row.key) === name; });
        if (exists) return;

        added.push(name);
        touched = true;
        out.push({
            key: name,
            value: doc.example === undefined || doc.example === null ? '' : String(doc.example),
            type: doc.type || 'string',
            required: doc.required === true,
            desc: doc.desc || '',
            enabled: true
        });
    });

    return { rows: out, added: added, removed: removed, touched: touched };
}

/** 「新增 a、b，删除 c」那种一句话 */
function summarizeNames(added, removed) {
    var parts = [];
    if (added.length) parts.push('新增 ' + added.join('、'));
    if (removed.length) parts.push('删除 ' + removed.join('、'));
    return parts.join('，');
}

/* ------------------------------------------------------------------ 请求体 */

/**
 * 16 位以上的数字**在字符串外面**出现时，JSON 往返会改坏它
 * （`JSON.parse` 把它转成双精度浮点：19 位雪花 ID 会变成 ...67000）。
 * 这种请求体不自动合并，让用户手动看一眼。
 *
 * 先把字符串字面量抹掉再找，免得把 `"orderNo": "12345678901234567890"` 这种
 * （本来就是字符串、往返不会坏）也算进去。
 */
function hasHugeNumber(text) {
    var outsideStrings = String(text || '').replace(/"(?:[^"\\]|\\.)*"/g, '""');
    return /\d{16,}/.test(outsideStrings);
}

/**
 * 请求体合并。两种形态都要管：
 *
 * - `urlencoded` / `formdata`：**OpenAPI 导进来的默认就是这个**（`rowsToBody` 产出的），
 *   按名字合并表单行，规则和参数一样；
 * - `raw` 且是合法 JSON 对象：合并顶层字段，规则一样；
 * - 其他（不是 JSON、有超大数字、mode 是 none/binary/graphql）：**不动**，
 *   有改动的话给一句「请求体无法自动合并，请手动检查」。
 */
function mergeBody(currentBody, incomingFields, lastDocNames) {
    var body = currentBody || {};
    var incoming = incomingFields || [];
    var mode = String(body.mode || 'none');

    if (mode === 'urlencoded' || mode === 'formdata') {
        var form = mergeRows({
            current: body.form,
            incoming: incoming,
            lastDocNames: lastDocNames
        });
        if (!form.touched) return { touched: false };

        return {
            touched: true,
            body: Object.assign({}, body, { form: form.rows }),
            summary: summarizeNames(form.added, form.removed) || '有更新',
            before: formatRows(body.form),
            after: formatRows(form.rows)
        };
    }

    if (mode === 'raw') {
        var text = String(body.raw === undefined || body.raw === null ? '' : body.raw);
        if (!text.trim()) return { touched: false };
        if (incoming.length === 0 && !(lastDocNames || []).length) return { touched: false };

        if (hasHugeNumber(text)) {
            return { problem: '请求体里有很长的数字，自动合并会改坏它，请手动检查' };
        }

        var parsed;
        try {
            parsed = JSON.parse(text);
        } catch (err) {
            return { problem: '请求体不是合法 JSON（可能带 {{变量}} 或注释），无法自动合并，请手动检查' };
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return { problem: '请求体的顶层不是对象，无法自动合并，请手动检查' };
        }

        var lastNames = {};
        (lastDocNames || []).forEach(function (name) { lastNames[String(name)] = true; });

        var next = {};
        var addedNames = [];
        var removedNames = [];
        var changed = false;

        Object.keys(parsed).forEach(function (key) {
            if (lastNames[key] && !incoming.some(function (row) { return String(row.key) === key; })) {
                removedNames.push(key);
                changed = true;
                return;
            }
            next[key] = parsed[key];
        });

        incoming.forEach(function (doc) {
            var name = String(doc.key);
            if (Object.prototype.hasOwnProperty.call(next, name)) return;
            next[name] = doc.example === undefined ? '' : doc.example;
            addedNames.push(name);
            changed = true;
        });

        if (!changed) return { touched: false };

        return {
            touched: true,
            body: Object.assign({}, body, { raw: JSON.stringify(next, null, 2) }),
            summary: summarizeNames(addedNames, removedNames) || '有更新',
            before: JSON.stringify(parsed, null, 2),
            after: JSON.stringify(next, null, 2)
        };
    }

    // none / binary / graphql：文档有字段、这边没地方放，提醒一句
    if (incoming.length && !(lastDocNames || []).length) {
        return { problem: '这个接口的请求体类型和文档对不上，无法自动合并，请手动检查' };
    }
    return { touched: false };
}

/* ------------------------------------------------------------------ 差异 */

function makeChange(field, label, before, after, summary) {
    return {
        field: field,
        label: label,
        summary: summary || '',
        before: before === undefined || before === null ? '' : String(before),
        after: after === undefined || after === null ? '' : String(after)
    };
}

/**
 * 一条接口要改成什么样。返回的 `patch` 直接交给 `apisRepo.update`。
 *
 * **不动**：脚本、示例、Mock 设置、鉴权、状态和负责人、`extra` 里别的字段。
 * （`extra` 只在刷新 `openapi.fields` 快照时才写，而且是**先读出原来的再合并**。）
 */
function planUpdate(api, route) {
    var changes = [];
    var patch = {};
    var record = docRecordOf(api);
    var lastFields = (record && record.fields) || {};
    var params = api.params || {};

    // 名称 / 说明：文档里为空时**不清空**用户写的
    var name = String(route.name || '').trim();
    if (name && name !== String(api.name || '')) {
        changes.push(makeChange('name', '名称', api.name, name));
        patch.name = name;
    }
    var description = String(route.desc || '').trim();
    if (description && description !== String(api.description || '')) {
        changes.push(makeChange('description', '说明', api.description, description));
        patch.description = description;
    }

    // 地址：只换路径部分
    var url = mergeUrl(api.url, route.path);
    if (url !== String(api.url || '')) {
        changes.push(makeChange('url', '地址', api.url, url));
        patch.url = url;
    }

    // 参数：路径 / query / 请求头
    var merged = {
        path: mergeRows({ current: params.path, incoming: route.pathParams, lastDocNames: lastFields.path }),
        query: mergeRows({ current: params.query, incoming: route.query, lastDocNames: lastFields.query }),
        headers: mergeRows({ current: params.headers, incoming: route.requestHeaders, lastDocNames: lastFields.headers })
    };

    var paramTouched = merged.path.touched || merged.query.touched || merged.headers.touched;
    if (paramTouched) {
        var addedNames = merged.query.added.concat(merged.path.added, merged.headers.added);
        var removedNames = merged.query.removed.concat(merged.path.removed, merged.headers.removed);

        patch.params = {
            path: merged.path.rows,
            query: merged.query.rows,
            headers: merged.headers.rows
        };
        changes.push(makeChange('params', '参数',
            formatRows(params.path) + '\n' + formatRows(params.query) + '\n' + formatRows(params.headers),
            formatRows(merged.path.rows) + '\n' + formatRows(merged.query.rows) + '\n' + formatRows(merged.headers.rows),
            summarizeNames(addedNames, removedNames) || '有更新'));
    }

    // 请求体
    var body = mergeBody(api.body, route.body, lastFields.body);
    if (body.problem) {
        changes.push(makeChange('body', '请求体', '', '', body.problem));
    } else if (body.touched) {
        patch.body = body.body;
        changes.push(makeChange('body', '请求体字段', body.before, body.after, body.summary));
    }

    // 刷新「上次文档给了哪些字段名」的快照 —— 下一次同步靠它区分
    // 「文档这次删掉的」和「用户自己加的」。**先读原来的 extra 再合并**，别覆盖别的字段。
    if (changes.length) {
        var nextRecord = openapiRecordFor(route);
        var currentExtra = api.extra && typeof api.extra === 'object' ? api.extra : {};
        var currentOpenapi = currentExtra.openapi && typeof currentExtra.openapi === 'object'
            ? currentExtra.openapi
            : {};

        var nextOpenapi = Object.assign({}, currentOpenapi, nextRecord);
        // 用户手动改过 key / operationId 的话不动它（那是「这条是从文档哪来的」的记号）
        if (currentOpenapi.key) nextOpenapi.key = currentOpenapi.key;
        if (currentOpenapi.operationId) nextOpenapi.operationId = currentOpenapi.operationId;

        if (JSON.stringify(nextOpenapi) !== JSON.stringify(currentOpenapi)) {
            patch.extra = Object.assign({}, currentExtra, { openapi: nextOpenapi });
        }
    }

    return { patch: patch, changes: changes };
}

/** 从文档来的接口要记的记号（新接口用它写 `extra.openapi`） */
function openapiRecordFor(route) {
    var record = {
        key: String(route.openapiKey || ''),
        fields: {
            query: namesOf(route.query),
            path: namesOf(route.pathParams),
            headers: namesOf(route.requestHeaders),
            body: namesOf(route.body)
        }
    };
    if (route.operationId) record.operationId = String(route.operationId);
    return record;
}

/** 同步范围：指定目录就是它连同子目录，没指定就是整个项目（返回 null） */
function scopeFolderIds(folders, folderId) {
    if (!folderId) return null;

    var ids = [folderId];
    var changed = true;
    while (changed) {
        changed = false;
        (folders || []).forEach(function (folder) {
            if (ids.indexOf(folder.id) > -1) return;
            if (folder.parentId && ids.indexOf(folder.parentId) > -1) {
                ids.push(folder.id);
                changed = true;
            }
        });
    }
    return ids;
}

/**
 * 算三组差异。
 *
 * **认接口要拿整个项目比，处理只落在指定范围里**：
 * 「新增」的定义是「文档里有、**项目里**没有」—— 只在指定目录里比的话，同一个接口
 * 在别的目录已经存在，就会又建一份出来（默认还是勾上的）。所以匹配用全项目的接口，
 * 「有改动」和「文档里已删除」再按范围过滤。
 *
 * @param {{routes: Array, apis: Array, folders: Array, folderId?: string|null}} options
 *   `apis` 是项目里现有的接口（要带 `extra`）；`folders` 用来算范围和新增接口的落点
 * @returns {{added: Array, changed: Array, removed: Array}}
 */
function computeDiff(options) {
    var routes = options.routes || [];
    var apis = options.apis || [];
    var folders = options.folders || [];
    var folderId = options.folderId || null;

    var scope = scopeFolderIds(folders, folderId);
    var inScope = {};
    apis.forEach(function (api) {
        if (!scope || scope.indexOf(api.folderId) > -1) inScope[api.id] = true;
    });

    var matched = matchRoutes(routes, apis);

    var changed = [];
    matched.pairs.forEach(function (pair) {
        if (!inScope[pair.api.id]) return;   // 范围外的接口不动，也不列出来

        var planned = planUpdate(pair.api, pair.route);
        if (!planned.changes.length) return;

        changed.push({
            apiId: pair.api.id,
            name: pair.api.name,
            method: String(pair.api.method || '').toUpperCase(),
            url: pair.api.url,
            key: String(pair.route.openapiKey || ''),
            changes: planned.changes,
            // 给 apply 用的：它拿这个 route 再算一次 patch（diff 接口出给前端时会去掉）
            route: pair.route
        });
    });

    var added = [];
    routes.forEach(function (route, index) {
        if (matched.usedRoutes[index]) return;

        // 指定了目录就放进那个目录（和「导入到选中的目录」一个口径）；
        // 从空白处进来就按 tag 找 / 建顶层目录（和导入时一样）。
        var target = folderId || folderIdByName(folders, route.group);

        added.push({
            key: String(route.openapiKey || ''),
            method: String(route.method || '').toUpperCase(),
            path: comparablePath(route.path),
            name: String(route.name || ''),
            folderId: target || null,
            folderName: target ? folderNameOf(folders, target) : (route.group ? String(route.group) : ''),
            route: route
        });
    });

    var removed = [];
    apis.forEach(function (api) {
        if (!inScope[api.id]) return;
        if (matched.usedApis[api.id]) return;
        if (!looksDocSourced(api)) return;

        removed.push({
            apiId: api.id,
            name: api.name,
            method: String(api.method || '').toUpperCase(),
            url: api.url
        });
    });

    return { added: added, changed: changed, removed: removed };
}

/** 顶层目录名 → 目录 id（导入时就是按 tag 建顶层目录的） */
function folderIdByName(folders, groupName) {
    var name = String(groupName === undefined || groupName === null ? '' : groupName).trim();
    if (!name) return null;

    var found = null;
    (folders || []).forEach(function (folder) {
        if (found || folder.parentId) return;
        if (String(folder.name).trim() === name) found = folder.id;
    });
    return found;
}

function folderNameOf(folders, folderId) {
    var found = null;
    (folders || []).forEach(function (folder) {
        if (folder.id === folderId) found = folder.name;
    });
    return found || '';
}

module.exports = {
    comparablePath: comparablePath,
    normalizePlaceholders: normalizePlaceholders,
    mergeUrl: mergeUrl,
    mergeRows: mergeRows,
    mergeBody: mergeBody,
    matchRoutes: matchRoutes,
    planUpdate: planUpdate,
    openapiRecordFor: openapiRecordFor,
    scopeFolderIds: scopeFolderIds,
    computeDiff: computeDiff,
    folderIdByName: folderIdByName,
    docRecordOf: docRecordOf,
    looksDocSourced: looksDocSourced,
    namesOf: namesOf
};
