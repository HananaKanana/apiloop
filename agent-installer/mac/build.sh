#!/bin/bash
#
# apiloop 本地网关：Mac arm64 安装包（.pkg）。
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
# 只用系统自带的 pkgbuild / productbuild / osacompile / pkgutil，仓库根目录的
# package.json 一个依赖都不加。
#
# 用法：bash agent-installer/mac/build.sh
# 产物：agent-installer/dist/apiloop-gateway-<版本>-arm64.pkg（不入库）

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

NODE_VERSION="${NODE_VERSION:-v24.21.0}"
NODE_ARCH="${NODE_ARCH:-arm64}"
NODE_MIRROR="${NODE_MIRROR:-https://npmmirror.com/mirrors/node}"
NODE_TEAM_ID="HX7739G8FX"
PKG_ID="com.apiloop.gateway"

WORK="$REPO/agent-installer/.work"
DIST="$REPO/agent-installer/dist"

log() { printf '\n===== %s =====\n' "$*"; }
die() { printf 'build.sh: %s\n' "$*" >&2; exit 1; }

for tool in curl tar shasum awk pkgbuild productbuild pkgutil codesign osacompile ditto node npm; do
    command -v "$tool" >/dev/null 2>&1 || die "缺少工具：$tool"
done

if [ "$(uname -s)" != "Darwin" ]; then
    die "这个脚本只能在 macOS 上跑（要用 pkgbuild / productbuild / osacompile）"
fi

VERSION="$(node -p "require('$REPO/package.json').version")"
[ -n "$VERSION" ] || die "读不出仓库 package.json 里的版本号"

mkdir -p "$WORK/cache" "$DIST"

log "目标"
printf '  版本      %s\n  架构      %s\n  Node      %s（nodejs.org 官方构建，镜像：%s）\n  工作目录  %s\n' \
    "$VERSION" "$NODE_ARCH" "$NODE_VERSION" "$NODE_MIRROR" "$WORK"

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
[ -n "$EXPECTED" ] || die "$SHASUMS 里没有 $TARBALL_NAME，镜像上可能还没有这个版本"

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
NODE_DIR="$WORK/node"
MARKER="$NODE_DIR/.apiloop-node-version"
if [ ! -f "$MARKER" ] || [ "$(cat "$MARKER")" != "$NODE_VERSION" ]; then
    rm -rf "$NODE_DIR"
    mkdir -p "$NODE_DIR"
    tar -xzf "$TARBALL" -C "$NODE_DIR" --strip-components=1
    printf '%s\n' "$NODE_VERSION" > "$MARKER"
fi
[ -x "$NODE_DIR/bin/node" ] || die "解压后没有 bin/node"
printf '  %s\n' "$("$NODE_DIR/bin/node" --version)"

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
# 锁文件没变就不重装：npm ci 会先把 node_modules 整个删掉，这一步在慢盘上很贵
LOCK_SHA="$(shasum -a 256 "$APP/package-lock.json" | awk '{print $1}')"
if [ ! -d "$APP/node_modules" ] || [ "$(cat "$APP/.apiloop-lock-sha" 2>/dev/null || true)" != "$LOCK_SHA" ]; then
    ( cd "$APP" && npm ci --omit=dev --no-audit --no-fund )
    printf '%s\n' "$LOCK_SHA" > "$APP/.apiloop-lock-sha"
else
    echo "  锁文件没变，复用已有的 node_modules"
fi
rm -f "$APP/.apiloop-lock-sha"
# 生产依赖里不该出现 devDependencies 的东西
[ -d "$APP/lib/web" ] || die "lib/web 不存在：先跑 npm run build:web"

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

