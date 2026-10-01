#!/bin/bash
#
# apiloop 本地网关：Windows 安装包（apiloop-gateway-<版本>-win-x64.exe）。
#
# **在 Mac 上打**，不需要 Windows 机器：
#   - node：nodejs.org 官方的 win-x64 zip（npmmirror 镜像），按 SHASUMS256 校验；
#   - 服务端代码：和 Mac 包同一份（bin / lib / 生产依赖）。依赖里没有原生模块
#     （SQLite 用的是 node 自带的 node:sqlite，脚本沙箱是 wasm），所以 Mac 上 npm ci
#     装出来的 node_modules 拿到 Windows 上原样能用；
#   - 窗口程序 apiloop.exe 和安装程序：C# / .NET Framework 4.8，用 dotnet SDK 交叉编译。
#
# 产物装到 %LOCALAPPDATA%\Programs\apiloop，不需要管理员权限；安装包不签名，
# 第一次运行时 Windows 会提示「Windows 已保护你的电脑」，点「更多信息 → 仍要运行」。
#
# 用法：APILOOP_CLOUD_URL=http://your-cloud:8080 bash agent-installer/windows/build.sh

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
WORK="${APILOOP_WIN_BUILD_DIR:-/tmp/apiloop-win-build}"
DIST="$REPO/agent-installer/dist"
NODE_VERSION="${NODE_VERSION:-v24.21.0}"
NODE_MIRROR="${NODE_MIRROR:-https://npmmirror.com/mirrors/node}"

log() { printf '\n===== %s =====\n' "$*"; }
die() { printf 'windows/build.sh: %s\n' "$*" >&2; exit 1; }

for tool in curl shasum awk unzip zip dotnet node npm swiftc sips python3; do
    command -v "$tool" >/dev/null 2>&1 || die "缺少工具：$tool"
done

VERSION="$(node -p "require('$REPO/package.json').version")"
[ -n "$VERSION" ] || die "读不出仓库 package.json 里的版本号"

# 云端地址：和 Mac 包一样打包时写死进 app/cloud.json，校验用网关运行时那同一份代码
CLOUD_URL="$(
    APILOOP_CLOUD_URL="${APILOOP_CLOUD_URL:-}" node -e '
        var cloud = require(process.argv[1]);
        var url = cloud.normalizeCloudUrl(process.env.APILOOP_CLOUD_URL || "");
        if (!url || !cloud.parseCloudUrl(url)) process.exit(1);
        process.stdout.write(url);
    ' "$REPO/lib/gateway/cloud.js" || true
)"
[ -n "$CLOUD_URL" ] || die "请用 APILOOP_CLOUD_URL=<云端地址> 指定云端地址"

OUT_NAME="apiloop-gateway-${VERSION}-win-x64.exe"
mkdir -p "$WORK/cache" "$DIST"

log "目标"
printf '  版本      %s\n  云端地址  %s\n  Node      %s（win-x64，镜像：%s）\n  工作目录  %s\n  产物      %s\n' \
    "$VERSION" "$CLOUD_URL" "$NODE_VERSION" "$NODE_MIRROR" "$WORK" "$OUT_NAME"

# ---------------------------------------------------------------- 1. 官方 node.exe

ZIP_NAME="node-${NODE_VERSION}-win-x64.zip"
BASE_URL="$NODE_MIRROR/$NODE_VERSION"
NODE_ZIP="$WORK/cache/$ZIP_NAME"
SHASUMS="$WORK/cache/SHASUMS256-${NODE_VERSION}.txt"

if [ ! -f "$SHASUMS" ]; then
    log "下载 $BASE_URL/SHASUMS256.txt"
    curl -fL --retry 3 --connect-timeout 20 -o "$SHASUMS.part" "$BASE_URL/SHASUMS256.txt"
    mv "$SHASUMS.part" "$SHASUMS"
fi
EXPECTED="$(awk -v f="$ZIP_NAME" '$2 == f { print $1 }' "$SHASUMS")"
[ -n "$EXPECTED" ] || die "$SHASUMS 里没有 ${ZIP_NAME}"

if [ ! -f "$NODE_ZIP" ]; then
    log "下载 $BASE_URL/$ZIP_NAME"
    curl -fL --retry 3 --connect-timeout 20 -o "$NODE_ZIP.part" "$BASE_URL/$ZIP_NAME"
    mv "$NODE_ZIP.part" "$NODE_ZIP"
