/**
 * Mock 期望接口（契约第 9 节，权限见第 10 节）。
 *
 * 「同一个接口按请求条件返回不同示例」的读写。条件本身不做任何执行 ——
 * 匹配发生在 mock 运行时（lib/mock-runtime.js），这里只负责把它清洗得能安全落库。
 *
 * 权限：改期望要 editor，和改示例同一档。定位一律走 `byParam` —— 期望和示例都不存
 * 项目 id，得先查到所属的 api 再查到项目，否则拿别人的 expectationId 就能改。
 *
 * 校验的严格程度是按「用户能不能看懂」定的：`in` / `op` 写错、key 空着、
 * 正则编译不过，都在保存时就报 400，而不是等到 mock 请求来了再默默不命中。
 */

var express = require('express');

var respond = require('./respond');
var dto = require('./dto');
var guardModule = require('./guard');
var apisRepo = require('../db/repos/apis');
var examplesRepo = require('../db/repos/examples');
var expectationsRepo = require('../db/repos/expectations');

var SOURCES = ['query', 'header', 'body', 'path'];
var OPS = ['eq', 'ne', 'contains', 'regex', 'exists', 'notExists', 'gt', 'lt'];

function createRouter(ctx) {
    var handle = ctx.handle;
    var router = express.Router();

    var g = guardModule.createGuard(ctx);
    var guard = g.guard;
    var byParam = g.byParam;

    function mustApi(id) {
        var api = apisRepo.get(handle, id);
        if (!api) throw respond.apiError(404, '接口不存在：' + id);
        return api;
    }

    function mustExpectation(id) {
        var expectation = expectationsRepo.get(handle, id);
        if (!expectation) throw respond.apiError(404, '期望不存在：' + id);
        return expectation;
    }

    /** 期望所属的接口；接口没了的外键孤儿不该存在，真碰上也别把 500 漏出去 */
    function apiOf(expectation) {
        var api = apisRepo.get(handle, expectation.apiId);
        if (!api) throw respond.apiError(404, '接口不存在：' + expectation.apiId);
        return api;
    }

    function apiPayload(apiId) {
        return dto.toApiDto(
            apisRepo.get(handle, apiId),
            examplesRepo.listByApi(handle, apiId),
            expectationsRepo.listByApi(handle, apiId)
        );
    }

    /**
     * 条件清洗。返回的是能直接落库的形状。
     * @param {*} value 请求里的 conditions
     * @returns {Array} 每个条件都是 `{ in, key, op, value }`
     */
    function cleanConditions(value) {
        if (!Array.isArray(value)) throw respond.apiError(400, 'conditions 必须是数组');

        return value.map(function (item, index) {
            var label = '第 ' + (index + 1) + ' 个条件';
            var condition = dto.plainObject(item);
            if (!condition) throw respond.apiError(400, label + '不是对象');

            var source = dto.str(condition.in);
            if (SOURCES.indexOf(source) === -1) {
                throw respond.apiError(400, label + '的 in 只能是 ' + SOURCES.join(' / '));
            }

            var op = dto.str(condition.op);
            if (OPS.indexOf(op) === -1) {
                throw respond.apiError(400, label + '的 op 只能是 ' + OPS.join(' / '));
            }

            // exists / notExists 用不上 value，但一样要求写 key —— 不写 key 的条件没有意义
            var key = dto.str(condition.key).trim();
            if (!key) throw respond.apiError(400, label + '的 key 不能为空');

            var text = dto.str(condition.value);
            if (op === 'regex') {
                try {
                    new RegExp(text);
                } catch (err) {
                    throw respond.apiError(400, '正则不合法：' + (err && err.message ? err.message : err));
                }
            }

            return { in: source, key: key, op: op, value: text };
        });
    }

    /**
     * 期望必须指明返回哪条示例 —— 指向一条不属于这个接口的示例是没有意义的，
     * 运行时也就没法把它展开成响应。
     */
    function resolveExampleId(api, value) {
        var exampleId = dto.str(value);
        if (!exampleId) throw respond.apiError(400, '请选择这条期望要返回的示例');

        var belongs = examplesRepo.listByApi(handle, api.id).some(function (item) {
            return item.id === exampleId;
        });
        if (!belongs) throw respond.apiError(400, '这个示例不属于该接口');

        return exampleId;
    }

    /* ---------------------------------------------------------- 增删改 */

    router.post('/apis/:id/expectations', guard('editor', byParam('api')), respond.wrap(function (req, res) {
        var api = mustApi(req.params.id);
        var input = dto.plainObject((req.body || {}).expectation || req.body) || {};

        var created = handle.transaction(function () {
            return expectationsRepo.insert(handle, api.id, {
                name: dto.str(input.name),
                enabled: input.enabled !== false,
                conditions: input.conditions === undefined ? [] : cleanConditions(input.conditions),
                exampleId: resolveExampleId(api, input.exampleId),
                position: input.position
            });
        }, { projectId: api.projectId });

        respond.ok(res, { expectation: dto.toExpectationDto(created), api: apiPayload(api.id) });
    }));

    router.put('/expectations/:id', guard('editor', byParam('expectation')), respond.wrap(function (req, res) {
        var expectation = mustExpectation(req.params.id);
        var api = apiOf(expectation);
        var input = dto.plainObject((req.body || {}).expectation || req.body) || {};
        var patch = {};

        if (input.name !== undefined) patch.name = dto.str(input.name);
        if (input.enabled !== undefined) patch.enabled = input.enabled !== false;
        if (input.conditions !== undefined) patch.conditions = cleanConditions(input.conditions);
        if (input.exampleId !== undefined) patch.exampleId = resolveExampleId(api, input.exampleId);
        if (input.position !== undefined) patch.position = Number(input.position) || 0;

        var updated = handle.transaction(function () {
            return expectationsRepo.update(handle, expectation.id, patch);
        }, { projectId: api.projectId });

        respond.ok(res, { expectation: dto.toExpectationDto(updated) });
    }));

    router.delete('/expectations/:id', guard('editor', byParam('expectation')), respond.wrap(function (req, res) {
        var expectation = mustExpectation(req.params.id);
        var api = apiOf(expectation);

        handle.transaction(function () {
            expectationsRepo.remove(handle, expectation.id);
            // 删完同级会留下 position 空洞，顺手收拢，让「同级 position 连续」继续成立
            expectationsRepo.setPositions(handle, api.id,
                expectationsRepo.listByApi(handle, api.id).map(function (item) { return item.id; }));
        }, { projectId: api.projectId });

        respond.ok(res, { api: apiPayload(api.id) });
    }));

    router.post('/apis/:id/expectations/reorder', guard('editor', byParam('api')), respond.wrap(function (req, res) {
        var api = mustApi(req.params.id);
        var ids = (req.body || {}).ids;
        if (!Array.isArray(ids)) throw respond.apiError(400, 'ids 必须是数组');

        handle.transaction(function () {
            expectationsRepo.setPositions(handle, api.id, ids);
        }, { projectId: api.projectId });

        respond.ok(res, { api: apiPayload(api.id) });
    }));

    return router;
}

module.exports = {
    createRouter: createRouter,
    SOURCES: SOURCES,
    OPS: OPS
};
