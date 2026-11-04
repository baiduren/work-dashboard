# 02 验收标准

> 每个工单在 PR 描述里必须给出“验收对照”；本文件给出模板与通用门槛。

## 功能验收模板

```markdown
## 目的
一句话说明这个工单要解决什么问题（对应 docs/00-product-brief.md 的场景）。

## 范围
- 做什么：
- 不做什么：

## 验收清单
- [ ] 场景 1：<Given 前提 / When 操作 / Then 结果>
- [ ] 场景 2：……
- [ ] 边界：空数据、越界、重复操作

## 验证方式
- 命令：`npm run lint`、`npm run typecheck`、`npm test`、`npm run build`
- 手工步骤：……
- UI 变更：附前后截图（Before / After），PR 描述中用绝对地址引用（见 [03 约定](03-conventions.md#pr-描述)）

## 设计依据
引用 docs/01-architecture.md 的相关小节；若有偏离，说明原因或新增 ADR。
```

## 认证验收（登录与会话，[ADR-0004](adr/0004-authentication.md)）

- [ ] 未登录访问 `/`（或其他页面）→ 302 跳转 `/login?next=…`；
- [ ] 未登录访问 `/api/*` → 401 JSON（不返回业务数据）；
- [ ] 正确账号 + 密码登录 → 进入目标页，会话 Cookie 带 `HttpOnly`、`SameSite=Lax`，
      生产环境带 `Secure`；
- [ ] 错误密码 → 401，且不下发会话 Cookie；
- [ ] 同一来源连续失败达到阈值后被限流（429 或等价拒绝），冷却后可再试；
- [ ] 手工篡改 / 截断 Cookie 后视为未登录（签名校验生效）；
- [ ] 退出后会话立即失效，再访问回到登录页；
- [ ] 日志中不出现密码、session secret、完整 Cookie；
- [ ] 变更类请求校验 `Origin` 与 `Host` 一致（跨站请求被拒）；
- [ ] 伪造/轮换 `X-Forwarded-For` 不改变限流键（只信任 `X-Real-IP` / `CF-Connecting-IP`，
      缺失时退化为 `unknown` 且限流仍生效）；
- [ ] 失败按 **来源 + 账号** 双键计数（换 IP 或换账号的轮换都无法绕过）；
      全局失败阈值（10 分钟 100 次）触发后拒绝所有登录；
- [ ] 大量不同来源失败后，限流记录数不超过上限（过期清理 + 淘汰最旧）；
- [ ] 未登录访问带点路径（如 `/api/tasks.json`、`/notes/2026.11.02`）不放行，
      静态资源仅按扩展名白名单放行；
- [ ] 非 `application/json` 登录请求返回 400，超过 1KB 的请求体返回 413，
      错误响应不含堆栈或配置信息。

## 导出 / 导入验收（数据备份与完整恢复，Issue #37）

- [ ] 未登录访问 `GET /api/export` / `POST /api/import` 返回 401（middleware 现有行为不变）；
- [ ] `GET /api/export` 返回全量 JSON：字段完整（含 orderIndex、completedAt、
      createdAt），日期为 ISO 字符串，带 `Content-Disposition: attachment`
      下载头与 `Cache-Control: no-store`；
- [ ] 导出 → 清库（deleteMany 全表）→ `POST /api/import` → 今日 / 项目 / 看板
      三视图数据与导出前一致：任务内容、状态、优先级、截止日、项目归属、
      看板列内顺序、完成时间全部恢复；
- [ ] 导入 version 非法 / 缺 tasks 字段 / task 类型错误 → 400，且库内现有数据
      不变（事务回滚可验证：导入失败后再 `GET /api/tasks?view=board` 数据与
      导入前一致）；
- [ ] UI：导出点击即下载；导入未确认（取消 confirm）不发起请求；导入成功后
      页面刷新显示新数据；空库导入合法文件后页面正常；
- [ ] `npm run lint` / `typecheck` / `test` / `build` 全绿。

## 标签验收（任务标签：创建 / 绑定 / 展示 / 级联删除，Issue #39）

- [ ] 未登录访问 `GET|POST /api/tags`、`PATCH|DELETE /api/tags/:id` 返回 401（middleware 现有行为不变）；
- [ ] 编辑弹层「标签」区块可新建标签（name ≤24 字符、可选颜色）并勾选到任务上，
      保存后刷新页面标签仍在；同名标签第二次创建返回 400，弹层显示固定文案「标签名已存在」；
- [ ] 任务行正确显示标签徽标（彩色圆点 + 名称），无标签不占位；取消勾选标签保存后徽标消失；
- [ ] 今日 / 项目 / 看板三处视图（`GET /api/tasks?view=…` 响应）的任务对象都带
      `tags: { id, name, color }[]` 且一致；
- [ ] 今日视图提供标签下拉筛选（「全部标签」+ 各标签），选中后按当前列表内 tags 前端过滤；
- [ ] `PATCH /api/tasks/:id` 支持 `tagIds`（string 数组，全量替换语义）：
      与字段更新、status 变更同一事务，任一非法（tagId 不存在、字段取值非法）时
      标签与字段都不落库（事务回滚）；未提供 `tagIds` 时不动既有绑定；
