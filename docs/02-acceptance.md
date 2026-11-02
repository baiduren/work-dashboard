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
- UI 变更：附前后截图（Before / After）

## 设计依据
引用 docs/01-architecture.md 的相关小节；若有偏离，说明原因或新增 ADR。
```

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
