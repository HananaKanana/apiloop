/**
 * 响应体的临时文件（第十七轮 T38）。
 *
 * 接口返回图片、Excel、PDF 这类非文本内容时，执行器内存里只留 5 MB
 * （`lib/executor.js` 的 `DEFAULT_MAX_BODY_BYTES`），超出的部分截断 —— 页面拿这份内容
 * 「保存」下来的文件是坏的。所以执行器在读响应流的时候**另开一路**，把**完整**内容
 * （解压之后的，和页面上看到的一致）写进这里的临时文件；页面再用
 * `GET /response-files/:id` 取回去。
 *
 * 生命周期（需求 J7）：
 *   1. 每个文件保留 1 小时，过期之后下载一律 404；
 *   2. 每个用户最多 20 个，登记第 21 个时删掉他最早的那个；
 *   3. **进程启动时把整个目录清空** —— 登记表只在内存里，上一次运行留下的文件谁也取不到，
 *      留着只是白占磁盘。这一步放在**模块第一次加载**时做（不去动 `lib/gateway/`）。
 *
 * 目录在 `<APILOOP_HOME>/tmp/response-files/`（`APILOOP_HOME` 就是 `appInfo.DATA_DIR`）。
 *
 * 文件和登记表是两回事：**先写文件、写完才登记**。写失败（磁盘满、被取消、请求出错）
 * 就把半截文件删掉、不登记，结果里也就没有 `fileId` —— 页面照样能显示响应，只是下载不了。
 */

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var appInfo = require('./app-info');

/** 一个文件保留多久 */
var TTL_MS = 60 * 60 * 1000;

/** 每个用户最多留几个 */
var MAX_PER_USER = 20;

/** 单个文件上限：超过的部分不再写，结果里给 `fileTruncated: true` */
var MAX_BYTES = 200 * 1024 * 1024;

/**
 * 多久扫一遍过期的文件。
 *
 * 到点的那一刻正好有人在下载也算过期（`metaOf` 里还会再判一次），这个定时器只是
 * 保证没人来下载的文件也会被清掉 —— 否则目录会一直涨到下一次重启。
 */
var SWEEP_MS = 5 * 60 * 1000;

/** 目录：第一次真要写文件时才建（模块加载时只负责清空） */
function dir() {
    return path.join(appInfo.DATA_DIR, 'tmp', 'response-files');
}

var dirReady = false;

function ensureDir() {
    if (dirReady) return true;

    try {
        fs.mkdirSync(dir(), { recursive: true });
        dirReady = true;
        return true;
    } catch (err) {
        console.error('[apiloop] 建响应临时文件目录失败：' + ((err && err.message) || err));
        return false;
    }
}

/**
 * 登记表：`fileId → { fileId, userId, path, fileName, contentType, size, truncated,
 * createdAt, expiresAt }`。**只在内存里** —— 进程一重启就谁也下载不到了（文件本身也会被清掉）。
 *
 * 用 `Object.create(null)` 是因为键是**外面传进来的** fileId：普通对象上 `constructor`、
 * `__proto__` 这些名字会命中原型链上的东西，查表时就会莫名其妙地「命中」。
 */
var entries = Object.create(null);

/**
 * 清空整个目录，并把登记表清掉。
 *
 * 删不掉只打日志、不抛：目录不存在（第一次跑）或者上一次的进程还占着，都不该让服务起不来。
 *
 * 注意：这个模块被 `lib/executor.js` 引着，所以**任何**加载到执行器的进程都会清一次目录
 * （云端、网关、CLI 都是）。CLI 和网关共用 `APILOOP_HOME` 时，CLI 那一下会把正在跑的
 * 网关的临时文件删掉，那些 fileId 就提前 404 了 —— 这是「启动时清空」这条规则本身的代价，
 * 换来的是磁盘上永远不会攒下垃圾。
 */
