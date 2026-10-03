/**
 * 同步引擎（L3 Task 2，设计稿 5.2）。
 *
 * 一轮 = 拉取（Task 2）→ 推送（Task 3）。这个文件只管**什么时候跑**、**跑的状态**，
 * 具体做什么在 `pull.js` / `push.js` 里。
 *
 * 什么时候跑（设计稿 5.2 最后一条，**只在已登录时**）：
 *
 *   - 登录之后（`manager.onChange` 会通知）；
 *   - 网关启动时；
 *   - 每 30 秒一次；
 *   - 连不上云端时改成每 10 秒试一次，一连上立刻恢复 30 秒。
 *
 * **同一时间只跑一轮**：跑的时候又被触发，就记下来，等这一轮结束再跑一次。
 *
 * 云端回 401 = 会话过期：`manager.markExpired()`，本机照常能用（状态栏显示「登录已过期」）。
 * 云端回 410 = 变更记录被清理了：这个 Task 先把 `lastError` 设成「需要重新下载」，
 * 真正的处理（另存本机改动 + 全量重下）在 Task 3。
 */

var cloud = require('../cloud');
var pull = require('./pull');
var push = require('./push');
var secrets = require('./secrets');
var apply = require('./apply');

var PERIOD_ONLINE = 30000;
var PERIOD_OFFLINE = 10000;

/** 本机写入之后隔多久触发一轮：几次连着改合成一次 */
var LOCAL_WRITE_DELAY = 2000;

var ERROR_RESET = '需要重新下载';

/**
 * @param {{manager: object, getCloudUrl: Function, log?: Function}} options
 * @returns {{kick: Function, status: Function, close: Function, periods: object}}
 */
