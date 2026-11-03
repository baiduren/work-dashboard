# work-dashboard 生产镜像（多阶段构建，见 docs/adr/0002-docker-deployment.md）
# syntax=docker/dockerfile:1

# ---- 阶段 1：安装全部依赖并产出生产构建 ----
# 基础镜像显式固定 Debian 版本（bookworm / OpenSSL 3.0，Issue #35）：
# 浮动 tag `node:20-slim` 在 bullseye（OpenSSL 1.1）→ bookworm 迁移期间，
# 构建缓存中的旧镜像与新拉取的镜像可能在同一构建的不同阶段混用，
# 导致 `prisma generate` 产物与运行环境平台不一致（Query Engine 缺失）。
# 三个阶段必须始终使用同一个镜像引用，改动时三个阶段一起改。
FROM node:20-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
# postinstall 会执行 prisma generate，需要先提供 schema
COPY package.json package-lock.json ./
COPY prisma/schema.prisma ./prisma/
RUN npm ci
COPY . .
RUN npm run build

# ---- 阶段 2：仅安装运行期依赖（prisma CLI 用于启动时迁移）----
FROM node:20-bookworm-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma/schema.prisma ./prisma/
RUN npm ci --omit=dev

# ---- 阶段 3：运行镜像（非 root，数据落在挂载卷 /app/data）----
FROM node:20-bookworm-slim AS runner
WORKDIR /app
# TZ 默认 Asia/Shanghai：今日/逾期边界与日期展示按服务器时区计算（Issue #23），
# 直接 docker run 时可用 -e TZ=… 覆盖；compose 部署由 docker-compose.yml 注入。
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    TZ=Asia/Shanghai \
    DATABASE_URL=file:/app/data/dashboard.db
# prisma 的 schema engine（migrate deploy）需要 libssl/openssl；
# tzdata 提供系统时区数据库，保证 TZ=Asia/Shanghai 生效（容器内 date / Node 本地时间）。
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl tzdata \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json next.config.ts ./
COPY prisma ./prisma
COPY public ./public
COPY --from=build /app/.next ./.next
COPY --from=prod-deps /app/node_modules ./node_modules
COPY docker/entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh \
    && mkdir -p /app/data \
    && chown -R node:node /app
USER node
VOLUME /app/data
EXPOSE 3000
# 只要 HTTP 服务能响应即视为存活（骨架阶段尚无页面路由，返回 404 也算启动成功）
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(()=>process.exit(0)).catch(()=>process.exit(1))"
ENTRYPOINT ["./entrypoint.sh"]
