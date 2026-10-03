/**
 * 空间管理（L3，设计稿 `2026-10-01-local-first.md` 第 3 节）。
 *
 * **本机只有一份数据，跟着最后登录的账号走**：
 *
 * ```
 * <数据目录>/spaces/local/data.db                  从没登录过时用的空间（「未绑定」）
 * <数据目录>/spaces/<主机>~<端口>~<账号ID>/data.db    每个登录过的账号一个
 *                                            session.json  云端会话（0600）
 * ```
 *
 * 三种状态（设计稿 3.2）：
 *
 * | 状态 | 身份 | 同步 |
 * |---|---|---|
 * | `unbound` | 本机用户 `u_local`（没有密码，系统角色 admin） | 不同步；修改记在 `changes` 里，第一次登录时一起上传 |
 * | `signedIn` | 云端账号（`users` 表从云端镜像） | 双向自动同步 |
 * | `signedOut` | 仍是这个账号（本机库里的那一行） | 暂停；修改照常记下，下次这个账号登录时推上去 |
 *
 * **同一个进程里一个空间只打开一次**（`cache`）。切换空间时先关掉当前的库再动文件
 * （`data.db` 和它的 `-wal` / `-shm` 一起搬），改名失败要退回原状。
 *
 * `session.json` 是「这个空间有没有云端会话」的唯一凭据：**没有这个文件就是
 * `signedOut`**。退出登录把它删掉之后，账号身份仍然能从目录名最后一段（账号 ID）读出来，
 * 所以退出之后照样能打开即进入、照常改数据。
 *
 * 管理台（`lib/admin.js`）只认 `handle`，所以每个空间各建一份指向自己那个库的实例。
 */

var fs = require('fs');
var path = require('path');

var db = require('../db');
var access = require('../access');
var adminModule = require('../admin');
var pkg = require('../../package.json');
var usersRepo = require('../db/repos/users');
var projectsRepo = require('../db/repos/projects');
var helpers = require('../db/repos/helpers');
var cloud = require('./cloud');
var syncApply = require('./sync/apply');
var trashModule = require('../trash');

var SPACES_DIR = 'spaces';
var LOCAL_SPACE_KEY = 'local';
var DB_FILE = 'data.db';
var SESSION_FILE = 'session.json';

var LOCAL_USER_ID = 'u_local';
var LOCAL_USERNAME = 'local';
var LOCAL_DISPLAY_NAME = '本机用户';

/** 库里一个项目都没有时替他建一个，免得打开就是空页面 */
/**
 * 未绑定空间自动建的那个项目的名字。和云端启动时建的「默认项目」同名（用户 2026-10-01：
 * 「登录和未登录的默认项目一个叫我的项目一个叫默认项目，不能合并成一个吗」）。
 * 老版本建的叫「我的项目」，拉取结束时清理没用过的那个也要认它（见 sync/pull.js）。
 */
var DEFAULT_PROJECT_NAME = '默认项目';

var UNBOUND = 'unbound';
var SIGNED_IN = 'signedIn';
var SIGNED_OUT = 'signedOut';

/* ------------------------------------------------------------------ 空间的键 */

/**
 * 空间目录名 = `<主机>~<端口>~<账号ID>`。
 *
 * 带上云端主机和端口，连不同云端（测试环境 / 正式环境）不会混；端口没写时按协议补
 * （http 80、https 443），否则 `http://host` 和 `http://host:80` 会变成两个空间。
 *
 * 整串里除了字母、数字、`.`、`-`、`_`、`~` 之外一律换成 `_` —— 目录名要能直接当路径用。
 * `~` 要留着（它是分隔符），而账号 ID 本来也不会带它。
 */
function spaceKey(cloudUrl, userId) {
    var base = cloud.parseCloudUrl(cloud.normalizeCloudUrl(cloudUrl));

    var host = 'cloud';
    var port = '80';
    if (base) {
        host = base.hostname.toLowerCase();
        port = base.port || (base.protocol === 'https:' ? '443' : '80');
    }

    return (host + '~' + port + '~' + String(userId)).replace(/[^a-zA-Z0-9._~-]/g, '_');
}

/** 目录名最后一段就是账号 ID（spaceKey 就是这么拼的） */
/** 空间键里「哪个云端」那部分（host~port），用来判断云端地址换没换 */
function cloudPartOfKey(key) {
    var text = String(key);
    var index = text.lastIndexOf('~');
    return index === -1 ? text : text.slice(0, index);
}

