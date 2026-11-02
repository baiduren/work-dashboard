# 03 约定

## 分支与提交

- 执行器分支：`agent/<工单短名>`（由执行器自动创建）；
- 提交信息用 Conventional Commits：`type(scope): 摘要`
  - type：`feat` / `fix` / `docs` / `refactor` / `test` / `chore`
- 一个 PR 对应一个工单；不混入无关改动；
- 提交作者为 agent 账号的 noreply 地址。

## PR 描述

必须包含：

1. 关联的 Issue（`Closes #N` 或 `Refs #N`）；
2. 验收对照（见 [02 验收标准](02-acceptance.md)）；
3. 设计依据（引用 docs/ 小节）；
4. UI 变更的前后截图。

## 代码

- TypeScript 严格模式；禁止 `any`（确需时写注释说明）；
- 组件不直接访问数据库；写操作走 lib/db 或 route handlers；
- 新增依赖需 ADR；
- 遵循现有目录结构（见 [01 架构](01-architecture.md)）。

## 文档

- 产品范围变化 → 更新 `00-product-brief.md`；
- 技术决策变化 → 新增 `adr/` 记录，不直接改旧 ADR；
- 每次 PR 检查 docs 是否需要同步。
