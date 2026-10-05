/**
 * 测试集（第八轮第 1 节）。
 *
 * 两个 router 合成一个文件：
 *
 * - **测试集本身**（`/projects/:pid/suites`、`/suites/:id`）：云端和网关都有。
 *   网关读写本机库、靠同步上云，所以这里不区分 —— 同一份代码两边跑。
 * - **运行记录**（`/suites/:id/runs`、`/suite-runs/:id`）：**只在云端**。
 *   网关收到这些路径会先被 `cloudOnlyPath` 转发给云端，根本走不到这里。
 *
 * 运行（`POST /suites/:id/run`）只在**本机网关**真跑（云端 `SERVER_SEND=0`，从团队共用的
 * 服务器上替别人发请求风险太大），云端那一份直接回 409。执行本身在 `lib/suite-runner.js`。
 */

var express = require('express');

var respond = require('./respond');
var dto = require('./dto');
var ndjson = require('./ndjson');
var guardModule = require('./guard');
var sendApi = require('./send');
var suiteData = require('../suite-data');
var suiteRunner = require('../suite-runner');
var cloud = require('../gateway/cloud');
var helpers = require('../db/repos/helpers');
var apisRepo = require('../db/repos/apis');
var suitesRepo = require('../db/repos/suites');
var suiteRunsRepo = require('../db/repos/suite-runs');

/** 名字 / 说明的长度上限 */
var MAX_NAME = 120;
var MAX_DESCRIPTION = 500;

/**
 * 正在跑的测试集：suiteId → AbortController（`/suites/:id/stop` 用）。
 * 同一个测试集同时只跑一份：第二份 409，免得两份运行的记录和进度搅在一起。
 */
var runningSuites = {};

/** 刚建的测试集还没同步上去时，催一轮同步之后等这么久再重试存记录 */
var SYNC_RETRY_DELAY_MS = 1200;

function clamp(value, min, max, fallback) {
    var number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, Math.round(number)));
}

function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

/** 步骤清洗：只认认识的字段，`assertions` / `extracts` 和接口上的是同一套清洗 */
function toSteps(value) {
    if (!Array.isArray(value)) return [];

    return value.map(function (item) {
        var step = item && typeof item === 'object' ? item : {};

        return {
            id: dto.str(step.id) || helpers.newId('st'),
            apiId: dto.str(step.apiId),
            enabled: step.enabled !== false,
            // 失败之后怎么办：继续（默认）还是跳过这一轮剩下的步骤
            onFail: step.onFail === 'skipIteration' ? 'skipIteration' : 'continue',
            delayMs: clamp(step.delayMs, 0, 10 * 60 * 1000, 0),
            assertions: dto.toAssertions(step.assertions),
            extracts: dto.toExtracts(step.extracts)
        };
    }).filter(function (step) { return step.apiId !== ''; });
}

/**
 * 测试集里的步骤不能是 gRPC 接口（第十一轮第 1 节）。
 *
 * 界面上「添加步骤」的清单里已经排除（和 WS / SIO 一样），这里是兜底：
 * 直接用接口建一个带 GRPC 步骤的测试集是做得出来的，而等到真跑起来才失败，
 * 用户要翻运行报告才知道错在哪一步。
 */
function rejectGrpcSteps(handle, steps) {
    var found = (steps || []).some(function (step) {
        var api = step && step.apiId ? apisRepo.get(handle, step.apiId) : null;
        return Boolean(api) && String(api.method || '').toUpperCase() === 'GRPC';
    });

    if (found) throw respond.apiError(400, 'gRPC 接口不能加进测试集，请在 gRPC 标签页里调用');
}

/** 运行设置。`timeoutMs` 不填就跟着全局设置走（prepare 那边有默认值） */
function toSettings(value) {
    var source = value && typeof value === 'object' ? value : {};
    var settings = {
        iterations: clamp(source.iterations, 1, 100, 1),
        delayMs: clamp(source.delayMs, 0, 10 * 60 * 1000, 0)
    };

    if (source.timeoutMs !== undefined && source.timeoutMs !== null && source.timeoutMs !== '') {
        settings.timeoutMs = clamp(source.timeoutMs, 1000, 10 * 60 * 1000, 30000);
    }

    return settings;
}

