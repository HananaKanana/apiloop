/**
 * 把仓库里的服务端「暂存」成一份可以打包的应用内容：`desktop/app/`。
 *
 * 为什么要有这一步，而不是让 electron-builder 直接去啃仓库根目录：
 * 根目录的 node_modules 里有一大堆前端开发依赖（vue、vite、codemirror……），
 * 而且根目录的 package.json **一个依赖都不许加**（Docker 镜像跑的是
 * `npm ci --omit=dev`，绝不能把 Electron 卷进去）。所以这里单独复制一份
 * 干净的服务端，并在里面按 package-lock.json 装**生产依赖**。
 *
 * 三个刻意的做法：
 * 1. **只覆盖、不删除。** 一开始写的是「先 rmSync 整棵 app/ 再复制」，但有些环境
 *    （带批量删除保护）会把一次删上千个文件拦下来。改成 `fs.cpSync(force)` 原地覆盖，
 *    代价是：上游**删掉**的文件会留在 app/ 里 —— D0 可以接受，D1 换更细的同步策略。
 * 2. **npm ci 按锁文件哈希缓存。** 装一次要十几秒，而绝大多数 stage 的输入没变。
 *    哈希写在 `app/node_modules/.stage-lock`，对得上就跳过。
 * 3. **产物是生成物**，不进仓库（见 .gitignore）。
 */

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var { spawnSync } = require('child_process');

var DESKTOP_DIR = path.resolve(__dirname, '..');
var REPO_ROOT = path.resolve(DESKTOP_DIR, '..');
var APP_DIR = path.join(DESKTOP_DIR, 'app');

/** 服务端运行时真正需要的东西。docs / web / test 都不进安装包 */
var ENTRIES = ['lib', 'bin', 'package.json', 'package-lock.json'];

var LOCK_MARKER = path.join(APP_DIR, 'node_modules', '.stage-lock');

function copyEntry(name) {
    var from = path.join(REPO_ROOT, name);
    var to = path.join(APP_DIR, name);

    if (!fs.existsSync(from)) {
        throw new Error('仓库里找不到 ' + name + '，stage 中止');
    }
    // force: 已存在的文件直接覆盖，不做删除
    fs.cpSync(from, to, { recursive: true, force: true });
}

function fileHash(file) {
    return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
}

function installIfNeeded() {
    var lockFile = path.join(APP_DIR, 'package-lock.json');
    var wanted = fileHash(lockFile);

    if (fs.existsSync(LOCK_MARKER) && fs.readFileSync(LOCK_MARKER, 'utf8').trim() === wanted) {
        console.log('[stage] 依赖没变，跳过 npm ci');
        return;
    }

    // --omit=dev：只要 dependencies（express / quickjs / ws 那几个），
    // 根目录 package.json 里的 devDependencies 一个都不装
    console.log('[stage] 在 app/ 里装生产依赖（npm ci --omit=dev）');
    var result = spawnSync('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], {
        cwd: APP_DIR,
        stdio: 'inherit',
        env: process.env
    });
    if (result.status !== 0) {
        throw new Error('npm ci 失败，退出码 ' + result.status);
    }

    fs.writeFileSync(LOCK_MARKER, wanted);
}

function main() {
    console.log('[stage] 仓库：' + REPO_ROOT);
    console.log('[stage] 目标：' + APP_DIR);

    fs.mkdirSync(APP_DIR, { recursive: true });
    ENTRIES.forEach(copyEntry);

    // lib/web 是管理台前端的构建产物，必须在。缺了的话页面会白屏，
    // 而那时候错误信息只会出现在浏览器控制台里，很难往这上面想。
    var webIndex = path.join(APP_DIR, 'lib', 'web', 'index.html');
    if (!fs.existsSync(webIndex)) {
        throw new Error('lib/web/index.html 不存在。先在仓库根目录跑 npm run build:web');
    }

    installIfNeeded();

    var count = fs.readdirSync(path.join(APP_DIR, 'node_modules')).length;
    console.log('[stage] 完成：app/node_modules 里有 ' + count + ' 个条目');
}

try {
    main();
} catch (err) {
    console.error('[stage] 失败：' + ((err && err.message) || err));
    process.exit(1);
}
