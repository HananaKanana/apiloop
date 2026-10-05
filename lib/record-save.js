/**
 * Mock 录制 → 存成接口示例（第十一轮第 2 节）。
 *
 * 用户勾几条录到的请求，这里把它们变成 apiloop 里的东西：
 *   - 匹配到已有接口的 → 给这个接口**加一个示例**（响应体、状态码、响应头）；
 *   - 没匹配上的 → **新建接口**再加示例（方法、地址、Params、请求体都从录到的请求还原）。
 *
 * 三条约定：
 * - **算不了的一条不拖累别的**：找不到记录、二进制、流式（SSE）、`apiId` 不属于这个项目，
 *   这些只在那一条的 `results` 里给 `error`，其余的照存；
 * - 写库是**一个事务**（`handle.transaction`），这样同步才会记下改动；所以先把所有条目
 *   算成「计划」，校验全过了再一起写；
 * - 用的是和「把响应存成示例」（`lib/api/tree.js` 的 `POST /apis/:id/examples`）**同一套 repo 函数**，
 *   不另造一份写库逻辑。
 */

var apisRepo = require('./db/repos/apis');
var examplesRepo = require('./db/repos/examples');
var foldersRepo = require('./db/repos/folders');
var environmentsRepo = require('./db/repos/environments');
var runtimeModule = require('./mock-runtime');
var urlUtils = require('./url-utils');
var recorder = require('./record-proxy');

/**
 * 存示例时丢掉这些响应头。
 *
 * 前七个是计划里点名的（逐次变化、或者和这一次的传输方式有关）；后面几个是 hop-by-hop 头
 * （RFC 7230 第 6.1 节）—— `keep-alive` 实测会被目标带回来（`timeout=5`），存进示例只会是噪音。
 */
var DROP_RESPONSE_HEADERS = recorder.DROP_RESPONSE_HEADERS.concat([
    'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'upgrade'
]);

function httpError(status, message) {
    var err = new Error(message);
    err.status = status;
    return err;
}

function pad2(num) {
    return num < 10 ? '0' + num : String(num);
}

/** 「录制 200 · 10-05 10:30」 */
function defaultExampleName(entry) {
    var at = new Date(entry.at);
    return '录制 ' + entry.status + ' · ' +
        pad2(at.getMonth() + 1) + '-' + pad2(at.getDate()) + ' ' +
        pad2(at.getHours()) + ':' + pad2(at.getMinutes());
}

function responseTypeOf(contentType) {
    var type = String(contentType || '').toLowerCase();
    if (type.indexOf('json') > -1) return 'json';
    if (type.indexOf('html') > -1) return 'html';
    return 'text';
}

/** 响应头 → 示例的 headers 行（丢掉逐次变化 / 和传输方式有关的那些） */
function exampleHeaders(headers) {
    var rows = [];
    Object.keys(headers || {}).forEach(function (name) {
        if (DROP_RESPONSE_HEADERS.indexOf(String(name).toLowerCase()) > -1) return;
        var value = headers[name];
        if (Array.isArray(value)) value = value.join(', ');
        rows.push({ key: String(name), value: String(value), enabled: true });
    });
    return rows;
}

/** 查询串 → Params 行 */
function queryRows(query) {
    var text = String(query || '');
    if (!text) return [];

    return text.split('&').filter(Boolean).map(function (pair) {
        var at = pair.indexOf('=');
        var rawKey = at === -1 ? pair : pair.slice(0, at);
        var rawValue = at === -1 ? '' : pair.slice(at + 1);

        function decode(value) {
            try {
                return decodeURIComponent(String(value).replace(/\+/g, ' '));
            } catch (err) {
                return String(value);
            }
        }

        return { key: decode(rawKey), value: decode(rawValue), enabled: true };
    }).filter(function (row) { return row.key !== ''; });
}

/** 路径里「一看就是 id」的段：纯数字、UUID、长串十六进制 */
function looksLikeId(segment) {
    if (/^\d+$/.test(segment)) return true;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) return true;
    if (/^[0-9a-f]{16,}$/i.test(segment)) return true;
    return false;
}

