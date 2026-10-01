#!/bin/bash
#
# apiloop 卸载。双击运行即可。
#
# 删掉的东西：后台服务、LaunchAgent、安装目录（含官方 Node）、启动器 .app。
# **不删 ~/.apiloop** —— 那是用户数据（云端地址、端口文件，以后还有本地库）。
#
# LaunchAgent 装在 /Library 下，所以需要管理员权限；这里自己 sudo 一把，
# 免得用户还要开终端手敲命令。

set -u

APP_SUPPORT="/Library/Application Support/apiloop"
LA_PLIST="/Library/LaunchAgents/com.apiloop.gateway.plist"
LAUNCHER_APP="/Applications/apiloop.app"

if [ "$(id -u)" -ne 0 ]; then
    echo "卸载 apiloop 需要管理员权限，请输入你的登录密码："
    # 路径里有空格，必须整体引用
    exec sudo "$0" "$@"
fi

CONSOLE_USER=$(stat -f %Su /dev/console)
case "$CONSOLE_USER" in
    ""|root|loginwindow) CONSOLE_UID="" ;;
    *) CONSOLE_UID=$(id -u "$CONSOLE_USER" 2>/dev/null || echo "") ;;
esac

if [ -n "$CONSOLE_UID" ]; then
    echo "停止后台服务（gui/$CONSOLE_UID）…"
    launchctl bootout "gui/$CONSOLE_UID/com.apiloop.gateway" 2>/dev/null || true
else
    echo "当前没有图形会话，跳过停服务这一步。"
fi

echo "删除 $LA_PLIST"
rm -f "$LA_PLIST"

echo "删除 $APP_SUPPORT"
rm -rf "$APP_SUPPORT"

echo "删除 $LAUNCHER_APP"
rm -rf "$LAUNCHER_APP"

echo
echo "apiloop 已卸载。"
echo "注意：~/.apiloop **没有**删除，里面是你的数据（云端地址、端口文件）。"
echo "      要一起清掉就自己执行：rm -rf ~/.apiloop"
echo
read -n 1 -s -r -p "按任意键关闭这个窗口…"
echo
