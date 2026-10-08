/**
 * 导出接口文档（第九轮第 2 节）。
 *
 * `GET /projects/:pid/export/doc?format=md|html|docx&folderId=&examples=1&mock=0&doneOnly=0`
 *
 * 三种格式的内容和打码规则完全一致（都走 `lib/export-doc.js`，数据来自分享文档页那份），
 * 区别只在渲染。**直接回文件**（`Content-Disposition: attachment`），不是 JSON ——
 * 前端拿到的就是能存下来的东西，不用再在浏览器里拼 Blob。
 *
 * 读的是本机库，所以网关上照常挂，不用转云端。
 */

var express = require('express');

var respond = require('./respond');
var dto = require('./dto');
var guardModule = require('./guard');
var exportDoc = require('../export-doc');
var foldersRepo = require('../db/repos/folders');
var i18n = require('../i18n');

var FORMATS = ['md', 'html', 'docx'];
var CONTENT_TYPES = {
    md: 'text/markdown; charset=utf-8',
    html: 'text/html; charset=utf-8',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
};

function createRouter(ctx) {
    var handle = ctx.handle;
    var router = express.Router();

    var g = guardModule.createGuard(ctx);
    var guard = g.guard;
    var byPid = g.byPid;

    /** 目录 id 必须属于这个项目（不然会导出到别人的目录上去） */
    function resolveFolderId(projectId, value) {
        if (value === undefined || value === null || value === '') return null;

        var folderId = dto.str(value);
        var folder = foldersRepo.get(handle, folderId);
        if (!folder || folder.projectId !== projectId) {
            throw respond.apiError(400, i18n.m('目录不存在或不属于这个项目'));
        }
        return folderId;
    }

    router.get('/projects/:pid/export/doc', guard('viewer', byPid), function (req, res) {
        var query = req.query || {};
        var format = FORMATS.indexOf(dto.str(query.format)) > -1 ? dto.str(query.format) : 'md';

        var doc;
        try {
            doc = exportDoc.buildDoc(handle, ctx, {
                project: req.project,
                folderId: resolveFolderId(req.project.id, query.folderId),
                mockBase: dto.str(query.mockBase),
                options: {
                    // 默认：带示例响应、不带 Mock 地址、不按状态过滤
                    examples: query.examples === undefined ? true : query.examples !== '0',
                    mock: query.mock === '1' || query.mock === 'true',
                    doneOnly: query.doneOnly === '1' || query.doneOnly === 'true'
                }
            });
        } catch (err) {
            return respond.fail(res, Number(err && err.status) || 500, (err && err.message) || i18n.m('导出失败'), err && err.code);
        }

        if (!doc || !doc.stats.apis) {
            return respond.fail(res, 400, i18n.m('这个范围里没有接口，没什么可导出的'));
        }

        var name = exportDoc.fileName(req.project.name, format);
        var encoded = encodeURIComponent(name);

        function send(body) {
            res.status(200);
            res.setHeader('Content-Type', CONTENT_TYPES[format]);
            // filename 用 ASCII 兜底、filename* 给中文名（老浏览器只认前者）
            res.setHeader('Content-Disposition',
                'attachment; filename="doc.' + format + '"; filename*=UTF-8\'\'' + encoded);
            res.setHeader('Cache-Control', 'no-store');
            res.send(body);
        }

        if (format === 'docx') {
            // 这个包用到时才 require（计划第 0 节：云端 / 网关启动时不该加载文档库）
            return exportDoc.renderDocx(doc).then(function (buffer) {
                send(buffer);
            }).catch(function (err) {
                console.error('[export-doc] 生成 Word 失败：' + ((err && err.stack) || err));
                if (!res.headersSent) respond.fail(res, 500, i18n.m('生成 Word 失败：{reason}', { reason: (err && err.message) || err }));
            });
        }

        send(format === 'html' ? exportDoc.renderHtml(doc) : exportDoc.renderMarkdown(doc));
        return undefined;
    });

    return router;
}

module.exports = {
    createRouter: createRouter
};