- [ ] 删除标签后：标签从下拉与勾选列表消失，原挂该标签的任务不再显示该徽标
      （TaskTag 级联删除生效），任务本身保留；删除任务同样级联清空其绑定；
- [ ] G 工单兼容：导出含标签数据 → 清库 → 导入 → 标签与任务绑定关系完整恢复；
- [ ] `npm run lint` / `typecheck` / `test` / `build` 全绿；
- [ ] UI 变更附 Before / After 截图（PR 描述用绝对地址引用）。

## 删除任务验收（编辑弹层删除入口 + 内联二次确认，Issue #41）

- [ ] 未登录访问 `DELETE /api/tasks/:id` 返回 401（middleware 现有行为不变，本工单不改 API）；
- [ ] 编辑弹层操作区左下角出现红色描边「删除」按钮；单击一次不删除，按钮原地变为
      「确认删除？」并出现「再想想」；再次点击才发 `DELETE /api/tasks/:id`（不用 `window.confirm`）；
- [ ] 点击「再想想」、点击弹层其他区域、5 秒无操作超时三者都会把确认态复位为「删除」，
      任务未被删除；
- [ ] 确认删除成功（204）后弹层关闭并触发回调（onDeleted，缺省复用 onSaved）：
      今日视图该任务行消失（router.refresh 生效），`GET /api/tasks?view=board` 中该任务不存在；
- [ ] 对已不存在的任务（删除返回 404，另一端已删）视为「已删除」：弹层关闭、页面刷新、无报错；
- [ ] 删除失败（网络异常 / 5xx）时弹层保留并显示固定错误文案（复用 apiErrorMessage），
      确认态复位，任务仍在；
- [ ] Esc / 「取消」关闭弹层不触发删除；删除进行中显示「删除中…」并禁用「保存 / 取消」，
      保存进行中禁用「删除」（互斥防并发）；
- [ ] 项目详情页只读 TaskList 不受影响（不渲染编辑弹层，不传新 prop 行为不变）；
- [ ] `npm run lint` / `typecheck` / `test` / `build` 全绿；
- [ ] UI 变更附 Before / After 截图（Before：弹层底部只有取消 / 保存；After：含「删除」按钮
      与「确认删除？」确认态两帧，PR 描述用绝对地址引用）。

## 项目归档 / 删除验收（archived 启用 + DELETE API + 两段式确认，Issue #43）

- [ ] 未登录访问 `PATCH|DELETE /api/projects/:id` 返回 401（middleware 现有行为不变）；
- [ ] 项目卡片常显「归档」入口：点击后卡片从主列表消失，出现在列表底部「已归档」折叠区
      （默认收起，标题「已归档（N）」，展开可见只读卡片：名称 + 计数）；
- [ ] 归档项目可恢复：折叠区内「恢复」后项目回到主列表，任务归属关系不变（计数原样）；
- [ ] 编辑任务的「所属项目」下拉（数据来自 `GET /api/projects`）不出现已归档项目；
- [ ] 详情页头部提供「归档 / 删除」（归档项目显示「恢复 / 删除」）：归档成功跳回 `/projects`；
- [ ] 详情页删除为内联两段式确认（不用 `window.confirm`）：单击一次进入「确认删除？」 +
      「再想想」，浮出提示「项目下的任务会保留，但不再归属任何项目」；点击其他区域 /
      5 秒无操作超时复位；再次点击才发 `DELETE /api/projects/:id`；
- [ ] 确认删除成功（204）后跳回项目列表：`GET /api/projects` 不含该项目，
      其下任务仍在（`GET /api/tasks?view=board` 可见）且任务的 `projectId` 为 `null`；
- [ ] `PATCH /api/projects/:id` 支持 `archived`（boolean）：`true` 归档、`false` 恢复；
      非法值（如字符串）返回 400；未知字段仍返回 400；
- [ ] `DELETE /api/projects/:id` 对不存在的项目返回 404；
- [ ] 归档项目 → 导出 → 清库 → 导入 → 归档状态与任务归属完整恢复（backup 测试覆盖）；
- [ ] 归档项目只读：不可改名 / 改色（无编辑入口），删除与恢复不受限；
- [ ] `npm run lint` / `typecheck` / `test` / `build` 全绿；
- [ ] UI 变更附 Before / After 截图（Before：主列表无归档入口、详情页无操作按钮；
      After：主列表归档入口 + 已归档折叠区展开、详情页操作按钮与删除确认态两帧，
      PR 描述用绝对地址引用）。

## 通用门槛（每个 PR 都要满足）

- [ ] `lint`、`typecheck`、`test`、`build` 全部通过；
- [ ] 有数据库结构变更时包含迁移；
- [ ] 没有未经 ADR 批准的新依赖；
- [ ] 不修改 `.github/workflows`（如需改动，单独开 Issue）；
- [ ] 文档与实现保持一致：行为变了，docs/ 相应更新；
- [ ] 提交信息符合 docs/03-conventions.md。

## 不接受的形态

- 只改 UI 不接数据；
- 测试通过但断言为空/跳过；
- 以“占位 TODO”交付功能；
- PR 描述与验收清单缺失。
