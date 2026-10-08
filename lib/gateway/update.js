/**
 * 一键更新（2026-10-01 用户：「版本不一致提示更新，点了之后下载新版本并安装」）。
 *
 * 流程：前端点「立即更新」→ `start(版本)` → 从云端 `/__admin/downloads/<安装包>` 下载
 * （下载不用登录）→ 下完交给系统安装：
 *   - **Mac**：`open xxx.pkg`，弹出系统的安装程序，用户输一次密码（装在系统目录里）。
 *     postinstall 会重启网关、重新打开壳子。
 *   - **Windows**：`xxx.exe /update` 静默安装（装在用户自己的目录，不要管理员）。
 *     安装程序自己会退掉旧的网关和窗口、换文件、再拉起来。
 *
 * 安装包名字和打包脚本、云端的下载白名单（`lib/api/downloads.js`）是同一套：
 *   Mac `apiloop-gateway-<版本>-<arm64|x64>.pkg`，Windows `apiloop-gateway-<版本>-win-x64.exe`。
 *
 * 状态给 `/__apiloop/status` 的 `update` 字段，前端靠它画进度条。
 */

var fs = require('fs');
var os = require('os');
var path = require('path');
var http = require('http');
var https = require('https');
var childProcess = require('child_process');

var appInfo = require('../app-info');
var cloud = require('./cloud');
var i18n = require('../i18n');

/** 下载超时：多久一个字节都没收到就算断了 */
var IDLE_TIMEOUT_MS = 30000;

/**
 * Windows 上打开安装程序遇到 EBUSY 时重试几次、隔多久（2026-10-02 用户遇到「spawn EBUSY」）。
 * 刚下载好的 exe 常被杀毒软件（Defender）扫描时锁住几秒，这时 CreateProcess 报共享冲突。
 */
var SPAWN_RETRIES = 10;
var SPAWN_RETRY_MS = 1000;

/**
 * 这台机器该装哪个安装包。不支持的平台返回 null（前端就不给「立即更新」按钮）。
 *
 * @param {string} version
 * @returns {string|null}
 */
function installerName(version, platform, arch) {
    platform = platform || process.platform;
    arch = arch || process.arch;
    if (!/^\d+\.\d+\.\d+$/.test(String(version || ''))) return null;

    if (platform === 'darwin' && (arch === 'arm64' || arch === 'x64')) {
        return 'apiloop-gateway-' + version + '-' + arch + '.pkg';
    }
    // Windows 只出 x64 一种：ARM 的 Windows 会用自带的模拟跑 x64
    if (platform === 'win32') return 'apiloop-gateway-' + version + '-win-x64.exe';
    return null;
}

/** `a` 比 `b` 新吗（三段数字按数值比；格式不对一律当「不新」） */
function isNewer(a, b) {
    var pattern = /^\d+\.\d+\.\d+$/;
    if (!pattern.test(String(a || '')) || !pattern.test(String(b || ''))) return false;
    var left = String(a).split('.').map(Number);
    var right = String(b).split('.').map(Number);
    for (var i = 0; i < 3; i++) {
        if (left[i] !== right[i]) return left[i] > right[i];
    }
    return false;
}

/** 下载放哪：Mac 的缓存目录、Windows 的本地应用数据目录，别的平台临时目录 */
function cacheDir() {
    if (process.platform === 'darwin') {
        return path.join(os.homedir(), 'Library', 'Caches', appInfo.APP_NAME, 'updates');
    }
    if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
        return path.join(process.env.LOCALAPPDATA, appInfo.APP_NAME, 'updates');
    }
    return path.join(os.tmpdir(), appInfo.APP_NAME + '-updates');
}

/**
 * @param {{getCloudUrl: function(): string, log: function(string)}} options
 */
