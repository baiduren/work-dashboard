# 01 架构

> 状态：**提案**。ADR-0001 确认前，改动技术栈需要新的 ADR。

## 技术栈（提案）

| 层 | 选择 | 理由 |
| --- | --- | --- |
| 框架 | Next.js（App Router）+ TypeScript | 单进程即可同时提供页面和 API，部署简单 |
| UI | Tailwind CSS | 快速构建，无额外运行时 |
| 数据 | SQLite + Prisma | 本地文件数据库，迁移可版本化 |
| 测试 | Vitest + Playwright（端到端一条） | 与 Next 生态契合 |

## 目录结构

```
app/                    Next.js 路由（页面与 route handlers）
components/             UI 组件（展示型，不直接访问数据库）
lib/
  domain/               领域逻辑（任务状态机、排序规则）
  db/                   数据库访问层（Prisma client 封装）
prisma/
  schema.prisma         数据模型与迁移
docs/                   产品与设计文档（本目录）
```

## 数据模型（草案）

- `Project`：id、name、color、archived
- `Task`：id、title、notes、status（todo/doing/done）、priority（low/medium/high）、
  dueDate、projectId、orderIndex、createdAt、updatedAt、completedAt
- `Tag`：id、name、color；`TaskTag`：taskId、tagId

看板列由任务状态映射，不单独建表；列内排序用 `orderIndex`。

## 模块边界

- **页面 / 组件**：只负责展示与交互，不直接读写数据库；
- **lib/domain**：任务状态与排序等纯逻辑，可单测；
- **lib/db**：唯一的数据访问入口（Prisma）；
- **route handlers**：参数校验后调用 domain/db，不承载业务分支。
- 新增依赖或跨层调用必须先写 ADR。

## 接口约定（草案）

- `GET /api/tasks?view=today|project|board` 返回列表；
- `POST /api/tasks`、`PATCH /api/tasks/:id`、`DELETE /api/tasks/:id`；
- 失败返回 `{ error }`，成功返回资源本身；
- 所有写操作在服务端校验状态迁移（todo→doing→done）是否合法。

## 非功能约定

- 本地单用户：无认证，禁止把服务暴露到公网；
- 无网络依赖：不调用第三方 API；
- 数据可移植：提供 JSON 导出 / 导入脚本。
