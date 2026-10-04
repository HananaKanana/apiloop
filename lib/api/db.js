/**
 * 数据库连接（第九轮第 3 节）。
 *
 * 只有一条路由：**测试连接**。连接本身是项目级设置，跟着 `PUT /projects/:pid`
 * 一起走（`extra.databases`），不在这里单独增删改 —— 少一套接口就少一处权限要判。
 *
 * **只在本机网关上挂**（`ctx.localSend`）。这个接口会拿着项目里存的库密码去连一台
 * 真实数据库：从团队共用的云端服务器上做这件事，等于让云端替所有人去连生产库；
 * 而且「能不能连上」本来就取决于**谁在连**，云端试出来的结果对用户没有意义
 * （`lib/api/load.js` 是同一个理由）。云端连路由都没有，直接 404。
 */

var express = require('express');

var respond = require('./respond');
var dto = require('./dto');
var guardModule = require('./guard');
var dbOps = require('../db-ops');
var sendApi = require('./send');

function createRouter(ctx) {
    var router = express.Router();

    if (!ctx.localSend) return router;

    var g = guardModule.createGuard(ctx);
    var preparer = sendApi.createPreparer(ctx);

    router.post('/projects/:pid/databases/test',
        g.guard('editor', g.byPid),
        respond.wrap(function (req, res) {
            var body = dto.plainObject(req.body) || {};
            var input = dto.plainObject(body.connection);
            if (!input) throw respond.apiError(400, '缺少 connection');

            // 名字可以还没填（用户先在弹窗里试一下能不能连上，再决定存不存）
            var connection = dbOps.toDatabase(input, { allowEmptyName: true });
            if (!connection) {
                throw respond.apiError(400, '连接配置不完整：类型只能是 MySQL / PostgreSQL / Redis');
            }

            // 连接的每个字段都能写 {{变量}}，替换用的和发送时是同一张表
            var vars = preparer.databaseVars(req, req.project, body.environmentId).vars;

            var statement = connection.type === 'redis' ? 'PING' : 'SELECT 1';

            dbOps.run({ statement: statement }, connection, vars, {}).then(function (outcome) {
                respond.ok(res, {
                    ok: outcome.ok,
                    timeMs: outcome.timeMs,
                    // 密码一个字都不回给前端 —— 它刚从请求体里来，没必要再原样送回去
                    error: outcome.error || null
                });
            }).catch(function (err) {
                // `wrap` 只兜同步抛出的异常，`.then` 里出的错得自己接住
                console.error('[db] 测试连接出错', err && err.stack ? err.stack : err);
                respond.fail(res, 500, '服务端出错：' + ((err && err.message) || '未知错误'));
            });
        }));

    return router;
}

module.exports = { createRouter: createRouter };
