/**
 * 网关自己处理的登录、退出，以及「只有云端有的功能」（L3，设计稿 4.3 / 4.4 / 4.5）。
 *
 * 这几条为什么不能交给本机管理台：
 *
 * - **登录**必须是网关的事 —— 它要拿账号密码去云端换会话，再把云端会话藏进
 *   `session.json`（**永远不交给浏览器**），同时决定这次登录用哪个空间；
 * - **退出**要顺手通知云端注销，再清掉本机保存的云端会话；
 * - **只有云端有的功能**（改密码、用户管理、成员管理、mock 日志、安装包列表）数据不同步，
 *   本机库里没有，所以已登录时转给云端、带上 `session.json` 里那份会话；未登录时明确
 *   返回 409，页面据此显示「登录后可用」。
 *
 * 转发用的是 `cloud.requestJson`（缓冲 JSON），不再走第一期那种「管道转发一切」——
 * 这几条接口全是小 JSON，缓冲反而少一层出错的余地。
 */

var auth = require('../auth');
var usersRepo = require('../db/repos/users');
var cloud = require('./cloud');
var adminModule = require('../admin');
var i18n = require('../i18n');

var API_PREFIX = adminModule.API_PATH;

var LOGIN_REQUIRED = {
    ok: false,
    code: 'LOGIN_REQUIRED',
    error: '这个功能要先登录'
};

var CLOUD_DOWN_LOGIN = '连不上云端，登录需要联网。不登录也可以继续在本机使用';

/**
 * 这一条请求是不是「只有云端有」的。返回相对 `/__admin/api` 的那段路径，不是就返回 ''。
 *
 * 路径清单在计划里逐条列过，别凭印象放宽：放宽一条就等于把本机库的数据接口送出去转发。
 * 注意 `/users` 只到 `/users/` 为止（`/users/lookup` 也算），`/projects/:pid/members`
 * 和 `/projects/:pid/mock-log` 是「某个项目的」子资源。
 */
function cloudOnlyPath(req) {
    var pathname = String(req.originalUrl || '').split('?')[0];
    if (pathname.indexOf(API_PREFIX + '/') !== 0) return '';

    var rest = pathname.slice(API_PREFIX.length);
    if (rest === '/auth/password') return rest;
    if (rest === '/users' || rest.indexOf('/users/') === 0) return rest;
    if (rest === '/downloads' || rest.indexOf('/downloads/') === 0) return rest;

    /*
     * 自动备份的设置（第十四轮）：**备份文件在云端的磁盘上**，本机库里没有那些文件，
     * 所以设置也只存在云端。注意 `GET /projects/:pid/backup`（导出，单数）**不在这里** ——
     * 那条读的是本机库，离线也要能用（见下面 backups 那一段）。
     */
    if (rest === '/settings/backup') return rest;

    var parts = rest.split('/');   // ['', 'projects', '<pid>', 'members' | 'mock-log' | 'shares', …]
    if (parts[1] === 'projects' && parts[2] &&
        (parts[3] === 'members' || parts[3] === 'mock-log' || parts[3] === 'shares')) return rest;

    /*
     * 云端自动备份的列表 / 下载 / 恢复（第十四轮）：同样只有云端才有那些文件。
     * 按**整段**匹配 `backups`（复数）—— 导出那条是 `backup`（单数），差一个字母。
     */
    if (parts[1] === 'projects' && parts[2] && parts[3] === 'backups') return rest;

    // 分享：`/shares`（「我的分享」的跨项目列表）和 `/shares/<链接串>`（撤销）。
    // 分享是**云端**对外发布出去的东西，本机库里没有这张表的对应数据，只能转给云端。
    if (rest === '/shares' || rest.indexOf('/shares/') === 0) return rest;

    // 接口评论和 @ 提醒（第五轮第 4 节）：评论是给人看的协作内容，只在云端保存
    // （`comments` / `notifications` 两张表不同步）。本机库里那两张表是空的，
    // 不转的话页面上评论永远是「还没有评论」。
    if (parts[1] === 'apis' && parts[2] && parts[3] === 'comments') return rest;
    if (rest === '/comments' || rest.indexOf('/comments/') === 0) return rest;
    if (rest === '/notifications' || rest.indexOf('/notifications/') === 0) return rest;
    if (parts[1] === 'projects' && parts[2] && parts[3] === 'comment-counts') return rest;

    /*
     * 运行记录（第八轮第 1 节）：只在云端。跑测试集是**本机**的事（`/suites/<id>/run`），
     * 但历次结果要存到云端让同事都能看到，所以记录那几个路径转给云端。
     *
     * 注意 `run`（运行，本机）和 `runs`（记录，云端）**只差一个字母** ——
     * 这里按**整段**匹配（`parts[3] === 'runs'`），不能写成前缀判断，
     * 否则运行请求会被转给云端，本机就永远跑不了测试集。
     */
    if (parts[1] === 'suites' && parts[2] && parts[3] === 'runs') return rest;
    if (rest === '/suite-runs' || rest.indexOf('/suite-runs/') === 0) return rest;

    return '';
}

