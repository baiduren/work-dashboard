# work-dashboard（个人工作台）

个人工作台：把日常与工作事项、任务看板与回顾集中在一个本地优先的单人工具里。

当前为项目骨架阶段：技术栈、目录与登录认证已就绪（单用户账号 + 密码，见下文「登录认证」），
页面与业务功能由后续工单实现。

应用需登录后使用（单用户账号 + 密码，见 [ADR-0004](docs/adr/0004-authentication.md)）；
公网部署必须经 HTTPS 代理。

## 设计文档

- [00 产品概要](docs/00-product-brief.md)
- [01 架构](docs/01-architecture.md)
- [02 验收标准](docs/02-acceptance.md)
- [03 约定](docs/03-conventions.md)
- [ADR-0001 技术栈](docs/adr/0001-stack.md)
- [ADR-0002 Docker 部署](docs/adr/0002-docker-deployment.md)
- [ADR-0003 技术栈确认与 UI 组件选型](docs/adr/0003-ui-components.md)
- [ADR-0004 认证与访问控制](docs/adr/0004-authentication.md)

## 技术栈

Next.js（App Router）+ TypeScript + Tailwind CSS + Prisma + SQLite（见 [ADR-0001](docs/adr/0001-stack.md)）；
UI 组件选型 shadcn/ui + dnd-kit + Tremor（见 [ADR-0003](docs/adr/0003-ui-components.md)，随后续 UI 工单安装）。

## 本地运行

环境要求：Node.js ≥ 20（本地验证使用 v24）、npm。

```bash
cp .env.example .env # 提供本地 DATABASE_URL 与登录认证配置（Windows 用 copy 命令）
npm install          # 安装依赖（postinstall 会自动执行 prisma generate）
npm run db:migrate   # 创建/更新本地 SQLite 数据库（prisma/dev.db）
npm run dev          # 启动开发服务器，默认 http://localhost:3000
```

## 登录认证

应用全站需要登录后访问（单用户账号 + 密码，设计见 [ADR-0004](docs/adr/0004-authentication.md)），
凭据只来自环境变量，在 `.env`（或部署环境）中配置：

| 变量 | 说明 |
| --- | --- |
| `AUTH_USERNAME` | 登录账号 |
| `AUTH_PASSWORD` | 登录密码 |
| `AUTH_SESSION_SECRET` | 会话签名密钥，**至少 32 个字符的随机串**（可用 `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"` 生成） |

- 未配置或密钥过短时应用按“未认证”处理（fail closed），登录接口返回 500；
- 会话 Cookie 为 HMAC-SHA256 签名，`HttpOnly`、`SameSite=Lax`，生产环境 `Secure`，有效期 7 天；
  换 secret 或改密码即全体会话失效；
- 登录限流：同一来源 15 分钟内连续失败 5 次后返回 429，冷却后可再试（单实例内存实现）；
- 公网部署必须经 HTTPS 代理（`Secure` Cookie 依赖 TLS），代理终止 TLS。

## Docker 部署

环境要求：Docker（含 Compose V2）。设计依据见 [ADR-0002](docs/adr/0002-docker-deployment.md)。

启动前需设置认证环境变量（`AUTH_USERNAME` / `AUTH_PASSWORD` / `AUTH_SESSION_SECRET`），
可在宿主环境或 compose 同目录 `.env` 中提供，缺少任一项容器无法启动：

```bash
AUTH_USERNAME=admin \
AUTH_PASSWORD='your-password' \
AUTH_SESSION_SECRET="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))")" \
docker compose up --build -d   # 构建镜像并后台启动，默认 http://localhost:3000
docker compose logs -f         # 查看日志（启动时会先执行 prisma migrate deploy）
docker compose down            # 停止；数据保留在命名卷中
```

- SQLite 数据持久化在命名卷 `work-dashboard-data`（容器内 `/app/data/dashboard.db`），升级镜像不丢数据；
- 端口映射默认 `3000`，可用 `WORK_DASHBOARD_PORT=8080 docker compose up -d` 修改；
- 不用 Compose 时：`docker build -t work-dashboard .`，然后
  `docker run -p 3000:3000 -v work-dashboard-data:/app/data work-dashboard:local`。

### 常用脚本

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 启动开发服务器 |
| `npm run build` | 生产构建 |
| `npm run start` | 运行生产构建 |
| `npm run lint` | ESLint 检查 |
| `npm run typecheck` | TypeScript 严格模式类型检查（不产出文件） |
| `npm run test` | Vitest 单元测试 |
| `npm run db:generate` | 生成 Prisma Client |
| `npm run db:migrate` | 创建/应用数据库迁移（开发环境） |

## 目录结构

与 [docs/01-architecture.md](docs/01-architecture.md)「目录结构」一致：

```
app/          Next.js 路由（页面与 route handlers）
  login/      登录页
  api/auth/   登录 / 退出接口
components/   展示型 UI 组件
lib/auth/     会话签名、凭据校验、登录限流
lib/domain/   领域逻辑（纯逻辑，可单测）
lib/db/       数据访问层（Prisma client 封装）
middleware.ts 全站访问控制（未登录一律拦截）
prisma/       schema.prisma 与迁移；本地 SQLite 为 prisma/dev.db（不入库）
public/       Next.js 静态资源
docker/       Docker 容器入口脚本
tests/        单元测试
```

## 约定

- 分支与提交信息见 [docs/03-conventions.md](docs/03-conventions.md)；
- 每个工单的 PR 必须附验收对照，模板见 [docs/02-acceptance.md](docs/02-acceptance.md)；
- 新增依赖或跨层调用需先写 ADR。
