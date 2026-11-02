# lib/domain/

领域逻辑目录（[docs/01-architecture.md](../../docs/01-architecture.md)「模块边界」）。

任务状态机（todo→doing→done 的合法迁移）、看板列内排序（`orderIndex`）等纯逻辑放在这里：可单测、不依赖数据库与框架。状态与优先级的合法取值约束也由本层负责（SQLite 不支持 enum，见 `prisma/schema.prisma` 注释）。
