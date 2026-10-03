/**
 * 全局查找替换的接口（第五轮第 2 节）。
 *
 * 两条：
 *
 * | 接口 | 权限 | 说明 |
 * | --- | --- | --- |
 * | `POST /projects/:pid/search` | viewer | 找；最多回 500 处，超了 `truncated: true` |
 * | `POST /projects/:pid/replace` | editor | 替换；服务端**重新搜一遍**，只动 targets 里列出的位置 |
 *
 * 查找规则一个字都不在这个文件里 —— 全在 `lib/search-replace.js`（纯函数）。
 * 这里只做三件事：划范围（整个项目 / 某个目录连同子目录）、读库、写库。
 *
 * **替换为什么要在服务端重搜一遍**：前端给的 targets 是「用户看到的那一刻」的清单，
 * 从搜索到点替换之间别人可能改过这些接口。重搜 + 按 `apiId + field + location` 对上，
 * 位置对不上了（比如那一行被删了）自然就跳过，不会把替换写到别的地方去。
 *
 * 替换只动 targets 里列出的位置，一个事务里做完；**已打开且有未保存修改的接口**
 * 由前端放进 `skipApiIds`，服务端不猜（它不知道别人页面上有什么没保存）。
 */

var express = require('express');

var respond = require('./respond');
var dto = require('./dto');
var guardModule = require('./guard');
var tree = require('../tree');
var searchReplace = require('../search-replace');
var urlUtils = require('../url-utils');
var runtimeModule = require('../mock-runtime');
var foldersRepo = require('../db/repos/folders');
var apisRepo = require('../db/repos/apis');