function clear() {
    try {
        fs.rmSync(dir(), { recursive: true, force: true });
    } catch (err) {
        console.error('[apiloop] 清空响应临时文件目录失败：' + ((err && err.message) || err));
    }

    dirReady = false;
    entries = Object.create(null);
}

/* ---------------------------------------------------------------- 文件名 */

/**
 * 从 `Content-Disposition` 里取出文件名，取不到就是 null。
 *
 * 三种写法都要认（RFC 6266）：
 *   - `filename*=UTF-8''%E6%8A%A5%E8%A1%A8.xlsx`：百分号编码，**优先用它**（它才是
 *     国际化的那个字段，`filename=` 只是给老客户端的兜底）；
 *   - `filename="报表.xlsx"`：服务端直接发 UTF-8 字节的，见 `decodeHeaderText`；
 *   - `filename="report.xlsx"`：纯 ASCII，两种解都一样。
 *
 * 取出来的名字**只留文件名本身**（`filename="../../.ssh/id_rsa"` 这种不能让它的路径部分
 * 参与后面的任何事）。
 */
function fileNameFrom(disposition) {
    var text = String(disposition === undefined || disposition === null ? '' : disposition);
    if (!text) return null;

    var params = parseParams(text);
    var extended = null;
    var plain = null;

    params.forEach(function (pair) {
        if (pair[0] === 'filename*' && extended === null) {
            extended = decodeExtended(pair[1]);
        } else if (pair[0] === 'filename' && plain === null) {
            plain = decodeHeaderText(unquote(pair[1]));
        }
    });

    var name = extended || plain;
    if (!name) return null;

    return baseName(name);
}

/**
 * `key=value; key2=value2` 拆成 `[[key, value]]`，key 一律小写。
 *
 * 引号里的分号不算分隔符 —— `filename="a;b.txt"` 是一个参数。引号不配对时按「都在引号里」
 * 处理，最后交给 `baseName` 收拾，反正结果只会是一个文件名。
 */
function parseParams(value) {
    var parts = [];
    var current = '';
    var quoted = false;

    for (var i = 0; i < value.length; i++) {
        var ch = value.charAt(i);

        if (ch === '"') quoted = !quoted;
        if (ch === ';' && !quoted) {
            parts.push(current);
            current = '';
            continue;
        }
        current += ch;
    }
    parts.push(current);

    var params = [];
    parts.forEach(function (part) {
        var at = part.indexOf('=');
        if (at < 0) return;
        params.push([part.slice(0, at).trim().toLowerCase(), part.slice(at + 1).trim()]);
    });
    return params;
}

/**
 * 去掉一层双引号。
 *
 * 从开引号取到**下一个引号为止**（而不是只看首尾两个字符）：同一个响应头出现两次时
 * （`attachment; filename="a.txt", attachment; filename="b.txt"`），Node 会把两个值拼成
 * 一个字符串交给这里 —— 取第一个引号对里的内容，正好就是第一个文件名。
 */
function unquote(value) {
    var text = String(value);
    if (text.charAt(0) !== '"') return text;

    var end = text.indexOf('"', 1);
    return end === -1 ? text.slice(1) : text.slice(1, end);
}

/**
 * `filename*` 的值：`UTF-8''%E6%8A%A5%E8%A1%A8.xlsx` → `报表.xlsx`。
 *
 * 只认 UTF-8（别的字符集按约定不管），认不出来（格式不对、百分号编码坏了）返回 null，
 * 调用方退回 `filename=`。
 */
function decodeExtended(value) {
    var text = unquote(value);
    var parts = text.split("'");

    if (parts.length < 3) return null;
    if (String(parts[0]).toLowerCase().replace('utf8', 'utf-8') !== 'utf-8') return null;

    try {
        // 语言标签（中间那一段）按约定忽略；值里本身可能有 `'`，所以剩下的全部拼回去
        return decodeURIComponent(parts.slice(2).join("'"));
    } catch (err) {
        return null;
    }
}