/** `/orders/1001/items/2` → `/orders/:id/items/:id2` */
function paramizePath(path) {
    var count = 0;
    return String(path || '').split('/').map(function (segment) {
        if (!segment || !looksLikeId(segment)) return segment;
        count += 1;
        return count === 1 ? ':id' : ':id' + count;
    }).join('/');
}

/**
 * 变量表：值 → 变量名。找「哪个变量的值正好是 target 的地址」时用。
 * 项目变量先放，环境变量后放（同值时环境优先，和替换时的优先级一致）。
 */
function variableByValue(project, environment) {
    var map = new Map();

    function add(rows) {
        (rows || []).forEach(function (row) {
            if (!row || row.enabled === false) return;
            var key = row.key === undefined || row.key === null ? '' : String(row.key);
            var value = row.value === undefined || row.value === null ? '' : String(row.value);
            if (!key || !value) return;
            map.set(value.replace(/\/+$/, ''), key);
        });
    }

    add(project.variables);
    if (environment) add(environment.variables);
    return map;
}

/**
 * 新接口的地址：能对上变量就写 `{{变量}}`，否则写 target 原样。
 *
 * 不管走哪一支，拼出来的地址都等于「origin + 后端真正收到的路径」——
 * 中间用哪一段变量只是写法不同。
 *
 * @param {object} target `{ origin, prefix, text }`（录这条请求时的 target）
 * @param {string} fullPath 后端真正收到的路径（target 前缀 + 客户端路径）
 * @param {Map<string,string>} byValue 值 → 变量名
 */
function buildUrl(target, fullPath, byValue) {
    var origin = target.origin;
    var prefix = target.prefix || '';
    var originAndPrefix = origin + prefix;

    // 变量值正好等于「origin + 前缀」：变量已经覆盖了前缀，后面接客户端路径
    if (byValue.has(originAndPrefix)) {
        return '{{' + byValue.get(originAndPrefix) + '}}' + (fullPath.slice(prefix.length) || '/');
    }

    // 变量值正好等于 origin：变量只到主机，后面接后端真正收到的完整路径
    if (byValue.has(origin)) {
        return '{{' + byValue.get(origin) + '}}' + (fullPath || '/');
    }

    // 都没对上：写 target 原样
    return originAndPrefix + (fullPath.slice(prefix.length) || '/');
}

/** 请求体：是 JSON 就存成接口的 raw JSON Body，其余留空 */
function requestBody(entry) {
    var text = String((entry.request && entry.request.body) || '');
    if (!text.trim()) return { mode: 'none' };
    if (entry.request && entry.request.bodyTruncated) return { mode: 'none' };

    var parsed = null;
    try {
        parsed = JSON.parse(text);
    } catch (err) {
        return { mode: 'none' };
    }
    if (parsed === null || typeof parsed !== 'object') return { mode: 'none' };

    return { mode: 'raw', language: 'json', raw: text };
}

function requestHeaderRows(entry) {
    var contentType = String((entry.request && entry.request.contentType) || '');
    if (!contentType) return [];
    return [{ key: 'Content-Type', value: contentType, enabled: true }];
}

/**
 * 把一条记录算成「要做什么」，不做任何写库。
 *
 * @returns {{ok: true, plan: object} | {ok: false, error: string}}
 */
