#!/bin/bash
#
# apiloop 本地网关：Mac 安装包（.pkg），arm64 与 x64 各一个。
#
# 为什么安装包里要带一份 Node：macOS 15 之后，没有苹果签名的程序访问同网段地址会被系统
# **直接拒绝，而且不弹授权框**；只有带签名、且由 launchd 直接启动的官方 Node 才能让系统
# 正常弹框（D0 第 3、4 轮实测）。所以这里的硬性要求是：
#
#   1. node 必须来自 nodejs.org（这里用国内镜像下同一份文件）；
#   2. **任何一步都不能对它重新签名** —— 全程不出现 codesign / --sign，
#      pkgbuild 与 productbuild 都只做打包；
#   3. 打完包把安装包展开，用 codesign -dv 核对里面的 node，TeamIdentifier 必须是 HX7739G8FX，
#      并且和下载下来那份逐字节相同（比 sha256）。
#
# 只用系统自带的 pkgbuild / productbuild / swiftc / pkgutil，仓库根目录的
# package.json 一个依赖都不加。
#
# 用法：APILOOP_CLOUD_URL=http://your-cloud:8080 bash agent-installer/mac/build.sh   （arm64）
#       NODE_ARCH=x64 APILOOP_CLOUD_URL=http://your-cloud:8080 bash …/build.sh      （Intel）
#       APILOOP_CLOUD_URL=http://your-cloud:8080 bash agent-installer/mac/build-all.sh（两个都打）
# 产物：agent-installer/dist/apiloop-gateway-<版本>-<架构>.pkg（不入库）
#
# **必须给 APILOOP_CLOUD_URL**，不给就拒绝打包（L1 起）。云端地址在打包时写死进
# `app/cloud.json`，装完之后用户界面上没有任何地方能改它 —— 换地址就是发一个新版本。
#
# **依赖里没有原生模块**（quickjs 是 wasm、sqlite 用 Node 自带的 node:sqlite），
# 所以 `npm ci` 的结果两种架构通用，不用为 x64 单独装一遍依赖。
#
# 写这个脚本的一个坑：变量后面紧跟中文时一律写 `${VAR}`。某些 locale 下 bash 会把变量名
# 后面的高位字节也算进名字里 —— 实测 `"完成（$NODE_ARCH）"` 报的是
# `NODE_ARCH<0xef>: unbound variable`，跑到最后一步才炸。

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

NODE_VERSION="${NODE_VERSION:-v24.21.0}"
NODE_ARCH="${NODE_ARCH:-arm64}"
NODE_MIRROR="${NODE_MIRROR:-https://npmmirror.com/mirrors/node}"
NODE_TEAM_ID="HX7739G8FX"
PKG_ID="com.apiloop.gateway"
# 壳子（/Applications/apiloop.app）的最低系统版本。`swiftc -target` 和 Info.plist 里
# 的 LSMinimumSystemVersion 用同一个值，两处不一致会在老系统上装完了打不开。
MIN_MACOS="12.0"

case "$NODE_ARCH" in
    arm64|x64) ;;
    *) printf 'build.sh: NODE_ARCH 只能是 arm64 或 x64，收到 %s\n' "$NODE_ARCH" >&2; exit 1 ;;
esac

# Distribution 里的 hostArchitectures 用的是**另一套名字**：x86_64 / arm64。
# 直接把 x64 写进去是个无效值，Installer 会当成「没有架构限制」。
if [ "$NODE_ARCH" = "x64" ]; then
    PKG_ARCH="x86_64"
else
    PKG_ARCH="arm64"
fi

# 中间产物一律不放在仓库里。两个理由：
#   1. 官方 node 解压后有 8000 多个文件，打一次包要整棵重建/整棵删掉；在 WorkBuddy 的
#      IDE 沙箱里，工作区内一次删超过 50 个文件会被「批量删除保护」拦下，脚本跑到一半
#      直接退出。放到 /tmp 就完全没有这个问题。
#   2. 这些中间产物加起来 300 MB 左右，没必要塞在仓库目录里（虽然 .gitignore 也挡得住）。
# 想固定住缓存（省一次 50MB 的下载）可以设 APILOOP_BUILD_WORK=<某个不入库的目录>。
#
# **两种架构共用同一个 $WORK，但各自的中间目录带架构后缀** —— 否则打完 arm64 再打 x64，
# 第二次会把第一次的 node 目录整个删掉重建，白等一次解压。
WORK="${APILOOP_BUILD_WORK:-/tmp/apiloop-agent-build}"
DIST="$REPO/agent-installer/dist"