function createUpdater(options) {
    var log = options.log || function () {};

    /** idle | downloading | installing | error */
    var state = { state: 'idle', version: '', received: 0, total: 0, error: '' };
    var current = null;   // 正在进行的请求，用来防重复

    function status() {
        return {
            supported: Boolean(installerName('0.0.0')),
            state: state.state,
            version: state.version,
            received: state.received,
            total: state.total,
            error: state.error
        };
    }

    function fail(message) {
        state.state = 'error';
        state.error = message;
        current = null;
        log('更新失败：' + message);
    }

    /**
     * 开始下载并安装 `version`。正在下载时再点一次直接返回现在的状态。
     *
     * @returns {{ok: boolean, error?: string}}
     */
    function start(version) {
        if (state.state === 'downloading') return { ok: true };

        var name = installerName(version);
        if (!name) return { ok: false, error: i18n.m('这个系统还不支持自动更新，请手动下载安装包') };

        var base = cloud.parseCloudUrl(options.getCloudUrl() || '');
        if (!base) return { ok: false, error: i18n.m('没有云端地址，没法下载新版本') };

        var dir = cacheDir();
        try {
            fs.mkdirSync(dir, { recursive: true });
        } catch (err) {
            return { ok: false, error: i18n.m('建不了下载目录 {dir}：{reason}', { dir: dir, reason: err.message }) };
        }

        var target = path.join(dir, name);
        var partial = target + '.part';

        state = { state: 'downloading', version: version, received: 0, total: 0, error: '' };
        log('开始下载新版本 ' + name);

        var transport = base.protocol === 'https:' ? https : http;
        var request = transport.request({
            protocol: base.protocol,
            hostname: base.hostname,
            port: base.port || (base.protocol === 'https:' ? 443 : 80),
            method: 'GET',
            path: '/__admin/downloads/' + encodeURIComponent(name),
            headers: { host: base.host }
        }, function (res) {
            if (res.statusCode === 404) {
                res.resume();
                return fail(i18n.m('云端还没有放 {version} 版的安装包（{name}），请联系管理员', { version: version, name: name }));
            }
            if (res.statusCode !== 200) {
                res.resume();
                return fail(i18n.m('下载失败：云端返回 {status}', { status: res.statusCode }));
            }

            state.total = Number(res.headers['content-length']) || 0;
            var out = fs.createWriteStream(partial);

            res.on('data', function (chunk) { state.received += chunk.length; });
            res.on('error', function (err) { out.destroy(); fail(i18n.m('下载中断：{reason}', { reason: err.message })); });
            out.on('error', function (err) { request.destroy(); fail(i18n.m('写不进下载目录：{reason}', { reason: err.message })); });
            // 等 'close' 而不是 'finish'：finish 时数据写完了，但文件句柄还没关，
            // Windows 上紧接着去运行这个 exe 会报 spawn EBUSY（2026-10-02 用户遇到）
            out.on('close', function () {
                if (state.state !== 'downloading') return;
                // 长度对不上说明半路断了（服务端没报错、连接却提前收了尾）
                if (state.total && state.received !== state.total) {
                    return fail(i18n.m('下载不完整（{received} / {total} 字节），请重试', { received: state.received, total: state.total }));
                }
                try {
                    fs.renameSync(partial, target);
                } catch (err) {
                    return fail(i18n.m('下载好了但存不下来：{reason}', { reason: err.message }));
                }
                install(target);
            });
            res.pipe(out);
        });

        request.setTimeout(IDLE_TIMEOUT_MS, function () {
            request.destroy(new Error(i18n.m('超过 {n} 秒没有收到数据', { n: IDLE_TIMEOUT_MS / 1000 })));
        });
        request.on('error', function (err) {
            if (state.state === 'downloading') fail(i18n.m('连不上云端：{reason}', { reason: err.message }));
        });
        request.end();
        current = request;

        return { ok: true };
    }

    /** 下好了，交给系统装 */
    function install(file) {
        current = null;
        state.state = 'installing';
        launch(file, 0);
    }

    /** 打开安装程序；Windows 上文件被锁（EBUSY）时隔一秒再试，见 SPAWN_RETRIES */
    function launch(file, attempt) {
        function onError(err) {
            var busy = err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES');
            if (process.platform === 'win32' && busy && attempt < SPAWN_RETRIES) {
                log('安装程序暂时被占用（' + err.code + '），' + SPAWN_RETRY_MS + 'ms 后重试');
                setTimeout(function () { launch(file, attempt + 1); }, SPAWN_RETRY_MS);
                return;
            }
            fail(i18n.m('打不开安装程序：{reason}', {
                reason: (err && err.message) || err
            }) + (busy
                ? i18n.m('。可能被杀毒软件锁住了，请稍后再点一次，或手动运行 {file}', { file: file })
                : ''));
        }

        try {
            var child;
            if (process.platform === 'darwin') {
                // 系统安装程序是独立进程，网关被 postinstall 重启也不影响它
                child = childProcess.spawn('open', [file], { detached: true, stdio: 'ignore' });
            } else {
                // Windows：静默安装。安装程序会先退掉本网关，所以必须 detached，不能当子进程。
                // cwd 不能继承网关的（安装目录下的 app\）：当前目录会占着那个文件夹，安装程序删不掉它
                child = childProcess.spawn(file, ['/update'], {
                    cwd: path.dirname(file), detached: true, stdio: 'ignore', windowsHide: true
                });
            }
            child.on('error', onError);
            child.on('spawn', function () { log('已打开安装程序 ' + file); });
            child.unref();
        } catch (err) {
            onError(err);
        }
    }

    function close() {
        if (current) current.destroy();
        current = null;
    }

    return { start: start, status: status, close: close };
}

module.exports = {
    createUpdater: createUpdater,
    installerName: installerName,
    isNewer: isNewer,
    cacheDir: cacheDir
};