/**
 * `filename=` 里的中文。
 *
 * Node 解析响应头时按 **latin1** 解字节，所以服务端发的 UTF-8 中文到这里是乱码
 * （`报表.xlsx` 变成 `æ¥è¡¨.xlsx`）。按 latin1 收回字节、再按 UTF-8 解一次就还原了；
 * 解不出来（`\ufffd`）说明本来就不是 UTF-8（纯 ASCII，或者真的按 latin1 发的），
 * 那就原样用。
 */
function decodeHeaderText(value) {
    var text = String(value);
    if (!text) return text;

    var decoded = Buffer.from(text, 'latin1').toString('utf8');
    return decoded.indexOf('\ufffd') === -1 ? decoded : text;
}

/**
 * 只留文件名：去掉路径（`/`、`\` 都算）、控制字符和首尾空白。
 *
 * 空名字、`.`、`..` 一律当没有 —— 它们既不是文件名，也不该出现在下载响应头里。
 */
function baseName(name) {
    var text = String(name === undefined || name === null ? '' : name);
    var cut = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
    if (cut > -1) text = text.slice(cut + 1);

    // eslint-disable-next-line no-control-regex
    text = text.replace(/[\u0000-\u001f\u007f]/g, '').trim();

    if (!text || text === '.' || text === '..') return null;
    return text;
}

/**
 * 没有 `Content-Disposition` 时下载用的名字：`response.<扩展名>`。
 *
 * 规则和页面上的 `web/src/components/response/BodyViewer.vue` 的 `downloadName()`
 * 保持一致 —— 常见类型查表，认不出来的图片拿子类型当扩展名，其余一律 `.bin`。
 */
var EXTENSIONS = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'image/bmp': 'bmp',
    'image/x-icon': 'ico',
    'image/vnd.microsoft.icon': 'ico',
    'image/avif': 'avif',
    'image/tiff': 'tiff',
    'application/json': 'json',
    'application/xml': 'xml',
    'text/xml': 'xml',
    'text/html': 'html',
    'text/plain': 'txt',
    'text/css': 'css',
    'text/csv': 'csv',
    'application/javascript': 'js',
    'text/javascript': 'js',
    'application/pdf': 'pdf',
    'application/zip': 'zip',
    'application/gzip': 'gz',
    'application/octet-stream': 'bin'
};

function fallbackName(contentType) {
    var type = String(contentType || '').toLowerCase().split(';')[0].trim();
    if (EXTENSIONS[type]) return 'response.' + EXTENSIONS[type];

    if (type.indexOf('image/') === 0) {
        var subtype = type.slice(6).split('+')[0].replace(/^x-/, '').replace(/[^a-z0-9]/g, '');
        if (subtype) return 'response.' + subtype;
    }
    return 'response.bin';
}

/**
 * 下载响应头里的 `Content-Disposition` 值。
 *
 * 中文文件名没法放进 `filename=`（老客户端按 latin-1 解，出来是乱码），所以按 RFC 5987
 * 再给一份 `filename*`：`filename=` 只留 ASCII 兜底。
 * 形状和 `lib/backup.js` 的 `disposition()` 一样 —— 那边发的是备份文件，这边是响应文件，
 * 两边各自成立，谁也不用引谁（`backup.js` 连着一堆读库的模块，执行器不该引它）。
 */
function contentDisposition(name) {
    var text = String(name);
    var ascii = text.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    return 'attachment; filename="' + ascii + '"; filename*=UTF-8\'\'' + encodeURIComponent(text);
}

/* ---------------------------------------------------------------- 登记表 */

function isExpired(meta) {
    return Date.now() >= meta.expiresAt;
}

function sameUser(meta, userId) {
    if (!meta.userId || !userId) return false;
    return String(meta.userId) === String(userId);
}

