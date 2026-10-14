/**
 * 页面静态资源压缩着发（用户 2026-10-13：网页版首次打开更快）。
 *
 * 前端产物（lib/web）原来由 express.static 原样发出去，主包好几 MB，网页版第一次打开
 * 全靠带宽硬扛。这里在 express.static 前面挡一层：浏览器声明能收 gzip、请求的又是
 * js / css / html / svg / json，就发压缩过的（一般只有原来的三分之一）。
 *
 * - 压缩结果按「路径 + 修改时间 + 大小」缓存在内存里，同一个文件只压一次；产物一共几 MB，缓存不大。
 * - `__apiloop/` 下的文件名带内容哈希，内容变了名字就变，可以让浏览器缓存一年；
 *   index.html 每次都要回来问（不然升级以后还拿着旧页面、去要已经不存在的旧文件）。
 * - 不认识的、不存在的、目录、范围请求，一律 `next()` 交还给 express.static，行为和原来一样。
 */

var fs = require('fs');
var path = require('path');
var zlib = require('zlib');

var TYPES = {
    '.js': 'application/javascript; charset=UTF-8',
    '.mjs': 'application/javascript; charset=UTF-8',
    '.css': 'text/css; charset=UTF-8',
    '.html': 'text/html; charset=UTF-8',
    '.svg': 'image/svg+xml',
    '.json': 'application/json; charset=UTF-8'
};

/** 太小的不值得压 */
var MIN_SIZE = 1024;
var IMMUTABLE_DIR = '__apiloop';

/**
 * @param {string} root 静态资源目录（lib/web）
 * @param {{index?: string}} [options] `index`：请求的是 `/` 时发哪个文件；不给就不管 `/`
 */
function createGzipStatic(root, options) {
    var base = path.resolve(root);
    var index = options && options.index;
    var cache = new Map();

    return function gzipStatic(req, res, next) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        if (req.headers.range) return next();
        if (!/\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) return next();

        var pathname;
        try {
            pathname = decodeURIComponent(String(req.path || '/'));
        } catch (err) {
            return next();
        }
        if (pathname === '/' || pathname === '') {
            if (!index) return next();
            pathname = '/' + index;
        }
        if (pathname.indexOf('\0') !== -1) return next();

        var type = TYPES[path.extname(pathname).toLowerCase()];
        if (!type) return next();

        // 只发 root 里面的文件：../ 之类的拼出去以后不在 root 下就不管
        var full = path.resolve(base, '.' + pathname);
        if (full.indexOf(base + path.sep) !== 0) return next();

        fs.stat(full, function (statErr, stat) {
            if (statErr || !stat.isFile() || stat.size < MIN_SIZE) return next();

            var key = full + '|' + stat.mtimeMs + '|' + stat.size;
            var hit = cache.get(full);
            if (hit && hit.key === key) return send(hit.body);

            fs.readFile(full, function (readErr, raw) {
                if (readErr) return next();
                zlib.gzip(raw, { level: 9 }, function (zipErr, body) {
                    if (zipErr) return next();
                    cache.set(full, { key: key, body: body });
                    send(body);
                });
            });

            function send(body) {
                var relative = path.relative(base, full).split(path.sep);
                res.setHeader('Content-Type', type);
                res.setHeader('Content-Encoding', 'gzip');
                res.setHeader('Vary', 'Accept-Encoding');
                res.setHeader('Content-Length', body.length);
                res.setHeader('Cache-Control', relative[0] === IMMUTABLE_DIR
                    ? 'public, max-age=31536000, immutable'
                    : 'no-cache');
                res.setHeader('Last-Modified', stat.mtime.toUTCString());
                if (req.method === 'HEAD') return res.end();
                res.end(body);
            }
        });
    };
}

module.exports = createGzipStatic;
