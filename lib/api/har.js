/**
 * HAR 导入接口（契约第 13 节）。
 *
 * 解析在 `lib/har.js`，写库复用 Postman 导入那套（`lib/api/import-collection.js`）——
 * 这里只负责「解析、决定导到哪里、拼响应」。
 *
 * **请求体上限**：这两个路径是 50MB（在 `lib/admin.js` 里单独挂了解析器），
 * 因为 HAR 经常几十 MB；管理台其他接口仍然是 4MB。
 *
 * 权限和 Postman 的 collection 导入完全一致：`new` 谁都能用（导完自己是 owner），
 * `into` 要 editor，且「项目不存在」和「不是成员」返回同一个 400 —— 都走
 * `import-collection.js` 的 `resolveTargetProject`，不另写一份。
 */

var express = require('express');

var respond = require('./respond');
var dto = require('./dto');
var importCollectionModule = require('./import-collection');
var har = require('../har');
var projectsRepo = require('../db/repos/projects');
var i18n = require('../i18n');

function createRouter(ctx) {
    var handle = ctx.handle;
    var router = express.Router();

    var importer = importCollectionModule.createCollectionImporter(ctx);

    function parseText(text, options) {
        if (!text || !String(text).trim()) {
            throw respond.apiError(400, i18n.m('请粘贴 HAR 文件内容'));
        }
        try {
            return har.parse(text, options);
        } catch (err) {
            // 贴错了东西不是服务端出错，原样转成 400
            throw respond.apiError(400, err.message);
        }
    }

    function optionsOf(body) {
        var options = (body || {}).options;
        return { keepCredentials: Boolean(options && options.keepCredentials === true) };
    }

    /* ---------------------------------------------------------- 预览 */

    router.post('/import/har/preview', respond.wrap(function (req, res) {
        var body = req.body || {};
        var parsed = parseText(body.text, optionsOf(body));

        // 只是看一眼，不写库
        respond.ok(res, {
            name: parsed.name,
            stats: parsed.stats,
            warnings: parsed.warnings.slice()
        });
    }));

    /* ---------------------------------------------------------- 导入 */

    router.post('/import/har', respond.wrap(function (req, res) {
        var body = req.body || {};
        var parsed = parseText(body.text, optionsOf(body));
        var mode = body.mode === 'into' ? 'into' : 'new';

        var written = importer.importCollection(req, parsed.collection, mode);

        respond.ok(res, {
            project: dto.toProjectDto(projectsRepo.getById(handle, written.project.id), ctx, req.user),
            stats: parsed.stats,
            warnings: parsed.warnings.concat(written.warnings)
        });
    }));

    return router;
}

module.exports = {
    createRouter: createRouter
};