function createRouter(ctx) {
    var handle = ctx.handle;
    var router = express.Router();

    var g = guardModule.createGuard(ctx);
    var guard = g.guard;
    var byPid = g.byPid;

    /**
     * 范围：`folderId` 为空是整个项目，否则是那个目录**连同它的子目录**。
     * 目录不属于这个项目时 400（和别的接口一个口径）。
     */
    function scopeFolderIds(projectId, folderId) {
        if (folderId === undefined || folderId === null || String(folderId) === '') return null;

        var id = dto.str(folderId);
        var folder = foldersRepo.get(handle, id);
        if (!folder || folder.projectId !== projectId) {
            throw respond.apiError(400, '目录不存在或不属于这个项目');
        }

        var ids = {};
        ids[id] = true;
        tree.descendants(handle, projectId, id).forEach(function (item) { ids[item.id] = true; });
        return ids;
    }

    /** 这个项目里、在范围内、按目录树顺序排好的接口 */
    function apisInScope(projectId, folderIds) {
        return apisRepo.list(handle, projectId).filter(function (api) {
            return folderIds ? folderIds[api.folderId] === true : true;
        });
    }

    /** 请求体 → 查找条件（`pattern` 用 `buildPattern` 造，正则写错会抛 400） */
    function conditionsOf(body) {
        var input = dto.plainObject(body) || {};
        var conditions = {
            query: dto.str(input.query),
            caseSensitive: input.caseSensitive === true,
            wholeWord: input.wholeWord === true,
            regex: input.regex === true,
            fields: searchReplace.normalizeFields(input.fields),
            replacement: dto.str(input.replacement)
        };
        conditions.pattern = searchReplace.buildPattern(conditions);
        return conditions;
    }

    /**
     * 改了 url 之后 mock.path 要不要跟着走。
     *
     * 和 `PUT /apis/:id` 里那条规则**一模一样**（那里是内联写的）：只有旧的 mock.path 还等于
     * 「从旧 url 推出来的」那个值（说明用户从没手动改过它），才跟着重推 ——
     * 用户手动填过的路径不能被 URL 一改就冲掉；推导结果不合法时也保持原值。
     *
     * @returns {string|null} 新的 mock 路径，不动时返回 null
     */
    function derivedMockPath(api, patch) {
        if (patch.url === undefined) return null;
        if (api.mockPath !== urlUtils.deriveMockPath(api.url)) return null;

        var derived = urlUtils.deriveMockPath(patch.url);
        if (runtimeModule.validateRoutePath(derived)) return null;
        return derived;
    }

    /* ---------------------------------------------------------- 查 */

    router.post('/projects/:pid/search', guard('viewer', byPid), respond.wrap(function (req, res) {
        var project = req.project;
        var body = req.body || {};
        var conditions = conditionsOf(body);

        // 没填查找词就是「什么都不匹配」，不是错误 —— 界面是边打字边搜的，
        // 清空输入框时给一个 400 只会弹一句看不懂的提示。
        if (!conditions.pattern) {
            return respond.ok(res, { matches: [], total: 0, truncated: false, fields: conditions.fields });
        }

        var folderIds = scopeFolderIds(project.id, body.folderId);
        var apis = apisInScope(project.id, folderIds);

        var matches = [];
        var total = 0;
        var truncated = false;

        for (var i = 0; i < apis.length; i++) {
            var found = searchReplace.findMatches(apis[i], conditions);
            total += found.length;

            for (var j = 0; j < found.length && matches.length < searchReplace.MAX_MATCHES; j++) {
                matches.push(found[j]);
            }

            // 够 500 处就停：剩下的不再扫（`total` 这时是个下限），界面显示「还有更多」
            if (total >= searchReplace.MAX_MATCHES) {
                truncated = i + 1 < apis.length || total > matches.length;
                break;
            }
        }

        respond.ok(res, { matches: matches, total: total, truncated: truncated });
    }));

    /* ---------------------------------------------------------- 替换 */

    router.post('/projects/:pid/replace', guard('editor', byPid), respond.wrap(function (req, res) {
        var project = req.project;
        var body = req.body || {};
        var conditions = conditionsOf(body);

        if (!conditions.pattern) throw respond.apiError(400, '请填写查找内容');

        /**
         * targets → `{ apiId: { location: true } }`。
         * 一个位置里可能有多个命中，所以这里只记位置，命中数在替换时数。
         */
        var targetsByApi = {};
        (Array.isArray(body.targets) ? body.targets : []).forEach(function (item) {
            var target = dto.plainObject(item);
            if (!target) return;

            var apiId = dto.str(target.apiId);
            var field = dto.str(target.field);
            var location = dto.str(target.location);
            if (!apiId || !location) return;
            if (searchReplace.FIELDS.indexOf(field) === -1) return;
            // `field` 只用来认位置属于哪一类，真正对的是 location（locations 由 apiId 下的清单生成）
            if (field !== locationField(location)) return;

            var bucket = targetsByApi[apiId] || (targetsByApi[apiId] = {});
            bucket[location] = true;
        });

        var skip = {};
        (Array.isArray(body.skipApiIds) ? body.skipApiIds : []).forEach(function (id) {
            skip[dto.str(id)] = true;
        });

        var apiIds = Object.keys(targetsByApi);
        if (!apiIds.length) return respond.ok(res, { changedApis: 0, changed: 0 });

        var summary = handle.transaction(function () {
            var changedApis = 0;
            var changed = 0;

            apiIds.forEach(function (apiId) {
                if (skip[apiId]) return;

                var api = apisRepo.get(handle, apiId);
                // 不属于这个项目的一律当没这条：targets 是客户端传上来的，不能拿它去写别的项目
                if (!api || api.projectId !== project.id) return;

                var result = searchReplace.applyToApi(api, conditions, targetsByApi[apiId]);
                if (!result) return;

                var mockPath = derivedMockPath(api, result.patch);
                if (mockPath !== null) result.patch.mockPath = mockPath;

                apisRepo.update(handle, apiId, result.patch);
                changedApis += 1;
                changed += result.changed;
            });

            return { changedApis: changedApis, changed: changed };
        }, { projectId: project.id });

        respond.ok(res, summary);
    }));

    return router;
}

/** location 属于哪一类（`headers[2].value` → `headers`）—— 校验 targets 用 */
function locationField(location) {
    var head = String(location).split(/[.[]/)[0];
    if (head === 'headers' || head === 'params' || head === 'body' || head === 'scripts') return head;
    if (head === 'url' || head === 'name' || head === 'description') return head;
    return '';
}

module.exports = {
    createRouter: createRouter
};
