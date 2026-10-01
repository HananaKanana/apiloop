/**
 * 网关的本机发送（G1，设计稿第 3.3 节）。
 *
 * 一次发送在这里被拆成三跳：
 *
 *   ① 向云端要上下文  POST <云端>/__admin/api/projects/:pid/send/prepare
 *   ② **在本机把请求发出去**  lib/send-core.js（和云端自己发送时是同一份实现）
 *   ③ 把结果交给云端    POST <云端>/__admin/api/projects/:pid/send/record
 *
 * 为什么非得这么绕：macOS 15 之后没有苹果签名的程序访问不了同网段地址（D0 实测），
 * 而官方 Node 由 launchd 启动时能拿到本地网络授权 —— 所以「读库、写库」留在云端，
 * 「发请求」挪到用户自己的电脑上。变量、继承的鉴权、脚本、Cookie、代理、上传的文件、
 * 历史一样都不能少，所以 ① 要带的东西比 G0 多得多。
 *
 * 事件流（`head` / `chunk` / `end`）和云端 `/send/stream` **完全一致**，前端不用改。
 */

var fs = require('fs');
var path = require('path');
var StringDecoder = require('string_decoder').StringDecoder;

var ndjson = require('../api/ndjson');
var executor = require('../executor');
var sendCore = require('../send-core');
var cloud = require('./cloud');

/** 私有网段：第一次访问这些地址被系统拦下时，错误信息要换成授权提示 */
var PRIVATE_PATTERNS = [
    /^10\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^192\.168\./,
    /^169\.254\./
];

/** 设计稿第 3.3 节的那段提示，第一次访问局域网必然会看到它 */
var LOCAL_NETWORK_HINT = '请求失败：系统还没有允许 node 访问本地网络。' +
    '请在系统弹出的「本地网络」授权框中点「允许」，然后重新发送。' +
    '如果没看到弹框，到「系统设置 → 隐私与安全性 → 本地网络」里把 node 打开。';

/** 和 `lib/api/send.js` 里同名的那个函数一样：从 `[[k, v]]` 里按头名取值 */
function headerValue(pairs, name) {
    if (!Array.isArray(pairs)) return '';

    var lower = String(name).toLowerCase();
    for (var i = 0; i < pairs.length; i++) {
        if (String(pairs[i][0]).toLowerCase() === lower) return pairs[i][1];
    }
    return '';
}

/**
 * 从错误信息里取出**实际连出去的那个地址**（G0 审阅 N5）。
 *
 * 只看 URL 里写的是不是私有 IP 是不够的：`http://dev.lan` 这种主机名解析到
 * 192.168.x.x，URL 上看不出来，而系统照样会拦。执行器把底层错误原样放在消息里
 * （形如 `connect EHOSTUNREACH 192.168.17.3:8080`），从那儿取才准。
 */
function hostFromError(message) {
    var matched = /EHOSTUNREACH[^\dA-Za-z]*(\[[0-9a-fA-F:]+\]|(?:\d{1,3}\.){3}\d{1,3})/
        .exec(String(message || ''));
    if (!matched) return null;
    return matched[1].replace(/^\[/, '').replace(/\]$/, '');
}

/** 这个地址是不是私有网段（含 IPv6 的环回、唯一本地、链路本地） */
function isPrivateAddress(host) {
    var value = String(host || '');
    if (!value) return false;

    if (value.indexOf(':') > -1) {
        var lower = value.toLowerCase();
        if (lower === '::1') return true;
        return /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower);
    }

    return PRIVATE_PATTERNS.some(function (pattern) { return pattern.test(value); });
}

/**
 * 把 `prepared.files` 落到本机的临时目录里，并把 spec 里引用到的路径改成落下来的那个。
 *
 * 三个要点：
 * - **保持文件名的最后一段**：form-data 用 `path.basename(src)` 当文件名发出去，
 *   改了它目标收到的文件名就不一样了。所以一个文件一个子目录，同名也不冲突；
 * - 这个目录是本次发送**唯一**的 `fileRoots`：页面没法借它读本机的其它文件；
 * - **一个文件都没有也照样建**这个空目录 —— `fileRoots` 传空数组等于不限制，
 *   那才是真的把本机文件开放给页面了。
 *
 * @returns {{dir: string, map: Object<string,string>}}
 */