/**
 * 数据清洗。**存之前先解析一次**：格式不对（列数对不上、超过 1000 行 / 2 MB）直接 400，
 * 别等到运行的时候才发现 —— 那时候用户已经在等结果了。
 */
function toData(value) {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'object') throw respond.apiError(400, '数据格式不对');

    var format = value.format === 'csv' || value.format === 'json' ? value.format : 'none';
    if (format === 'none') return null;

    var data = {
        format: format,
        fileName: dto.str(value.fileName).slice(0, 200),
        text: dto.str(value.text)
    };

    var parsed = suiteData.parse(data);
    if (!parsed.ok) throw respond.apiError(400, parsed.error);
    return data;
}

/**
 * 测试集 DTO。
 *
 * 列表里**不带 `data.text`**：一份数据可能 2 MB，一屏列表拉几十份就是几十 MB，
 * 而列表上只用得到格式和文件名。
 */
function toSuiteDto(suite, options) {
    var withData = !options || options.withData !== false;
    var steps = suite.steps || [];
    var data = suite.data;

    if (data && !withData) data = { format: data.format, fileName: data.fileName || '' };

    return {
        id: suite.id,
        projectId: suite.projectId,
        name: suite.name,
        description: suite.description,
        position: suite.position,
        steps: steps,
        stepCount: steps.length,
        enabledStepCount: steps.filter(function (step) { return step.enabled !== false; }).length,
        data: data,
        settings: suite.settings || {},
        createdAt: suite.createdAt,
        updatedAt: suite.updatedAt
    };
}

/** 复制时的名字：「原名（副本）」「原名（副本 2）」…… */
function copyName(handle, projectId, name) {
    var taken = suitesRepo.namesOf(handle, projectId);
    var base = name + '（副本）';
    if (taken.indexOf(base) === -1) return base;

    for (var index = 2; index < 100; index += 1) {
        var candidate = name + '（副本 ' + index + '）';
        if (taken.indexOf(candidate) === -1) return candidate;
    }
    return name + '（副本 ' + Date.now() + '）';
}

