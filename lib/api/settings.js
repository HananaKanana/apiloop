/**
 * 系统设置接口（契约第 12 节的代理部分）。
 *
 * 目前只有代理一项，而且是**全局**的：代理是「这台机器怎么出去」的事，
 * 跟项目没关系。所以这里不挂项目 guard，改成「读要登录、写要管理员」——
 * 改代理等于把所有人的请求都指到另一个地址去，不该是随便谁都能动的。
 *
 * 出口一律 `mask()`：代理地址里的密码连管理员也不回显，只显示 `***`，
 * 改密码时提交同样的 `***` 表示「保持不变」。
 */

var express = require('express');

var respond = require('./respond');
var dto = require('./dto');
var auth = require('../auth');
var proxySettings = require('../proxy-settings');

function createRouter(ctx) {
    var handle = ctx.handle;
    var router = express.Router();

    router.get('/settings/proxy', respond.wrap(function (req, res) {
        respond.ok(res, { proxy: proxySettings.mask(proxySettings.get(handle)) });
    }));

    router.put('/settings/proxy', auth.requireAdmin, respond.wrap(function (req, res) {
        var input = dto.plainObject((req.body || {}).proxy);
        if (!input) throw respond.apiError(400, '缺少 proxy');

        var saved = proxySettings.set(handle, input);
        respond.ok(res, { proxy: proxySettings.mask(saved) });
    }));

    return router;
}

module.exports = {
    createRouter: createRouter
};
