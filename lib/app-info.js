/**
 * 产品级常量集中在这里。
 *
 * 产品名还没最终定，先用 httpman 占位。数据目录、默认库路径、cookie 名、
 * 环境变量前缀都从 APP_NAME 派生，以后改名只改这一个文件。
 */

var os = require('os');
var path = require('path');

var APP_NAME = 'httpman';
var ENV_PREFIX = APP_NAME.toUpperCase();

module.exports = {
    APP_NAME: APP_NAME,

    /** 全局数据目录：~/.httpman */
    DATA_DIR: path.join(os.homedir(), '.' + APP_NAME),

    /** 默认库路径：~/.httpman/data.db */
    DEFAULT_DB: path.join(os.homedir(), '.' + APP_NAME, 'data.db'),

    /** 登录态 cookie 名 */
    SESSION_COOKIE: APP_NAME + '_sid',

    /** 指定库路径的环境变量，优先级低于 --db */
    ENV_DB: ENV_PREFIX + '_DB',

    /** 预设初始管理员密码的环境变量 */
    ENV_ADMIN_PASSWORD: ENV_PREFIX + '_ADMIN_PASSWORD'
};