/**
 * @param {{manager: object, getCloudUrl: Function, log?: Function}} options
 * @returns {{login: Function, register: Function, logout: Function, deleteSpace: Function,
 *            forwardCloudOnly: Function, cloudOnlyPath: Function}}
 */
function createAccountRoutes(options) {
    var manager = options.manager;
    var getCloudUrl = options.getCloudUrl;
    var log = options.log || function () {};

    function fail(res, status, message, code) {
        var body = { ok: false, error: message };
        if (code) body.code = code;
        res.status(status).json(body);
    }

    /** 当前空间里那个用户行；改密码成功之后要清掉它的「先改密码」标记 */
    function clearMustChangePassword() {
        var space = manager.current();
        if (!space || !space.user) return;
        try {
            usersRepo.update(space.handle, space.user.id, { mustChangePassword: false });
        } catch (err) {
            log('清 must_change_password 失败：' + ((err && err.message) || err));
        }
    }

    /* ---------------------------------------------------------- 登录 */

    /**
     * `POST /__admin/api/auth/login`（设计稿 4.3）。
     *
     * 登录**必须联网**：账号密码交给云端，云端认得的人才算数。所以连不上云端时明确报
     * 502 并说明「不登录也可以继续在本机使用」—— 这和第 1 版的「离线登录」不一样，
     * 退出登录之后数据照样在，根本不需要离线登录。
     */
    function login(req, res) {
        var body = req.body || {};
        var username = String(body.username === undefined || body.username === null ? '' : body.username).trim();
        var password = String(body.password === undefined || body.password === null ? '' : body.password);
        if (!username || !password) return fail(res, 400, i18n.m('请输入用户名和密码'));

        var cloudUrl = getCloudUrl();
        if (!cloudUrl) return fail(res, 503, i18n.m('这个安装包没有配置云端地址'));

        cloud.requestJson({
            cloudUrl: cloudUrl,
            path: API_PREFIX + '/auth/login',
            method: 'POST',
            // 告诉云端界面现在是什么语言：密码错、账号被锁这些提示是云端拼的，
            // 不带这个头它只会回中文（`answer.json` 里那句话说给谁看都很别扭）
            headers: { 'accept-language': i18n.locale() },
            body: { username: username, password: password }
        }).then(finish, function (err) {
            // 只有「云端根本没回响应」才是连不上。登录成功之后本机这边出错是另一回事，
            // 在 finish 里各自报 —— 都塞进这一句会把用户引到错的方向（N1）
            log('登录：连不上云端：' + ((err && err.message) || err));
            return fail(res, 502, i18n.m(CLOUD_DOWN_LOGIN));
        });

        /** 云端回了响应之后的分支。里面的异常不会再落到上面那个 502 */
        function finish(answer) {
            if (answer.status < 200 || answer.status >= 300) {
                // 密码错、账号被锁：状态码和文案原样给页面，登录页的提示才不会和云端不一致
                if (answer.json) return res.status(answer.status).json(answer.json);
                return fail(res, answer.status, answer.text || i18n.m('登录失败'));
            }

            var user = answer.json && answer.json.user;
            var cookie = cloud.sessionCookieFrom(answer.setCookie);
            if (!user || !user.id || !cookie) {
                return fail(res, 502, i18n.m('云端返回的登录结果看不懂'));
            }

            // 空间处理（改名 / 并库 / 切换）失败**不是**登录失败：账号密码是对的，
            // 云端认得这个人是真的，只是本机这边没能把数据安排到他名下
            var space;
            try {
                space = manager.signIn(user, cookie);
            } catch (err) {
                log('登录：切换本机空间失败：' + ((err && err.stack) || err));
                return fail(res, 500, i18n.m('登录成功了，但本机数据切换失败：{reason}', {
                    reason: (err && err.message) || err
                }));
            }

            // 云端要求先改密码的话，本机库里那一行也打上同一个标记，
            // 否则页面刷新之后就看不到「请先修改密码」了
            try {
                usersRepo.update(space.handle, user.id, {
                    mustChangePassword: user.mustChangePassword === true
                });
            } catch (err) {
                log('同步 must_change_password 失败：' + ((err && err.message) || err));
            }

            auth.createSession(space.handle, user.id, res);
            return res.json({ ok: true, user: user });
        }
    }

    /* ---------------------------------------------------------- 注册 */

    /**
     * `POST /__admin/api/auth/register`：原样转给云端（账号只存在云端）。
     * 注册成功只是「申请提交了」，不登录、不切空间，等管理员审核通过后再走登录。
     */
    function register(req, res) {
        var body = req.body || {};
        var cloudUrl = getCloudUrl();
        if (!cloudUrl) return fail(res, 503, i18n.m('这个安装包没有配置云端地址'));

        cloud.requestJson({
            cloudUrl: cloudUrl,
            path: API_PREFIX + '/auth/register',
            method: 'POST',
            // 注册被拒的话（用户名占用、密码太短）提示是云端拼的，同样要告诉它语言
            headers: { 'accept-language': i18n.locale() },
            body: { username: body.username, password: body.password, displayName: body.displayName }
        }).then(function (answer) {
            if (answer.json) return res.status(answer.status).json(answer.json);
            return fail(res, answer.status >= 400 ? answer.status : 502, answer.text || i18n.m('注册失败'));
        }, function (err) {
            log('注册：连不上云端：' + ((err && err.message) || err));
            return fail(res, 502, i18n.m('连不上云端，注册需要联网'));
        });
    }

    /* ---------------------------------------------------------- 退出 */

    /**
     * `POST /__admin/api/auth/logout`（设计稿 4.4）。
     *
     * **浏览器那份本机会话保留**：退出只表示「不同步了」，页面照常可用、数据全都在。
     * 通知云端注销是顺手做的，失败不管 —— 本地的会话已经清掉了。
     */
    function logout(req, res) {
        var cookie = manager.cloudCookie();
        var cloudUrl = getCloudUrl();

        function finish() {
            manager.signOut();
            res.json({ ok: true });
        }

        if (!cookie || !cloudUrl) return finish();

        cloud.requestJson({
            cloudUrl: cloudUrl,
            path: API_PREFIX + '/auth/logout',
            method: 'POST',
            headers: { cookie: cookie }
        }).then(finish, finish);
        return undefined;
    }

    /* ---------------------------------------------------------- 删掉本机数据 */

    function deleteSpace(req, res) {
        manager.deleteCurrent();
        res.json({ ok: true, space: { state: manager.state() } });
    }

    /* ---------------------------------------------------------- 只有云端有的功能 */

    function forwardCloudOnly(req, res) {
        var cookie = manager.cloudCookie();
        if (!cookie) return fail(res, 409, i18n.m(LOGIN_REQUIRED.error), LOGIN_REQUIRED.code);

        var cloudUrl = getCloudUrl();
        if (!cloudUrl) return fail(res, 503, i18n.m('这个安装包没有配置云端地址'));

        var pathname = String(req.originalUrl || '').split('?')[0];
        var hasBody = req.method !== 'GET' && req.method !== 'HEAD';

        cloud.requestJson({
            cloudUrl: cloudUrl,
            path: req.originalUrl,
            method: req.method,
            /**
             * 带上界面语言：这几条接口（用户管理、成员、评论、运行记录……）**只在云端**，
             * 错误提示也是云端拼的。不带这个头，英文界面下转发回来的还是中文。
             * `i18n.locale()` 给的是规范化的 `en` / `zh-CN`，正好是云端认的两种写法。
             */
            headers: { cookie: cookie, 'accept-language': i18n.locale() },
            body: hasBody ? (req.body || {}) : undefined
        }).then(function (answer) {
            // 云端说会话没用了：同步暂停、状态栏显示「登录已过期」，本机照常能用
            if (answer.status === 401) manager.markExpired();

            // 改密码成功之后云端会重发一个会话，换掉 session.json 里那份；
            // 同时清掉本机行上的「先改密码」标记
            if (answer.status >= 200 && answer.status < 300 &&
                pathname === API_PREFIX + '/auth/password') {
                manager.updateCloudCookie(cloud.sessionCookieFrom(answer.setCookie));
                clearMustChangePassword();
            }

            if (answer.json) return res.status(answer.status).json(answer.json);
            if (!answer.text) return fail(res, answer.status, i18n.m('云端返回 {status}', { status: answer.status }));
            return res.status(answer.status).type('text/plain').send(answer.text);
        }).catch(function (err) {
            log('转发 ' + req.method + ' ' + req.originalUrl + ' 失败：' + err.message);
            return fail(res, 502, cloud.cloudDownMessage(cloudUrl, err));
        });

        return undefined;
    }

    return {
        login: login,
        register: register,
        logout: logout,
        deleteSpace: deleteSpace,
        forwardCloudOnly: forwardCloudOnly,
        cloudOnlyPath: cloudOnlyPath
    };
}

module.exports = {
    createAccountRoutes: createAccountRoutes,
    cloudOnlyPath: cloudOnlyPath,
    CLOUD_DOWN_LOGIN: CLOUD_DOWN_LOGIN
};