function stageFiles(prepared, tmpRoot) {
    var files = (prepared.files && prepared.files.map) || {};
    var keys = Object.keys(files);

    fs.mkdirSync(tmpRoot, { recursive: true });
    var dir = fs.mkdtempSync(path.join(tmpRoot, 'send-'));

    var map = {};
    keys.forEach(function (raw, index) {
        var bucket = path.join(dir, String(index));
        fs.mkdirSync(bucket, { recursive: true });

        var name = path.basename(String(raw));
        if (!name || name === '.' || name === '..') name = 'file';

        var target = path.join(bucket, name);
        fs.writeFileSync(target, Buffer.from((files[raw] && files[raw].base64) || '', 'base64'));
        map[raw] = target;
    });

    return { dir: dir, map: map };
}

/** 把 spec 里的文件路径换成临时目录里的那份（键就是用户在 spec 里写的原文） */
function rewriteFilePaths(spec, map) {
    var body = (spec && spec.body) || {};

    if (body.mode === 'formdata') {
        (body.form || []).forEach(function (row) {
            if (!row || row.kind !== 'file') return;
            var next = map[row.src];
            if (next) row.src = next;
        });
        return;
    }

    if (body.mode === 'binary' && body.file) {
        var target = map[body.file.src];
        if (target) body.file.src = target;
    }
}

/**
 * 造本机发送的处理函数。
 *
 * @param {{getCloudUrl: Function, dataDir: string, log: Function}} options
 * @returns {Function} `(req, res, body) => void`，body 已经解析成 JSON 对象
 */
