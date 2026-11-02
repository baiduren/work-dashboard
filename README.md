# work-dashboard（个人工作台）

个人工作台：把日常与工作事项、任务看板与回顾集中在一个本地优先的单人工具里。

当前为项目骨架阶段：技术栈与目录已就绪，页面与业务功能由后续工单实现。

## 设计文档

- [00 产品概要](docs/00-product-brief.md)
- [01 架构](docs/01-architecture.md)
- [02 验收标准](docs/02-acceptance.md)
- [03 约定](docs/03-conventions.md)
- [ADR-0001 技术栈](docs/adr/0001-stack.md)

## 技术栈

Next.js（App Router）+ TypeScript + Tailwind CSS + Prisma + SQLite（见 [ADR-0001](docs/adr/0001-stack.md)）。

## 本地运行

环境要求：Node.js ≥ 20（本地验证使用 v24）、npm。

```bash
npm install          # 安装依赖（postinstall 会自动执行 prisma generate）
npm run db:migrate   # 创建/更新本地 SQLite 数据库（prisma/dev.db）
npm run dev          # 启动开发服务器，默认 http://localhost:3000
```

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
components/   展示型 UI 组件
lib/domain/   领域逻辑（纯逻辑，可单测）
lib/db/       数据访问层（Prisma client 封装）
prisma/       schema.prisma 与迁移；本地 SQLite 为 prisma/dev.db（不入库）
tests/        单元测试
```

## 约定

- 分支与提交信息见 [docs/03-conventions.md](docs/03-conventions.md)；
- 每个工单的 PR 必须附验收对照，模板见 [docs/02-acceptance.md](docs/02-acceptance.md)；
- 新增依赖或跨层调用需先写 ADR。
