# ADR-0001：技术栈选择（提案）

- 状态：**提议（Proposed）**
- 日期：2026-11-02

## 背景

个人工作台是单人、本地优先的综合工作台（见 [00 产品概要](../00-product-brief.md)）。需要同时承载页面与数据接口，部署应尽量简单，且便于后续迭代。

## 决策

采用 **Next.js（App Router）+ TypeScript + Prisma + SQLite + Tailwind**：

- 单进程提供前后端，`npm run dev` 一条命令启动；
- SQLite 零依赖、单文件，数据可直接备份；
- Prisma 提供可版本化的迁移；
- Tailwind 减少样式层的运行时依赖。

## 备选方案

| 方案 | 优点 | 缺点 |
| --- | --- | --- |
| Vite + React + FastAPI + SQLite | 前后端分离、Python 生态 | 两个进程，联调与部署更重 |
| Django + 模板 | 后台与 ORM 成熟 | 前端交互（拖拽看板）实现更重 |
| Tauri + React | 桌面原生 | 打包与跨平台成本高，MVP 过重 |

## 后果

- 好处：部署简单、迭代快、生态完善；
- 代价：后续若需多人协作/云同步，SQLite 需迁移到 Postgres（届时新增 ADR）；
- 约束：MVP 不做登录，服务只绑定本机地址。

## 待确认

- 是否接受该技术栈；若不接受，需改为 Vite + FastAPI 方案并在本 ADR 追加说明。