fi

log "校验 node 的 sha256"
ACTUAL="$(shasum -a 256 "$NODE_ZIP" | awk '{print $1}')"
[ "$EXPECTED" = "$ACTUAL" ] || die "sha256 不匹配：期望 $EXPECTED，实际 $ACTUAL。删掉 $NODE_ZIP 再试"
printf '  %s  %s\n' "$ACTUAL" "$ZIP_NAME"

# 只要 node.exe 一个文件（npm 之类用不上）
NODE_EXE="$WORK/node.exe"
unzip -o -j -q "$NODE_ZIP" "node-${NODE_VERSION}-win-x64/node.exe" -d "$WORK"
[ -f "$NODE_EXE" ] || die "zip 里没有 node.exe"

# ---------------------------------------------------------------- 2. 服务端代码

log "暂存服务端代码（bin / lib / 生产依赖）"
[ -d "$REPO/lib/web" ] || die "lib/web 不存在：先跑 npm run build:web"
APP="$WORK/app"
mkdir -p "$APP"
rm -rf "$APP/bin" "$APP/lib"
cp -R "$REPO/bin" "$APP/bin"
cp -R "$REPO/lib" "$APP/lib"
cp "$REPO/package.json" "$REPO/package-lock.json" "$APP/"

LOCK_MARKER="$WORK/app-lock-sha"
LOCK_SHA="$(shasum -a 256 "$APP/package-lock.json" | awk '{print $1}')"
if [ ! -d "$APP/node_modules" ] || [ "$(cat "$LOCK_MARKER" 2>/dev/null || true)" != "$LOCK_SHA" ]; then
    ( cd "$APP" && npm ci --omit=dev --no-audit --no-fund )
    printf '%s\n' "$LOCK_SHA" > "$LOCK_MARKER"
else
    echo "  锁文件没变，复用已有的 node_modules"
fi

# 依赖里要是混进了原生模块（.node 文件），Mac 上装出来的那份在 Windows 上用不了 —— 宁可打包时就停
NATIVE="$(find "$APP/node_modules" -name '*.node' -type f | head -1 || true)"
[ -z "$NATIVE" ] || die "生产依赖里有原生模块，Mac 上装的不能给 Windows 用：$NATIVE"

printf '{\n  "cloudUrl": "%s"\n}\n' "$CLOUD_URL" > "$APP/cloud.json"
printf '  已写入 app/cloud.json：%s\n' "$(tr -d '\n' < "$APP/cloud.json")"

# ---------------------------------------------------------------- 3. 图标

log "画图标 apiloop.ico（和 Mac 同一张图）"
ICON_DIR="$WORK/icon"
rm -rf "$ICON_DIR"
mkdir -p "$ICON_DIR"
swiftc -O -swift-version 5 -target "$(uname -m)-apple-macos12.0" -framework AppKit \
    "$REPO/agent-installer/mac/shell/make-icon.swift" -o "$ICON_DIR/make-icon"
"$ICON_DIR/make-icon" "$ICON_DIR/icon-1024.png" >/dev/null
for size in 16 24 32 48 64 128 256; do
    sips -z "$size" "$size" "$ICON_DIR/icon-1024.png" --out "$ICON_DIR/icon-$size.png" >/dev/null
done
# .ico 就是一个目录头 + 若干张 PNG（Vista 起支持 PNG 条目），几行 python 就能拼出来
python3 - "$ICON_DIR" <<'PY'
import struct, sys, os
d = sys.argv[1]
sizes = [16, 24, 32, 48, 64, 128, 256]
images = [open(os.path.join(d, 'icon-%d.png' % s), 'rb').read() for s in sizes]
offset = 6 + 16 * len(sizes)
out = struct.pack('<HHH', 0, 1, len(sizes))
for size, data in zip(sizes, images):
    dim = 0 if size == 256 else size
    out += struct.pack('<BBBBHHII', dim, dim, 0, 0, 1, 32, len(data), offset)
    offset += len(data)
open(os.path.join(d, 'apiloop.ico'), 'wb').write(out + b''.join(images))
PY
ICON="$ICON_DIR/apiloop.ico"
printf '  %s（%s 字节）\n' "$ICON" "$(wc -c < "$ICON" | tr -d ' ')"

