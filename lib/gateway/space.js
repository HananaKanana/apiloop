/**
 * 本机空间（L1，设计稿 `2026-10-01-local-first.md` 第 3.2 节）。
 *
 * 「跳过登录」之后页面读写的就是这个空间：一个独立的 SQLite 库，放在
 * `<数据目录>/spaces/local/data.db`，**表结构和云端完全一样**（用的是同一个 `lib/db`，
 * 迁移照跑）。装好 apiloop 之后不联网、不配置云端地址也能用起来，就是靠它。
 *
 * 管理台那一套（`lib/admin.js`）是以 `handle` 为参数的，所以这里**再建一份指向本机库的
 * 实例**就完事 —— 页面调的接口、项目/目录/接口/示例/环境、本机发送、WebSocket 调试，
 * 全和直接打开云端时是同一份代码、同一套规则。网关只是把请求交给它，而不是转发出去。
 *
 * 库里有一个**固定的本机用户** `u_local`：
 * - **没有密码**（`password_hash` 是空串）。`auth.verifyPassword` 对空串一律返回 false，
 *   所以「用户名 local + 任意密码」这条路**在任何情况下都进不来** —— 本机身份只能由网关
 *   自己发会话（`POST /__apiloop/local/enter`）拿到，不是账号密码那条路。
 * - 系统角色是 admin，是这个空间里所有项目的 owner（不然「仅成员可见」一上线，
 *   本机用户自己建的项目就看不见了）。
 */

var fs = require('fs');
var path = require('path');

var db = require('../db');
var access = require('../access');
var adminModule = require('../admin');
var pkg = require('../../package.json');
var usersRepo = require('../db/repos/users');
var projectsRepo = require('../db/repos/projects');

/** 空间目录名。账号空间是 `spaces/<云端主机>~<端口>~<账号ID>`，未登录的是这个 */
var LOCAL_SPACE_DIR = 'local';

var LOCAL_USER_ID = 'u_local';
var LOCAL_USERNAME = 'local';
var LOCAL_DISPLAY_NAME = '本机用户';

/** 库里一个项目都没有时，替他建一个，免得打开就是空页面 */
var DEFAULT_PROJECT_NAME = '我的项目';

/**
 * 打开过的空间。**同一个进程里只打开一次**：第二次调用直接返回第一次那份 ——
 * 再 `db.open` 同一个文件会拿到两个 handle、两条 WAL 连接，写起来互相打架。
 */
var opened = new Map();

/** 本机库的路径。空间目录跟着数据目录走（`APILOOP_HOME` 一改就整体搬走） */
function localDbFile(dataDir) {
    return path.join(path.resolve(dataDir), 'spaces', LOCAL_SPACE_DIR, 'data.db');
}

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
            // 空串就是「谁都别想用密码登进来」，见文件头
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

/**
 * 打开（必要时新建）本机空间。
 *
 * **不要调 `auth.bootstrapAdmin`**：那是云端首次启动时建管理员用的，本机空间里只有一个
 * 没有密码的本机用户，多一个带密码的 admin 等于多一条登录入口。
 *
 * @param {string} dataDir 数据目录（`<dataDir>/spaces/local/data.db`）
 * @returns {{handle: object, admin: object, user: object, dataDir: string, dbFile: string}}
 */
function openLocalSpace(dataDir) {
    var dir = path.resolve(dataDir);
    var cached = opened.get(dir);
    if (cached) return cached;

    var file = localDbFile(dir);
    if (!fs.existsSync(path.dirname(file))) fs.mkdirSync(path.dirname(file), { recursive: true });

    var handle = db.open(file);
    var user = ensureLocalUser(handle);
    ensureDefaultProject(handle, user);

    var admin = adminModule.createAdmin({
        handle: handle,
        // 本机没有「挂在根路径」的项目：所有项目的 mock 地址都是 /mock-<ID>/。
        // （mock 服务本身在云端，本机这套只是让页面能正常读写。）
        store: { projectId: null, filePath: '' },
        version: pkg.version,
        rootProjectId: null
    });

    var space = {
        handle: handle,
        admin: admin,
        user: user,
        dataDir: dir,
        dbFile: file
    };
    opened.set(dir, space);
    return space;
}

module.exports = {
    openLocalSpace: openLocalSpace,
    localDbFile: localDbFile,
    LOCAL_SPACE_DIR: LOCAL_SPACE_DIR,
    LOCAL_USER_ID: LOCAL_USER_ID,
    LOCAL_USERNAME: LOCAL_USERNAME,
    DEFAULT_PROJECT_NAME: DEFAULT_PROJECT_NAME
};