log() { printf '\n===== %s =====\n' "$*"; }
die() { printf 'build.sh: %s\n' "$*" >&2; exit 1; }

for tool in curl tar shasum awk pkgbuild productbuild pkgutil codesign swiftc sips iconutil lipo ditto node npm; do
    command -v "$tool" >/dev/null 2>&1 || die "缺少工具：$tool"
done

if [ "$(uname -s)" != "Darwin" ]; then
    die "这个脚本只能在 macOS 上跑（要用 pkgbuild / productbuild / swiftc）"
fi

VERSION="$(node -p "require('$REPO/package.json').version")"
[ -n "$VERSION" ] || die "读不出仓库 package.json 里的版本号"

# ---------------------------------------------------------------- 0. 云端地址

# **打包时必须给云端地址**（L1 起）。它会写进安装包里的 `app/cloud.json`，网关照它转发和登录；
# 用户界面上没有任何地方能改，所以漏了这一步打出来的包是废的 —— 宁可在打包时就报错。
#
# 校验用的是网关运行时那同一份代码（`lib/gateway/cloud.js`）——云端地址的规则只此一处，
# 别在这儿再写一遍正则：两边不一致的话，打包时通过、运行时解析不了，最难查。
CLOUD_URL="$(
    APILOOP_CLOUD_URL="${APILOOP_CLOUD_URL:-}" node -e '
        var cloud = require(process.argv[1]);
        var url = cloud.normalizeCloudUrl(process.env.APILOOP_CLOUD_URL || "");
        if (!url || !cloud.parseCloudUrl(url)) process.exit(1);
        process.stdout.write(url);
    ' "$REPO/lib/gateway/cloud.js" || true
)"
[ -n "$CLOUD_URL" ] || die "请用 APILOOP_CLOUD_URL=<云端地址> 指定云端地址"

mkdir -p "$WORK/cache" "$DIST"

log "目标"
printf '  版本      %s\n  架构      %s（node 二进制：%s）\n  云端地址  %s\n  Node      %s（nodejs.org 官方构建，镜像：%s）\n  工作目录  %s\n' \
    "$VERSION" "$NODE_ARCH" "$PKG_ARCH" "$CLOUD_URL" "$NODE_VERSION" "$NODE_MIRROR" "$WORK"

# ---------------------------------------------------------------- 1. 官方 node

TARBALL_NAME="node-${NODE_VERSION}-darwin-${NODE_ARCH}.tar.gz"
BASE_URL="$NODE_MIRROR/$NODE_VERSION"
TARBALL="$WORK/cache/$TARBALL_NAME"
SHASUMS="$WORK/cache/SHASUMS256-${NODE_VERSION}.txt"

if [ ! -f "$SHASUMS" ]; then
    log "下载 $BASE_URL/SHASUMS256.txt"
    curl -fL --retry 3 --connect-timeout 20 -o "$SHASUMS.part" "$BASE_URL/SHASUMS256.txt"
    mv "$SHASUMS.part" "$SHASUMS"
fi

EXPECTED="$(awk -v f="$TARBALL_NAME" '$2 == f { print $1 }' "$SHASUMS")"
[ -n "$EXPECTED" ] || die "$SHASUMS 里没有 ${TARBALL_NAME}，镜像上可能还没有这个版本"

if [ ! -f "$TARBALL" ]; then
    log "下载 $BASE_URL/$TARBALL_NAME"
    curl -fL --retry 3 --connect-timeout 20 -o "$TARBALL.part" "$BASE_URL/$TARBALL_NAME"
    mv "$TARBALL.part" "$TARBALL"
fi

log "校验 node 的 sha256"
ACTUAL="$(shasum -a 256 "$TARBALL" | awk '{print $1}')"
if [ "$EXPECTED" != "$ACTUAL" ]; then
    die "sha256 不匹配，下载的文件有问题：
  期望 $EXPECTED
  实际 $ACTUAL
  删掉 $TARBALL 再试一次"
fi
printf '  %s  %s\n' "$ACTUAL" "$TARBALL_NAME"

log "解出 node（原样解压，不碰签名）"
# 目录带架构后缀：两种架构各自的 node 互不覆盖，打第二个包时不用重新解压
NODE_DIR="$WORK/node-$NODE_ARCH"
MARKER="$NODE_DIR/.apiloop-node-version"
if [ ! -f "$MARKER" ] || [ "$(cat "$MARKER")" != "$NODE_VERSION" ]; then
    rm -rf "$NODE_DIR"
    mkdir -p "$NODE_DIR"
    tar -xzf "$TARBALL" -C "$NODE_DIR" --strip-components=1
    printf '%s\n' "$NODE_VERSION" > "$MARKER"