# 启动器。osacompile 出来就是 ad-hoc 签名的（arm64 上没签名的 Mach-O 根本起不来），
# 这里只编译，不再额外签一次。
log "编译启动器 /Applications/apiloop.app"
osacompile -o "$ROOT/Applications/apiloop.app" "$HERE/launcher.applescript"
codesign -v "$ROOT/Applications/apiloop.app" >/dev/null 2>&1 || echo "  提示：启动器的 ad-hoc 签名校验没过"

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
cp "$HERE/scripts/postinstall" "$SCRIPTS/postinstall"
chmod 755 "$SCRIPTS/postinstall"

COMPONENT="$WORK/apiloop-gateway-component.pkg"
rm -f "$COMPONENT"

log "pkgbuild（不带 --sign：这个包就是不签名的，node 也一个字都没动）"
pkgbuild \
    --root "$ROOT" \
    --identifier "$PKG_ID" \
    --version "$VERSION" \
    --scripts "$SCRIPTS" \
    --ownership recommended \
    --install-location "/" \
    "$COMPONENT"

DIST_XML="$WORK/distribution.xml"
cat > "$DIST_XML" <<XML
<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="1">
    <title>apiloop</title>
    <organization>com.apiloop</organization>
    <domains enable_localSystem="true" enable_anywhere="false" enable_currentUserHome="false"/>
    <options customize="never" require-scripts="false" hostArchitectures="$NODE_ARCH"/>
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
rm -f "$OUT"

log "productbuild（同样不带 --sign）"
productbuild --distribution "$DIST_XML" --package-path "$WORK" "$OUT"

# ---------------------------------------------------------------- 5. 核对签名

log "展开刚打好的安装包，核对里面那份 node"
VERIFY="$WORK/verify"
rm -rf "$VERIFY"
mkdir -p "$VERIFY"
pkgutil --expand-full "$OUT" "$VERIFY/expanded"

PACKED_NODE="$(find "$VERIFY/expanded" -type f -path '*/apiloop/node/bin/node' | head -1)"
[ -n "$PACKED_NODE" ] || die "安装包里找不到 node/bin/node，打包结果不对"

SIG="$(codesign -dv --verbose=4 "$PACKED_NODE" 2>&1 || true)"
echo "----- codesign -dv --verbose=4 的输出 -----"
printf '%s\n' "$SIG"
echo "-----------------------------------------"

case "$SIG" in
    *"TeamIdentifier=$NODE_TEAM_ID"*) ;;
    *) die "安装包里 node 的 TeamIdentifier 不是 $NODE_TEAM_ID，打包流程里有人给它重新签名了" ;;
esac

log "逐字节比对：安装包里的 node vs 下载下来那份"
ORIGINAL_SHA="$(shasum -a 256 "$NODE_DIR/bin/node" | awk '{print $1}')"
PACKED_SHA="$(shasum -a 256 "$PACKED_NODE" | awk '{print $1}')"
printf '  下载的  %s\n  包里的  %s\n' "$ORIGINAL_SHA" "$PACKED_SHA"
[ "$ORIGINAL_SHA" = "$PACKED_SHA" ] || die "安装包里的 node 和下载的不一样（可能被重新签名了）"

log "安装包里的其它关键文件"
for probe in \
    "*/apiloop/app/bin/server" \
    "*/apiloop/app/lib/web/index.html" \
    "*/apiloop/app/lib/gateway/index.js" \
    "*/apiloop/app/node_modules/express/package.json" \
    "*/LaunchAgents/com.apiloop.gateway.plist" \
    "*/Applications/apiloop.app/Contents/MacOS/applet"
do
    found="$(find "$VERIFY/expanded" -path "$probe" | head -1)"
    if [ -n "$found" ]; then
        printf '  ✓ %s\n' "${found#"$VERIFY/expanded"/}"
    else
        die "安装包里缺少 $probe"
    fi
done

log "完成"
printf '  安装包  %s\n  大小    %s\n\n' "$OUT" "$(du -h "$OUT" | awk '{print $1}')"
echo "安装包**不签名**（用户机器上第一次打开要点「仍要打开」）。"
echo "不要自己安装：安装要输管理员密码，也会动用户的系统。"
