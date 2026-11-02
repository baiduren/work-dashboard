#!/bin/sh
set -e

# 容器启动流程（docs/adr/0002-docker-deployment.md）：
# 1. 把 prisma/migrations 幂等地应用到挂载卷中的 SQLite 数据库；
# 2. 前台启动 Next.js 生产服务（next start 监听 0.0.0.0:PORT）。

echo "[entrypoint] prisma migrate deploy ..."
./node_modules/.bin/prisma migrate deploy

echo "[entrypoint] next start -H 0.0.0.0 -p ${PORT:-3000}"
exec ./node_modules/.bin/next start -H 0.0.0.0 -p "${PORT:-3000}"
