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
| `AUTH_COOKIE_SECURE` | 可选：`true`/`false` 强制指定 Cookie 的 `Secure` 属性；不设置时按请求协议自动判断（HTTPS/代理 → Secure，纯 HTTP → 不 Secure） |

- 未配置或密钥过短时应用按“未认证”处理（fail closed），登录接口返回 500；
- 会话 Cookie 为 HMAC-SHA256 签名，`HttpOnly`、`SameSite=Lax`，默认按请求协议决定 `Secure`，
  有效期 7 天；换 secret 或改密码即全体会话失效；
- **纯 HTTP 部署**（如内网 `http://IP:3000`）：Cookie 自动不带 `Secure`，可以正常登录；
  但公网部署仍必须经 HTTPS 代理——明文 HTTP 下 Cookie 可被中间人截获；
- 登录限流（单实例内存实现，记录数有上限）：
  - 同一来源 15 分钟内连续失败 5 次后返回 429，冷却后可再试；
  - 同时按 **来源 + 账号** 双键计数：只换 IP 或只换账号的轮换都无法绕过已达阈值的另一维度；
  - 全局失败阈值：10 分钟内累计失败达 100 次后暂时拒绝所有登录尝试，防分布式撞库；
- 登录接口只接受 `Content-Type: application/json` 的请求（否则 400），请求体最大 1KB（超限 413）；
  错误响应只含固定文案，不含堆栈或配置信息；
- 公网部署必须经 HTTPS 代理（`Secure` Cookie 依赖 TLS），代理终止 TLS。

### 反向代理要求（登录限流依赖）

限流键只信任**代理注入**的来源地址，客户端伪造 `X-Forwarded-For` 无法绕过限流。
部署反向代理时必须：

- **设置 `X-Real-IP`** 为真实客户端地址（nginx 示例：`proxy_set_header X-Real-IP $remote_addr;`）；
  未设置时回退读取 `CF-Connecting-IP`（Cloudflare），两者都没有则按 `unknown` 限流；
- **覆盖（而非追加）`X-Forwarded-For`**：使用 `proxy_set_header X-Forwarded-For $remote_addr;`，
  不要用 `$proxy_add_x_forwarded_for`（追加模式会保留客户端伪造的链）；
  应用不读取 XFF 生成限流键；
- 经多级代理时，由最外层（面向互联网的）代理设置上述两个头，内层代理不得透传客户端可控的同名头；
- **HTTPS 代理需设置 `X-Forwarded-Proto: https`**（nginx：`proxy_set_header X-Forwarded-Proto $scheme;`），
  应用据此判断是否给会话 Cookie 加 `Secure`；未设置时按收到的请求协议判断。

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

### 时区

今日 / 已逾期分组与日期标题的边界按**服务器时区**计算（`lib/domain/task.ts` 的
`startOfDay` / `endOfDay` 与展示组件的日期格式化都使用本地时区）。容器默认 `Asia/Shanghai`：

- Compose 部署：`docker-compose.yml` 注入 `TZ: ${TZ:-Asia/Shanghai}`，宿主设置 `TZ`
  环境变量（或 compose 同目录 `.env`）即可覆盖，例如 `TZ=Asia/Tokyo docker compose up -d`；
- 直接 `docker run`：镜像内置 `ENV TZ=Asia/Shanghai`，可用 `-e TZ=…` 覆盖；
- 暂不做每用户时区配置（后续在用户设置里再做）。

### 使用 Docker Hub 镜像

镜像在以下时机构建并推送（每次都要求 checks 全过；PR 上只构建、不推送）：

- **每日 21:00**（Asia/Shanghai，即 UTC 13:00）自动运行；
- **手动触发**：Actions 页选择 `CI` → `Run workflow`；
- **推送 `v*` tag**（如 `v1.0.0`）。

镜像标签：

- `<DockerHub 用户名>/work-dashboard:latest`：默认分支的定时 / 手动运行更新；
- `sha-<短哈希>`：每次发布的可追溯标签；
- `v1.2.3` / `1.2`：推送 `v*` tag 时生成。

```bash
docker run -d --name work-dashboard -p 3000:3000 \
  -v work-dashboard-data:/app/data \
  -e AUTH_USERNAME=admin \
  -e AUTH_PASSWORD='your-password' \
  -e AUTH_SESSION_SECRET='<至少 32 字符的随机串>' \
  <DockerHub 用户名>/work-dashboard:latest
```

也可以把 `docker-compose.yml` 里的 `build: .` 换成
`image: <DockerHub 用户名>/work-dashboard:latest`，直接用已发布的镜像部署。

### 发布镜像（维护者一次性配置）

1. 在 [Docker Hub](https://hub.docker.com) 创建仓库 `work-dashboard`（与 GitHub 仓库同名，public/private 均可）；
2. Docker Hub → Account Settings → Personal access tokens → **New Access Token**（权限选 **Read & Write**）；
3. 在 GitHub 仓库 Settings → Secrets and variables → Actions 里添加：
   - `DOCKERHUB_USERNAME`：Docker Hub 用户名；
   - `DOCKERHUB_TOKEN`：上一步生成的 Access Token（不要用账号密码）；
   - 可选：在 **Variables** 里加 `DOCKERHUB_REPOSITORY` 覆盖镜像仓库名（默认 `work-dashboard`）；
4. 配置完成后，三种触发（每日 21:00 / 手动 / `v*` tag）都会在 checks 通过后发布；
5. 未配置 secrets 时，`docker` job 会明确报错提示缺哪个 secret（不会推送任何镜像）。

> 镜像默认只构建 `linux/amd64`；需要 arm64（Apple Silicon 服务器/树莓派）时，在
> `.github/workflows/ci.yml` 的 `platforms` 加上 `linux/arm64`，并启用 `docker/setup-qemu-action@v3`。

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
