/**
 * 安装包下载（G3 Task2，设计稿第 5 节）。
 *
 * 网页版只能发本机以外的请求；要访问用户自己电脑所在的网段，必须在用户机器上跑一个
 * 本地网关（`lib/gateway/`）。那个网关的安装包由这里的
 * 两个接口发出去。
 *
 * 两个接口的**登录要求刻意不一样**：
 * - `GET /__admin/api/downloads`（列目录）挂在 `requireLogin` 之后，要登录；
 * - `GET /__admin/downloads/:name`（真下载）**不要求登录** —— 下载链接要能直接发给
 *   同事（安装包不是私密数据，它本来就是要发给每个用的人的）。
 *
 * 安装包放在 `<数据目录>/downloads/`。Docker 部署时数据目录挂的就是宿主机的 `./data`，
 * 所以把 .pkg 丢进 `./data/downloads/` 就行，不用重新构建镜像。
 */

var express = require('express');
var fs = require('fs');
var path = require('path');

var appInfo = require('../app-info');
var respond = require('./respond');
var i18n = require('../i18n');

/**
 * 只认这种文件名，别的一律不列、也不能下。
 *
 * - Mac：`apiloop-gateway-<版本>-<arm64|x64>.pkg`，`agent-installer/mac/build.sh` 的产物；
 * - Windows：`apiloop-gateway-<版本>-win-x64.exe`，`agent-installer/windows/build.sh` 的产物。
 *
 * 版本号固定三段数字（和 package.json 的 version 一致）。第 2 组是「列表里的那一格」：
 * `arm64` / `x64` 是 Mac 的两种芯片，`win-x64` 是 Windows。
 *
 * **这条正则既是「列表的过滤器」也是「下载的白名单」**：`..`、`/`、`%2F` 这些
 * 想读别的文件的花招都进不了这个形状。
 */
var FILE_PATTERN = /^apiloop-gateway-(\d+\.\d+\.\d+)-(?:(arm64|x64)\.pkg|(win-x64)\.exe)$/;

/** 列出来的顺序：Apple 芯片在前（绝大多数人下这个），Windows 最后 */
var ARCH_ORDER = ['arm64', 'x64', 'win-x64'];

/** 安装包目录。目录不存在时列表返回空，不报错（还没传过包是正常状态） */
function downloadsDir() {
    return path.join(appInfo.DATA_DIR, 'downloads');
}

/** 三段数字按数值比大小；相等返回 0 */
function compareVersion(a, b) {
    var left = String(a).split('.');
    var right = String(b).split('.');
    for (var i = 0; i < 3; i++) {
        var l = Number(left[i]) || 0;
        var r = Number(right[i]) || 0;
        if (l !== r) return l - r;
    }
    return 0;
}

/**
 * 列出可下载的安装包。
 *
 * 同名架构有多个版本时**只列最新的那一个** —— 用户要的是「装哪个」，不是版本历史；
 * 列表里出现两个 arm64 只会让人犹豫。旧文件留在磁盘上不影响（想直接下也下不了，
 * 因为下载走的是同一份列表）。
 *
 * @returns {Array<{name: string, platform: string, arch: string, version: string, size: number}>}
 */
function listFiles(dir) {
    var names;
    try {
        names = fs.readdirSync(dir);
    } catch (err) {
        return [];  // 目录不存在 / 没权限：当成「还没有上传安装包」
    }

    var newest = {};
    names.forEach(function (name) {
        var matched = FILE_PATTERN.exec(name);
        if (!matched) return;

        var version = matched[1];
        var arch = matched[2] || matched[3];
        var stat;
        try {
            stat = fs.statSync(path.join(dir, name));
        } catch (err) {
            return;
        }
        if (!stat.isFile()) return;
        if (!newest[arch] || compareVersion(version, newest[arch].version) > 0) {
            newest[arch] = {
                name: name,
                platform: arch === 'win-x64' ? 'windows' : 'mac',
                arch: arch,
                version: version,
                size: stat.size
            };
        }
    });

    return ARCH_ORDER.filter(function (arch) {
        return Boolean(newest[arch]);
    }).map(function (arch) {
        return newest[arch];
    });
}

/**
 * 要登录的那一半：列目录。
 *
 * @param {{version?: string}} ctx `version` 是**云端自己**的版本（前端拿它和网关的版本比，
 *   不一致就提示「有新版本」）。
 */
function createRouter(ctx) {
    var router = express.Router();

    router.get('/downloads', respond.wrap(function (req, res) {
        respond.ok(res, {
            version: (ctx && ctx.version) || '',
            files: listFiles(downloadsDir())
        });
    }));

    return router;
}

/**
 * **不需要登录**的那一半：下载。
 *
 * 安全性靠「名字必须正好是列表里的一个」这一条：列表来自 `readdirSync`，里面全是
 * 真实存在的目录项，不可能带路径分隔符；不在列表里的（`../`、编码过的斜杠、
 * 别的文件）一律 404，而且**文案统一**，不区分「不存在」和「不允许」——
 * 免得成了探测文件是否存在的工具。
 */
function createDownloadRouter() {
    var router = express.Router();

    router.get('/:name', function (req, res) {
        var name = String(req.params.name || '');
        var dir = path.resolve(downloadsDir());

        function notFound() {
            respond.fail(res, 404, i18n.m('安装包不存在'));
        }

        var allowed = listFiles(dir).map(function (item) { return item.name; });
        if (allowed.indexOf(name) === -1) return notFound();

        // 双保险。名字来自 readdir，本来就不可能有路径分隔符；但这是整个管理台里
        // **唯一一个不需要登录**的接口，多一行判断换「想不到的来源也读不到别的文件」。
        var full = path.resolve(dir, name);
        if (path.dirname(full) !== dir) return notFound();

        // res.download 会带上 Content-Disposition: attachment，浏览器直接存盘
        res.download(full, name, function (err) {
            if (!err) return;
            // 传输中途出错（客户端断开、文件恰好被删）：能改状态码就改，不能就断开
            if (res.headersSent) return res.destroy();
            return notFound();
        });
    });

    return router;
}

module.exports = {
    createRouter: createRouter,
    createDownloadRouter: createDownloadRouter,
    listFiles: listFiles,
    downloadsDir: downloadsDir,
    FILE_PATTERN: FILE_PATTERN
};
