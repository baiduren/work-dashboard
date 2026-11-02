# ADR-0002：Docker 部署方案

- 状态：已接受（依据 Issue #6 的部署需求）
- 日期：2026-11-02

## 背景

[00 产品概要](../00-product-brief.md)把「部署形态：本机单进程运行」列为开放问题；
Issue #6 提出需要支持 Docker 方式部署。当前技术栈为
Next.js（App Router）+ TypeScript + Prisma + SQLite（[ADR-0001](0001-stack.md)），
方案不引入新的第三方依赖或运行时组件。

## 决策

提供多阶段 `Dockerfile` 与 `docker-compose.yml`，一键构建并启动：

- 基础镜像 `node:20-slim`（满足「Node ≥ 20」约定；Debian OpenSSL 3 与 Prisma 引擎兼容）；
- 构建阶段执行 `npm ci` + `npm run build`；运行阶段仅安装生产依赖；
- 容器启动时先执行 `prisma migrate deploy`（幂等），再前台运行 `next start -H 0.0.0.0`；
- SQLite 数据库落在挂载卷（容器内 `/app/data/dashboard.db`），升级镜像不丢数据；
- 以 `node` 用户运行，不使用 root；
- 健康检查用 Node 内置 `fetch` 探测自身 HTTP 端口，不引入 curl 等额外工具。

配套调整：

- `prisma/schema.prisma` 的 `url` 从硬编码 `file:./dev.db` 改为 `env("DATABASE_URL")`；
  本地开发通过 `.env.example`（复制为 `.env`）提供默认值，行为不变；
- `prisma` CLI 从 devDependencies 移到 dependencies：容器启动时需要执行
  `prisma migrate deploy`，属运行期依赖；不是新增第三方依赖；
- 新增 `.dockerignore`、`docker/entrypoint.sh`、`public/`（Next 静态资源目录，当前为占位）。

## 备选方案

| 方案 | 结论 |
| --- | --- |
| `output: "standalone"` 精简镜像 | 体积更小，但文件追踪需要为 Prisma 引擎做额外配置，较脆弱；当前以正确性优先 |
| 在 CI 中构建镜像 | [02 验收标准](../02-acceptance.md)约定不修改 `.github/workflows`（如需改动单独开 Issue） |
| 镜像内运行 `prisma migrate dev` | 该命令面向开发环境（可能交互/重置数据），生产启动只允许 `migrate deploy` |

## 后果

- 好处：`docker compose up --build` 一条命令完成部署；数据持久化在命名卷；
  迁移在启动时自动应用，与本地开发共用同一套 `prisma/migrations`；
- 代价：镜像内保留完整 Next 运行时与 prisma CLI，体积较大；后续如需瘦身另立 ADR；
- 约束：服务仍默认只映射到本机端口，面向单人使用，不应暴露公网
  （[01 架构](../01-architecture.md)「非功能约定」）；
- 注意：后续如果引入构建期（预渲染）访问数据库的页面，Docker 构建阶段需要提供
  可用的 `DATABASE_URL`，或将相关页面改为动态渲染。
