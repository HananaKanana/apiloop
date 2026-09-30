#!/usr/bin/env bash
# apiloop 的 Docker 部署脚本（基于 docker compose）
#
# 用法：
#   ./deploy.sh              构建镜像并后台启动（等同 ./deploy.sh up）
#   ./deploy.sh up --cn      使用国内 npm 镜像源构建
#   ./deploy.sh logs         查看实时日志
#   ./deploy.sh restart      重启服务
#   ./deploy.sh stop         停止服务（数据保存在 ./data）
#   ./deploy.sh status       查看运行状态
#   ./deploy.sh user ...     在容器里执行用户命令，例如 ./deploy.sh user list、./deploy.sh user reset-password admin
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 检测可用的 Compose 命令：支持新版 `docker compose` 插件和独立的 `docker-compose`
detect_compose() {
  if [ -n "${DOCKER_COMPOSE:-}" ]; then
    read -r -a COMPOSE <<< "$DOCKER_COMPOSE"
    return
  fi
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    COMPOSE=(docker compose)
    return
  fi
  if command -v docker-compose >/dev/null 2>&1; then
    COMPOSE=(docker-compose)
    return
  fi
  echo "错误：未找到 Docker Compose（docker compose 插件或 docker-compose 命令）。" >&2
  echo "  已安装但不在 PATH 中时可手动指定：DOCKER_COMPOSE=/实际路径/docker-compose ./deploy.sh" >&2
  exit 1
}
detect_compose

# 固定项目名：目录名是中文等非英文字符时，Compose 默认项目名会报错
PROJECT="${COMPOSE_PROJECT_NAME:-apiloop}"
compose() { "${COMPOSE[@]}" -p "$PROJECT" "$@"; }

CMD="${1:-up}"
shift || true

case "$CMD" in
  up)
    for opt in "$@"; do
      case "$opt" in
        --cn)
          export NPM_REGISTRY=https://registry.npmmirror.com
          echo "使用国内 npm 镜像源构建"
          ;;
        *) echo "未知参数：$opt" >&2; exit 1 ;;
      esac
    done
    # 先建好数据目录：不存在时 Docker 会以 root 身份创建，容器里的 node 用户（uid 1000）就写不进去了
    mkdir -p data
    compose up -d --build
    PORT_SHOWN="${PORT:-$(grep -s '^PORT=' .env | cut -d= -f2)}"
    echo "服务已启动：http://localhost:${PORT_SHOWN:-8080}"
    echo "首次启动时 admin 的随机密码在日志里：./deploy.sh logs | grep 初始密码（在 .env 设了 ADMIN_PASSWORD 则用它）"
    ;;
  logs) compose logs -f --tail=200 ;;
  restart) compose restart ;;
  stop|down) compose down ;;
  status|ps) compose ps ;;
  user) compose exec apiloop apiloop user "$@" ;;
  *) sed -n '2,12p' "$0"; exit 1 ;;
esac
