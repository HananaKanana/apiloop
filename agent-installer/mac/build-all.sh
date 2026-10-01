#!/bin/bash
#
# 两个 Mac 安装包一起打：Apple 芯片（arm64）和 Intel（x64）。
#
# 用法：bash agent-installer/mac/build-all.sh
#
# 两个包的内容完全一样，只有里面的官方 node 和 Distribution 里的架构限制不同：
#   - node 分别下 node-<版本>-darwin-arm64.tar.gz 和 …-darwin-x64.tar.gz，各自的 sha256 都核对；
#   - hostArchitectures 分别是 arm64 / x86_64，装错架构会被安装器直接拒绝；
#   - 依赖只装一次（`npm ci` 的结果两种架构通用：没有原生模块，quickjs 是 wasm、
#     数据库用 Node 自带的 node:sqlite），第二个包会复用。
#
# 中间产物放在同一个 $WORK 里、但各自的子目录带架构后缀，所以第二次不用重新解压 node。
# 想换地方就设 APILOOP_BUILD_WORK。

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"

for arch in arm64 x64; do
    printf '\n########## 打 %s 包 ##########\n' "$arch"
    NODE_ARCH="$arch" bash "$HERE/build.sh"
done

printf '\n两个包都打好了：\n'
ls -lh "$HERE/../dist/"*.pkg
echo
echo "安装包**不签名**，用户第一次打开要点「仍要打开」。"
echo "不要自己安装：安装要输管理员密码，也会动系统。"
