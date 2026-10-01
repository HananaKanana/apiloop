#!/bin/bash
#
# 两个 Mac 安装包一起打：Apple 芯片（arm64）和 Intel（x64）。
#
# 用法：APILOOP_CLOUD_URL=http://your-cloud:8080 bash agent-installer/mac/build-all.sh
#
# **必须给 APILOOP_CLOUD_URL**（L1 起）：云端地址打包时写死进安装包里的 app/cloud.json，
# 装完之后用户界面上没有地方能改。这里先查一遍，免得打到一半才失败。
# 两个包写的是同一个地址，原样传给 build.sh。
#
# 两个包的内容完全一样，只有里面的官方 node 和 Distribution 里的架构限制不同：
#   - node 分别下 node-<版本>-darwin-arm64.tar.gz 和 …-darwin-x64.tar.gz，各自的 sha256 都核对；
#   - hostArchitectures 都是 arm64,x86_64，装错架构由 installation-check 拒绝并给中文提示；
#   - 依赖只装一次（`npm ci` 的结果两种架构通用：没有原生模块，quickjs 是 wasm、
#     数据库用 Node 自带的 node:sqlite），第二个包会复用。
#
# 中间产物放在同一个 $WORK 里、但各自的子目录带架构后缀，所以第二次不用重新解压 node。
# 想换地方就设 APILOOP_BUILD_WORK。

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"

if [ -z "${APILOOP_CLOUD_URL:-}" ]; then
    printf 'build-all.sh: 请用 APILOOP_CLOUD_URL=<云端地址> 指定云端地址\n' >&2
    exit 1
fi
export APILOOP_CLOUD_URL

for arch in arm64 x64; do
    printf '\n########## 打 %s 包 ##########\n' "$arch"
    NODE_ARCH="$arch" bash "$HERE/build.sh"
done

printf '\n两个包都打好了（云端地址都是 %s）：\n' "$APILOOP_CLOUD_URL"
ls -lh "$HERE/../dist/"*.pkg
echo
echo "安装包**不签名**，用户第一次打开要点「仍要打开」。"
echo "不要自己安装：安装要输管理员密码，也会动系统。"