# ---------------------------------------------------------------- 4. 窗口程序 apiloop.exe

log "编译窗口程序 apiloop.exe"
SHELL_OUT="$WORK/shell-out"
rm -rf "$SHELL_OUT"
dotnet build "$HERE/shell/apiloop.csproj" -c Release -nologo -v quiet \
    -p:Version="$VERSION" -p:ApiloopIcon="$ICON" -o "$SHELL_OUT"
[ -f "$SHELL_OUT/apiloop.exe" ] || die "没编出 apiloop.exe"

# ---------------------------------------------------------------- 5. 载荷

log "搭出安装后的目录（payload.zip）"
PAYLOAD="$WORK/payload"
rm -rf "$PAYLOAD"
mkdir -p "$PAYLOAD/node" "$PAYLOAD/runtimes/win-x64/native"
cp "$NODE_EXE" "$PAYLOAD/node/node.exe"
cp -R "$APP" "$PAYLOAD/app"
rm -f "$PAYLOAD/app/package-lock.json"
cp "$SHELL_OUT/apiloop.exe" "$SHELL_OUT/apiloop.exe.config" \
   "$SHELL_OUT/Microsoft.Web.WebView2.Core.dll" "$SHELL_OUT/Microsoft.Web.WebView2.WinForms.dll" "$PAYLOAD/"
cp "$SHELL_OUT/runtimes/win-x64/native/WebView2Loader.dll" "$PAYLOAD/runtimes/win-x64/native/"
# WebView2 的 WinForms 版在 .NET Framework 下按 exe 旁边找 WebView2Loader.dll，两处都放一份最稳
cp "$SHELL_OUT/runtimes/win-x64/native/WebView2Loader.dll" "$PAYLOAD/"

PAYLOAD_ZIP="$WORK/payload.zip"
rm -f "$PAYLOAD_ZIP"
( cd "$PAYLOAD" && zip -qr -X "$PAYLOAD_ZIP" . )
printf '  payload.zip %s 字节\n' "$(wc -c < "$PAYLOAD_ZIP" | tr -d ' ')"

# ---------------------------------------------------------------- 6. 安装程序

log "编译安装程序"
SETUP_OUT="$WORK/setup-out"
rm -rf "$SETUP_OUT"
dotnet build "$HERE/setup/setup.csproj" -c Release -nologo -v quiet \
    -p:Version="$VERSION" -p:ApiloopIcon="$ICON" -p:ApiloopPayload="$PAYLOAD_ZIP" -o "$SETUP_OUT"
[ -f "$SETUP_OUT/apiloop-setup.exe" ] || die "没编出安装程序"

cp "$SETUP_OUT/apiloop-setup.exe" "$DIST/$OUT_NAME"

# ---------------------------------------------------------------- 7. 核对

log "核对"
file "$DIST/$OUT_NAME" | sed 's/^/  /'
case "$(file "$DIST/$OUT_NAME")" in
    *PE32+*x86-64*) echo "  ✓ 是 64 位 Windows 程序" ;;
    *) die "产物不是 64 位 Windows 程序" ;;
esac
for need in node/node.exe apiloop.exe apiloop.exe.config Microsoft.Web.WebView2.Core.dll \
            Microsoft.Web.WebView2.WinForms.dll WebView2Loader.dll app/bin/server app/cloud.json \
            app/lib/gateway/index.js app/lib/web/index.html app/node_modules/express/package.json; do
    unzip -l "$PAYLOAD_ZIP" "$need" >/dev/null 2>&1 || die "payload.zip 里缺 $need"
    printf '  ✓ %s\n' "$need"
done
unzip -p "$PAYLOAD_ZIP" app/cloud.json | grep -q "$CLOUD_URL" && echo "  ✓ app/cloud.json 是 $CLOUD_URL"

log "完成"
printf '  %s（%s 字节）\n' "$DIST/$OUT_NAME" "$(wc -c < "$DIST/$OUT_NAME" | tr -d ' ')"
echo
echo "安装包**不签名**：第一次运行时点「更多信息 → 仍要运行」。"
echo "不要在这台 Mac 上试图运行它；拿到 Windows 10 / 11 上双击安装。"