function createLocalSend(options) {
    var getCloudUrl = options.getCloudUrl;
    var dataDir = options.dataDir;
    var log = options.log || function () {};

    var tmpRoot = path.join(dataDir, 'tmp');

    return function localSend(req, res, body) {
        var cloudUrl = getCloudUrl();
        if (!cloudUrl) {
            res.status(503).json({ error: '网关还没有配置云端地址' });
            return;
        }

        var apiBase = '/__admin/api/projects/' + encodeURIComponent(req.params.pid);
        var prepareRequest = null;
        var controller = new AbortController();
        var stagedDir = null;

        // 浏览器断开：掐断还在飞的 prepare，取消本机在途的请求。
        // **record 不取消** —— 历史照样要写，和云端那条路一致。
        res.on('close', function () {
            if (prepareRequest) prepareRequest.destroy();
            if (!res.writableEnded) controller.abort();
        });

        /** 临时文件**一定**要删掉：成功、失败、取消都不例外 */
        function cleanup() {
            if (!stagedDir) return;
            try {
                fs.rmSync(stagedDir, { recursive: true, force: true });
            } catch (err) {
                log('清理临时目录失败 ' + stagedDir + '：' + err.message);
            }
            stagedDir = null;
        }

        function failJson(status, payload) {
            if (res.headersSent) {
                if (!res.writableEnded) res.end();
                return;
            }
            res.status(status).json(payload);
        }

        /** ③ 把结果交给云端。失败不算发送失败：页面照样拿到结果，只是历史没存上 */
        function recordOnCloud(prepared, outcome) {
            return cloud.requestJson({
                cloudUrl: cloudUrl,
                path: apiBase + '/send/record',
                method: 'POST',
                headers: req.headers,
                body: {
                    apiId: prepared.apiId,
                    environmentId: prepared.environmentId,
                    requesting: prepared.requesting,
                    resolvedAuth: outcome.resolvedAuth,
                    result: outcome.result,
                    changes: outcome.changes
                }
            }).then(function (answer) {
                if (answer.status !== 200 || !answer.json || answer.json.ok !== true) {
                    var reason = (answer.json && answer.json.error) ||
                        ('云端返回 ' + answer.status);
                    return { error: reason };
                }
                return { historyId: answer.json.historyId, scripts: answer.json.scripts };
            }, function (err) {
                return { error: cloud.cloudDownMessage(cloudUrl, err) };
            });
        }

        /** ② 本机执行 + ③ 记录，事件流从这里开始 */
        function runOnLocal(prepared) {
            var decoder = new StringDecoder('utf8');
            var textResponse = false;
            var controls = null;
            var waitingForDrain = false;

            /**
             * 写一段 chunk；写不进去就把上游按停（背压）。
             * 和云端那份一样**只按一次** —— 重复 pause / resume 会让 drain 的配对错位。
             */
            function writeChunk(payload) {
                if (ndjson.write(res, payload)) return;
                if (waitingForDrain || !controls) return;

                waitingForDrain = true;
                controls.pause();
                res.once('drain', function () {
                    waitingForDrain = false;
                    controls.resume();
                });
            }

            var hooks = {
                signal: controller.signal,
                fileRoots: [stagedDir],
                // 前置脚本跑完、请求将要发出的那一刻才开流式 —— 和云端同一个时机
                onReady: function () { ndjson.start(res); },
                onHead: function (head, headControls) {
                    controls = headControls;
                    textResponse = executor.isTextContentType(
                        headerValue(head.response.headers, 'content-type'));

                    ndjson.write(res, {
                        type: 'head',
                        response: head.response,
                        redirects: head.redirects
                    });
                },
                onChunk: function (buffer) {
                    if (textResponse) {
                        writeChunk({ type: 'chunk', text: decoder.write(buffer) });
                        return;
                    }
                    writeChunk({ type: 'chunk', base64: Buffer.from(buffer).toString('base64') });
                }
            };

            return sendCore.run(prepared, hooks).then(function (outcome) {
                // 先按本机的结果把脚本状态挂上：即使云端记不上，页面也该看到测试结果
                outcome.result.scripts = outcome.changes.scriptState;

                /**
                 * 第一次访问局域网必然失败：授权框还没被点掉，内核直接回 EHOSTUNREACH。
                 * 只看「连不上」用户没法自救，所以把错误信息换成明确指引（G0 审阅 N5：
                 * 网段判断用的是**实际连出去的那个地址**，不是 URL 里写的那个）。
                 */
                if (outcome.result.error &&
                    /EHOSTUNREACH/.test(String(outcome.result.error.message || ''))) {
                    var actual = hostFromError(outcome.result.error.message);
                    if (isPrivateAddress(actual)) {
                        outcome.result.error.message = LOCAL_NETWORK_HINT;
                        outcome.result.error.localNetworkHint = true;
                    }
                }

                return recordOnCloud(prepared, outcome).then(function (saved) {
                    if (saved.error) {
                        // 请求已经发出去了，页面照样拿结果；只是历史与变量没存上
                        outcome.result.recordError = '历史和变量没有保存到云端：' + saved.error;
                    } else {
                        outcome.result.scripts = saved.scripts;
                    }

                    if (textResponse) {
                        var tail = decoder.end();
                        if (tail) ndjson.write(res, { type: 'chunk', text: tail });
                    }

                    ndjson.write(res, {
                        type: 'end',
                        result: outcome.result,
                        historyId: saved.error ? null : saved.historyId
                    });
                    if (!res.writableEnded) res.end();
                });
            });
        }

        /* ------------------------------------------------ ① 向云端要上下文 */

        cloud.requestJson({
            cloudUrl: cloudUrl,
            path: apiBase + '/send/prepare',
            method: 'POST',
            headers: req.headers,
            body: body || {},
            onRequest: function (request) { prepareRequest = request; }
        }).then(function (answer) {
            if (answer.status !== 200 || !answer.json || !answer.json.prepared) {
                // 云端明确回了错误（400/413/401 都算）：状态码和文案原样转给页面。
                // 这时还没开始写 NDJSON，页面能按普通 JSON 错误处理。
                failJson(answer.status || 502,
                    answer.json || { error: '云端返回了无法识别的内容' });
                return undefined;
            }

            var prepared = answer.json.prepared;
            var staged = stageFiles(prepared, tmpRoot);
            stagedDir = staged.dir;
            rewriteFilePaths(prepared.spec, staged.map);

            return runOnLocal(prepared).catch(function (err) {
                log('本机发送失败：' + ((err && err.message) || err));
                if (!res.headersSent) {
                    return failJson(500, { error: '服务端出错：' + ((err && err.message) || '未知错误') });
                }
                if (!res.writableEnded) res.end();
                return undefined;
            });
        }).catch(function (err) {
            // 连不上云端：给一句能自救的话，别让页面一直转圈
            failJson(502, { error: cloud.cloudDownMessage(cloudUrl, err) });
        }).then(cleanup, cleanup);
    };
}

module.exports = {
    createLocalSend: createLocalSend,
    stageFiles: stageFiles,
    rewriteFilePaths: rewriteFilePaths,
    hostFromError: hostFromError,
    isPrivateAddress: isPrivateAddress,
    headerValue: headerValue,
    LOCAL_NETWORK_HINT: LOCAL_NETWORK_HINT
};
