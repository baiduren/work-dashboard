# 01 架构

> 状态：已确认。技术栈经 [ADR-0001](adr/0001-stack.md) 与 [ADR-0003](adr/0003-ui-components.md)
> 于 2026-11-02 确认接受；改动技术栈或新增依赖仍需新的 ADR。

## 技术栈

| 层 | 选择 | 理由 |
| --- | --- | --- |
| 框架 | Next.js（App Router）+ TypeScript | 单进程即可同时提供页面和 API，部署简单 |
| UI | Tailwind CSS + shadcn/ui + dnd-kit + Tremor | Tailwind 为基础（[ADR-0001](adr/0001-stack.md)）；shadcn/ui 提供通用组件，dnd-kit 支撑看板拖拽，Tremor 提供统计图表（[ADR-0003](adr/0003-ui-components.md)） |
| 数据 | SQLite + Prisma | 本地文件数据库，迁移可版本化 |
| 测试 | Vitest + Playwright（端到端一条） | 与 Next 生态契合 |

## 目录结构

```
app/                    Next.js 路由（页面与 route handlers）
  login/                登录页
  api/auth/             登录 / 退出接口
components/             UI 组件（展示型，不直接访问数据库）
lib/
  auth/                 会话签名、校验、限流
  domain/               领域逻辑（任务状态机、排序规则）
  db/                   数据库访问层（Prisma client 封装）
prisma/
  schema.prisma         数据模型与迁移
middleware.ts           全局访问控制（未登录一律拦截）
docs/                   产品与设计文档（本目录）
```

## 认证与访问控制（[ADR-0004](adr/0004-authentication.md)）

单用户、账号 + 密码，应用内实现，不接第三方身份服务：

- 凭据来自环境变量：`AUTH_USERNAME`、`AUTH_PASSWORD`、`AUTH_SESSION_SECRET`（≥32 字符）；
- 登录成功写入 **HMAC-SHA256 签名的会话 Cookie**：`httpOnly`、`sameSite=lax`、生产环境 `secure`，
  有效期 7 天，含用户名与签发/过期时间；改密或换 secret 即全体失效；
- `middleware.ts` 保护**所有**路由：页面未登录重定向到 `/login?next=…`，`/api/*` 未登录返回 401；
  放行清单只有 `/login`、`/api/auth/login`、静态资源；
- 退出接口清除 Cookie；登录失败返回 401，并对同一来源做**限流**（如 15 分钟内 5 次），
  密码比较使用恒定时间算法；
- 变更类请求校验 `Origin`/`Host` 一致，配合 `sameSite=lax` 防 CSRF；
- 不做用户表、注册、找回密码：单用户凭据只存在于部署环境变量。


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

- 认证：单用户账号 + 密码，Cookie 会话；公网必须经 **HTTPS 代理**（代理终止 TLS），
  禁止匿名访问任何页面与 API（见 [ADR-0004](adr/0004-authentication.md)）；
- 无网络依赖：不调用第三方 API（认证不引入外部身份服务）；
- 数据可移植：提供 JSON 导出 / 导入脚本；
- 支持 Docker 部署：启动时自动执行 `prisma migrate deploy`，SQLite 数据持久化在挂载卷，
  数据库地址由 `DATABASE_URL` 注入（见 [ADR-0002](adr/0002-docker-deployment.md)）。