fi
[ -x "$NODE_DIR/bin/node" ] || die "解压后没有 bin/node"
# 本机跑不了另一架构的 node（这台 Mac 没有 Rosetta 2，x64 的会报 Bad CPU type），
# 那只是**打印版本号**这一步跑不了 —— 包里那份文件本身没问题，下面用 file 核架构。
if BUILT_NODE_VERSION="$("$NODE_DIR/bin/node" --version 2>/dev/null)"; then
    printf '  %s\n' "$BUILT_NODE_VERSION"
else
    printf '  （本机跑不了这份 node，跳过版本打印；架构用 file 核）\n'
fi

# ---------------------------------------------------------------- 2. 暂存服务端

log "暂存服务端代码（bin / lib / package.json）"
APP="$WORK/app"
mkdir -p "$APP"
rm -rf "$APP/bin" "$APP/lib"
ditto "$REPO/bin" "$APP/bin"
ditto "$REPO/lib" "$APP/lib"
cp "$REPO/package.json" "$APP/package.json"
cp "$REPO/package-lock.json" "$APP/package-lock.json"

log "安装生产依赖（npm ci --omit=dev）"
# 锁文件没变就不重装：npm ci 会先把 node_modules 整个删掉，这一步在慢盘上很贵。
# **标记文件放 $WORK，不放 $APP** —— $APP 是要打进安装包的，放进去既会被打包带走，
# 又会被下面那行 rm 清掉，缓存判断永远不命中（N1）。
rm -f "$APP/.apiloop-lock-sha"        # 清掉旧版本遗留的那一个
LOCK_MARKER="$WORK/app-lock-sha"
LOCK_SHA="$(shasum -a 256 "$APP/package-lock.json" | awk '{print $1}')"
if [ ! -d "$APP/node_modules" ] || [ "$(cat "$LOCK_MARKER" 2>/dev/null || true)" != "$LOCK_SHA" ]; then
    ( cd "$APP" && npm ci --omit=dev --no-audit --no-fund )
    printf '%s\n' "$LOCK_SHA" > "$LOCK_MARKER"
else
    echo "  锁文件没变，复用已有的 node_modules"
fi
# 生产依赖里不该出现 devDependencies 的东西
[ -d "$APP/lib/web" ] || die "lib/web 不存在：先跑 npm run build:web"

# 云端地址写死进安装包（L1）。位置就是 app 根目录下的 cloud.json ——
# 网关从 `lib/gateway/cloud.js` 往上两层找它（`<安装目录>/app/cloud.json`）。
# 内容只有这一个键；用户改不了它，换地址就是发新版本。
printf '{\n  "cloudUrl": "%s"\n}\n' "$CLOUD_URL" > "$APP/cloud.json"
printf '  已写入 app/cloud.json：%s\n' "$(cat "$APP/cloud.json" | tr -d '\n')"

# ---------------------------------------------------------------- 3. 载荷

log "搭出安装后的目录树"
ROOT="$WORK/root"
rm -rf "$ROOT"
APILOOP_DIR="$ROOT/Library/Application Support/apiloop"
mkdir -p "$APILOOP_DIR" "$ROOT/Library/LaunchAgents" "$ROOT/Applications"

ditto "$NODE_DIR" "$APILOOP_DIR/node"
rm -f "$APILOOP_DIR/node/.apiloop-node-version"

ditto "$APP" "$APILOOP_DIR/app"

cp "$HERE/com.apiloop.gateway.plist" "$ROOT/Library/LaunchAgents/com.apiloop.gateway.plist"

cp "$HERE/uninstall.command" "$APILOOP_DIR/卸载 apiloop.command"
chmod 755 "$APILOOP_DIR/卸载 apiloop.command"

# 原生壳（L4）：一个很小的 Swift 程序（AppKit + WKWebView），换掉原来 osacompile
# 出来的那个启动器。**位置和 bundle id 都不变**（/Applications/apiloop.app、
# com.apiloop.launcher），所以覆盖安装那两道防线（BundleIsRelocatable=false 与
# preinstall）一个字都不用改。
log "编译原生壳 /Applications/apiloop.app"
LAUNCHER_APP="$ROOT/Applications/apiloop.app"
LAUNCHER_PLIST="$LAUNCHER_APP/Contents/Info.plist"
mkdir -p "$LAUNCHER_APP/Contents/MacOS" "$LAUNCHER_APP/Contents/Resources"

