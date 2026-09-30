# syntax=docker/dockerfile:1
# apiloop 运行镜像。前端页面使用仓库里已提交的 lib/web 构建产物，镜像内不编译前端。
#
# 几个约定（详见 docs/docker.md）：
# - 应用代码在 /app，数据在 /app/data（APILOOP_HOME）：SQLite 库 data.db + 上传文件 files/，请挂载出去
# - 工作目录是 /app/workspace，不是 /app：服务会从工作目录读 router.js、旧 routes.json、静态文件，
#   还会往里写 .router.js，而仓库根目录本身带一个示例 router.js，不能混在一起
# - 容器内监听 0.0.0.0（程序默认的 127.0.0.1 从容器外访问不到）

FROM node:24-alpine

# 国内可用 --build-arg NPM_REGISTRY=https://registry.npmmirror.com 加速
ARG NPM_REGISTRY=https://registry.npmjs.org

# tini：让 docker stop 的 SIGTERM 能传到 node，正常退出而不是等 10 秒被强杀
# tzdata：mock 模板里的 {{@date}} / {{@datetime}} 用本地时间，配合 TZ 才对得上
RUN apk add --no-cache tini tzdata

WORKDIR /app

# 先只复制依赖清单，源码变化时可复用依赖这一层缓存；只装运行时依赖
COPY package.json package-lock.json ./
RUN npm config set registry "$NPM_REGISTRY" \
    && npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force

COPY bin ./bin
COPY lib ./lib
COPY sample ./sample

# apiloop 命令：docker compose exec apiloop apiloop user list
RUN ln -s /app/bin/server /usr/local/bin/apiloop \
    && mkdir -p /app/data /app/workspace \
    && chown -R node:node /app/data /app/workspace

ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    APILOOP_HOME=/app/data

USER node
WORKDIR /app/workspace

VOLUME /app/data
EXPOSE 8080

# /index.html 是管理台入口，不需要登录。用 node 探测，不依赖镜像里有没有 curl
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:8080/index.html').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--", "apiloop"]
CMD ["web", "--host", "0.0.0.0", "--port", "8080"]
