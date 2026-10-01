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
var apply = require('./apply');

var PERIOD_ONLINE = 30000;
var PERIOD_OFFLINE = 10000;

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
        lastError: null
    };

    var timer = null;
    var queued = false;
    var closed = false;

    function currentSpace() {
        return manager.current();
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

        pull.runPull({
            handle: space.handle,
            cloud: client(cloudUrl, cookie),
            userId: space.user ? space.user.id : null,
            // 一轮是异步的，中途可能被「登录别的账号」把空间切走 —— 那一轮直接作废，
            // 不要拿一个已经关掉的 handle 继续写
            isCurrent: function () { return manager.current() === space; }
        }).then(function (summary) {
            state.online = true;
            state.lastError = null;
            state.lastSyncAt = Date.now();

            summary.warnings.forEach(function (line) { log('同步：' + line); });
            if (summary.applied || summary.deleted) {
                log('同步完成（' + reason + '）：应用 ' + summary.applied + ' 行，删除 ' + summary.deleted + ' 行');
            }
        }, function (err) {
            if (err && err.stale === true) {
                log('同步：这一轮开始时那个空间已经不是当前空间了，作废');
                return;
            }
            classify(err, cloudUrl);
        }).then(function () {
            state.running = false;
            refreshCounts();
            schedule();

            if (queued) {
                queued = false;
                kick('排队的一轮');
            }
        });
    }

    /**
     * 让引擎跑一轮。没登录、没配云端地址就直接返回 —— 调用方不需要自己判断。
     */
    function kick(reason) {
        if (closed) return;

        // 退出登录、还没登录：不同步。本机的修改照样记在 changes 里，下次登录推上去
        if (manager.state() !== 'signedIn') return;

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
    }

    return {
        kick: kick,
        status: status,
        close: close,
        // 自测脚本要按它算「多久之内应该恢复同步」
        periods: { online: PERIOD_ONLINE, offline: PERIOD_OFFLINE }
    };
}

module.exports = {
    createSyncEngine: createSyncEngine,
    PERIOD_ONLINE: PERIOD_ONLINE,
    PERIOD_OFFLINE: PERIOD_OFFLINE,
    ERROR_RESET: ERROR_RESET
};