# 架构用的是 Distribution 那一套名字（x64 → x86_64）
if [ "$NODE_ARCH" = "x64" ]; then
    SWIFT_TARGET="x86_64-apple-macos${MIN_MACOS}"
else
    SWIFT_TARGET="arm64-apple-macos${MIN_MACOS}"
fi

# `-disable-autolinking-runtime-compatibility` **不能省**。Swift 驱动在「部署目标 < 13
# 的 x86_64」上会给每个目标文件塞一条 `-lswiftCompatibility56` / `-lswiftCompatibilityPacks`
# 自动链接指令，而 CommandLineTools 里这两个静态库只有 arm64 切片，于是 ld 报
#     Undefined symbols: __swift_FORCE_LOAD_$_swiftCompatibility56
# 直接失败（这台机器上连 `print("hi")` 都编不过）。那两个库是「Swift 并发 / 参数包」
# 回退到老系统的备份实现，这个壳两样都不用（没有 async、没有参数包）。
# 实测关掉之后 arm64 与 x86_64 两个二进制的 `otool -L` 依赖清单一致，都只用
# /usr/lib/swift 下那几个系统自带的 dylib，所以 macOS 12.0 的最低版本照样成立。
swiftc -O -swift-version 5 \
    -target "$SWIFT_TARGET" \
    -Xfrontend -disable-autolinking-runtime-compatibility \
    -framework AppKit -framework WebKit \
    "$HERE/shell/main.swift" \
    -o "$LAUNCHER_APP/Contents/MacOS/apiloop"

# Info.plist 由脚本写出来。**CFBundleIdentifier 不能变**：pkgbuild 判断「这是个 bundle
# 组件」靠的正是它，缺了或者换了就会报
#   error: Path ".../Applications/apiloop.app" is not a valid bundle component
# 然后直接退出，--component-plist 里那条 BundleIsRelocatable=false 根本轮不到生效；
# 覆盖安装时 Installer 也是按它认「这个是同一个 app」。
log "写壳子的 Info.plist"
cat > "$LAUNCHER_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleIdentifier</key>
    <string>com.apiloop.launcher</string>
    <key>CFBundleExecutable</key>
    <string>apiloop</string>
    <key>CFBundleName</key>
    <string>apiloop</string>
    <key>CFBundleDisplayName</key>
    <string>apiloop</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleInfoDictionaryVersion</key>
    <string>6.0</string>
    <key>CFBundleShortVersionString</key>
    <string>${VERSION}</string>
    <key>CFBundleVersion</key>
    <string>${VERSION}</string>
    <key>CFBundleIconFile</key>
    <string>apiloop</string>
    <key>LSMinimumSystemVersion</key>
    <string>${MIN_MACOS}</string>
    <key>NSHighResolutionCapable</key>
    <true/>
    <!-- 壳子只连 127.0.0.1，但 ATS 默认会拦明文 http。这条只放开本机网络，
         不是 NSAllowsArbitraryLoads —— 别的地址照旧走系统浏览器，壳子也连不到。 -->
    <key>NSAppTransportSecurity</key>
    <dict>
        <key>NSAllowsLocalNetworking</key>
        <true/>
    </dict>
</dict>
</plist>
PLIST
plutil -lint "$LAUNCHER_PLIST" >/dev/null || die "刚写出来的 Info.plist 不合法"

# 图标：编一个小工具画 1024×1024 的 PNG，再出 iconset 的 10 个尺寸合成 .icns。
# 图标工具按**本机架构**编（它是打包时跑一次的命令行程序，必须能在本机运行 ——
# 打 x64 包时也不能编成 x86_64，这台 Apple 芯片的机器跑不了）。
log "画图标 Resources/apiloop.icns"
ICON_DIR="$WORK/icon"
rm -rf "$ICON_DIR"
mkdir -p "$ICON_DIR/apiloop.iconset"
swiftc -O -swift-version 5 \
    -target "$(uname -m)-apple-macos${MIN_MACOS}" \
    -framework AppKit \
    "$HERE/shell/make-icon.swift" \
    -o "$ICON_DIR/make-icon"
"$ICON_DIR/make-icon" "$ICON_DIR/icon-1024.png"
for spec in 16:icon_16x16 32:icon_16x16@2x 32:icon_32x32 64:icon_32x32@2x \
            128:icon_128x128 256:icon_128x128@2x 256:icon_256x256 512:icon_256x256@2x \
            512:icon_512x512 1024:icon_512x512@2x; do
    pixels="${spec%%:*}"; name="${spec##*:}"
    sips -z "$pixels" "$pixels" "$ICON_DIR/icon-1024.png" \
        --out "$ICON_DIR/apiloop.iconset/$name.png" >/dev/null
