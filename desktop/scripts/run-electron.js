/**
 * 启动 Electron（开发用）。
 *
 * 存在的唯一理由：**必须清掉 `ELECTRON_RUN_AS_NODE`**。
 *
 * 这个环境变量一旦非空，Electron 的二进制会退化成纯 Node —— 没有 `app`、没有窗口、
 * `require('electron')` 也拿不到主进程模块，报出来的是
 * `TypeError: Cannot read properties of undefined (reading 'isPackaged')`，
 * 完全看不出是环境变量干的。IDE 自带的终端里经常会设它。
 *
 * 直接 `npx electron .` 也能跑，前提是那个环境变量没被设上；这里统一处理掉，
 * 免得「在我机器上好好的」。
 */

var path = require('path');
var { spawnSync } = require('child_process');

var DESKTOP_DIR = path.resolve(__dirname, '..');

// 这个 require 要的是「二进制的路径」——所以本文件必须用纯 Node 跑（npm run 就是），
// 不能用 Electron 跑（那时 require('electron') 拿到的是主进程模块）。
var binary = require('electron');

var env = Object.assign({}, process.env);
delete env.ELECTRON_RUN_AS_NODE;

var args = [DESKTOP_DIR].concat(process.argv.slice(2));
var result = spawnSync(binary, args, { stdio: 'inherit', env: env });

process.exit(result.status === null ? 1 : result.status);
