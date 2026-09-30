/**
 * 产品级常量集中在这里。
 *
 * 产品名已定为 apiloop（2026-09-30）。数据目录、默认库路径、cookie 名、
 * 环境变量前缀全部从 APP_NAME 派生，以后改名只改这一个文件 —— 其他地方
 * 一律不许硬编码产品名。
 */

var os = require('os');
var path = require('path');

var APP_NAME = 'apiloop';
var ENV_PREFIX = APP_NAME.toUpperCase();

// 数据目录可以用 APILOOP_HOME 整体搬走（Docker 里挂到 /app/data 就靠它）。
// 库文件和上传文件都在这个目录下，所以只挂一个目录就能把数据全部持久化。
var ENV_HOME = ENV_PREFIX + '_HOME';
var DATA_DIR = process.env[ENV_HOME]
    ? path.resolve(process.env[ENV_HOME])
    : path.join(os.homedir(), '.' + APP_NAME);

module.exports = {
    APP_NAME: APP_NAME,

    /** 全局数据目录：$APILOOP_HOME，未设置时为 ~/.apiloop */
    DATA_DIR: DATA_DIR,

    /** 默认库路径：<DATA_DIR>/data.db（--db 与 APILOOP_DB 优先级更高） */
    DEFAULT_DB: path.join(DATA_DIR, 'data.db'),

    /** 指定数据目录的环境变量 */
    ENV_HOME: ENV_HOME,

    /** 登录态 cookie 名 */
    SESSION_COOKIE: APP_NAME + '_sid',

    /** 指定库路径的环境变量，优先级低于 --db */
    ENV_DB: ENV_PREFIX + '_DB',

    /** 预设初始管理员密码的环境变量 */
    ENV_ADMIN_PASSWORD: ENV_PREFIX + '_ADMIN_PASSWORD'
};