done
iconutil -c icns "$ICON_DIR/apiloop.iconset" -o "$LAUNCHER_APP/Contents/Resources/apiloop.icns"

# ad-hoc 签名。arm64 上没有签名的 Mach-O 根本起不来；`--sign -` 是免证书的自签名，
# 不需要开发者账号（壳子只连 127.0.0.1，不触发任何 TCC 授权，harden runtime 也不用开）。
#
# **动的只是这个几百 KB 的壳**；安装包里那份官方 node 一个字节都没碰 ——
# 下面第 5 步还会拿 sha256 逐字节比对，并核对 TeamIdentifier。
codesign --force --sign - "$LAUNCHER_APP"
codesign -v "$LAUNCHER_APP" >/dev/null 2>&1 || echo "  提示：壳子的 ad-hoc 签名校验没过"

# 多用户的电脑上每个用户各跑一个网关，所以这些东西要对所有用户可读（目录可进）
chmod -R a+rX "$ROOT"
chmod 644 "$ROOT/Library/LaunchAgents/com.apiloop.gateway.plist"

log "载荷清单"
printf '  %s\n' "$ROOT/Library/LaunchAgents/com.apiloop.gateway.plist"
printf '  %s\n' "$ROOT/Applications/apiloop.app"
printf '  %s\n' "$APILOOP_DIR/卸载 apiloop.command"
printf '  %s（%s）\n' "$APILOOP_DIR/node/bin/node" "$(du -sh "$APILOOP_DIR/node" | awk '{print $1}')"
printf '  %s（%s）\n' "$APILOOP_DIR/app" "$(du -sh "$APILOOP_DIR/app" | awk '{print $1}')"

# ---------------------------------------------------------------- 4. 打 pkg

SCRIPTS="$WORK/scripts"
rm -rf "$SCRIPTS"
mkdir -p "$SCRIPTS"
cp "$HERE/scripts/preinstall" "$SCRIPTS/preinstall"
cp "$HERE/scripts/postinstall" "$SCRIPTS/postinstall"
chmod 755 "$SCRIPTS/preinstall" "$SCRIPTS/postinstall"

COMPONENT="$WORK/apiloop-gateway-component.pkg"
rm -f "$COMPONENT"

# 组件描述（N3）。`BundleIsRelocatable=false` 是要紧的那一条：用户把 apiloop.app 挪到
# 别处之后再覆盖安装时，Installer 默认会「就近更新」它找到的那份副本，/Applications
# 下于是永远没有干净的这一个。设成 false 就是「不准挪，就装在我说的位置」。
# （preinstall 再删一次旧的是第二道防线，两处都要。）
COMPONENT_PLIST="$WORK/component-plist.xml"
cat > "$COMPONENT_PLIST" <<'XML'
<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<array>
    <dict>
        <key>BundleHasStrictIdentifier</key>
        <false/>
        <key>BundleIsRelocatable</key>
        <false/>
        <key>BundleIsVersionChecked</key>
        <false/>
        <key>BundleOverwriteAction</key>
        <string>upgrade</string>
        <key>RootRelativeBundlePath</key>
        <string>Applications/apiloop.app</string>
    </dict>
</array>
</plist>
XML

log "pkgbuild（不带 --sign：这个包就是不签名的，node 也一个字都没动）"
pkgbuild \
    --root "$ROOT" \
    --identifier "$PKG_ID" \
    --version "$VERSION" \
    --scripts "$SCRIPTS" \
    --component-plist "$COMPONENT_PLIST" \
    --ownership recommended \
    --install-location "/" \
    "$COMPONENT"

# 装错架构时直接拒绝（审阅重点第 3 条）。判断依据是 `hw.optional.arm64`：
# Apple 芯片上是 1，Intel 上这个 oid 不存在（Installer 的 sysctl 取不到就返回 null）。
#
# 这段 JS 里**不能出现 `<`、`>`、`&`** —— 它是写在 XML 的 <script> 里的，
# 这几个字符要么被当成标签、要么必须转义。所以一律用 === / !== / || 表达。
#
# installation-check 的约定（Installer JavaScript）：返回 true 放行；要拒绝时先填好
# my.result（type 设成 'Fatal'，title / message 是给用户看的），再**返回 false**。
# 返回一个字符串不是约定的写法 —— 非空字符串会被当成「真」，结果照样放行。
#
# hostArchitectures 两个包都写 "arm64,x86_64"：只写 x86_64 的话，Apple 芯片上的 Installer
# 会先弹「需要安装 Rosetta」，轮不到下面这段中文提示。架构由这段脚本来拦，不交给它。
if [ "$NODE_ARCH" = "arm64" ]; then
    WANTS_ARM="true"
    WRONG_MSG="这是 Apple 芯片版。你的 Mac 是 Intel 芯片，请下载 Intel 芯片版。"
