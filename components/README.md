# components/

展示型 UI 组件目录（[docs/01-architecture.md](../docs/01-architecture.md)「目录结构」）。

约定：组件只负责展示与交互，不直接读写数据库；数据访问一律走 `lib/db`，业务分支放在 `lib/domain` 或 route handlers。
