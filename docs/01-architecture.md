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
- 登录成功写入 **HMAC-SHA256 签名的会话 Cookie**：`httpOnly`、`sameSite=lax`，
  `secure` 按请求协议决定（HTTPS / 代理 `X-Forwarded-Proto: https` 时为 true，纯 HTTP 部署为 false；
  可用 `AUTH_COOKIE_SECURE` 强制覆盖），有效期 7 天，含用户名与签发/过期时间；
  改密或换 secret 即全体失效；
- `middleware.ts` 保护**所有**路由：页面未登录重定向到 `/login?next=…`，`/api/*` 未登录返回 401；
  放行清单只有 `/login`、`/api/auth/login`、静态资源（`/_next/*`、`/favicon.ico` 与
  **扩展名白名单**文件：png/jpg/jpeg/svg/css/js/webp/woff/woff2/ico；
  其余路径——含「最后一段带点」的——一律走认证，防止未来新增 `/api/tasks.json` 之类路径被放行）；
- 退出接口清除 Cookie；登录失败返回 401，并做**限流**（如 15 分钟内 5 次）：
  限流键只信任代理注入的来源头（`X-Real-IP` → `CF-Connecting-IP`，都缺失记为 `unknown`，
  不取客户端可伪造的 `X-Forwarded-For`），并按 **来源 + 账号** 双键计数（防单一维度轮换），
  另有全局失败阈值（10 分钟 100 次失败后全局拒绝一段时间）；限流记录数有上限
  （满员先清理过期项、再按插入顺序淘汰最旧项），部署要求见 README「反向代理要求」。
  密码比较使用恒定时间算法；登录请求体限定 `application/json` 且 ≤ 1KB，
  错误响应不含堆栈或配置信息；
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
- **lib/domain**：任务状态与排序等纯逻辑，可单测（`lib/domain/task.ts`：取值校验、
  completedAt 语义、看板移动计算、今日归类；日期边界可注入当前时间）；
  项目取值校验在 `lib/domain/project.ts`（name 非空且 ≤60 字符、color 为 `#RRGGBB`
  或 null、patch 只允许 name/color）；
- **lib/db**：唯一的数据访问入口（Prisma）；任务数据的读写函数在 `lib/db/tasks.ts`，
  项目数据的读写函数在 `lib/db/projects.ts`（未归档项目 + 各状态任务计数），
  所有写操作用事务保证一致；
- **route handlers**：参数校验后调用 domain/db，不承载业务分支。
- 新增依赖或跨层调用必须先写 ADR。

## 接口约定（草案）

- `GET /api/tasks?view=today|overdue|undated|board|project[&projectId=…]` 返回列表
  （`board` 返回按状态分组的结构；`project` 必须带 `projectId`；`view` 缺失或非法 → 400）；
  今日 / 逾期视图的日期边界按**服务器时区**计算，部署默认 `Asia/Shanghai`，容器可用 `TZ` 覆盖；
- `POST /api/tasks`、`GET /api/tasks/:id`、`PATCH /api/tasks/:id`、`DELETE /api/tasks/:id`；
- `PATCH /api/tasks/:id` 的字段更新与 `status` 变更在同一事务内完成：`status` 变更时
  任务追加到目标列末尾、原列重排为 `0..n-1`（等价于 `/move` 移到列尾），
  两列 `orderIndex` 连续无重复；列内位置微调走 `/move`；
- `POST /api/tasks/:id/move`：body `{ status, orderIndex }`，按领域规则移动并在事务内
  重排同列顺序（移动后各列 orderIndex 连续、无重复）；
- `GET /api/projects`：返回未归档项目数组，每项含 `id / name / color / counts`
  （counts 为该项目的 todo / doing / done 任务数与 total 合计）；空库返回 `[]`；
- `POST /api/projects`：创建项目（name 必填、trim 后非空且 ≤60 字符；color 可选
  `#RRGGBB` 或 null），成功 201 返回项目；
- `GET /api/projects/:id`：存在返回项目，不存在 → 404；
- `PATCH /api/projects/:id`：仅允许更新 `name / color`（未知字段 → 400；显式
  `color=null` 清空颜色），项目不存在 → 404；项目名重复不拒绝（schema 未加唯一约束，
  与任务标题同一策略）；项目归档 / 删除不在当前范围（后续工单）；
- 失败返回 `{ error }`，成功返回资源本身；API 响应统一带 `Cache-Control: no-store`；
- 所有写操作在服务端校验字段与状态取值（`status` 仅 `todo|doing|done`，`priority` 仅
  `low|medium|high`），非法值抛出可识别错误（`lib/domain` 的 `TaskValidationError`），调用方据此返回 400；
  项目字段校验同样抛出 `TaskValidationError`（`TaskNotFoundError` / `ProjectNotFoundError`
  均由 `toErrorResponse` 映射为 404）。
- 状态迁移允许任意直接切换（看板拖拽，含 `done → todo/doing` 的“取消完成”）：
  进入 `done` 写入 `completedAt`，离开 `done` 清空，`done → done` 保留首次完成时间。

## 非功能约定

- 认证：单用户账号 + 密码，Cookie 会话；公网必须经 **HTTPS 代理**（代理终止 TLS），
  禁止匿名访问任何页面与 API（见 [ADR-0004](adr/0004-authentication.md)）；
- 无网络依赖：不调用第三方 API（认证不引入外部身份服务）；
- 数据可移植：提供 JSON 导出 / 导入脚本；
- 支持 Docker 部署：启动时自动执行 `prisma migrate deploy`，SQLite 数据持久化在挂载卷，
  数据库地址由 `DATABASE_URL` 注入（见 [ADR-0002](adr/0002-docker-deployment.md)）。
