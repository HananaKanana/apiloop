# 用 Docker 部署 apiloop

写法和 stock_ai 保持一致：数据库挂载到项目目录下的 `./data`，用 `deploy.sh` 封装常用操作。

## 快速开始

```bash
cp .env.example .env        # 可选：修改端口、设置 admin 初始密码
./deploy.sh                 # 构建镜像并后台启动；国内网络加 --cn
./deploy.sh logs            # 首次启动时，admin 的随机初始密码会打印在日志里（搜「初始密码」）
```

启动后打开 <http://localhost:8080>，用 `admin` 登录。

| 命令 | 作用 |
| --- | --- |
| `./deploy.sh up [--cn]` | 构建并启动；加 `--cn` 使用国内 npm 镜像源 |
| `./deploy.sh logs` / `restart` / `stop` / `status` | 查看日志 / 重启 / 停止 / 查看状态 |
| `./deploy.sh user list` | 在容器里管理用户：`user add alice`、`user reset-password admin` 等 |

不想用脚本时，直接执行 `mkdir -p data && docker compose -p apiloop up -d --build`。**注意 `mkdir -p data` 这一步不能省**，原因见下一节。

## 数据

所有数据都放在宿主机的 **`./data`** 目录，对应容器里的 `/app/data`，由环境变量 `APILOOP_HOME` 指定：

| 文件 | 内容 |
| --- | --- |
| `data/data.db`（以及 `-wal`、`-shm` 两个辅助文件） | SQLite 数据库：用户、项目、接口、示例、环境、历史 |
| `data/files/` | 管理台上传的文件，发送 formdata 或 binary 请求时用 |

- 删除容器、重新构建镜像都不会丢数据；升级镜像后，启动时会自动迁移数据库结构。
- **备份**：先 `./deploy.sh stop`，再打包 `data/` 目录，最后重新启动。不要在服务运行时直接复制 `data.db`，因为 WAL 模式下还有一部分数据暂存在 `-wal` 文件里，只复制 `data.db` 会不完整。
- **目录权限**：容器以 uid 1000 运行。`./data` 必须能被 uid 1000 写入：
  - 如果启动前目录不存在，Docker 会以 root 身份创建它，容器就写不进去了。`deploy.sh` 会先执行 `mkdir -p data` 避免这个问题。
  - 如果宿主机用户的 uid 不是 1000，把 `docker-compose.yml` 里 `user:` 那一行的注释去掉，改成 `id -u`:`id -g` 的结果。

## 沿用老的 server-mock 项目

把老项目目录挂载到 `/app/workspace`，`docker-compose.yml` 里已经写好了一行注释，去掉注释即可。启动时服务会：
- 把目录里的 `routes.db` 或 `routes.json` 导入成一个项目，并挂在根路径下；
- 继续加载目录里的 `router.js`，同时会往这个目录写一个 `.router.js`，所以目录同样需要 uid 1000 可写。

## 网络与安全

- **容器内的服务固定监听 `0.0.0.0`**，否则从容器外访问不到。所以启动日志里总会出现「局域网内可访问」的提示，这是正常的。
- **对外端口由 `.env` 里的 `PORT` 决定**。映射出去以后，局域网里的其他人也能访问：管理台需要登录，**mock 接口不需要登录**。如果只想让本机访问，把 compose 里的端口映射改成 `"127.0.0.1:${PORT:-8080}:8080"`。
- **用随机初始密码时，这个密码会留在容器日志里**。第一次登录后请立刻修改。

## 已知限制

- **镜像不编译前端**，直接使用仓库里已提交的 `lib/web` 构建产物。改了 `web/` 下的前端代码后，要先执行 `npm run build:web`，再重新部署。P2 切换完成后，会评估是否改成像 stock_ai 那样在镜像里多阶段构建前端。
- **健康检查请求的是 `/index.html`，只在 `web` 模式下有效。** 如果把启动命令改成 `start`，需要同时去掉或改写健康检查。
- **构建时用 `npm ci`**，要求 `package-lock.json` 和 `package.json` 保持一致。
- **时区默认是 `Asia/Shanghai`**，会影响 mock 模板里的日期和时间。