/** 删文件 + 去掉登记。文件已经不在了（被外面的清理删掉）不算错 */
function remove(meta) {
    delete entries[meta.fileId];
    try {
        fs.unlinkSync(meta.path);
    } catch (err) {
        // 已经没了
    }
}

/**
 * 取一个文件的登记信息。
 *
 * 三种情况一律返回 null：不存在、不是这个用户的、已经过期 —— 路由层对它们给同一个 404，
 * 别让人靠状态码试出「这个 id 存在」。
 */
function metaOf(fileId, userId) {
    var meta = entries[String(fileId === undefined || fileId === null ? '' : fileId)];
    if (!meta) return null;
    if (!sameUser(meta, userId)) return null;

    if (isExpired(meta)) {
        remove(meta);
        return null;
    }
    return meta;
}

/**
 * 每个用户最多 `MAX_PER_USER` 个：登记完新的之后，把他**最早**的删到只剩上限。
 *
 * 刚登记的这一个不算在候选里（同一毫秒建的两个文件靠 createdAt 分不出先后，
 * 按「先登记的先留」处理最省心）。
 */
function evictOldest(userId, keepId) {
    var mine = Object.keys(entries).map(function (key) {
        return entries[key];
    }).filter(function (meta) {
        return sameUser(meta, userId) && meta.fileId !== keepId;
    }).sort(function (a, b) {
        return a.createdAt - b.createdAt;
    });

    var over = mine.length + 1 - MAX_PER_USER;
    for (var i = 0; i < over && i < mine.length; i++) remove(mine[i]);
}

/** 扫一遍过期的。定时跑，另外每次下载时也会单独判一次 */
function sweep() {
    Object.keys(entries).forEach(function (key) {
        if (isExpired(entries[key])) remove(entries[key]);
    });
}

setInterval(sweep, SWEEP_MS).unref();

/* ---------------------------------------------------------------- 落文件 */

/**
 * 开一个「往临时文件写」的接收器。执行器每收到一段响应数据就 `write()` 一次。
 *
 * 背压：`write()` 返回 false 表示写不动了（写流自己攒的缓冲超过了 highWaterMark），
 * 调用方要把上游按停、等 `onceDrain()` 叫它再放行 —— 不然磁盘慢的时候整个响应会先攒在
 * 内存里，而这正是这个任务要解决的问题。`onceDrain` 在**写失败**时也会被叫一次，
 * 免得调用方一直停着。
 *
 * 收尾只有两条路：
 *   - `close(info, cb)`：等数据真的落盘（`'finish'`）再登记，`cb` 拿到 `{ fileId, size,
 *     truncated }`；写失败就是 `cb(null)`；
 *   - `abort()`：直接删掉、不登记（用户取消、响应出错、这次结果不要了）。
 *
 * @param {{userId: string}} options 谁的文件 —— 只有他能下载
 * @returns {object} sink
 */
