/**
 * 打包（D0）：先 stage 出一份干净的服务端，再依次打
 *   - Mac 的 .dmg：arm64 和 x64（Apple 芯片与 Intel 各一个）
 *   - Windows 的 NSIS 安装程序 .exe：x64
 *
 * 为什么不直接 `electron-builder --mac --win`：
 * 1. 得先跑 stage（app/ 是生成物）；
 * 2. electron-builder 下载 Electron 二进制和它自己那套辅助工具（winCodeSign、
 *    nsis、wine）时只看**环境变量**，不认 .npmrc 里的镜像 —— 国内不设镜像基本下不动。
 *
 * 安装包一律不签名（`identity: null`），所以 Mac 第一次打开会被系统拦一次。
 */

var path = require('path');
var { spawnSync } = require('child_process');

var DESKTOP_DIR = path.resolve(__dirname, '..');

// 镜像：允许外部覆盖（比如换回官方源）
process.env.ELECTRON_MIRROR = process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/';
process.env.ELECTRON_BUILDER_BINARIES_MIRROR = process.env.ELECTRON_BUILDER_BINARIES_MIRROR ||
    'https://npmmirror.com/mirrors/electron-builder-binaries/';

function run(title, command, args, cwd) {
    console.log('\n[dist] ' + title);
    var result = spawnSync(command, args, {
        cwd: cwd || DESKTOP_DIR,
        stdio: 'inherit',
        env: process.env
    });
    if (result.status !== 0) {
        console.error('[dist] 失败（退出码 ' + result.status + '）：' + title);
        process.exit(result.status || 1);
    }
}

run('stage：准备 app/', process.execPath, [path.join(__dirname, 'stage.js')]);
run('electron-builder：dmg(arm64/x64) + exe(x64)',
    path.join(DESKTOP_DIR, 'node_modules', '.bin', 'electron-builder'),
    ['--mac', '--win']);

console.log('\n[dist] 完成，产物在 desktop/dist/');