function createRouter(ctx) {
    var handle = ctx.handle;
    var router = express.Router();

    var g = guardModule.createGuard(ctx);
    var guard = g.guard;
    var byPid = g.byPid;
    var byParam = g.byParam;

    var preparer = sendApi.createPreparer(ctx);

    function mustSuite(id) {
        var suite = suitesRepo.get(handle, id);
        if (!suite) throw respond.apiError(404, '测试集不存在');
        return suite;
    }

    /**
     * 流式接口在**开始输出之前**出错时按普通 JSON 回（契约第 14 节）。
     * 和 `send.js` 的 `failFrom` 一个写法：`err.code` 要带给前端
     * （`SERVER_SEND_DISABLED` 就是靠它认出来的）。
     */
    function failFrom(res, err) {
        if (res.headersSent || res.writableEnded) return;

        var status = Number(err && err.status);
        if (Number.isFinite(status) && status >= 400 && status < 600) {
            return respond.fail(res, status, err.message, err.code);
        }
        console.error('[suites]', err && err.stack ? err.stack : err);
        return respond.fail(res, 500, '服务端出错：' + ((err && err.message) || '未知错误'));
    }

    /* ---------------------------------------------------------- 测试集 */

    router.get('/projects/:pid/suites', guard('viewer', byPid), respond.wrap(function (req, res) {
        var list = suitesRepo.list(handle, req.project.id).map(function (suite) {
            return toSuiteDto(suite, { withData: false });
        });

        respond.ok(res, { suites: list });
    }));

    /**
     * 新建。「存为测试集」会直接带上 `steps`（把批量运行里勾选的接口按顺序建成一个测试集）。
     */
    router.post('/projects/:pid/suites', guard('editor', byPid), respond.wrap(function (req, res) {
        var body = req.body || {};

        var steps = toSteps(body.steps);
        rejectGrpcSteps(handle, steps);

        var suite = handle.transaction(function () {
            return suitesRepo.create(handle, req.project.id, {
                name: dto.str(body.name).trim().slice(0, MAX_NAME) || '新建测试集',
                description: dto.str(body.description).slice(0, MAX_DESCRIPTION),
                steps: steps,
                data: toData(body.data),
                settings: toSettings(body.settings)
            });
        }, { projectId: req.project.id });

        respond.ok(res, { suite: toSuiteDto(suite) });
    }));

    router.get('/suites/:id', guard('viewer', byParam('suite')), respond.wrap(function (req, res) {
        respond.ok(res, { suite: toSuiteDto(mustSuite(req.params.id)) });
    }));

    /** 只改传了的字段（界面上四个页签各改各的，一次只提交一页） */
    router.put('/suites/:id', guard('editor', byParam('suite')), respond.wrap(function (req, res) {
        var suite = mustSuite(req.params.id);
        var body = req.body || {};
        var patch = {};

        if (body.name !== undefined) {
            var name = dto.str(body.name).trim().slice(0, MAX_NAME);
            if (!name) throw respond.apiError(400, '名字不能为空');
            patch.name = name;
        }
        if (body.description !== undefined) patch.description = dto.str(body.description).slice(0, MAX_DESCRIPTION);
        if (body.steps !== undefined) {
            patch.steps = toSteps(body.steps);
            rejectGrpcSteps(handle, patch.steps);
        }
        if (body.data !== undefined) patch.data = toData(body.data);
        if (body.settings !== undefined) patch.settings = toSettings(body.settings);

        var updated = handle.transaction(function () {
            return suitesRepo.update(handle, suite.id, patch);
        }, { projectId: suite.projectId });

        respond.ok(res, { suite: toSuiteDto(updated) });
    }));

    /** 删除。**不进回收站**：回收站那张表只认目录 / 接口 / 环境 */
    router.delete('/suites/:id', guard('editor', byParam('suite')), respond.wrap(function (req, res) {
        var suite = mustSuite(req.params.id);

        handle.transaction(function () {
            suitesRepo.remove(handle, suite.id);
        }, { projectId: suite.projectId });

        respond.ok(res, {});
    }));

    router.post('/suites/:id/copy', guard('editor', byParam('suite')), respond.wrap(function (req, res) {
        var suite = mustSuite(req.params.id);

        var copy = handle.transaction(function () {
            return suitesRepo.create(handle, suite.projectId, {
                name: copyName(handle, suite.projectId, suite.name),
                description: suite.description,
                steps: suite.steps,
                data: suite.data,
                settings: suite.settings
            });
        }, { projectId: suite.projectId });

        respond.ok(res, { suite: toSuiteDto(copy) });
    }));

    router.post('/projects/:pid/suites/reorder', guard('editor', byPid), respond.wrap(function (req, res) {
        var body = req.body || {};
        var ids = Array.isArray(body.ids) ? body.ids.map(function (id) { return dto.str(id); }) : [];

        handle.transaction(function () {
            suitesRepo.reorder(handle, req.project.id, ids);
        }, { projectId: req.project.id });

        respond.ok(res, {
            suites: suitesRepo.list(handle, req.project.id).map(function (suite) {
                return toSuiteDto(suite, { withData: false });
            })
        });
    }));

    /** 预览数据（数据页签那张表）：只解析，不存 */
    router.post('/projects/:pid/suites/preview-data', guard('viewer', byPid), respond.wrap(function (req, res) {
        var body = req.body || {};
        var preview = suiteData.preview({
            format: dto.str(body.format) || 'none',
            text: dto.str(body.text)
        }, 20);

        if (!preview.ok) throw respond.apiError(400, preview.error);

        respond.ok(res, {
            columns: preview.columns,
            rows: preview.rows,
            total: preview.total
        });
    }));

    /* ---------------------------------------------------------- 运行（只在本机） */

    /**
     * 跑一个测试集，NDJSON 流。
     *
     * 事件：`start`（轮数、步骤数）→ 每步一条 `step` → 一条 `done`。
     * `done.saved` 是「运行记录有没有存到云端」，没存上不算运行失败（`warning` 里给原因）。
     *
     * 浏览器断开（`res` 的 close）就停：当前请求取消、后面不再发，状态记 `stopped`，
     * **照样存运行记录** —— 跑到一半停下来的那次也是有效信息。
     */
    router.post('/suites/:id/run', guard('viewer', byParam('suite')), function (req, res) {
        var suite;
        try {
            suite = mustSuite(req.params.id);
            // 云端不替网页版发请求（和 /send 同一个判断和同一句提示）
            if (!sendApi.serverSendEnabled()) throw sendApi.serverSendDisabled();
        } catch (err) {
            return failFrom(res, err);
        }

        if (runningSuites[suite.id]) {
            return respond.fail(res, 409, '这个测试集正在运行，等它结束再开始');
        }

        var body = req.body || {};
        var who = { user: { id: req.user ? req.user.id : null }, role: req.role };
        var controller = new AbortController();
        runningSuites[suite.id] = controller;

        function release() {
            if (runningSuites[suite.id] === controller) delete runningSuites[suite.id];
        }

        ndjson.start(res);

        res.on('close', function () {
            if (!res.writableEnded) controller.abort();
        });

        suiteRunner.runSuite({
            handle: handle,
            preparer: preparer,
            project: req.project,
            suite: suite,
            environmentId: body.environmentId ? dto.str(body.environmentId) : null,
            mockBase: body.mockBase ? dto.str(body.mockBase) : '',
            who: who,
            signal: controller.signal,
            fileRoots: preparer.sendFileRoots(req.project),
            onEvent: function (event) { ndjson.write(res, event); }
        }).then(function (outcome) {
            var record = {
                suiteId: suite.id,
                projectId: suite.projectId,
                source: 'app',
                environmentName: outcome.environmentName,
                status: outcome.status,
                summary: outcome.summary,
                result: outcome.result,
                triggeredBy: who.user.id,
                label: '',
                startedAt: outcome.startedAt,
                finishedAt: outcome.finishedAt
            };

            // 跑完就放开：存记录要等云端（可能要等同步重试），不该挡住下一次运行
            release();

            return saveRun(suite, record).then(function (saved) {
                ndjson.write(res, {
                    type: 'done',
                    runId: outcome.runId,
                    status: outcome.status,
                    summary: outcome.summary,
                    // 整份结果（已经按 2 MB 裁过）：界面上这次的报告直接用它 —— 光靠一条条
                    // step 事件拼，每一轮用的是哪行数据就丢了
                    result: outcome.result,
                    saved: saved.saved,
                    warning: saved.warning || ''
                });
                res.end();
            });
        }).catch(function (err) {
            release();
            // 走到这里是我们自己的 bug（runSuite 承诺不抛）：别让前端一直等
            ndjson.write(res, {
                type: 'done',
                status: 'error',
                summary: { message: (err && err.message) || '运行失败' },
                saved: false,
                warning: '运行出错了：' + ((err && err.message) || err)
            });
            res.end();
        });

        return undefined;
    });

    /**
     * 停止一个正在跑的测试集。界面上的「停止」走这里而不是直接断开连接：断开的话
     * 最后那条 `done`（汇总、记录有没有存上）就收不到了。这里只 abort，
     * 收尾、存记录、`done` 都照常走上面那条流（状态记 `stopped`）。
     */
    router.post('/suites/:id/stop', guard('viewer', byParam('suite')), respond.wrap(function (req, res) {
        var controller = runningSuites[req.params.id];
        if (controller) controller.abort();
        respond.ok(res, { stopped: Boolean(controller) });
    }));

    /**
     * 把这次运行存到云端。
     *
     * - **云端自己跑**（`SERVER_SEND=1`）：直接写本机库；
     * - **网关上**：带当前用户的会话调云端的 `POST /suites/:id/runs`。
     *   刚在本机建的测试集还没同步上去时云端会说找不到它 —— 先催一轮同步再重试一次
     *   （同步是异步的，这里只能等一小会儿），还不行就如实报 `saved: false` + 原因。
     *   **没登录不算错**：运行照跑，只是不留记录。
     */
    function saveRun(suite, record) {
        if (ctx.localSend !== true) {
            suiteRunsRepo.insert(handle, record);
            return Promise.resolve({ saved: true });
        }

        var cloudAccess = ctx.cloud;
        if (!cloudAccess || typeof cloudAccess.cookie !== 'function' || !cloudAccess.cookie()) {
            return Promise.resolve({ saved: false, warning: '没有登录，这次运行没有保存到云端' });
        }

        var cloudUrl = cloudAccess.url();
        if (!cloudUrl) return Promise.resolve({ saved: false, warning: '这个安装包没有配置云端地址' });

        function post() {
            return cloud.requestJson({
                cloudUrl: cloudUrl,
                path: '/__admin/api/suites/' + encodeURIComponent(suite.id) + '/runs',
                method: 'POST',
                headers: { cookie: cloudAccess.cookie() },
                body: record
            });
        }

        return post().then(function (answer) {
            if (answer.status >= 200 && answer.status < 300) return { saved: true };
            if (answer.status !== 404) return { saved: false, warning: describe(answer) };

            // 404 多半是「测试集还没同步上去」：催一轮同步，等一会儿再试一次
            if (typeof cloudAccess.syncNow === 'function') cloudAccess.syncNow();

            return sleep(SYNC_RETRY_DELAY_MS).then(post).then(function (retry) {
                if (retry.status >= 200 && retry.status < 300) return { saved: true };
                return { saved: false, warning: describe(retry) };
            });
        }).catch(function (err) {
            return { saved: false, warning: '运行记录没有保存：' + ((err && err.message) || '云端连不上') };
        });
    }

    function describe(answer) {
        var message = answer && answer.json && answer.json.error;
        return '运行记录没有保存：' + (message || ('云端返回 ' + ((answer && answer.status) || '?')));
    }

    /* ---------------------------------------------------------- 运行记录（只在云端） */

    router.get('/suites/:id/runs', guard('viewer', byParam('suite')), respond.wrap(function (req, res) {
        var suite = mustSuite(req.params.id);
        var limit = Number((req.query || {}).limit);

        respond.ok(res, {
            runs: suiteRunsRepo.list(handle, suite.id, limit),
            keep: suiteRunsRepo.KEEP_PER_SUITE
        });
    }));

    router.post('/suites/:id/runs', guard('viewer', byParam('suite')), respond.wrap(function (req, res) {
        var suite = mustSuite(req.params.id);
        var body = req.body || {};
        var status = ['passed', 'failed', 'stopped', 'error'].indexOf(dto.str(body.status)) > -1
            ? dto.str(body.status)
            : 'error';

        var run = suiteRunsRepo.insert(handle, {
            suiteId: suite.id,
            projectId: suite.projectId,
            source: dto.str(body.source) === 'cli' ? 'cli' : 'app',
            environmentName: dto.str(body.environmentName).slice(0, MAX_NAME),
            status: status,
            summary: body.summary && typeof body.summary === 'object' ? body.summary : {},
            result: body.result && typeof body.result === 'object' ? body.result : {},
            triggeredBy: req.user ? req.user.id : null,
            label: dto.str(body.label).slice(0, MAX_NAME),
            startedAt: Number(body.startedAt) || Date.now(),
            finishedAt: Number(body.finishedAt) || Date.now()
        });

        respond.ok(res, { run: run });
    }));

    router.get('/suite-runs/:id', guard('viewer', byParam('suite-run')), respond.wrap(function (req, res) {
        var run = suiteRunsRepo.get(handle, req.params.id);
        if (!run) throw respond.apiError(404, '这条运行记录不存在');
        respond.ok(res, { run: run });
    }));

    router.delete('/suite-runs/:id', guard('editor', byParam('suite-run')), respond.wrap(function (req, res) {
        var run = suiteRunsRepo.get(handle, req.params.id);
        if (!run) throw respond.apiError(404, '这条运行记录不存在');

        suiteRunsRepo.remove(handle, run.id);
        respond.ok(res, {});
    }));

    return router;
}

module.exports = {
    createRouter: createRouter,
    toSuiteDto: toSuiteDto,
    toSteps: toSteps,
    toData: toData,
    toSettings: toSettings
};