else
    WANTS_ARM="false"
    WRONG_MSG="这是 Intel 芯片版。你的 Mac 是 Apple 芯片（M 系列），请下载 Apple 芯片版。"
fi

DIST_XML="$WORK/distribution-$NODE_ARCH.xml"
cat > "$DIST_XML" <<XML
<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="1">
    <title>apiloop</title>
    <organization>com.apiloop</organization>
    <domains enable_localSystem="true" enable_anywhere="false" enable_currentUserHome="false"/>
    <options customize="never" require-scripts="false" hostArchitectures="arm64,x86_64"/>
    <installation-check script="apiloopCheckChip()"/>
    <script>
    function apiloopCheckChip() {
        var silicon = false;
        try {
            var raw = system.sysctl('hw.optional.arm64');
            if (raw === 1) { silicon = true; }
            if (raw === '1') { silicon = true; }
        } catch (err) {
            silicon = false;
        }
        if ($WANTS_ARM === silicon) { return true; }
        my.result.type = 'Fatal';
        my.result.title = '芯片类型不对';
        my.result.message = '$WRONG_MSG';
        return false;
    }
    </script>
    <choices-outline>
        <line choice="default">
            <line choice="$PKG_ID"/>
        </line>
    </choices-outline>
    <choice id="default"/>
    <choice id="$PKG_ID" visible="false">
        <pkg-ref id="$PKG_ID"/>
    </choice>
    <pkg-ref id="$PKG_ID" version="$VERSION" onConclusion="none">$(basename "$COMPONENT")</pkg-ref>
</installer-gui-script>
XML

OUT="$DIST/apiloop-gateway-$VERSION-$NODE_ARCH.pkg"
# **先在 $WORK 里打，再用 cp 覆盖到 dist**。不在 dist 里直接 productbuild + 先删旧的：
# 删那个几十 MB 的 flat pkg 在某些环境下会触发「一次删太多」的保护（实测把它算成几千个
# 条目），脚本会跑到最后一步才失败。cp 是覆盖写，不产生删除。
BUILT="$WORK/apiloop-gateway-$VERSION-$NODE_ARCH.pkg"
rm -f "$BUILT"

log "productbuild（同样不带 --sign）"
productbuild --distribution "$DIST_XML" --package-path "$WORK" "$BUILT"

mkdir -p "$DIST"
cp -f "$BUILT" "$OUT"

# ---------------------------------------------------------------- 5. 核对签名

log "展开刚打好的安装包，核对里面那份 node"
VERIFY="$WORK/verify-$NODE_ARCH"
rm -rf "$VERIFY"
mkdir -p "$VERIFY"
pkgutil --expand-full "$OUT" "$VERIFY/expanded"

PACKED_NODE="$(find "$VERIFY/expanded" -type f -path '*/apiloop/node/bin/node' | head -1)"
[ -n "$PACKED_NODE" ] || die "安装包里找不到 node/bin/node，打包结果不对"

echo "----- file 的结果（架构要对得上）-----"
file "$PACKED_NODE"
echo "--------------------------------------"
case "$(file -b "$PACKED_NODE")" in
    *"$PKG_ARCH"*) ;;
    *) die "安装包里的 node 不是 ${PKG_ARCH}：$(file -b "$PACKED_NODE")" ;;
esac

SIG="$(codesign -dv --verbose=4 "$PACKED_NODE" 2>&1 || true)"
echo "----- codesign -dv --verbose=4 的输出 -----"
printf '%s\n' "$SIG"
echo "-----------------------------------------"

case "$SIG" in
    *"TeamIdentifier=$NODE_TEAM_ID"*) ;;
    *) die "安装包里 node 的 TeamIdentifier 不是 ${NODE_TEAM_ID}，打包流程里有人给它重新签名了" ;;
esac

log "逐字节比对：安装包里的 node vs 下载下来那份"
ORIGINAL_SHA="$(shasum -a 256 "$NODE_DIR/bin/node" | awk '{print $1}')"
PACKED_SHA="$(shasum -a 256 "$PACKED_NODE" | awk '{print $1}')"
printf '  下载的  %s\n  包里的  %s\n' "$ORIGINAL_SHA" "$PACKED_SHA"
[ "$ORIGINAL_SHA" = "$PACKED_SHA" ] || die "安装包里的 node 和下载的不一样（可能被重新签名了）"