function userIdFromKey(key) {
    var text = String(key);
    var index = text.lastIndexOf('~');
    return index === -1 ? '' : text.slice(index + 1);
}

/* ------------------------------------------------------------------ session.json */

function sessionFile(dir) {
    return path.join(dir, SESSION_FILE);
}

function readSession(dir) {
    var parsed = null;
    try {
        parsed = JSON.parse(fs.readFileSync(sessionFile(dir), 'utf8'));
    } catch (err) {
        return null;   // 没有这个文件、或者内容坏了，都按「没有会话」处理
    }
    if (!parsed || typeof parsed !== 'object') return null;
    if (!parsed.cookie || !parsed.user || !parsed.user.id) return null;
    return parsed;
}

/** 0600：这里存着云端会话，同机器上的其他用户不该读到 */
function writeSession(dir, session) {
    fs.writeFileSync(sessionFile(dir), JSON.stringify(session, null, 2) + '\n', { mode: 384 });
}

function removeSession(dir) {
    try {
        fs.rmSync(sessionFile(dir), { force: true });
    } catch (err) {
        // 删不掉也当没有：凭据是文件内容，不是文件是否存在
    }
}

/* ------------------------------------------------------------------ 用户 */

/** 建出本机用户。已经有了就原样返回 */
function ensureLocalUser(handle) {
    var existing = usersRepo.getById(handle, LOCAL_USER_ID);
    if (existing) return existing;

    return handle.transaction(function () {
        return usersRepo.create(handle, {
            id: LOCAL_USER_ID,
            username: LOCAL_USERNAME,
            display_name: LOCAL_DISPLAY_NAME,
            role: 'admin',
            // 空串就是「谁都别想用密码登进来」：verifyPassword 对空串一律 false
            password_hash: '',
            must_change_password: 0
        });
    }, { projectId: null });
}

/**
 * 保证某个云端账号在这个库里有一行用户。
 *
 * 镜像来的用户**没有密码**（空串）—— 本机的身份由网关自己发会话，不走账号密码那条路。
 * 用户名重复时加个后缀：云端账号叫 `local` 的话会和本机用户撞上（username 是 UNIQUE）。
 */
function ensureUser(handle, user) {
    var username = String(user.username || user.id);
    var taken = usersRepo.getByUsername(handle, username);
    if (taken && taken.id !== user.id) username = username + '~' + String(user.id).slice(-6);

    var existing = usersRepo.getById(handle, user.id);
    if (existing) {
        /**
         * 已经有这一行：**按云端的账号信息更新**（云端说了算）。
         *
         * 打开一个还没写会话的空间时（登录时先开库、后写 session.json），refreshState
         * 会先用账号 ID 补一行占位用户（用户名就是那串 ID、角色是成员）。以前这里见到
         * 「已存在」就直接返回，占位的那行就一直留着 —— 界面上用户名显示成 u_xxx、
         * 管理员显示成成员（2026-10-01 换云端地址迁移后用户看到的）。
         */
        if (!user.username) return existing;
        var role = user.role === 'admin' ? 'admin' : 'member';
        var displayName = user.displayName || '';
        if (existing.username === username && existing.displayName === displayName && existing.role === role) {
            return existing;
        }
        return handle.transaction(function () {
            return usersRepo.update(handle, user.id, { username: username, displayName: displayName, role: role });
        }, { projectId: null });
    }

    return handle.transaction(function () {
        return usersRepo.create(handle, {
            id: user.id,
            username: username,
            display_name: user.displayName || '',
            role: user.role === 'admin' ? 'admin' : 'member',
            password_hash: '',
            must_change_password: 0
        });
    }, { projectId: null });
}

/** 空库建一个「我的项目」。已经有项目了就什么都不做 */
function ensureDefaultProject(handle, user) {
    if (projectsRepo.list(handle).length > 0) return null;

    return handle.transaction(function () {
        var project = projectsRepo.create(handle, {
            name: DEFAULT_PROJECT_NAME,
            created_by: user.id
        });
        access.addOwner(handle, project.id, user.id);
        return project;
    }, { projectId: null });
}

/* ------------------------------------------------------------------ 跨库搬运 */

/** 跨库搬行要用的表，顺序就是外键的顺序（父级在前） */
var COPY_TABLES = ['environments', 'folders', 'apis', 'examples', 'mock_expectations'];