function planOne(entry, item, context) {
    if (!entry) return { ok: false, error: '找不到这条记录（可能已经被清空）' };
    if (entry.error) return { ok: false, error: '这条记录没拿到响应，不能存成示例' };
    if (entry.response && entry.response.binary) return { ok: false, error: '二进制响应不能存成示例' };
    if (entry.response && String(entry.response.contentType || '') === 'text/event-stream') {
        return { ok: false, error: '流式响应（SSE）不能存成示例' };
    }

    var example = {
        name: String((item && item.name) || '').trim() || defaultExampleName(entry),
        status: entry.status,
        headers: exampleHeaders(entry.response && entry.response.headers),
        body: String((entry.response && entry.response.body) || ''),
        responseType: responseTypeOf(entry.response && entry.response.contentType),
        source: 'recorded'
    };

    var apiId = item && item.apiId ? String(item.apiId) : '';

    if (apiId) {
        var api = context.apisById[apiId];
        if (!api) return { ok: false, error: '要保存到的接口不存在' };
        return { ok: true, plan: { entryId: entry.id, apiId: api.id, example: example, api: null } };
    }

    var folderId = item && item.folderId ? String(item.folderId) : null;
    if (folderId && !context.folderIds.has(folderId)) {
        return { ok: false, error: '选中的目录不存在' };
    }

    var target = recorder.targetOf(entry) || { origin: '', prefix: '', text: '' };
    var fullPath = (target.prefix || '') + entry.path;
    var apiPath = context.paramize ? paramizePath(fullPath) : fullPath;
    var url = buildUrl(target, apiPath, context.byValue);

    var mockPath = urlUtils.deriveMockPath(url);
    if (runtimeModule.validateRoutePath(mockPath)) mockPath = null;

    return {
        ok: true,
        plan: {
            entryId: entry.id,
            seq: entry.seq,
            apiId: null,
            example: example,
            apiPath: apiPath,
            /** 客户端发来的路径 + target 的路径前缀：重新匹配时要用 */
            clientPath: entry.path,
            targetPrefix: target.prefix || '',
            api: {
                name: String((item && item.name) || '').trim() || (entry.method + ' ' + apiPath),
                folderId: folderId,
                method: entry.method,
                url: url,
                params: {
                    path: [],
                    query: queryRows(entry.query),
                    headers: requestHeaderRows(entry)
                },
                body: requestBody(entry),
                mockPath: mockPath
            }
        }
    };
}

/** 「录制 200 · 10-05 10:30」重名了就加「 (2)」「 (3)」… */
function uniqueName(base, taken) {
    if (!taken.has(base)) return base;

    for (var i = 2; i < 1000; i += 1) {
        var next = base + ' (' + i + ')';
        if (!taken.has(next)) return next;
    }
    return base;
}

/**
 * 保存勾选的记录。
 *
 * @param {{handle: object, project: object, body: object}} input
 * @returns {{created: {apis: number, examples: number}, results: Array}}
 */
