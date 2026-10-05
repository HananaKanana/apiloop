/**
 * 云端自动备份（第十四轮）。
 *
 * 每天到点给**每个项目**写一份备份到数据目录下的 `backups/<项目ID>/<yyyyMMdd-HHmmss>.json`。
 * 三件事：
 *
 *   - 内容是 `lib/backup.js` 的 `build`（和手动导出的是同一份）；
 *   - **内容和上一份一样就不写**（按项目内容 hash，不含 `exportedAt` 这种每次都变的字段）；
 *   - 超过 `keepDays` 的删掉；项目已经删掉的，它的目录在保留期过后一起删。
 *
 * **只在云端跑**：网关不跑（本机是同步的一端，自动备份是云端这个「中心」的事）。
 * 启动点在 `lib/command.js` 的 `startChangePurge` 旁边 —— 那边本来就是「云端是唯一的
 * 清道夫」那套每日清理。
 *
 * 设置（`{ enabled, hour, keepDays }`）存在 `meta` 表的 `backup` 键里，和代理设置
 * 同一个存法（见 `lib/proxy-settings.js`）：库里有就用库里的，没有就用默认值
 * （默认关闭 —— 「默默开始往磁盘上写文件」不该是默认行为）。
 *
 * 定时器用 `setTimeout` **链**（每次算下一次的毫秒数），不是每分钟轮询；定时器
 * `unref()` 过，不拦着进程退出。
 */

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var backup = require('./backup');
var projectsRepo = require('./db/repos/projects');

/** 默认值：关闭、凌晨 3 点、留 14 天 */
var DEFAULTS = { enabled: false, hour: 3, keepDays: 14 };

/** 备份文件名的形状（也是列表 / 下载接口认的 id）：`20261005-030000` */
var FILE_ID = /^\d{8}-\d{6}$/;

var META_KEY = 'backup';

/** 已经启动的定时器：设置改了要立刻按新的 hour 重排，不用等它先烧掉一轮 */
var liveSchedulers = new Set();

/* ------------------------------------------------------------------ 设置 */

function clamp(value, min, max, fallback) {
    var num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.min(max, Math.max(min, Math.round(num)));
}

/** 缺省 / 超界都收拾成合法值：`hour` 0–23、`keepDays` 1–90 */
function normalize(patch, current) {
    var base = current || DEFAULTS;
    var input = patch || {};

    return {
        enabled: input.enabled === undefined ? base.enabled === true : input.enabled === true,
        hour: clamp(input.hour === undefined ? base.hour : input.hour, 0, 23, base.hour),
        keepDays: clamp(input.keepDays === undefined ? base.keepDays : input.keepDays, 1, 90, base.keepDays)
    };
}

