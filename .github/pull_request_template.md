# 概要

<!-- 一句话说明这个 PR 做了什么、对应哪个 Issue。 -->

关联 Issue：<!-- Closes #N / Refs #N -->

## 目的

<!-- 对应 docs/00-product-brief.md 的哪个场景，解决什么问题。 -->

## 范围

- 做了什么：
- 没做什么：

## 验收对照

<!-- 按 docs/02-acceptance.md 的模板逐条列出。 -->

- [ ] 场景 1：<Given 前提 / When 操作 / Then 结果>
- [ ] 场景 2：
- [ ] 边界：空数据、越界、重复操作

## 验证

- [ ] `npm.cmd run lint`
- [ ] `npm.cmd run typecheck`
- [ ] `npm.cmd test`
- [ ] `npm.cmd run build`

UI 变更时必须附**同一场景的 Before / After 截图**（写清基线 commit 与变更后 commit）。

## 设计依据

<!-- 引用 docs/01-architecture.md 或 docs/adr/ 的相关小节；偏离时说明原因或新增 ADR。 -->

## 其他检查

- [ ] 数据库结构变更包含迁移
- [ ] 无未经 ADR 批准的新依赖
- [ ] 未修改 `.github/`
- [ ] 文档已同步（行为变了，docs/ 相应更新）
