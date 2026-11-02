# ADR-0003：技术栈确认与 UI 组件选型

- 状态：**已接受（Accepted）**（2026-11-02 经 [Issue #8](https://github.com/baiduren/work-dashboard/issues/8) 确认）
- 日期：2026-11-02

## 背景

[ADR-0001](0001-stack.md) 以提案形式给出技术栈并列有备选方案，等待产品负责人确认。
同时 [01 架构](../01-architecture.md) 的 UI 层此前只有 Tailwind CSS：任务看板需要拖拽交互，
回顾视图需要统计图表，通用组件（按钮、对话框、表单等）若全部手写会拖慢后续工单。
按 [03 约定](../03-conventions.md)，新增依赖需 ADR 批准，故本文一并记录 UI 组件选型。

## 决策

1. **技术栈确认**：[ADR-0001](0001-stack.md) 的 Next.js（App Router）+ TypeScript +
   Prisma + SQLite + Tailwind 方案经产品负责人确认**接受**；其备选方案全部**否决**，
   不再保留为候选项（[Issue #8](https://github.com/baiduren/work-dashboard/issues/8)）。
2. **UI 组件选型**（在 Tailwind 之上新增，不替换）：

| 组件 | 用途 | 理由 |
| --- | --- | --- |
| shadcn/ui | 通用 UI 组件（按钮、对话框、表单、下拉等） | 组件源码生成进 `components/ui`，可按需改造，不引入封闭的运行时组件库 |
| dnd-kit | 看板拖拽（状态列间移动、列内排序） | 轻量、可访问性支持好、与 React/Next 生态契合 |
| Tremor | 回顾视图的统计图表 | 图表组件风格与 Tailwind 一致，覆盖 MVP 所需的周回顾展示 |

## 边界

- 本 ADR 只确认选型与依赖准入；各依赖在后续实际 UI 工单中按需安装并记录版本，
  本 ADR 不固定版本号；
- shadcn/ui 生成的组件落在 `components/ui`，仍遵循 [01 架构](../01-architecture.md)
  「模块边界」：组件是展示层，不直接读写数据库；
- dnd-kit 只承担拖拽交互；排序结果的持久化仍走 `lib/domain` 的排序规则与 route handlers。

## 后果

- 好处：后续 UI 工单不必重复选型，组件与图表风格统一，拖拽交互有成熟实现；
- 代价：新增运行时依赖 dnd-kit 与 Tremor；shadcn/ui 为源码分发，
  其底层 Radix UI 原语随所用组件按需进入依赖树；
- 约束：更换任一 UI 组件库，或新增本 ADR 之外的 UI 依赖，需新的 ADR。
