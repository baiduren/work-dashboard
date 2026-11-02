# AGENTS.md — 执行者须知（work-dashboard / 个人工作台）

本文件是仓库对自动化执行者（Superagent worker、其他 coding agent）的**执行指令**。
产品与设计文档在 `docs/`，本文件只讲“怎么在这里干活”。

## 先读这些

1. `docs/00-product-brief.md` — 做什么、MVP 范围、**非目标**
2. `docs/01-architecture.md` — 技术栈、目录结构、数据模型、模块边界
3. `docs/02-acceptance.md` — 验收模板与通用门槛（PR 必须按它写）
4. `docs/03-conventions.md` — 分支、提交、代码与文档约定
5. `docs/adr/` — 已生效的技术决策（不要违背；要改就新增 ADR）

## 环境

- Windows + PowerShell（DSH 的 `pwsh` 工具）。
- **必须用 `npm.cmd`，不要用 `npm`**：本机 PowerShell 执行策略禁止 `npm.ps1`。
- Node.js ≥ 20（CI/Docker 用 20；本机可能是 24）。
- 依赖安装用 `npm ci`；不要手工改 `package-lock.json`。

## 常用命令

```powershell
npm.cmd ci                     # 安装依赖（含 prisma client 生成）
copy .env.example .env         # 本地数据库地址（.env 已在 .gitignore）
npm.cmd run db:generate        # 生成 prisma client（改 schema 后必跑）
npm.cmd run db:migrate         # 本地迁移（会创建 prisma/dev.db）
npm.cmd run lint               # eslint
npm.cmd run typecheck          # tsc --noEmit
npm.cmd test                   # vitest
npm.cmd run build              # next build
npm.cmd run dev                # 本地开发（http://localhost:3000）
```

Docker（本机未装 Docker 时跳过，不要为了跑 Docker 去装）：

```powershell
docker compose up --build -d
docker compose logs -f
docker compose down
```

## 提交前必须全绿

按顺序跑，全部通过才能 push：

```powershell
npm.cmd run lint
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
```

UI 变更另需：同一场景的 **Before / After 截图**，写进 PR 描述（`docs/02-acceptance.md` 要求）。

## 工作流程约束

- 分支由执行器创建（`agent/<工单名>`），**不要自己去改 main**，也不要直接 push `main`；
- 一个 PR 对应一个工单，不混无关改动；
- 提交信息用 Conventional Commits：`feat|fix|docs|refactor|test|chore(scope): 摘要`；
- 提交作者用执行器提供的 agent 身份（见 `$env:DSH_SUPERAGENT_GITHUB_*`），不要用操作者本人身份；
- 不修改 `.github/`（对应改动单独开 Issue，由人处理）；
- 新增依赖必须先在 PR 里说明理由；架构级依赖需要新增 ADR；
- 数据库结构变更必须带 `prisma/migrations`；
- 行为变了就同步更新 `docs/`；文档与实现不一致时以文档为先，先改文档再改代码。

## 不确定就停下

以下情况**不要自己猜**，在工单里提 `attention`（问人）：

- Issue 的范围、目标页面、验收标准不明确；
- 需要做产品取舍（比如“回顾”要不要进 v1）；
- 需要架构变更、新依赖、改 CI；
- 需要凭据、外部服务或人的操作。

## 目录速览

```
app/         Next.js 路由（页面 + route handlers）
components/  UI 组件（展示型，不直接访问数据库）
lib/domain/  领域逻辑（纯函数，可单测）
lib/db/      唯一数据访问入口（Prisma）
prisma/      schema + migrations
tests/       vitest 测试
docker/      部署相关
docs/        产品与设计文档
```

## 已知坑

- PowerShell 下 `npm` 会被执行策略拦截 → 用 `npm.cmd`。
- `npm ci` 输出的 `install-scripts` 只是警告，不影响；若 prisma client 缺失，显式跑 `npm.cmd run db:generate`。
- SQLite 的 `status` / `priority` 是字符串，合法值由 `lib/domain` 约束（schema 里没有 enum）。
- 不要提交 `prisma/dev.db`、`.env`、`node_modules`（已在 `.gitignore`）。
