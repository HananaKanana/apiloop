/**
 * 简单压测的接口（第八轮第 2 节）：`POST /projects/:pid/load`，NDJSON 流。
 *
 * 请求体和 `/send` 一样（`request` / `apiId` / `environmentId` / `mockBase`），多一个
 * `load: { concurrency, mode, count, durationSec, rampUpSec, timeoutMs, okStatus }`。
 *
 * **只在本机网关上挂这个路由**（`ctx.localSend` 为真）。从团队共用的云端服务器上压测
 * 别人的接口风险太大：出口是被压方日志里的那个 IP、打的又是内网地址，出事所有人一起背。
 * 所以云端**不管 `APILOOP_SERVER_SEND` 开没开都不挂**（收到就是 404），前端靠
 * 「页面是不是从网关上打开的」决定入口灰不灰。
 *
 * 准备阶段（`prepare`）出的错、参数越界、已经有一个压测在跑 —— 这些都在**开始写流之前**
 * 按普通 JSON 返回；一旦 `ndjson.start` 过，就只剩事件了。
 */

var express = require('express');

var respond = require('./respond');
var dto = require('./dto');
var guardModule = require('./guard');
var sendApi = require('./send');
var ndjson = require('./ndjson');
var loadRunner = require('../load-runner');

/** 一个进程同时只允许一个压测：两个压测互相抢连接，量出来的数谁也不准 */
var running = false;
/** 正在跑的那个压测的取消句柄（`/load/stop` 用） */
var currentController = null;

function createRouter(ctx) {
    var router = express.Router();

    // 云端（不是本机网关）：这个 router 什么都不挂
    if (!ctx.localSend) return router;

    var g = guardModule.createGuard(ctx);
    var preparer = sendApi.createPreparer(ctx);

    router.post('/projects/:pid/load', g.guard('viewer', g.byPid), function (req, res) {
        if (running) {
            return respond.fail(res, 409, '已经有一个压测在跑，等它结束再开始');
        }

        var project = req.project;
        var body = req.body || {};

        var checked = loadRunner.normalizeLoad(body.load);
        if (checked.error) return respond.fail(res, 400, checked.error);

        if (!dto.plainObject(body.request)) return respond.fail(res, 400, '缺少 request');

        /**
         * 准备好的请求。和「发送」共用同一份 prepare —— 变量分层、鉴权继承、
         * 公共请求头、保密值这些规则只有一处，压测不另写一套。
         *
         * `cookies: false`：压测不读写 Cookie。并发几百个请求共用一个 cookie jar，
         * 光是互相覆盖就够乱了，量出来的数没有意义（要带就自己在请求头里写）。
         * `scripts: false`：脚本一跑，「响应时间」量到的就是脚本跑多久。
         */
        var prepared;
        try {
            prepared = preparer.prepare({ user: req.user, role: req.role }, project, {
                apiId: body.apiId,
                environmentId: body.environmentId,
                mockBase: body.mockBase,
                request: body.request,
                options: { scripts: false, cookies: false, skipHistory: true }
            }, {});
        } catch (err) {
            var status = Number(err && err.status);
            if (Number.isFinite(status) && status >= 400 && status < 600) {
                return respond.fail(res, status, err.message, err.code);
            }
            console.error('[load]', err && err.stack ? err.stack : err);
            return respond.fail(res, 500, '服务端出错：' + ((err && err.message) || '未知错误'));
        }

        var fileRoots = preparer.sendFileRoots(project);

        var controller = new AbortController();
        res.on('close', function () {
            // 响应还没写完就断了，说明浏览器走了：在途的全部取消，后面不再发
            if (!res.writableEnded) controller.abort();
        });

        running = true;
        currentController = controller;
        ndjson.start(res);

        loadRunner.runLoad({
            prepared: prepared,
            load: checked.value,
            signal: controller.signal,
            fileRoots: fileRoots,
            onEvent: function (event) { ndjson.write(res, event); }
        }).then(function () {
            if (!res.writableEnded) res.end();
        }).catch(function (err) {
            /**
             * 执行器承诺「永远 resolve」，走到这里说明是我们自己的 bug。流已经开了，
             * 没法改成 500，只能发一条 done 让前端不要一直转圈。
             */
            console.error('[load] 压测跑挂了', err && err.stack ? err.stack : err);
            ndjson.write(res, {
                type: 'done',
                status: 'error',
                summary: null,
                warning: '压测出错：' + ((err && err.message) || '未知错误')
            });
            if (!res.writableEnded) res.end();
        }).finally(function () {
            // 无论如何都要把闸门放开：卡在 true 的话之后每次压测都是 409
            running = false;
            if (currentController === controller) currentController = null;
        });

        return undefined;
    });

    /**
     * 停止正在跑的压测。
     *
     * 界面上的「停止」走这里，**不是直接断开连接**：断开的话服务端停是停了，可最后那条
     * `done`（汇总表、状态码分布、错误分组）就发不回来了 —— 按时长跑时提前停是常事，
     * 停下来正是要看「到这儿为止」的汇总。这里只 abort，收尾和 `done` 照常走上面那条流。
     */
    router.post('/projects/:pid/load/stop', g.guard('viewer', g.byPid), function (req, res) {
        var had = Boolean(currentController);
        if (currentController) currentController.abort();
        respond.ok(res, { stopped: had });
    });

    return router;
}

module.exports = {
    createRouter: createRouter
};