function save(input) {
    var handle = input.handle;
    var project = input.project;
    var body = input.body || {};
    var items = Array.isArray(body.items) ? body.items : [];

    if (!items.length) throw httpError(400, '请先勾选要保存的记录');

    var environmentId = body.environmentId ? String(body.environmentId) : '';
    var environment = environmentId ? environmentsRepo.get(handle, environmentId) : null;
    if (environment && environment.projectId !== project.id) environment = null;

    var context = {
        paramize: body.paramize !== false,
        setMock: body.setMock !== false,
        byValue: variableByValue(project, environment),
        apisById: {},
        folderIds: new Set()
    };

    apisRepo.list(handle, project.id).forEach(function (api) { context.apisById[api.id] = api; });
    foldersRepo.list(handle, project.id).forEach(function (folder) { context.folderIds.add(folder.id); });

    /* ---- 第一步：逐条算成「计划」（不写库） ---- */

    var decisions = items.map(function (item) {
        // 项目对不上的记录当「找不到」—— 不能拿别的项目的 entryId 把内容存进这个项目
        var entry = recorder.getEntry(item && item.entryId, project.id);
        var outcome = planOne(entry, item, context);

        if (!outcome.ok) {
            return { ok: false, entryId: (item && item.entryId) || '', error: outcome.error };
        }
        return { ok: true, entryId: outcome.plan.entryId, plan: outcome.plan };
    });

    /* ---- 第二步：没给 apiId 的，先用**当前库里**的接口重新匹配一次 ---- */
    /*
     * 记录的 `match` 是录的那一刻算的。用户先把 /orders/1001 存成新接口之后，之前录到的
     * /orders/1002 还是 match: null（界面上显示「新接口」）—— 不重新匹配的话会再建一个重复的
     * 接口。匹配用的是同一个 matchApi（1 秒的路由缓存，开销可接受）。
     */
    decisions.forEach(function (decision) {
        if (!decision.ok || decision.plan.apiId) return;

        var matched = recorder.matchApi(
            handle, project.id, decision.plan.api.method,
            decision.plan.clientPath, decision.plan.targetPrefix
        );

        if (matched && context.apisById[matched.apiId]) {
            decision.plan.apiId = matched.apiId;
            decision.plan.createdApi = false;
        }
    });

    /* ---- 第三步：还要新建的按「方法 + 参数化路径 + 目录」分组，每组只建一个接口 ---- */

    var groups = [];
    var groupIndex = {};

    decisions.forEach(function (decision) {
        if (!decision.ok || decision.plan.apiId) return;

        var api = decision.plan.api;
        var key = api.method + '\n' + decision.plan.apiPath + '\n' + (api.folderId || '');
        if (groupIndex[key] === undefined) {
            groupIndex[key] = groups.length;
            groups.push([]);
        }
        groups[groupIndex[key]].push(decision);
    });

    /* ---- 第四步：一个事务里写完 ---- */

    var nameCache = new Map();

    /** 这个接口现在已经有哪些示例名（含本次刚加的），用来给重名的加序号 */
    function takenNames(apiId) {
        if (!nameCache.has(apiId)) {
            nameCache.set(apiId, new Set(examplesRepo.listByApi(handle, apiId).map(function (item) {
                return item.name;
            })));
        }
        return nameCache.get(apiId);
    }

    function addExample(apiId, example) {
        var taken = takenNames(apiId);
        var fields = Object.assign({}, example, { name: uniqueName(example.name, taken) });
        var created = examplesRepo.insert(handle, apiId, fields);
        taken.add(created.name);
        return created;
    }

    var writable = decisions.filter(function (decision) { return decision.ok; });

    if (writable.length) {
        handle.transaction(function () {
            groups.forEach(function (list) {
                // 按录制顺序排：第一条定 Params / Body，最后一条给 Mock 指
                list.sort(function (a, b) { return a.plan.seq - b.plan.seq; });

                var first = list[0].plan.api;
                var created = apisRepo.insert(handle, project.id, Object.assign({}, first, {
                    mockEnabled: true,
                    position: apisRepo.nextPositionIn(handle, project.id, first.folderId)
                }));

                list.forEach(function (decision) {
                    decision.plan.apiId = created.id;
                    decision.plan.createdApi = true;
                    decision.plan.exampleId = addExample(created.id, decision.plan.example).id;
                });

                if (context.setMock) {
                    apisRepo.update(handle, created.id, {
                        mockExampleId: list[list.length - 1].plan.exampleId,
                        mockEnabled: true
                    });
                }
            });

            // 对上了已有接口的：逐条加示例
            writable.forEach(function (decision) {
                if (decision.plan.createdApi) return;
                decision.plan.exampleId = addExample(decision.plan.apiId, decision.plan.example).id;

                if (context.setMock) {
                    apisRepo.update(handle, decision.plan.apiId, {
                        mockExampleId: decision.plan.exampleId,
                        mockEnabled: true
                    });
                }
            });
        }, { projectId: project.id });

        recorder.invalidateRoutes();
    }

    /* ---- 第五步：结果按传进来的 items 顺序回 ---- */

    var results = decisions.map(function (decision) {
        if (!decision.ok) {
            return { entryId: decision.entryId, apiId: null, exampleId: null, createdApi: false, error: decision.error };
        }
        return {
            entryId: decision.entryId,
            apiId: decision.plan.apiId,
            exampleId: decision.plan.exampleId,
            createdApi: !!decision.plan.createdApi,
            error: null
        };
    });

    return {
        created: {
            apis: groups.length,
            examples: writable.length
        },
        results: results
    };
}

module.exports = {
    save: save
};