function createSyncEngine(options) {
    var manager = options.manager;
    var getCloudUrl = options.getCloudUrl || function () { return ''; };
    var log = options.log || function () {};

    var state = {
        running: false,
        online: false,
        pending: 0,
        conflicts: 0,
        lastSyncAt: null,
        lastError: null,
        /**
         * 本机数据被同步改过就加一（拉下来新行、删了行、合并、被云端覆盖……）。
         * 页面盯着它，一变就重新加载项目列表和目录树 —— 不然别的电脑推上去的项目要重开
         * apiloop 才看得到（用户 2026-10-01：Windows 显示已同步，项目却没出来）。
         */
        dataVersion: 0
    };

    var timer = null;
    var queued = false;
    var closed = false;

    /** 正在跑一轮：这期间本机库的写入都是同步引擎自己写的，不该再触发一轮 */
    var applying = false;
    /** 这一轮进行中用户真的改了东西 —— 跑完要再排一轮（N1） */
    var changedWhileApplying = false;
    /** 本机写入的合并计时器 */
    var changeTimer = null;
    /** 已经挂上监听的 handle（切空间时要换） */
    var attached = null;
    /** 「云端还不支持保密值同步」只记一次日志，别每 30 秒刷一遍（第 7 节） */
    var secretsUnsupportedLogged = false;

    function currentSpace() {
        return manager.current();
    }

    /**
     * 本机库被改动 → 隔 2 秒同步一轮（设计稿 5.2）。
     *
     * 事件带 `projectId`：**引擎自己写库一律传 `projectId: null`**（应用云端的行、
     * 镜像成员表……），那些不该再触发一轮；不排掉就是「同步 → 写库 → 触发同步 → 写库」
     * 的死循环。
     *
     * 但用户在本轮进行中保存的修改**带的是真实 projectId**（N1）：不能直接丢掉，
     * 否则他要么等到 30 秒后的定时那一轮，要么一直等下去。记一个标记，这一轮结束就排下一轮。
     */
    function onLocalChange(payload) {
        if (closed) return;

        if (applying) {
            if ((payload && payload.projectId) || (payload && payload.external)) changedWhileApplying = true;
            return;
        }

        if (changeTimer) clearTimeout(changeTimer);
        changeTimer = setTimeout(function () {
            changeTimer = null;
            kick('本机写入');
        }, LOCAL_WRITE_DELAY);
        if (changeTimer.unref) changeTimer.unref();
    }

    /** 把监听挂到当前空间的库上；切空间时换一份 */
    function attach() {
        var space = currentSpace();
        var handle = space ? space.handle : null;
        if (handle === attached) return;

        if (attached) attached.events.removeListener('change', onLocalChange);
        attached = handle;
        if (attached) attached.events.on('change', onLocalChange);
    }

    /** 待同步和冲突数每次都现算 —— 本机随时在改，缓存下来只会看到过期的数字 */
    function refreshCounts() {
        var space = currentSpace();
        if (!space) {
            state.pending = 0;
            state.conflicts = 0;
            return;
        }
        try {
            state.pending = apply.pendingCount(space.handle);
            state.conflicts = apply.conflictCount(space.handle);
        } catch (err) {
            log('统计待同步行数失败：' + ((err && err.message) || err));
        }
    }

    function status() {
        refreshCounts();
        return {
            running: state.running,
            online: state.online,
            pending: state.pending,
            conflicts: state.conflicts,
            lastSyncAt: state.lastSyncAt,
            lastError: state.lastError,
            dataVersion: state.dataVersion,
            expired: manager.isExpired()
        };
    }

    /**
     * 包一层云端的调用：`cloud.requestJson` 是「有没有响应」这一层的抽象，
     * 这里再往上一步，把非 2xx 变成带 `status` 的异常，调用方只要看状态码。
     *
     * **只有这一层的失败才是「连不上」**，所以给它打上 `offline` 标记 —— 后面
     * （应用快照、写库）出的错跟网络没关系，报成「连不上云端」会把排查引到错的方向。
     */
    function client(cloudUrl, cookie) {
        function call(method, path, body) {
            return cloud.requestJson({
                cloudUrl: cloudUrl,
                path: '/__admin/api' + path,
                method: method,
                headers: { cookie: cookie },
                body: body
            }).then(function (answer) {
                if (answer.status >= 200 && answer.status < 300) return answer.json || {};

                var message = (answer.json && answer.json.error) || ('云端返回 ' + answer.status);
                var err = new Error(message);
                err.status = answer.status;
                err.code = answer.json && answer.json.code;
                throw err;
            }, function (err) {
                if (err) err.offline = true;
                throw err;
            });
        }

        return {
            get: function (path) { return call('GET', path); },
            post: function (path, body) { return call('POST', path, body); }
        };
    }

    /** 把这一轮的失败归一下类：网断了、会话过期、要重新下载，还是本机这边出错 */
    function classify(err, cloudUrl) {
        if (err && err.offline === true) {
            state.online = false;
            state.lastError = cloud.cloudDownMessage(cloudUrl, err);
            log('同步：' + state.lastError);
            return;
        }

        if (err && err.status === 401) {
            // 会话不能用了。**本机照常能用**，只是不同步 —— 状态栏会显示「登录已过期」
            state.online = true;
            state.lastError = '登录已过期';
            manager.markExpired();
            log('同步：云端说会话已过期');
            return;
        }

        if (err && err.status === 410) {
            state.online = true;
            state.lastError = ERROR_RESET;
            log('同步：' + ERROR_RESET);
            return;
        }

        if (err && err.status) {
            state.online = true;
            state.lastError = (err && err.message) || ('云端返回 ' + err.status);
            log('同步失败：' + state.lastError);
            return;
        }

        // 云端是通的，是本机处理这一轮时出的错（写库、应用快照……）
        state.online = true;
        state.lastError = '同步出错：' + ((err && err.message) || err);
        log('同步出错：' + ((err && err.stack) || err));
    }

    function schedule() {
        if (closed) return;
        if (timer) clearTimeout(timer);

        var period = state.online ? PERIOD_ONLINE : PERIOD_OFFLINE;
        timer = setTimeout(function () {
            timer = null;
            kick('定时');
        }, period);
        // 网关要能退出：这个定时器不该把进程钉住（purge 那边也是这么做的）
        if (timer.unref) timer.unref();
    }

    function run(reason) {
        var cloudUrl = getCloudUrl();
        var space = currentSpace();
        var cookie = manager.cloudCookie();

        if (!cloudUrl || !cookie || !space) {
            schedule();
            return;
        }

        state.running = true;
        applying = true;

        var clientForRound = client(cloudUrl, cookie);

        pull.runPull({
            handle: space.handle,
            cloud: clientForRound,
            userId: space.user ? space.user.id : null,
            // 一轮是异步的，中途可能被「登录别的账号」把空间切走 —— 那一轮直接作废，
            // 不要拿一个已经关掉的 handle 继续写
            isCurrent: function () { return manager.current() === space; }
        }).then(function (pullSummary) {
            pullSummary.warnings.forEach(function (line) { log('同步：' + line); });

            // 一轮 = 拉取 → 推送（设计稿 5.2）
            return push.runPush({ handle: space.handle, cloud: clientForRound })
                .then(function (pushSummary) {
                    logPush(pushSummary);
                    return { pull: pullSummary, push: pushSummary };
                });
        }).then(function (out) {
            /**
             * 保密值（第 7 节）：普通拉推做完之后，再单独同步一遍**自己的**保密值
             * （`lib/gateway/sync/secrets.js`，先拉后推）。它自己吞掉 404 / 网络错误，
             * 不影响上面两段的结果；切空间时它会抛 `stale`，这一轮照样作废。
             */
            return secrets.runSecrets({
                handle: space.handle,
                cloud: clientForRound,
                userId: space.user ? space.user.id : null,
                isCurrent: function () { return manager.current() === space; }
            }).then(function (secretsSummary) {
                logSecrets(secretsSummary);
                out.secrets = secretsSummary;
                return out;
            });
        }).then(function (out) {
            state.online = true;
            state.lastError = out.push.errors.length ? out.push.errors[0] : null;
            state.lastSyncAt = Date.now();
            if (out.pull.applied || out.pull.deleted) {
                log('同步完成（' + reason + '）：拉下来 ' + out.pull.applied + ' 行、删 ' +
                    out.pull.deleted + ' 行，推上去 ' + out.push.pushed + ' 行');
            }

            /**
             * 自动合并过的行还留在待同步里，等下一轮才推得上去。
             * 不等那 30 秒 —— 直接排一轮，把合并结果接着送出去。
             * 合并过的行推上去之后就是 `ok`，不会无限循环。
             */
            if (out.pull.merged || out.push.merged) queued = true;

            var pull = out.pull;
            var push = out.push;
            if (pull.applied || pull.deleted || pull.merged || pull.conflicts || pull.dropped ||
                (pull.removedProjects && pull.removedProjects.length) ||
                push.merged || push.conflicts || push.forbidden || push.recreated ||
                // 保密值拉下来了几行 → 页面上的变量值要重新读一遍
                (out.secrets && out.secrets.pulled)) {
                state.dataVersion++;
            }
        }, function (err) {
            if (err && err.stale === true) {
                log('同步：这一轮开始时那个空间已经不是当前空间了，作废');
                return;
            }
            classify(err, cloudUrl);
        }).then(function () {
            state.running = false;
            applying = false;
            refreshCounts();
            attach();
            schedule();

            // 本轮进行中用户保存过东西（N1）：立刻再跑一轮，别让他等 30 秒
            if (changedWhileApplying) {
                changedWhileApplying = false;
                queued = true;
            }

            if (queued) {
                queued = false;
                kick('排队的一轮');
            }
        });
    }

    function logPush(summary) {
        summary.warnings.forEach(function (line) { log('同步：' + line); });
        if (summary.failed) {
            log('同步：有 ' + summary.failed + ' 行云端不收（' + summary.errors[0] + '）');
        }
    }

    /**
     * 保密值那一步的结果（第 7 节）。
     *
     * 404 = 云端还是旧版本、没有这两个接口：**只记一次**（每 30 秒刷一遍日志没人受得了），
     * 这一部分先跳过，普通同步照常。网络不通时上面已经报过「连不上云端」，这里不重复。
     */
    function logSecrets(summary) {
        if (!summary) return;

        if (summary.unsupported) {
            if (secretsUnsupportedLogged) return;
            secretsUnsupportedLogged = true;
            log('同步：云端还不支持保密值同步（接口不存在），这一部分先跳过');
            return;
        }
        if (summary.error && !summary.offline) {
            log('同步：保密值这一步失败：' + summary.error);
        }
    }

    /**
     * 让引擎跑一轮。没登录、没配云端地址就直接返回 —— 调用方不需要自己判断。
     */
    function kick(reason) {
        if (closed) return;

        // 退出登录、还没登录：不同步。本机的修改照样记在 changes 里，下次登录推上去
        if (manager.state() !== 'signedIn') return;

        attach();

        if (state.running) {
            queued = true;
            return;
        }

        run(reason || '触发');
    }

    function close() {
        closed = true;
        if (timer) clearTimeout(timer);
        timer = null;
        if (changeTimer) clearTimeout(changeTimer);
        changeTimer = null;
        if (attached) attached.events.removeListener('change', onLocalChange);
        attached = null;
    }

    return {
        kick: kick,
        status: status,
        close: close,
        // 自测脚本要按它算「多久之内应该恢复同步」
        periods: { online: PERIOD_ONLINE, offline: PERIOD_OFFLINE, localWrite: LOCAL_WRITE_DELAY }
    };
}

module.exports = {
    createSyncEngine: createSyncEngine,
    PERIOD_ONLINE: PERIOD_ONLINE,
    PERIOD_OFFLINE: PERIOD_OFFLINE,
    LOCAL_WRITE_DELAY: LOCAL_WRITE_DELAY,
    ERROR_RESET: ERROR_RESET
};
