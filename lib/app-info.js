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

module.exports = {
    APP_NAME: APP_NAME,

    /** 全局数据目录：~/.apiloop */
    DATA_DIR: path.join(os.homedir(), '.' + APP_NAME),

    /** 默认库路径：~/.apiloop/data.db */
    DEFAULT_DB: path.join(os.homedir(), '.' + APP_NAME, 'data.db'),

    /** 登录态 cookie 名 */
    SESSION_COOKIE: APP_NAME + '_sid',

    /** 指定库路径的环境变量，优先级低于 --db */
    ENV_DB: ENV_PREFIX + '_DB',

    /** 预设初始管理员密码的环境变量 */
    ENV_ADMIN_PASSWORD: ENV_PREFIX + '_ADMIN_PASSWORD'
};