log "核对 Distribution（架构限制与装错架构时的提示）"
DIST_CONTENT="$(cat "$VERIFY/expanded/Distribution")"
case "$DIST_CONTENT" in
    *'hostArchitectures="arm64,x86_64"'*) echo '  ✓ hostArchitectures="arm64,x86_64"（架构由 installation-check 拦）' ;;
    *) die "Distribution 里的 hostArchitectures 不是 arm64,x86_64" ;;
esac
case "$DIST_CONTENT" in
    *'installation-check script="apiloopCheckChip()"'*) echo "  ✓ installation-check 已挂上" ;;
    *) die "Distribution 里没有 installation-check" ;;
esac
case "$DIST_CONTENT" in
    *"$WRONG_MSG"*) printf '  ✓ 提示文字：%s\n' "$WRONG_MSG" ;;
    *) die "Distribution 里没有那句中文提示" ;;
esac

log "核对安装包里写死的云端地址（L1）"
PACKED_CLOUD_JSON="$(find "$VERIFY/expanded" -type f -path '*/apiloop/app/cloud.json' | head -1)"
[ -n "$PACKED_CLOUD_JSON" ] || die "安装包里没有 app/cloud.json：网关装完不知道该连哪个云端"
PACKED_CLOUD_URL="$(node -e '
    var fs = require("fs");
    var parsed = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    process.stdout.write(String(parsed.cloudUrl || ""));
' "$PACKED_CLOUD_JSON")"
printf '  包里的  %s\n  期望的  %s\n' "$PACKED_CLOUD_URL" "$CLOUD_URL"
[ "$PACKED_CLOUD_URL" = "$CLOUD_URL" ] || die "安装包里的 cloud.json 和 APILOOP_CLOUD_URL 对不上"
echo "  ✓ app/cloud.json 是 $CLOUD_URL"

log "核对覆盖安装的两道防线（N3）"
PKGINFO_PATH="$(find "$VERIFY/expanded" -type f -name 'PackageInfo' | head -1)"
[ -n "$PKGINFO_PATH" ] || die "展开后的安装包里找不到 PackageInfo"
PKGINFO_CONTENT="$(cat "$PKGINFO_PATH")"
case "$PKGINFO_CONTENT" in
    *'relocatable="false"'*) echo '  ✓ PackageInfo 里 relocatable="false"（BundleIsRelocatable 生效）' ;;
    *) die "component-plist 没生效：PackageInfo 里没有 relocatable=\"false\"" ;;
esac
case "$PKGINFO_CONTENT" in
    *'com.apiloop.launcher'*) echo "  ✓ 壳子被当成 bundle 组件（com.apiloop.launcher）" ;;
    *) die "壳子没有被识别成 bundle：是不是 Info.plist 里的 CFBundleIdentifier 丢了" ;;
esac

PREINSTALL_PATH="$(find "$VERIFY/expanded" -type f -path '*/Scripts/preinstall' | head -1)"
[ -n "$PREINSTALL_PATH" ] || die "安装包里没有 preinstall 脚本"
POSTINSTALL_PATH="$(find "$VERIFY/expanded" -type f -path '*/Scripts/postinstall' | head -1)"
[ -n "$POSTINSTALL_PATH" ] || die "安装包里没有 postinstall 脚本"
echo "  ✓ Scripts/preinstall 与 Scripts/postinstall 都在包里"
case "$(cat "$POSTINSTALL_PATH")" in
    *'launchctl asuser "$CONSOLE_UID" sudo -u "$CONSOLE_USER" open'*)
        echo "  ✓ postinstall 用 launchctl asuser 打开壳子（N2）" ;;
    *) die "postinstall 里没有 launchctl asuser（N2 没改到）" ;;
esac

log "核对壳子（架构 / Info.plist / 签名）"
LAUNCHER_PATH="$(find "$VERIFY/expanded" -type d -name 'apiloop.app' | head -1)"
[ -n "$LAUNCHER_PATH" ] || die "安装包里找不到 apiloop.app"
echo "  ✓ $LAUNCHER_PATH"

SHELL_BIN="$LAUNCHER_PATH/Contents/MacOS/apiloop"
[ -f "$SHELL_BIN" ] || die "壳子里没有 Contents/MacOS/apiloop"
file "$SHELL_BIN" | sed 's/^/  /'
SHELL_ARCHS="$(lipo -archs "$SHELL_BIN")"
printf '  lipo -archs → %s（期望 %s）\n' "$SHELL_ARCHS" "$PKG_ARCH"
[ "$SHELL_ARCHS" = "$PKG_ARCH" ] || die "壳子的架构不对：$SHELL_ARCHS"

