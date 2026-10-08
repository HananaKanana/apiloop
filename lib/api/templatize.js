/**
 * 智能模板化接口（契约第 8 节）。
 *
 * 纯计算，不写库：把 JSON 文本里的「可以随机化的值」换成 {{@...}} 占位符，
 * 返回替换清单给前端展示、让用户确认。规则本身在 lib/templatize.js。
 */

var express = require('express');

var respond = require('./respond');
var templatizeModule = require('../templatize');
var i18n = require('../i18n');

function createRouter() {
    var router = express.Router();

    router.post('/templatize', respond.wrap(function (req, res) {
        var text = (req.body || {}).body;
        if (typeof text !== 'string') {
            throw respond.apiError(400, i18n.m('body 必须是字符串'));
        }

        var result = templatizeModule.templatize(text);
        respond.ok(res, {
            body: result.body,
            replacements: result.replacements,
            skipped: result.skipped
        });
    }));

    return router;
}

module.exports = {
    createRouter: createRouter
};