/** SQLite 的字符串字面量：单引号里的单引号要写两遍 */
function quote(value) {
    return "'" + String(value).replace(/'/g, "''") + "'";
}

/**
 * 把未绑定空间的数据并进 U 的空间（设计稿 4.3 第 2 步的第二种情况）。
 *
 * 调用前未绑定那个库**必须已经关掉**：`ATTACH` 打开的是另一条连接，原来那条还攥着
 * WAL，两边一起写会打架。
 *
 * 整个搬运在一个事务里 —— 中途失败就整体回滚，宁可什么都没搬也不要搬一半。
 * （`ATTACH` / `DETACH` 不能放在事务里，所以它在事务外面。）
 */
function mergeUnbound(handle, srcFile, user) {
    handle.db.exec('ATTACH DATABASE ' + quote(srcFile) + ' AS src');
    try {
        handle.transaction(function () {
            // 1) 项目。created_by 换成 U：原来是 u_local，而它在主库里不存在，
            //    照搬会直接违反外键。
            //
            //    slug 必须重新取一个没被占用的：两个空间各自自动建过「我的项目」是
            //    常事（未绑定空间本来就有一个），照搬 slug 会直接撞 UNIQUE 约束，
            //    整个登录以 502 收场。逐行插而不是一条 INSERT…SELECT，就是为了这一下。
            var projects = handle.db.prepare('SELECT * FROM src.projects').all();
            var insertProject = handle.db.prepare(
                'INSERT INTO main.projects (id, slug, name, description, source_dir, is_default, ' +
                'variables, auth, scripts, extra, created_by, created_at, updated_at, rev) ' +
                'VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, 1)'
            );
            projects.forEach(function (row) {
                insertProject.run(row.id, projectsRepo.uniqueSlug(handle, row.slug), row.name,
                    row.description, row.source_dir, row.variables, row.auth, row.scripts,
                    row.extra, user.id, row.created_at, row.updated_at);
            });

            // 2) 成员表只留 U 一行 owner（未绑定空间里的成员是 u_local，搬过去没有意义）
            handle.db.exec(
                'INSERT INTO main.project_members (project_id, user_id, role) ' +
                "SELECT id, '" + user.id + "', 'owner' FROM src.projects"
            );

            // 3) 其余表原样搬
            COPY_TABLES.forEach(function (table) {
                handle.db.exec('INSERT INTO main.' + table + ' SELECT * FROM src.' + table);
            });

            // 3b) 保密变量的值不能原样搬 —— 主键里有 user_id，要从 u_local 换成 U；
            //     搬过来的行标成「待推」（第 7 节起它会跟着同步推上云端）。
            //     同主键时以搬过来的那份为准：未绑定空间里的才是用户刚改的
            handle.db.exec(
                'INSERT OR REPLACE INTO main.secret_values ' +
                '(user_id, scope, scope_id, key, value, deleted, dirty, seq, updated_at) ' +
                'SELECT ' + quote(user.id) + ', scope, scope_id, key, value, deleted, 1, seq, updated_at ' +
                'FROM src.secret_values'
            );

            // 4) 历史和 Cookie：不带 id（历史是 AUTOINCREMENT，Cookie 换新 id），
            //    用户换成 U。这两张表只存本机，不参与同步
            var history = handle.db.prepare('SELECT * FROM src.history').all();
            var historyStatement = handle.db.prepare(
                'INSERT INTO history (project_id, api_id, user_id, request, response, created_at) ' +
                'VALUES (?, ?, ?, ?, ?, ?)'
            );
            history.forEach(function (row) {
                historyStatement.run(row.project_id, row.api_id, user.id,
                    row.request, row.response, row.created_at);
            });

            var cookies = handle.db.prepare('SELECT * FROM src.cookies').all();
            var cookieStatement = handle.db.prepare(
                'INSERT INTO cookies (id, project_id, user_id, domain, path, name, value, expires, ' +
                'host_only, secure, http_only, same_site, created_at, updated_at) ' +
                'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
            );
            cookies.forEach(function (row) {
                cookieStatement.run(helpers.newId('c'), row.project_id, user.id, row.domain,
                    row.path, row.name, row.value, row.expires, row.host_only, row.secure,
                    row.http_only, row.same_site, row.created_at, row.updated_at);
            });
        }, { projectId: null });
    } finally {
        try {
            handle.db.exec('DETACH DATABASE src');
        } catch (err) {
            // DETACH 失败不影响已经提交的数据
        }
    }
}

/* ------------------------------------------------------------------ 管理器 */

/**
 * @param {{dataDir: string, getCloudUrl: Function, currentSpace?: string,
 *          onSpaceChange?: Function, log?: Function}} options
 */
function createSpaceManager(options) {
    var dataDir = path.resolve(options.dataDir);
    var getCloudUrl = options.getCloudUrl || function () { return ''; };
    var onSpaceChange = typeof options.onSpaceChange === 'function' ? options.onSpaceChange : null;
    var log = options.log || function () {};

    var listeners = [];
    var cache = new Map();
    var current = null;
    /** 云端会话过期（同步时云端回 401）。登录成功时清掉 */
    var expired = false;

    function spacesDir() {
        return path.join(dataDir, SPACES_DIR);
    }

    function dirForKey(key) {
        return path.join(spacesDir(), key);
    }

    function removeDir(dir) {
        try {
            fs.rmSync(dir, { recursive: true, force: true });
        } catch (err) {
            log('删不掉空间目录 ' + dir + '：' + ((err && err.message) || err));
        }
    }

    function notify() {
        listeners.forEach(function (fn) {
            try {
                fn(current);
            } catch (err) {
                log('空间变更监听器出错：' + ((err && err.message) || err));
            }
        });
    }

    /** 按磁盘上的现状重算 `state` 和身份用户（写完 / 删完 session.json 都要走一遍） */
    function refreshState(space) {
        var handle = space.handle;

        if (space.key === LOCAL_SPACE_KEY) {
            space.state = UNBOUND;
            space.user = ensureLocalUser(handle);
            ensureDefaultProject(handle, space.user);
            return space;
        }

        var session = readSession(space.dir);
        if (session) {
            space.state = SIGNED_IN;
            space.user = ensureUser(handle, session.user);
            return space;
        }

        // 没有会话仍要知道这个空间是谁的 —— 账号 ID 就在目录名最后一段
        space.state = SIGNED_OUT;
        var userId = userIdFromKey(space.key);
        space.user = usersRepo.getById(handle, userId);
        if (!space.user) {
            // 理论上到不了：账号空间只可能由 signIn 建出来，那一步会写用户行。
            // 真碰上了也要能打开，否则这个空间就永远进不去了。
            log('空间 ' + space.key + ' 里没有用户 ' + userId + '，补一行');
            space.user = ensureUser(handle, {
                id: userId, username: userId, displayName: '', role: 'member'
            });
        }
        return space;
    }

    /** 打开一个空间；已经打开过的直接返回那一份（同一个库不能有两个连接） */
    function openSpace(key) {
        var cached = cache.get(key);
        if (cached) return cached;

        var dir = dirForKey(key);
        fs.mkdirSync(dir, { recursive: true });

        var handle = db.open(path.join(dir, DB_FILE));

        /**
         * 标记「这是客户端的那一份库」（第 7 节）：`secret_values` 的写入要打 `dirty` 标记
         * （本机改过、还没推上云端），云端那一份不打 —— 见 lib/db/repos/secret-values.js。
         */
        handle.localStore = true;

        var space = {
            key: key,
            dir: dir,
            handle: handle,
            admin: null,
            user: null,
            state: UNBOUND
        };

        space.admin = adminModule.createAdmin({
            handle: space.handle,
            // 本机没有「挂在根路径」的项目：所有项目的 mock 地址都是 /mock-<ID>/。
            // （mock 服务本身在云端，本机这套只是让页面能正常读写。）
            store: { projectId: null, filePath: '' },
            version: pkg.version,
            rootProjectId: null,
            // 本机管理台才需要把 EHOSTUNREACH 换成 macOS 的「本地网络」授权提示
            localSend: true
        });

        // 同步用的两张表（`sync_base`、`sync_conflicts`）是网关这边独有的，不在迁移里，
        // 所以**每个空间打开时都要建一次** —— 老库、刚建的库、切回来的库都走这条路
        syncApply.ensureTables(space.handle);

        // 未绑定的本机空间没有云端，回收站的 30 天清理得自己来（云端那边由
        // lib/command.js 的定时任务清，删掉的记录再同步下来）。打开时清一次就够。
        if (key === LOCAL_SPACE_KEY) {
            try {
                trashModule.purgeTrash(space.handle, Date.now());
            } catch (err) {
                log('清理回收站失败：' + ((err && err.message) || err));
            }
        }

        refreshState(space);
        cache.set(key, space);
        return space;
    }

    function remember(space, reason) {
        current = space;
        if (onSpaceChange) {
            try {
                onSpaceChange(space.key);
            } catch (err) {
                log('写当前空间失败：' + ((err && err.message) || err));
            }
        }
        if (reason) log('当前空间：' + space.key + '（' + reason + '）');
        notify();
        return space;
    }

    /** 关掉当前空间。切空间、删空间、退出进程都要先走这一步 */
    function closeCurrent() {
        var space = current;
        current = null;
        if (!space) return;

        cache.delete(space.key);
        try {
            space.handle.close();
        } catch (err) {
            log('关库失败：' + ((err && err.message) || err));
        }
    }

    /**
     * 把未绑定空间整个变成 U 的（U 在本机还没有空间）。
     *
     * 库里 `u_local` 出现过的每一处都要换成 U.id，然后删掉 `u_local` 和所有会话 ——
     * 本机用户从此不存在，这个空间就是 U 的了。最后关库、把目录改名。
     *
     * `session.json` 放在**改名成功之后**写：改名失败时这个目录还是未绑定空间，
     * 里面留一份云端会话既没用（`unbound` 状态不看它），又是一份不该留的凭据。
     */
    function bindLocalSpace(space, user, key, session) {
        var handle = space.handle;

        ensureUser(handle, user);

        handle.transaction(function () {
            handle.db.prepare('UPDATE project_members SET user_id = ? WHERE user_id = ?')
                .run(user.id, LOCAL_USER_ID);
            handle.db.prepare('UPDATE projects SET created_by = ? WHERE created_by = ?')
                .run(user.id, LOCAL_USER_ID);
            handle.db.prepare('UPDATE history SET user_id = ? WHERE user_id = ?')
                .run(user.id, LOCAL_USER_ID);
            handle.db.prepare('UPDATE cookies SET user_id = ? WHERE user_id = ?')
                .run(user.id, LOCAL_USER_ID);

            // 保密变量的值也换人（主键里有 user_id；U 在这个空间里还没有行，先删掉防撞）
            handle.db.prepare('DELETE FROM secret_values WHERE user_id = ?').run(user.id);
            handle.db.prepare('UPDATE secret_values SET user_id = ? WHERE user_id = ?')
                .run(user.id, LOCAL_USER_ID);
            // 保密值从这一版起要跟着同步（第 7 节）：标成「待推」，下一轮推上云端
            handle.db.prepare('UPDATE secret_values SET dirty = 1 WHERE user_id = ?').run(user.id);

            // 会话全清：浏览器手里那份是发给 u_local 的，空间换了它不该再用
            handle.db.exec('DELETE FROM sessions');
            handle.db.prepare('DELETE FROM users WHERE id = ?').run(LOCAL_USER_ID);
        }, { projectId: null });

        // 先关库再改名：WAL 文件要跟着 data.db 一起走，连接还开着就搬不动
        var from = space.dir;
        var to = dirForKey(key);
        closeCurrent();
        try {
            fs.renameSync(from, to);
        } catch (err) {
            // 退回去：重新打开未绑定空间，网关继续照常服务（数据一条没动）
            log('把 spaces/local 改名成 ' + key + ' 失败：' + ((err && err.message) || err));
            remember(openSpace(LOCAL_SPACE_KEY), '改名失败，退回未绑定空间');
            throw err;
        }

        writeSession(to, session);
    }

    /**
     * 出错时保证网关手里**一定还有库可用**：`current` 为空就退回未绑定空间。
     *
     * 登录这条路上有好几个地方会先关掉当前空间再动文件（改名、并库、切账号），
     * 中间任何一步抛出去、又没把空间重新打开，之后每个请求都会拿不到库 ——
     * 那比「这次登录失败」严重得多。
     */
    function restoreUsableSpace(reason) {
        if (current) return;
        try {
            remember(openSpace(LOCAL_SPACE_KEY), reason);
        } catch (err) {
            log('退回未绑定空间也失败了：' + ((err && err.message) || err));
        }
    }

    /** 关掉某个空间（可能没打开过）。切账号、并库失败时清理用 */
    function closeSpace(key) {
        var space = cache.get(key);
        if (!space) return;
        cache.delete(key);
        try {
            space.handle.close();
        } catch (err) {
            log('关库失败：' + ((err && err.message) || err));
        }
    }

    /**
     * `signIn` 的实体。抽出来只是为了外面能整段包 try —— 中间任何一步失败都要保证
     * 网关手里还有库可用。
     */
    function doSignIn(cloudUser, cloudCookie) {
        var key = spaceKey(getCloudUrl(), cloudUser.id);
        var session = { cookie: cloudCookie, user: cloudUser, signedInAt: Date.now() };
        var space;

        if (current && current.key === key) {
            writeSession(current.dir, session);
            space = remember(refreshState(current), '已登录');
        } else if (current && current.key === LOCAL_SPACE_KEY) {
            if (!fs.existsSync(dirForKey(key))) {
                // U 在本机还没有空间：把这个未绑定空间整个变成 U 的
                bindLocalSpace(current, cloudUser, key, session);
                space = remember(refreshState(openSpace(key)), '未绑定空间已绑定到账号');
            } else {
                // U 在本机已经有空间：把未绑定空间的数据并进去，然后扔掉它。
                // 未绑定的目录一直留到最后一刻才删，所以中途出错退得回来
                // （退回去那一步由 signIn 的 try 兜着）。
                var unboundDir = current.dir;
                closeCurrent();
                try {
                    var target = openSpace(key);
                    mergeUnbound(target.handle, path.join(unboundDir, DB_FILE),
                        ensureUser(target.handle, cloudUser));
                    writeSession(target.dir, session);
                    removeDir(unboundDir);
                    space = remember(refreshState(target), '未绑定空间的数据已并入');
                } catch (err) {
                    log('把未绑定空间并进 ' + key + ' 失败：' + ((err && err.message) || err));
                    // 目标空间可能已经建出来一半，里面那份会话先清掉（凭据不留）
                    removeSession(dirForKey(key));
                    throw err;
                }
            }
        } else if (current && current.key !== LOCAL_SPACE_KEY &&
                   cloudPartOfKey(current.key) !== cloudPartOfKey(key) &&
                   !fs.existsSync(dirForKey(key))) {
            /**
             * **云端地址换了**（比如从测试环境换到正式环境），这个账号在新云端上本机还没有空间：
             * 把当前空间里的数据当成「本机还没同步的数据」并进新空间，登录后推上新云端。
             *
             * 用户 2026-10-01：本机数据都在旧地址的空间里，换到线上后 Windows 上同步不下来。
             * 不并的话这些数据就留在旧空间里，换了地址就再也看不到。
             *
             * 和「未绑定空间并进账号」走同一套 `mergeUnbound`：新空间里没有基线，所有行都是
             * 待同步，以 baseRev = 0 推上去。旧空间的目录**留着不删**（万一并错了还能找回来），
             * 只删掉它的云端会话。
             */
            var oldSpace = current;
            var oldFile = path.join(oldSpace.dir, DB_FILE);
            removeSession(oldSpace.dir);
            closeCurrent();
            try {
                var fresh = openSpace(key);
                mergeUnbound(fresh.handle, oldFile, ensureUser(fresh.handle, cloudUser));
                // 旧空间里自动建过的空项目（默认项目）不用跟过来，拉取结束时 dropUnusedAutoProject 会处理
                writeSession(fresh.dir, session);
                space = remember(refreshState(fresh), '云端地址换了，本机数据已并入新空间');
                log('云端地址换了：' + oldSpace.key + ' 的数据已并入 ' + key + '，登录后推上新云端');
            } catch (err) {
                log('把 ' + oldSpace.key + ' 并进 ' + key + ' 失败：' + ((err && err.message) || err));
                removeSession(dirForKey(key));
                throw err;
            }
        } else {
            // 切到别的账号：**上一个账号的 `session.json` 要删掉**（N2）。
            // 那份云端会话已经不再用了（换回来本来就要求重新登录），留着只是让
            // 一份凭据躺在磁盘上。数据目录、库都不动，切回去时数据还在。
            if (current && current.key !== LOCAL_SPACE_KEY) {
                removeSession(current.dir);
                log('已清掉上一个空间 ' + current.key + ' 里保存的云端会话');
            }

            closeCurrent();
            space = openSpace(key);
            writeSession(space.dir, session);
            space = remember(refreshState(space), '切换到已登录账号');
        }

        expired = false;
        notify();
        return space;
    }

    var manager = {
        /** 当前空间。打不开时返回 null（调用方要明确报 503，不能放它往下走） */
        current: function () {
            return current;
        },

        /** 当前空间的状态：`unbound` / `signedIn` / `signedOut` */
        state: function () {
            return current ? current.state : UNBOUND;
        },

        /** 已登录时返回 `session.json` 里的云端 Cookie（形如 `apiloop_sid=…`），否则 null */
        cloudCookie: function () {
            if (!current || current.state !== SIGNED_IN) return null;
            var session = readSession(current.dir);
            return session ? session.cookie : null;
        },

        /** 云端会话过期了没有（同步时云端回 401 会置上） */
        isExpired: function () {
            return expired;
        },

        /**
         * 云端换了新会话（改完密码云端会重发一个），把 `session.json` 里那份换掉。
         * 没有会话、或者已经是退出状态时什么都不做。
         */
        updateCloudCookie: function (cloudCookie) {
            if (!cloudCookie) return;
            if (!current || current.state !== SIGNED_IN) return;

            var session = readSession(current.dir);
            if (!session) return;

            session.cookie = cloudCookie;
            writeSession(current.dir, session);
        },

        /**
         * 登录成功后把账号和云端会话落到本机（设计稿 4.3 第 2 步）。
         *
         * 按「当前是哪个空间」分三种：
         *   - 当前就是 U 的空间：直接用，写会话；
         *   - 当前是未绑定空间：U 在本机没有空间就整体改名成 U 的；有就并进 U 的空间，扔掉未绑定的；
         *   - 当前是别的账号的空间：那个目录原样留着，切到 U 的空间（没有就新建一个空的）。
         *
         * **整段包在 try 里**：中间任何一步失败都要保证网关手里还有库可用
         * （见 `restoreUsableSpace`），然后把错抛给调用方去报「本机数据切换失败」。
         */
        signIn: function (cloudUser, cloudCookie) {
            try {
                return doSignIn(cloudUser, cloudCookie);
            } catch (err) {
                restoreUsableSpace('登录失败，退回未绑定空间');
                throw err;
            }
        },

        /** 退出登录：只清云端会话，当前空间和数据一个都不动 */
        signOut: function () {
            if (current && current.key !== LOCAL_SPACE_KEY) {
                removeSession(current.dir);
                remember(refreshState(current), '已退出');
            }
            return current;
        },

        /** 云端会话过期：动作和退出一样，只是状态栏要说明原因 */
        markExpired: function () {
            expired = true;
            if (current && current.key !== LOCAL_SPACE_KEY && current.state === SIGNED_IN) {
                removeSession(current.dir);
                remember(refreshState(current), '登录已过期');
            }
            return current;
        },

        /** 删掉当前空间的数据，换成一个新的、空的未绑定空间 */
        deleteCurrent: function () {
            var dir = current ? current.dir : null;
            closeCurrent();
            if (dir) removeDir(dir);
            return remember(refreshState(openSpace(LOCAL_SPACE_KEY)), '本机数据已删除');
        },

        /** 空间切换、状态变化时通知（同步引擎用） */
        onChange: function (fn) {
            if (typeof fn === 'function') listeners.push(fn);
        },

        /** 当前空间的最新 `{ handle, user }`（同步引擎每轮开头取一次） */
        refresh: function () {
            return current ? refreshState(current) : null;
        },

        close: function () {
            closeCurrent();
            cache.clear();
        }
    };

    try {
        remember(refreshState(openSpace(options.currentSpace || LOCAL_SPACE_KEY)));
    } catch (err) {
        log('打开空间 ' + (options.currentSpace || LOCAL_SPACE_KEY) + ' 失败：' +
            ((err && err.stack) || err));
    }

    return manager;
}

module.exports = {
    createSpaceManager: createSpaceManager,
    spaceKey: spaceKey,
    userIdFromKey: userIdFromKey,
    SPACES_DIR: SPACES_DIR,
    DB_FILE: DB_FILE,
    SESSION_FILE: SESSION_FILE,
    LOCAL_SPACE_KEY: LOCAL_SPACE_KEY,
    LOCAL_USER_ID: LOCAL_USER_ID,
    LOCAL_USERNAME: LOCAL_USERNAME,
    DEFAULT_PROJECT_NAME: DEFAULT_PROJECT_NAME,
    UNBOUND: UNBOUND,
    SIGNED_IN: SIGNED_IN,
    SIGNED_OUT: SIGNED_OUT
};