function createSink(options) {
    var opts = options || {};
    var userId = opts.userId ? String(opts.userId) : null;

    var fileId = 'rf_' + crypto.randomBytes(12).toString('hex');
    var target = path.join(dir(), fileId + '.bin');

    var stream = null;
    var size = 0;
    var truncated = false;
    var broken = false;
    /** `close()` 已经调过：写流正在收尾，再写就是 write after end */
    var closing = false;
    var finished = false;
    var onClose = null;
    var drainWaiters = [];

    if (!ensureDir()) {
        broken = true;
    } else {
        try {
            stream = fs.createWriteStream(target);
            stream.on('error', function (err) {
                /**
                 * 磁盘满、权限不对……落文件失败**不该让这次发送失败**：删掉半截文件、
                 * 不登记，结果里没有 fileId，请求本身照常出结果。
                 */
                console.error('[apiloop] 写响应临时文件失败：' + ((err && err.message) || err));
                fail();
            });
            stream.on('drain', flushDrain);
        } catch (err) {
            console.error('[apiloop] 建响应临时文件失败：' + ((err && err.message) || err));
            broken = true;
        }
    }

    function flushDrain() {
        var waiters = drainWaiters;
        drainWaiters = [];
        waiters.forEach(function (cb) { cb(); });
    }

    /** 收尾只做一次：登记成功给 info，失败 / 被取消给 null */
    function settle(info) {
        if (finished) return;
        finished = true;

        flushDrain();
        if (onClose) {
            var cb = onClose;
            onClose = null;
            cb(info);
        }
    }

    /** 这次落文件作废：关掉写流、删掉文件、不登记 */
    function fail() {
        if (broken) return;
        broken = true;

        if (stream) {
            try { stream.destroy(); } catch (err) { /* 已经关了 */ }
        }
        try { fs.unlinkSync(target); } catch (err) { /* 还没建出来 */ }
        settle(null);
    }

    /** 登记：走到这里说明文件已经完整落在磁盘上了 */
    function register(info) {
        var now = Date.now();
        var meta = {
            fileId: fileId,
            userId: userId,
            path: target,
            fileName: (info && info.fileName) || null,
            contentType: (info && info.contentType) || 'application/octet-stream',
            size: size,
            truncated: truncated,
            createdAt: now,
            expiresAt: now + TTL_MS
        };

        entries[fileId] = meta;
        evictOldest(userId, fileId);

        return { fileId: fileId, size: size, truncated: truncated };
    }

    return {
        fileId: fileId,

        /**
         * 写一段。返回 false = 写不动了，调用方该把上游按停等 `onceDrain`。
         *
         * 超过 `MAX_BYTES` 的部分不再写（`truncated` 置 true），但**响应照样读完** ——
         * 和内存里那份截断的处理一样，`result.response.size` 仍是真实大小。
         */
        write: function (chunk) {
            if (finished || broken || closing || !stream || truncated) return true;

            var room = MAX_BYTES - size;
            var part = chunk.length > room ? chunk.subarray(0, room) : chunk;
            size += part.length;
            if (part.length < chunk.length) truncated = true;

            try {
                return stream.write(part);
            } catch (err) {
                console.error('[apiloop] 写响应临时文件失败：' + ((err && err.message) || err));
                fail();
                return true;
            }
        },

        /** 能写了（或者确定永远不会能写了）就叫它一次 */
        onceDrain: function (cb) {
            if (finished || broken) return cb();
            drainWaiters.push(cb);
        },

        /**
         * 收尾并登记。`info` 是这份文件自己的信息（`{ contentType, fileName }`），
         * 存进登记表供下载时用。
         */
        close: function (info, cb) {
            if (finished) return cb(null);
            if (broken || !stream) return cb(null);

            closing = true;
            onClose = cb;
            try {
                // end() 的回调在 'finish'（数据都交给内核了）时才触发 —— 不能提前登记，
                // 否则下载到的可能是半截文件
                stream.end(function () {
                    if (broken) return;      // 出错那条路已经 settle 过了
                    settle(register(info));
                });
            } catch (err) {
                fail();
            }
        },

        /** 不要这个文件了：删掉，不登记 */
        abort: function () {
            if (finished) return;
            broken = true;

            if (stream) {
                try { stream.destroy(); } catch (err) { /* 已经关了 */ }
            }
            try { fs.unlinkSync(target); } catch (err) { /* 还没建出来 */ }
            settle(null);
        }
    };
}

// 进程启动时清一次（见文件头第 3 条）
clear();

module.exports = {
    TTL_MS: TTL_MS,
    MAX_PER_USER: MAX_PER_USER,
    MAX_BYTES: MAX_BYTES,

    dir: dir,
    clear: clear,
    createSink: createSink,
    metaOf: metaOf,
    fileNameFrom: fileNameFrom,
    fallbackName: fallbackName,
    contentDisposition: contentDisposition
};