SHELL_PLIST="$LAUNCHER_PATH/Contents/Info.plist"
plutil -lint "$SHELL_PLIST" | sed 's/^/  /'
SHELL_BUNDLE_ID="$(plutil -extract CFBundleIdentifier raw -o - "$SHELL_PLIST")"
printf '  CFBundleIdentifier = %s\n' "$SHELL_BUNDLE_ID"
# bundle id 变了，覆盖安装就会当成另一个 app：旧的那份留在 /Applications 里，
# 用户点开看到的还是老壳子
[ "$SHELL_BUNDLE_ID" = "com.apiloop.launcher" ] || die "壳子的 bundle id 变了：$SHELL_BUNDLE_ID"
SHELL_MIN="$(plutil -extract LSMinimumSystemVersion raw -o - "$SHELL_PLIST")"
[ "$SHELL_MIN" = "$MIN_MACOS" ] || die "壳子的 LSMinimumSystemVersion 不是 ${MIN_MACOS}：$SHELL_MIN"
SHELL_EXEC="$(plutil -extract CFBundleExecutable raw -o - "$SHELL_PLIST")"
[ "$SHELL_EXEC" = "apiloop" ] || die "CFBundleExecutable 不是 apiloop：$SHELL_EXEC"
echo "  ✓ exec / 最低系统版本都对"
[ -f "$LAUNCHER_PATH/Contents/Resources/apiloop.icns" ] || die "壳子里没有图标"
echo "  ✓ 图标 apiloop.icns 在"

if codesign -v "$LAUNCHER_PATH" >/dev/null 2>&1; then
    echo "  ✓ codesign -v 通过（ad-hoc 自签名）"
else
    die "壳子的签名校验没过：codesign --force --sign - 那一步没生效"
fi

log "核对日志路径（N4：plist 里不该再有 StandardOutPath）"
PLIST_PATH="$(find "$VERIFY/expanded" -type f -name 'com.apiloop.gateway.plist' | head -1)"
[ -n "$PLIST_PATH" ] || die "安装包里找不到 LaunchAgent plist"
PLIST_CONTENT="$(cat "$PLIST_PATH")"
# 比的是**键本身**（<key>StandardOutPath</key>），不是这个词：plist 里那段注释专门
# 解释了为什么不能设它，拿裸词去比会把注释也算成「没修掉」。
case "$PLIST_CONTENT" in
    *'<key>StandardOutPath</key>'*) die "plist 里还有 StandardOutPath：多用户共用 /tmp 的那个问题没修掉" ;;
    *'<key>StandardErrorPath</key>'*) die "plist 里还有 StandardErrorPath：多用户共用 /tmp 的那个问题没修掉" ;;
    *) echo "  ✓ plist 里没有 StandardOutPath / StandardErrorPath" ;;
esac
case "$PLIST_CONTENT" in
    *'node/bin/node'*) echo "  ✓ ProgramArguments 里是官方 node 的绝对路径" ;;
    *) die "plist 的 ProgramArguments 不对" ;;
esac

log "安装包里的其它关键文件"
for probe in \
    "*/apiloop/app/bin/server" \
    "*/apiloop/app/lib/gateway/index.js" \
    "*/apiloop/app/lib/web/index.html" \
    "*/apiloop/app/node_modules/express/package.json" \
    "*/apiloop/app/node_modules/ws/package.json" \
    "*/LaunchAgents/com.apiloop.gateway.plist" \
    "*/Applications/apiloop.app/Contents/MacOS/apiloop" \
    "*/Applications/apiloop.app/Contents/Resources/apiloop.icns" \
    "*/Applications/apiloop.app/Contents/Info.plist"
do
    found="$(find "$VERIFY/expanded" -path "$probe" | head -1)"
    if [ -n "$found" ]; then
        printf '  ✓ %s\n' "${found#"$VERIFY/expanded"/}"
    else
        die "安装包里缺少 $probe"
    fi
done

log "完成（${NODE_ARCH}）"
printf '  安装包  %s\n  大小    %s\n  中间产物 %s（可以随时删掉，下次会重新下载 node）\n\n' \
    "$OUT" "$(du -h "$OUT" | awk '{print $1}')" "$WORK"
echo "安装包**不签名**（用户机器上第一次打开要点「仍要打开」）。"
echo "不要自己安装：安装要输管理员密码，也会动用户的系统。"