function readStored(handle) {
    var row = handle.db.prepare('SELECT value FROM meta WHERE key = ?').get(META_KEY);
    if (!row) return null;

    try {
        var parsed = JSON.parse(row.value);
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (err) {
        return null;
    }
}

function getSettings(handle) {
    return normalize(readStored(handle) || {}, DEFAULTS);
}

function setSettings(handle, patch) {
    var next = normalize(patch, getSettings(handle));
    handle.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
        .run(META_KEY, JSON.stringify(next));

    // 改了 hour 立刻生效：不让用户等到「下一轮烧完」才看到变化
    liveSchedulers.forEach(function (scheduler) { scheduler.reschedule(); });
    return next;
}

/* ------------------------------------------------------------------ 文件 */

/** 备份文件放在哪：默认就是 `data.db` 所在的目录（云端是 ./data） */
function dataDirOf(handle, options) {
    var opts = options || {};
    if (opts.dataDir) return String(opts.dataDir);
    return handle && handle.file ? path.dirname(handle.file) : process.cwd();
}

function backupsDirOf(handle, options) {
    return path.join(dataDirOf(handle, options), 'backups');
}

function pad(n) { return String(n).padStart(2, '0'); }

/** `<yyyyMMdd-HHmmss>`，同时当文件 id 用 */
function stampOf(ts) {
    var at = new Date(ts);
    return String(at.getFullYear()) + pad(at.getMonth() + 1) + pad(at.getDate()) +
        '-' + pad(at.getHours()) + pad(at.getMinutes()) + pad(at.getSeconds());
}

/** 文件名 → 毫秒时间戳；解析不出来返回 null */
function timeOfId(id) {
    if (!FILE_ID.test(String(id))) return null;

    var text = String(id);
    var at = new Date(
        Number(text.slice(0, 4)), Number(text.slice(4, 6)) - 1, Number(text.slice(6, 8)),
        Number(text.slice(9, 11)), Number(text.slice(11, 13)), Number(text.slice(13, 15))
    );
    var time = at.getTime();
    return Number.isFinite(time) ? time : null;
}

function sha1(text) {
    return crypto.createHash('sha1').update(text, 'utf8').digest('hex');
}

/**
 * 内容 hash 用的那一段：**不含** `exportedAt` / `appVersion`。
 *
 * 拿整套 JSON 去比的话，每次 `exportedAt` 都在变，「内容没变就不写」永远不成立。
 */
function contentOf(payload) {
    return JSON.stringify({
        project: payload.project,
        folders: payload.folders,
        apis: payload.apis,
        examples: payload.examples,
        expectations: payload.expectations,
        environments: payload.environments,
        suites: payload.suites
    });
}

/**
 * 上一份文件的内容和这次一样吗。
 *
 * **读不出来 / 解析不了都当「不一样」** —— 一份坏掉的旧备份不该把以后所有备份都卡住
 * （那是「永远不再备份」这种最糟的故障模式）。这时按「内容变了」处理，写一份新的。
 */
function sameContent(file, fingerprint) {
    try {
        return sha1(contentOf(JSON.parse(fs.readFileSync(file, 'utf8')))) === fingerprint;
    } catch (err) {
        return false;
    }
}

/** 某个项目的备份文件（按 id 排序，新的在前）。名字不认识的跳过 */
function filesOf(dir, projectId) {
    var projectDir = path.join(dir, projectId);
    var names;
    try {
        names = fs.readdirSync(projectDir);
    } catch (err) {
        return [];
    }

    return names.map(function (name) {
        if (!name.endsWith('.json')) return null;

        var id = name.slice(0, -'.json'.length);
        var at = timeOfId(id);
        if (at === null) return null;

        var full = path.join(projectDir, name);
        var stat;
        try {
            stat = fs.statSync(full);
        } catch (err) {
            return null;
        }
        return { id: id, at: at, size: stat.size, path: full };
    }).filter(Boolean).sort(function (a, b) { return b.id.localeCompare(a.id); });
}

/**
 * 列出某个项目的备份。
 *
 * @returns {Array<{id: string, at: number, size: number}>} 新的在前
 */
function listBackups(handle, projectId, options) {
    return filesOf(backupsDirOf(handle, options), projectId).map(function (file) {
        return { id: file.id, at: file.at, size: file.size };
    });
}

/**
 * 读一份备份文件。
 *
 * `id` **只允许** `yyyyMMdd-HHmmss` 这一种形状 —— 用户给的字符串直接进
 * `path.join` 之前必须先过这一关，否则 `../` 就能读到数据目录外面去。
 */
function readBackup(handle, projectId, id, options) {
    var key = String(id === undefined || id === null ? '' : id);
    if (!FILE_ID.test(key)) throw badRequest('备份编号不合法');

    var file = path.join(backupsDirOf(handle, options), projectId, key + '.json');
    var text;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch (err) {
        throw notFound('这份备份不在了：' + key);
    }

    var parsed;
    try {
        parsed = JSON.parse(text);
    } catch (err) {
        throw badRequest('这份备份文件坏了，读不出内容');
    }

    return { id: key, at: timeOfId(key), size: Buffer.byteLength(text, 'utf8'), backup: parsed };
}

function badRequest(message) {
    var err = new Error(message);
    err.status = 400;
    err.exposed = true;
    return err;
}

function notFound(message) {
    var err = new Error(message);
    err.status = 404;
    err.exposed = true;
    return err;
}

/* ------------------------------------------------------------------ 跑一轮 */

/**
 * 跑一轮自动备份。**这是 start 的定时器里调的那个函数**，自测里也直接调它
 * （不用等到那个点）。
 *
 * @param {object} [options] 同 `start`
 * @returns {{at: number, enabled: boolean, written: Array, skipped: Array, removed: number,
 *            errors: string[]}}
 */
function runOnce(handle, options) {
    var opts = options || {};
    var now = typeof opts.now === 'function' ? opts.now() : Date.now();
    var settings = getSettings(handle);
    var result = { at: now, enabled: settings.enabled, written: [], skipped: [], removed: 0, errors: [] };

    // 关着的时候**什么都不做**（连清理都不做）—— 「关掉自动备份」就是关掉
    if (!settings.enabled) return result;

    var dir = backupsDirOf(handle, opts);
    var projects = projectsRepo.list(handle);

    projects.forEach(function (project) {
        try {
            var payload = backup.build(handle, project.id);
            var content = JSON.stringify(payload, null, 2);
            var fingerprint = sha1(contentOf(payload));

            var existing = filesOf(dir, project.id);
            var latest = existing[0] || null;

            if (latest && sameContent(latest.path, fingerprint)) {
                result.skipped.push({ projectId: project.id, id: latest.id });
                return;
            }

            var projectDir = path.join(dir, project.id);
            fs.mkdirSync(projectDir, { recursive: true });

            var id = stampOf(now);
            var file = path.join(projectDir, id + '.json');
            // 先写临时文件再改名：中途崩了也不会留下半份读不出来的备份
            var temp = file + '.tmp';
            fs.writeFileSync(temp, content, 'utf8');
            fs.renameSync(temp, file);

            result.written.push({ projectId: project.id, id: id, size: Buffer.byteLength(content, 'utf8') });
        } catch (err) {
            result.errors.push('项目 ' + project.id + ' 备份失败：' + ((err && err.message) || err));
        }
    });

    result.removed = cleanup(dir, projects, settings.keepDays, now);
    return result;
}

/**
 * 清理：超过 `keepDays` 的文件删掉；项目已经不在了、而且目录里一个文件都不剩的，
 * 把目录也删掉。
 *
 * @returns {number} 删掉几个文件
 */
function cleanup(dir, projects, keepDays, now) {
    var alive = {};
    projects.forEach(function (project) { alive[project.id] = true; });

    var cutoff = now - keepDays * 24 * 60 * 60 * 1000;
    var removed = 0;

    var names;
    try {
        names = fs.readdirSync(dir);
    } catch (err) {
        return 0;   // 还没建过任何备份
    }

    names.forEach(function (name) {
        var projectDir = path.join(dir, name);
        var stat;
        try {
            stat = fs.statSync(projectDir);
        } catch (err) {
            return;
        }
        if (!stat.isDirectory()) return;

        var kept = 0;
        fs.readdirSync(projectDir).forEach(function (file) {
            var full = path.join(projectDir, file);
            var id = file.endsWith('.json') ? file.slice(0, -'.json'.length) : '';
            var at = timeOfId(id);

            if (at === null) {
                // 认识不了的名字（残留的 .tmp、别人手工放的）按修改时间算，不误删新的
                try {
                    at = fs.statSync(full).mtimeMs;
                } catch (err) {
                    return;
                }
            }

            if (at < cutoff) {
                try {
                    fs.unlinkSync(full);
                    removed += 1;
                } catch (err) {
                    return;
                }
                return;
            }
            kept += 1;
        });

        // 项目已经删了：留着它的备份目录没有意义，等保留期过完（一个文件都不剩）再删目录
        if (!alive[name] && kept === 0) {
            try {
                fs.rmdirSync(projectDir);
            } catch (err) {
                // 目录非空或已经没了，下次再说
            }
        }
    });

    return removed;
}

/* ------------------------------------------------------------------ 定时器 */

/** 距离下一次 `hour` 点还有多少毫秒（今天这个点已经过了就排到明天） */
function msUntilNext(hour, now) {
    var next = new Date(now);
    next.setHours(hour, 0, 0, 0);
    if (next.getTime() <= now) next.setDate(next.getDate() + 1);
    return next.getTime() - now;
}

/**
 * 启动自动备份。**只在云端调一次**（`lib/command.js` 的 `startChangePurge` 旁边）。
 *
 * @param {object} handle
 * @param {object} [options]
 *   - `dataDir`：备份文件放哪。默认取 `data.db` 所在的目录（`handle.file` 的 dirname）；
 *     自测里指到临时目录用。
 *   - `now`：注入当前时间（`() => ts`），自测里把「下一次」算成马上就到。
 *   - `log`：写日志（`log(text)`），默认什么都不打。
 * @returns {{stop: Function, reschedule: Function, runOnce: Function}}
 *   `stop()` 停掉定时器；`reschedule()` 按当前的 `hour` 重排（`setSettings` 自己会调）；
 *   `runOnce()` 立刻跑一轮（返回 `runOnce` 的结果）。
 */
function start(handle, options) {
    var opts = options || {};
    var log = typeof opts.log === 'function' ? opts.log : function () {};
    var stopped = false;
    var timer = null;

    var scheduler = {
        stop: function () {
            stopped = true;
            if (timer) clearTimeout(timer);
            timer = null;
            liveSchedulers.delete(scheduler);
        },
        reschedule: function () {
            if (stopped) return;
            if (timer) clearTimeout(timer);
            timer = null;
            arm();
        },
        runOnce: function () { return runOnce(handle, opts); }
    };

    function arm() {
        if (stopped) return;

        var now = typeof opts.now === 'function' ? opts.now() : Date.now();
        var delay = msUntilNext(getSettings(handle).hour, now);

        timer = setTimeout(function () {
            timer = null;
            // 定时器回调里抛出去就是 uncaughtException：自己兜住，只打日志
            try {
                var result = runOnce(handle, opts);
                if (result.written.length || result.removed || result.errors.length) {
                    log('自动备份：写出 ' + result.written.length + ' 份、跳过 ' +
                        result.skipped.length + ' 份、清理 ' + result.removed + ' 个文件' +
                        (result.errors.length ? '；' + result.errors.join('；') : ''));
                }
            } catch (err) {
                log('自动备份失败：' + ((err && err.message) || err));
            }
            arm();
        }, delay);

        // 定时器不能拦着进程退出
        if (timer.unref) timer.unref();
    }

    liveSchedulers.add(scheduler);
    arm();
    return scheduler;
}

module.exports = {
    DEFAULTS: DEFAULTS,
    FILE_ID: FILE_ID,
    getSettings: getSettings,
    setSettings: setSettings,
    dataDirOf: dataDirOf,
    backupsDirOf: backupsDirOf,
    listBackups: listBackups,
    readBackup: readBackup,
    runOnce: runOnce,
    start: start,
    msUntilNext: msUntilNext,
    stampOf: stampOf
};
